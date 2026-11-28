import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectusError,
  SSR_CACHE_CONTROL,
  applyCacheHeaders,
  categoryById,
  categoryBySlug,
  excerpt,
  fetchArticleBySlug,
  fetchCategories,
  fetchPublishedArticles,
  formatDate,
  normalizeTechSummary,
  normalizeTldr,
  publishedDate,
  resolveConfig,
  safeSourceUrl,
  sourceHost,
} from "./directus.js";

const CONFIG = { baseUrl: "https://cms.example", token: "read-token" };
const ARTICLE = {
  id: "a1",
  title: "Drony w rolnictwie",
  slug: "drony-w-rolnictwie",
  source_url: "https://example.com/a",
  image_url: "https://media.example/a.webp",
  text_content: "<p>Treść</p>",
  tldr: ["Punkt"],
  tech_summary: { podmiot: "Firma", technologia: "RTK", cel_wdrozenia: "Mapowanie" },
  published_at: "2026-10-20T10:00:00Z",
  created_at: "2026-10-19T10:00:00Z",
  category_id: "c1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => jsonResponse(body, status));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveConfig", () => {
  it("normalizuje trailing slash", () => {
    expect(resolveConfig("https://cms.example///", " token ")).toEqual({
      baseUrl: "https://cms.example",
      token: "token",
    });
  });

  it("brak URL/tokenu → błąd konfiguracji", () => {
    expect(() => resolveConfig("", "token")).toThrow(/DIRECTUS_URL/);
    expect(() => resolveConfig("https://cms.example", " ")).toThrow(/DIRECTUS_PUBLIC_READ_TOKEN/);
  });
});

describe("fetchCategories", () => {
  it("pobiera kategorie z auth i limitem", async () => {
    const fetchMock = mockFetch({ data: [{ id: "c1", name: "Agro", slug: "agro", description: null }] });

    const categories = await fetchCategories(CONFIG);

    expect(categories).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain("https://cms.example/items/categories");
    expect(url.searchParams.get("limit")).toBe("100");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer read-token");
  });
});

describe("fetchPublishedArticles", () => {
  it("filtruje published, sortuje po dacie i mapuje limit", async () => {
    const fetchMock = mockFetch({ data: [ARTICLE] });

    const articles = await fetchPublishedArticles(CONFIG, { limit: 6 });

    expect(articles[0]?.slug).toBe("drony-w-rolnictwie");
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("filter[status][_eq]")).toBe("published");
    expect(url.searchParams.get("sort")).toBe("-published_at");
    expect(url.searchParams.get("limit")).toBe("6");
    expect(url.searchParams.get("filter[category_id][_eq]")).toBeNull();
  });

  it("dodaje filtr kategorii", async () => {
    const fetchMock = mockFetch({ data: [] });

    await fetchPublishedArticles(CONFIG, { categoryId: "c1" });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("filter[category_id][_eq]")).toBe("c1");
  });

  it("błąd Directusa → DirectusError ze statusem", async () => {
    mockFetch({ errors: [{ message: "forbidden" }] }, 403);

    await expect(fetchPublishedArticles(CONFIG)).rejects.toMatchObject({
      name: "DirectusError",
      status: 403,
    });
    await expect(fetchPublishedArticles(CONFIG)).rejects.toBeInstanceOf(DirectusError);
  });
});

describe("fetchArticleBySlug", () => {
  it("zwraca artykuł po slug (published)", async () => {
    const fetchMock = mockFetch({ data: [ARTICLE] });

    const article = await fetchArticleBySlug(CONFIG, "drony-w-rolnictwie");

    expect(article?.id).toBe("a1");
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("filter[slug][_eq]")).toBe("drony-w-rolnictwie");
    expect(url.searchParams.get("filter[status][_eq]")).toBe("published");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("brak wyniku → null", async () => {
    mockFetch({ data: [] });
    await expect(fetchArticleBySlug(CONFIG, "brak")).resolves.toBeNull();
  });
});

describe("mapowanie i normalizacja", () => {
  const categories = [
    { id: "c1", name: "Agro", slug: "agro", description: null },
    { id: "c2", name: "AI", slug: "ai", description: "Opis" },
  ];

  it("categoryById / categoryBySlug", () => {
    expect(categoryById(categories, "c2")?.slug).toBe("ai");
    expect(categoryById(categories, null)).toBeNull();
    expect(categoryBySlug(categories, "agro")?.id).toBe("c1");
    expect(categoryBySlug(categories, "brak")).toBeNull();
  });

  it("tldr: tylko niepuste stringi", () => {
    expect(normalizeTldr(["a", "", 5, "b"])).toEqual(["a", "b"]);
    expect(normalizeTldr({ a: 1 })).toEqual([]);
  });

  it("tech_summary: wymaga kompletu pól", () => {
    expect(normalizeTechSummary({ podmiot: "F", technologia: "T", cel_wdrozenia: "C" })).toEqual({
      podmiot: "F",
      technologia: "T",
      cel_wdrozenia: "C",
    });
    expect(normalizeTechSummary({ podmiot: "F" })).toBeNull();
  });

  it("data: published_at z fallbackiem, błędna data → empty", () => {
    expect(publishedDate(ARTICLE)).toBe("2026-10-20T10:00:00Z");
    expect(publishedDate({ ...ARTICLE, published_at: null })).toBe("2026-10-19T10:00:00Z");
    expect(formatDate("2026-10-20T10:00:00Z")).toMatch(/2026/);
    expect(formatDate("nie-data")).toBe("");
    expect(formatDate(null)).toBe("");
  });

  it("źródło: tylko http(s), host bez www", () => {
    expect(safeSourceUrl("https://www.example.com/a")).toBe("https://www.example.com/a");
    expect(safeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(safeSourceUrl("ftp://example.com")).toBeNull();
    expect(sourceHost("https://www.example.com/a")).toBe("example.com");
  });

  it("excerpt: bez tagów, encje i cięcie na granicy słowa", () => {
    expect(excerpt("<p>Drony &amp; RTK</p>")).toBe("Drony & RTK");
    const cut = excerpt(`<p>${"słowo ".repeat(60)}</p>`, 50);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut).not.toContain("<");
    expect(excerpt(null)).toBe("");
  });
});

describe("cache", () => {
  it("ustawia dokładny Cache-Control", () => {
    const headers = new Headers();
    applyCacheHeaders(headers);
    expect(headers.get("Cache-Control")).toBe(SSR_CACHE_CONTROL);
    expect(SSR_CACHE_CONTROL).toBe("public, s-maxage=3600, stale-while-revalidate=86400");
  });
});
