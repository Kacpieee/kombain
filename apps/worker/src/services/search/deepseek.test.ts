import { describe, expect, it, vi } from "vitest";
import { SearchConfigError, deepseekFetch, deepseekSearch, serpSearch } from "./deepseek.js";

const OK_BODY = {
  results: [
    {
      title: "Raport",
      url: "https://example.com/raport",
      snippet: "krótko",
      summary: "długie podsumowanie",
      site_name: "example.com",
      authority: 3,
      rerank_score: 2.2,
      date: "2026-01-01T00:00:00Z",
    },
    { title: "Bez URL", url: "ftp://x", summary: "x" },
  ],
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("deepseekSearch", () => {
  it("wysyła POST z Bearer i normalizuje wyniki", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return response(200, OK_BODY);
    }) as unknown as typeof fetch;

    const results = await deepseekSearch("drony", { apiKey: "k", fetchImpl, retryDelayMs: 0 });

    expect(seen!.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect((seen!.init!.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(JSON.parse(String(seen!.init!.body))).toMatchObject({ query: "drony", count: 10, need_content: false });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ url: "https://example.com/raport", authority: 3 });
  });

  it("brak klucza → SearchConfigError", async () => {
    await expect(deepseekSearch("x", { apiKey: "" })).rejects.toBeInstanceOf(SearchConfigError);
  });

  it("402 → SearchConfigError (fallback po stronie researchu)", async () => {
    const fetchImpl = (async () => response(402, {})) as unknown as typeof fetch;
    await expect(deepseekSearch("x", { apiKey: "k", fetchImpl, retryDelayMs: 0 })).rejects.toBeInstanceOf(SearchConfigError);
  });

  it("429 raz, potem sukces (retry 1x)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? response(429, {}) : response(200, OK_BODY);
    }) as unknown as typeof fetch;

    const results = await deepseekSearch("x", { apiKey: "k", fetchImpl, retryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(results).toHaveLength(1);
  });
});

describe("deepseekFetch", () => {
  it("pobiera treść strony (Markdown)", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return response(200, { title: "T", content: "# Treść" });
    }) as unknown as typeof fetch;

    const content = await deepseekFetch("https://example.com/a", { apiKey: "k", fetchImpl });
    expect(content).toBe("# Treść");
    expect(JSON.parse(body)).toEqual({ url: "https://example.com/a" });
  });

  it("402 → SearchConfigError", async () => {
    const fetchImpl = (async () => response(402, {})) as unknown as typeof fetch;
    await expect(deepseekFetch("https://example.com/a", { apiKey: "k", fetchImpl })).rejects.toBeInstanceOf(SearchConfigError);
  });
});

describe("serpSearch (fallback)", () => {
  const HTML = `<html><body>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Tytuł A</a>
      <a class="result__snippet">Snippet A</a></div>
    <div class="result"><a class="result__a" href="https://example.org/b">Tytuł B</a>
      <a class="result__snippet">Snippet B</a></div>
    <div class="result"><a class="result__a" href="ftp://evil.example/c">Zły</a>
      <a class="result__snippet">Zły snippet</a></div>
  </body></html>`;

  it("brak klucza ScrapingAnt → SearchConfigError", async () => {
    await expect(serpSearch("x", { scrapingAntKey: "" })).rejects.toBeInstanceOf(SearchConfigError);
  });

  it("parsuje wyniki DDG i dekoduje uddg", async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, text: async () => HTML }) as unknown as Response) as unknown as typeof fetch;

    const results = await serpSearch("drony", { scrapingAntKey: "key", fetchImpl });
    expect(results.map((result) => result.url)).toEqual(["https://example.com/a", "https://example.org/b"]);
    expect(results[0]?.summary).toBe("Snippet A");
  });
});
