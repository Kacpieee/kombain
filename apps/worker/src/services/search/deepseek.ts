import { buildScrapingAntUrl } from "../ingestion.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  site_name: string | null;
  authority: number;
  rerank_score: number;
  date: string | null;
}

export class SearchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchConfigError";
  }
}

export interface DeepSeekOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  count?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/** DeepSeek Search API (POST /v1/tools/search). 401/402/403 → SearchConfigError (wołający robi fallback). */
export async function deepseekSearch(query: string, options: DeepSeekOptions = {}): Promise<SearchResult[]> {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) throw new SearchConfigError("Brak DEEPSEEK_API_KEY");

  const baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = JSON.stringify({ query: query.slice(0, 128), count: options.count ?? 10, need_content: false });

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/tools/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      if (attempt === 0) {
        await delay(options.retryDelayMs ?? 500);
        continue;
      }
      throw error;
    }

    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new SearchConfigError(`DeepSeek search: HTTP ${response.status}`);
    }
    if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt === 0) {
      await delay(options.retryDelayMs ?? 500);
      continue;
    }
    if (!response.ok) throw new Error(`DeepSeek search: HTTP ${response.status}`);

    const payload = (await response.json()) as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new Error("DeepSeek search: brak results");

    return payload.results
      .map((raw) => normalizeResult(raw))
      .filter((result): result is SearchResult => result !== null);
  }

  throw new Error("DeepSeek search: wyczerpano próby");
}

/** DeepSeek Fetch API (POST /v1/tools/fetch) — Markdown strony; używane, gdy summary nie wystarcza. */
export async function deepseekFetch(url: string, options: DeepSeekOptions = {}): Promise<string> {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) throw new SearchConfigError("Brak DEEPSEEK_API_KEY");

  const baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/tools/fetch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });

  if (response.status === 401 || response.status === 402 || response.status === 403) {
    throw new SearchConfigError(`DeepSeek fetch: HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`DeepSeek fetch: HTTP ${response.status}`);

  const payload = (await response.json()) as { content?: unknown };
  return typeof payload.content === "string" ? payload.content : "";
}

/** Fallback: DuckDuckGo HTML przez ScrapingAnt (tylko gdy DeepSeek padnie). */
export interface SerpOptions {
  scrapingAntKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function serpSearch(query: string, options: SerpOptions = {}): Promise<SearchResult[]> {
  const key = options.scrapingAntKey ?? process.env.SCRAPINGANT_API_KEY ?? "";
  if (!key) throw new SearchConfigError("Brak SCRAPINGANT_API_KEY dla fallbacku SERP");

  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.slice(0, 128))}`;
  const response = await (options.fetchImpl ?? fetch)(buildScrapingAntUrl(target, key), {
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok) throw new Error(`SERP fallback: HTTP ${response.status}`);

  const { load } = await import("cheerio");
  const $ = load(await response.text());
  const results: SearchResult[] = [];

  $(".result").each((_, element) => {
    const link = $(element).find("a.result__a").attr("href") ?? "";
    const title = $(element).find("a.result__a").text().trim();
    const snippet = $(element).find(".result__snippet").text().trim();
    const url = decodeDuckDuckGoUrl(link);
    if (!url || !title || !/^https?:\/\//i.test(url)) return;

    results.push({
      title,
      url,
      snippet,
      summary: snippet,
      site_name: safeHostname(url),
      authority: 1,
      rerank_score: 1,
      date: null,
    });
  });

  return results;
}

function normalizeResult(raw: unknown): SearchResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!/^https?:\/\//i.test(url) || !title) return null;

  const summary = typeof value.summary === "string" ? value.summary : "";
  const snippet = typeof value.snippet === "string" ? value.snippet : "";

  return {
    title,
    url,
    snippet,
    summary: summary || snippet,
    site_name: typeof value.site_name === "string" ? value.site_name : safeHostname(url),
    authority: typeof value.authority === "number" ? value.authority : -1,
    rerank_score: typeof value.rerank_score === "number" ? value.rerank_score : 0,
    date: typeof value.date === "string" ? value.date : null,
  };
}

function decodeDuckDuckGoUrl(href: string): string {
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return "";
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
