const REQUEST_TIMEOUT_MS = 10_000;

export const SSR_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";
export const NO_STORE_CACHE_CONTROL = "no-store";

export interface DirectusConfig {
  baseUrl: string;
  token: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface Article {
  id: string;
  title: string;
  slug: string;
  source_url: string;
  image_url: string | null;
  text_content: string | null;
  tldr: unknown;
  tech_summary: unknown;
  published_at: string | null;
  created_at: string;
  category_id: string | null;
}

export interface TechSummary {
  podmiot: string;
  technologia: string;
  cel_wdrozenia: string;
}

export interface ArticleWithCategory extends Article {
  category: Category | null;
}

export interface ArticleQuery {
  limit?: number;
  categoryId?: string;
}

const ARTICLE_FIELDS =
  "id,title,slug,source_url,image_url,text_content,tldr,tech_summary,published_at,created_at,category_id";

export class DirectusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "DirectusError";
  }
}

/** Buduje config z env; brak base URL lub tokenu to błąd konfiguracji, nie cichy request bez auth. */
export function resolveConfig(baseUrl: string | undefined, token: string | undefined): DirectusConfig {
  const normalized = baseUrl?.trim().replace(/\/+$/, "") ?? "";
  const trimmedToken = token?.trim() ?? "";
  if (!normalized) throw new Error("Brak DIRECTUS_URL");
  if (!trimmedToken) throw new Error("Brak DIRECTUS_PUBLIC_READ_TOKEN");
  return { baseUrl: normalized, token: trimmedToken };
}

/** Cache brzegowy dla SSR (Dokumentacja §2 / AGENTS §0). */
export function applyCacheHeaders(headers: Headers, cacheControl: string = SSR_CACHE_CONTROL): void {
  headers.set("Cache-Control", cacheControl);
}

export async function fetchCategories(config: DirectusConfig): Promise<Category[]> {
  const body = await request<{ data: Category[] }>(config, "categories", {
    fields: "id,name,slug,description",
    sort: "name",
    limit: 100,
  });
  return body.data;
}

export async function fetchPublishedArticles(
  config: DirectusConfig,
  { limit = 20, categoryId }: ArticleQuery = {}
): Promise<Article[]> {
  const params: Record<string, string | number> = {
    fields: ARTICLE_FIELDS,
    "filter[status][_eq]": "published",
    sort: "-published_at",
    limit,
  };
  if (categoryId) params["filter[category_id][_eq]"] = categoryId;

  const body = await request<{ data: Article[] }>(config, "articles", params);
  return body.data;
}

export async function fetchArticleBySlug(config: DirectusConfig, slug: string): Promise<Article | null> {
  const body = await request<{ data: Article[] }>(config, "articles", {
    fields: ARTICLE_FIELDS,
    "filter[status][_eq]": "published",
    "filter[slug][_eq]": slug,
    limit: 1,
  });
  return body.data[0] ?? null;
}

export function categoryById(categories: Category[], id: string | null): Category | null {
  if (!id) return null;
  return categories.find((category) => category.id === id) ?? null;
}

export function categoryBySlug(categories: Category[], slug: string): Category | null {
  return categories.find((category) => category.slug === slug) ?? null;
}

export function publishedDate(article: Article): string | null {
  return article.published_at ?? article.created_at ?? null;
}

export function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "long" }).format(date);
}

export function normalizeTldr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function normalizeTechSummary(value: unknown): TechSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const podmiot = typeof record.podmiot === "string" ? record.podmiot.trim() : "";
  const technologia = typeof record.technologia === "string" ? record.technologia.trim() : "";
  const cel = typeof record.cel_wdrozenia === "string" ? record.cel_wdrozenia.trim() : "";
  if (!podmiot || !technologia || !cel) return null;
  return { podmiot, technologia, cel_wdrozenia: cel };
}

/** Tylko http(s) — link „Źródło:” doklejany w kodzie, nigdy z LLM. */
export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function sourceHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

export function articleImage(article: Article): string | null {
  return typeof article.image_url === "string" && article.image_url.length > 0 ? article.image_url : null;
}

/** Zajawka z HTML redaktora; bez tagów, encje basic, cięcie na granicy słowa. */
export function excerpt(html: string | null, max = 160): string {
  if (!html) return "";
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trim()}…`;
}

async function request<T>(
  config: DirectusConfig,
  collection: string,
  params: Record<string, string | number>
): Promise<T> {
  const url = new URL(`${config.baseUrl}/items/${collection}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new DirectusError(response.status, `Directus ${response.status} (${collection})`);
  }

  return (await response.json()) as T;
}
