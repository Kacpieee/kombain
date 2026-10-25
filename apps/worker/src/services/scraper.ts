import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { buildScrapingAntUrl, normalizeUrl } from "./ingestion.js";

export const MIN_TEXT_LENGTH = 800;
export const REJECTION_REASON_SHORT = "Tekst zbyt krótki (<800 znaków)";

const DIRECT_TIMEOUT_MS = 10_000;
const SCRAPINGANT_TIMEOUT_MS = 30_000;
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CLOUDFLARE_MARKERS = [
  "just a moment",
  "cf-browser-verification",
  "cf_chl_opt",
  "cf-challenge",
  "checking your browser",
  "enable javascript and cookies",
  "verify you are human",
  "attention required",
];

export interface HttpResponse {
  status: number;
  html: string;
}

export interface ScraperDeps {
  /** Wstrzykiwane w testach; domyślnie fetch UA Chrome + timeout 10 s. */
  fetchDirect?: (url: string) => Promise<HttpResponse>;
  /** Wstrzykiwane w testach; domyślnie ScrapingAnt z kluczem i timeoutem 30 s. */
  fetchScrapingAnt?: (url: string) => Promise<HttpResponse>;
  scrapingAntKey?: string;
  scrapingAntEndpoint?: string;
}

export interface ScrapedArticle {
  sourceUrl: string;
  title: string;
  text: string;
  contentHtml: string;
  ogImage: string | null;
  charCount: number;
  fetchedVia: "direct" | "scrapingant";
}

export type ScrapeOutcome =
  | { status: "ok"; article: ScrapedArticle }
  | {
      status: "rejected";
      sourceUrl: string;
      title: string;
      reason: string;
      charCount: number;
      text: string;
      fetchedVia: "direct" | "scrapingant";
    }
  | { status: "error"; sourceUrl: string; error: string; fetchedVia: "direct" | "scrapingant" | null };

/** 403/429/503 albo sygnatura Cloudflare = trzeba iść przez ScrapingAnt. */
export function isBlockedResponse(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  const lower = html.toLowerCase();
  return CLOUDFLARE_MARKERS.some((marker) => lower.includes(marker));
}

/** og:image (meta), a gdy brak — pierwszy obraz z artykułu; zawsze rozwiązywany do absolutu. */
export function extractOgImage(html: string, baseUrl: string): string | null {
  const { document } = parseHTML(html);

  const meta =
    document.querySelector('meta[property="og:image"]') ??
    document.querySelector('meta[name="og:image"]') ??
    document.querySelector('meta[property="twitter:image"]');
  const metaContent = meta?.getAttribute("content")?.trim();
  if (metaContent) return normalizeUrl(metaContent, baseUrl);

  const image = document.querySelector("article img");
  const raw = image?.getAttribute("src") ?? image?.getAttribute("data-src") ?? image?.getAttribute("data-original");
  const src = raw?.trim();
  return src ? normalizeUrl(src, baseUrl) : null;
}

/**
 * Smart fetch + ekstrakcja (Dokumentacja §4 KROK 2):
 * bezpośredni fetch → fallback ScrapingAnt przy blokadzie → Readability → twardy filtr 800.
 */
export async function scrapeArticle(sourceUrl: string, deps: ScraperDeps = {}): Promise<ScrapeOutcome> {
  const key = deps.scrapingAntKey ?? process.env.SCRAPINGANT_API_KEY ?? "";
  const fetchDirect = deps.fetchDirect ?? defaultFetchDirect;
  const fetchFallback =
    deps.fetchScrapingAnt ??
    ((target: string) => defaultFetchScrapingAnt(target, key, deps.scrapingAntEndpoint));
  let via: "direct" | "scrapingant" | null = null;

  try {
    const first = await fetchDirect(sourceUrl);
    via = "direct";
    let html = first.html;

    if (isBlockedResponse(first.status, html)) {
      if (!key) {
        return {
          status: "error",
          sourceUrl,
          error: "Brak SCRAPINGANT_API_KEY (fallback wymagany przy blokadzie)",
          fetchedVia: via,
        };
      }

      const fallback = await fetchFallback(sourceUrl);
      via = "scrapingant";
      if (fallback.status >= 400 || !fallback.html) {
        return { status: "error", sourceUrl, error: `ScrapingAnt HTTP ${fallback.status}`, fetchedVia: via };
      }
      html = fallback.html;

      if (isBlockedResponse(fallback.status, html)) {
        return { status: "error", sourceUrl, error: "Strona nadal zablokowana po fallbacku (Cloudflare)", fetchedVia: via };
      }
    } else if (first.status < 200 || first.status >= 300) {
      // 404/410/500 bez sygnatury blokady: to błąd pobrania, nie artykuł i nie permanentny odrzut.
      return { status: "error", sourceUrl, error: `HTTP ${first.status}`, fetchedVia: via };
    }

    return extractArticle(sourceUrl, html, via);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", sourceUrl, error: redact(message, key), fetchedVia: via };
  }
}

function extractArticle(sourceUrl: string, html: string, via: "direct" | "scrapingant"): ScrapeOutcome {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();

  if (!article?.content || !article.textContent) {
    return { status: "error", sourceUrl, error: "Nie udało się wyekstrahować treści (Readability)", fetchedVia: via };
  }

  const text = article.textContent.replace(/\s+/g, " ").trim();
  const title = (article.title ?? "").replace(/\s+/g, " ").trim();
  const charCount = text.length;
  const ogImage = extractOgImage(html, sourceUrl);

  if (charCount < MIN_TEXT_LENGTH) {
    return { status: "rejected", sourceUrl, title, reason: REJECTION_REASON_SHORT, charCount, text, fetchedVia: via };
  }

  return {
    status: "ok",
    article: { sourceUrl, title, text, contentHtml: article.content, ogImage, charCount, fetchedVia: via },
  };
}

async function defaultFetchDirect(url: string): Promise<HttpResponse> {
  const response = await fetch(url, {
    headers: { "User-Agent": CHROME_UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
  });
  return { status: response.status, html: await response.text() };
}

async function defaultFetchScrapingAnt(target: string, key: string, endpoint?: string): Promise<HttpResponse> {
  const response = await fetch(buildScrapingAntUrl(target, key, endpoint), {
    headers: { "User-Agent": CHROME_UA, Accept: "text/html,*/*;q=0.8" },
    signal: AbortSignal.timeout(SCRAPINGANT_TIMEOUT_MS),
  });
  return { status: response.status, html: await response.text() };
}

function redact(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
}
