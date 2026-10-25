import * as cheerio from "cheerio";
import Parser from "rss-parser";
export { slugify } from "@kombain/db/slug";

export const MAX_LINKS_PER_SOURCE = 15;

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SCRAPINGANT_ENDPOINT = "https://api.scrapingant.com/v2/general";

export type SourceKind = "rss" | "scraper";

export interface SourceForIngestion {
  id: string;
  name: string;
  url: string;
  type: string;
  link_selector: string | null;
}

export interface RawArticleCandidate {
  sourceId: string | null;
  originalTitle: string;
  sourceUrl: string;
}

export interface IngestionDeps {
  /** Wstrzykiwane w testach; domyślnie fetch z UA Chrome i timeoutem 10 s. */
  fetchText?: (url: string) => Promise<string>;
  scrapingAntKey?: string;
  scrapingAntEndpoint?: string;
  /** Limit pozycji na źródło (max 15, AGENTS §2.1). */
  maxLinks?: number;
}

export interface IngestionResult {
  sourceId: string;
  type: SourceKind;
  candidates: RawArticleCandidate[];
  error: string | null;
}

export class UnknownSourceTypeError extends Error {
  constructor(type: string) {
    super(`Nieznany typ źródła: ${type}`);
    this.name = "UnknownSourceTypeError";
  }
}

/** route-source: rss → parser, scraper → ScrapingAnt + cheerio. */
export function routeSource(source: { type: string }): SourceKind {
  if (source.type === "rss" || source.type === "scraper") return source.type;
  throw new UnknownSourceTypeError(source.type);
}

/**
 * Normalizacja URL: względny → bezwzględny, bez utm_ i fbclid/gclid, bez fragmentu.
 * `&amp;` jest rozkodowywane przed parsowaniem (typowy artefakt z HTML/RSS).
 */
export function normalizeUrl(href: string, baseUrl: string): string | null {
  const cleaned = href.replace(/&amp;/g, "&").trim();
  if (!cleaned) return null;

  try {
    const url = new URL(cleaned, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (/^utm_/i.test(key) || lower === "fbclid" || lower === "gclid") url.searchParams.delete(key);
    }
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

/** Wyciąga linki z HTML listy (scraper): selektor z DB albo domyślne `a[href]`. */
export function extractLinks(
  html: string,
  source: SourceForIngestion,
  selector: string | null = source.link_selector,
  maxLinks: number = MAX_LINKS_PER_SOURCE
): RawArticleCandidate[] {
  const $ = cheerio.load(html);
  const query = selector && selector.trim() ? selector.trim() : "a[href]";
  const seen = new Set<string>();
  const candidates: RawArticleCandidate[] = [];

  $(query).each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    const raw = href.trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw)) return;

    const sourceUrl = normalizeUrl(raw, source.url);
    if (!sourceUrl || seen.has(sourceUrl)) return;

    const originalTitle = $(element).text().replace(/\s+/g, " ").trim();
    if (originalTitle.length < 3) return;

    seen.add(sourceUrl);
    candidates.push({ sourceId: source.id, originalTitle, sourceUrl });
  });

  return candidates.slice(0, Math.min(maxLinks, MAX_LINKS_PER_SOURCE));
}

export function buildScrapingAntUrl(targetUrl: string, apiKey: string, endpoint = SCRAPINGANT_ENDPOINT): string {
  const url = new URL(endpoint);
  url.searchParams.set("url", targetUrl);
  url.searchParams.set("x-api-key", apiKey);
  return url.toString();
}

/** Pobiera listę linków ze źródła. Błąd źródła nie przerywa runu — trafia do `error`. */
export async function ingestSource(source: SourceForIngestion, deps: IngestionDeps = {}): Promise<IngestionResult> {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const key = deps.scrapingAntKey ?? process.env.SCRAPINGANT_API_KEY ?? "";
  let type: SourceKind = source.type === "scraper" ? "scraper" : "rss";

  try {
    type = routeSource(source);
    const base = { sourceId: source.id, type };

    if (type === "rss") {
      const xml = await fetchText(source.url);
      const feed = await new Parser().parseString(xml);
      if (!Array.isArray(feed.items)) throw new Error("Nieprawidłowy feed RSS");
      return { ...base, candidates: collectFeedItems(feed.items, source, deps.maxLinks), error: null };
    }

    if (!key) return { ...base, candidates: [], error: "Brak SCRAPINGANT_API_KEY dla źródła typu scraper" };

    const html = await fetchText(buildScrapingAntUrl(source.url, key, deps.scrapingAntEndpoint));
    return { ...base, candidates: extractLinks(html, source, source.link_selector, deps.maxLinks), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { sourceId: source.id, type, candidates: [], error: redactSecret(message, key) };
  }
}

/** Komunikat błędu nigdy nie może zawierać klucza API (trafia do logów JSONL). */
function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

function collectFeedItems(
  items: Array<{ title?: string; link?: string }>,
  source: SourceForIngestion,
  maxLinks: number = MAX_LINKS_PER_SOURCE
): RawArticleCandidate[] {
  const limit = Math.min(maxLinks, MAX_LINKS_PER_SOURCE);
  const seen = new Set<string>();
  const candidates: RawArticleCandidate[] = [];

  for (const item of items) {
    const link = item.link?.trim();
    if (!link) continue;

    const sourceUrl = normalizeUrl(link, source.url);
    if (!sourceUrl || seen.has(sourceUrl)) continue;

    const originalTitle = (item.title ?? "").replace(/\s+/g, " ").trim();
    if (!originalTitle) continue;

    seen.add(sourceUrl);
    candidates.push({ sourceId: source.id, originalTitle, sourceUrl });
    if (candidates.length >= limit) break;
  }

  return candidates;
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": CHROME_UA,
      Accept: "application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.8",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const safe = new URL(url);
    safe.search = "";
    throw new Error(`HTTP ${response.status} dla ${safe.toString()}`);
  }
  return response.text();
}

/** Wyciąga pierwszy poprawny obiekt/tablicę JSON, odpornie na fence i prozę wokół. */
export function parseSynthesisJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const found = extractFirstJson(trimmed);
    if (found === undefined) throw new Error("Nie odnaleziono JSON w odpowiedzi LLM");
    return found;
  }
}

function extractFirstJson(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const char = text[start];
    if (char !== "{" && char !== "[") continue;
    const candidate = sliceBalanced(text, start);
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // to była klamra z prozy — szukaj dalej
    }
  }
  return undefined;
}

/** Zwraca domknięty fragment od `start` albo null, gdy klamra nigdy się nie zamyka. */
function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
