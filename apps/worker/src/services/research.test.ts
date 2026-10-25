import { describe, expect, it, vi } from "vitest";
import type { GenerateFn } from "./llm.js";
import { buildResearchQueries, factsFromDistill, normalizeFacts, researchTopic } from "./research.js";
import type { SearchResult } from "./search/deepseek.js";

const INPUT = {
  title: "Drony RTK w sadownictwie",
  text: "Długi tekst źródłowy o NOAA i wzroście o 20% w 2025 roku.",
  category: "Inteligentne Maszyny i Drony" as const,
};

function results(): SearchResult[] {
  return [
    {
      title: "Rynek dronów rolniczych",
      url: "https://example.com/raport",
      snippet: "Wzrost o 20%",
      summary: "Rynek dronów rolniczych wzrósł o 20% w 2025 roku.",
      site_name: "example.com",
      authority: 3,
      rerank_score: 2.1,
      date: null,
    },
    {
      title: "Drugi wynik",
      url: "https://example.org/dane",
      snippet: "Inne dane",
      summary: "Drugi wynik ze szczegółami.",
      site_name: "example.org",
      authority: 2,
      rerank_score: 1.6,
      date: null,
    },
  ];
}

function distill(facts: Array<{ claim: string; source_index: number }>): string {
  return JSON.stringify({ facts });
}

describe("buildResearchQueries", () => {
  it("buduje dwie krótkie kwerendy (tytuł + encje z tekstu/kategoria)", () => {
    const queries = buildResearchQueries(INPUT);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe("Drony RTK w sadownictwie");
    expect(queries[1]).toContain("Inteligentne Maszyny i Drony");
    expect(queries[1]).toContain("NOAA");
    expect(queries[1]).toContain("2025");
    expect(queries[1]).toContain("after:2025");
    for (const query of queries) expect(query.length).toBeLessThanOrEqual(128);
  });
});

describe("factsFromDistill", () => {
  it("mapuje indeks na URL i odrzuca indeks spoza zakresu", () => {
    const facts = factsFromDistill(
      [
        { claim: "Rynek dronów wzrósł o 20% w 2025 roku.", source_index: 0 },
        { claim: "Fakt spoza listy wyników.", source_index: 99 },
      ],
      results()
    );

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ url: "https://example.com/raport", source_type: "search:example.com" });
  });

  it("odrzuca wyniki bez http(s) i puste URL", () => {
    const facts = factsFromDistill(
      [{ claim: "Rynek dronów wzrósł o 20% w 2025 roku.", source_index: 0 }],
      [{ ...results()[0]!, url: "ftp://example.com/x" }]
    );
    expect(facts).toHaveLength(0);
  });

  it("odrzuca krótkie claimy i duplikaty", () => {
    const facts = factsFromDistill(
      [
        { claim: "Krótki", source_index: 0 },
        { claim: "Rynek dronów wzrósł o 20% w 2025 roku.", source_index: 0 },
        { claim: "RYNEK DRONÓW WZRÓSŁ O 20% W 2025 ROKU.", source_index: 1 },
      ],
      results()
    );

    expect(facts).toHaveLength(1);
  });
});

describe("researchTopic", () => {
  it("DeepSeek: search → distill → fakty z URL z wyników", async () => {
    const search = vi.fn(async () => results());
    const generate = vi.fn(async () => distill([{ claim: "Rynek dronów wzrósł o 20% w 2025 roku.", source_index: 0 }])) as unknown as GenerateFn;

    const outcome = await researchTopic(INPUT, { provider: "deepseek", search, generate });

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.facts[0]).toMatchObject({ url: "https://example.com/raport" });
    }
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("fallback SERP, gdy DeepSeek padnie", async () => {
    const search = vi.fn(async () => {
      throw new Error("402");
    });
    const serp = vi.fn(async () => results());
    const generate = vi.fn(async () => distill([{ claim: "Rynek dronów wzrósł o 20% w 2025 roku.", source_index: 0 }])) as unknown as GenerateFn;

    const outcome = await researchTopic(INPUT, { provider: "deepseek", search, serp, generate });

    expect(outcome.status).toBe("ok");
    expect(serp).toHaveBeenCalled();
  });

  it("DeepSeek + SERP padają → error", async () => {
    const search = vi.fn(async () => {
      throw new Error("402");
    });
    const serp = vi.fn(async () => {
      throw new Error("SERP down");
    });

    const outcome = await researchTopic(INPUT, { provider: "deepseek", search, serp });

    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.error).toContain("SERP down");
  });

  it("provider off → pusty brief bez sieci", async () => {
    const search = vi.fn(async () => results());
    const outcome = await researchTopic(INPUT, { provider: "off", search });
    expect(outcome).toEqual({ status: "ok", facts: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it("provider gemini → stary grounding z search:true", async () => {
    let seenSearch: boolean | undefined;
    const generate = vi.fn(async ({ search }: { search?: boolean }) => {
      seenSearch = search;
      return JSON.stringify({ facts: [{ claim: "Rynek dronów wzrósł o 20% w 2025 roku.", url: "https://e.com", source_type: "press" }] });
    }) as unknown as GenerateFn;

    const outcome = await researchTopic(INPUT, { provider: "gemini", generate });
    expect(seenSearch).toBe(true);
    expect(outcome.status).toBe("ok");
  });

  it("pusty wynik wyszukiwania → error bez wołania modelu", async () => {
    const search = vi.fn(async () => []);
    const serp = vi.fn(async () => []);
    const generate = vi.fn(async () => {
      throw new Error("model nie powinien być wołany");
    }) as unknown as GenerateFn;

    const outcome = await researchTopic(INPUT, { provider: "deepseek", search, serp, generate });
    expect(outcome.status).toBe("error");
    expect(generate).not.toHaveBeenCalled();
  });

  it("pusta dystylacja → fallback SERP, nie cichy pusty brief", async () => {
    const search = vi.fn(async () => results());
    const serp = vi.fn(async () => results());
    const generate = vi.fn(async () => JSON.stringify({ facts: [] })) as unknown as GenerateFn;

    const outcome = await researchTopic(INPUT, { provider: "deepseek", search, serp, generate });

    expect(outcome.status).toBe("error");
    expect(serp).toHaveBeenCalled();
  });
});

describe("normalizeFacts (ścieżka gemini)", () => {
  it("odrzuca nie-http URL i krótkie claimy", () => {
    const facts = normalizeFacts([
      { claim: "Poprawny fakt o rynku AgTech.", url: "https://example.com/a", source_type: "press" },
      { claim: "Poprawny fakt o rynku AgTech.", url: "https://duplikat.example/b", source_type: "blog" },
      { claim: "Krótki", url: "https://example.com/c", source_type: "other" },
      { claim: "Zły URL faktu.", url: "ftp://example.com/d", source_type: "other" },
    ]);
    expect(facts).toHaveLength(1);
  });

  it("obcina do limitu 10", () => {
    const input = Array.from({ length: 15 }, (_, i) => ({
      claim: `Fakt numer ${i} o technologii AgTech.`,
      url: `https://example.com/${i}`,
      source_type: "press",
    }));
    expect(normalizeFacts(input)).toHaveLength(10);
  });
});
