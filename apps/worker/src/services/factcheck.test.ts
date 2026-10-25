import { describe, expect, it, vi } from "vitest";
import type { R2Atom } from "../prompts.js";
import { verifyExternalAtoms } from "./factcheck.js";
import type { GenerateFn } from "./llm.js";
import type { SearchResult } from "./search/deepseek.js";

const ATOMS: R2Atom[] = [{ text: "Firma X ma 40% rynku.", type: "external", evidence: "" }];

function results(summary = "Raport potwierdza 40% udziału firmy X."): SearchResult[] {
  return [
    {
      title: "Raport rynkowy",
      url: "https://example.com/raport",
      snippet: "40%",
      summary,
      site_name: "example.com",
      authority: 3,
      rerank_score: 2.2,
      date: null,
    },
  ];
}

function judge(verdict: "confirmed" | "refuted" | "uncertain", index: number | null): string {
  return JSON.stringify({ results: [{ claim: "Firma X ma 40% rynku.", verdict, source_index: index }] });
}

describe("verifyExternalAtoms — gemini (rollback)", () => {
  it("pusta lista nie woła modelu", async () => {
    let called = false;
    const generate: GenerateFn = async () => {
      called = true;
      return "{}";
    };
    const result = await verifyExternalAtoms([], { generate, provider: "gemini" });
    expect(called).toBe(false);
    expect(result).toEqual({ status: "ok", result: { results: [] } });
  });

  it("woła model z search grounding", async () => {
    let seen: { search?: boolean } | null = null;
    const generate: GenerateFn = async ({ search }) => {
      seen = { search };
      return JSON.stringify({
        results: [{ claim: "Firma X ma 40% rynku.", verdict: "confirmed", evidence_url: "https://e.com/a" }],
      });
    };
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "gemini" });
    expect(seen!.search).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("werdykt spoza enuma → error R3", async () => {
    const generate: GenerateFn = async () =>
      JSON.stringify({ results: [{ claim: "x", verdict: "maybe", evidence_url: "" }] });
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "gemini" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toMatch(/Walidacja odpowiedzi R3/);
  });
});

describe("verifyExternalAtoms — deepseek (search + lite judge)", () => {
  it("confirmed: URL dowodu pochodzi z wyników wyszukiwania", async () => {
    const search = vi.fn(async () => results());
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]).toEqual({
        claim: "Firma X ma 40% rynku.",
        verdict: "confirmed",
        evidence_url: "https://example.com/raport",
      });
    }
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("refuted z indeksem → evidence_url z wyniku", async () => {
    const generate = vi.fn(async () => judge("refuted", 0)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search: async () => results() });
    if (result.status === "ok") expect(result.result.results[0]?.verdict).toBe("refuted");
  });

  it("uncertain gdy source_index null", async () => {
    const generate = vi.fn(async () => judge("uncertain", null)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search: async () => results() });
    if (result.status === "ok") {
      expect(result.result.results[0]).toEqual({ claim: "Firma X ma 40% rynku.", verdict: "uncertain", evidence_url: "" });
    }
  });

  it("indeks spoza zakresu → uncertain (nie ufa modelowi)", async () => {
    const generate = vi.fn(async () => judge("confirmed", 7)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search: async () => results() });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.result.results[0]?.verdict).toBe("uncertain");
  });

  it("confirmed + source_index null → uncertain", async () => {
    const generate = vi.fn(async () => judge("confirmed", null)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search: async () => results() });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]).toEqual({ claim: "Firma X ma 40% rynku.", verdict: "uncertain", evidence_url: "" });
    }
  });

  it("indeks ujemny → uncertain", async () => {
    const generate = vi.fn(async () => judge("refuted", -1)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search: async () => results() });
    if (result.status === "ok") expect(result.result.results[0]?.verdict).toBe("uncertain");
  });

  it("sędzia używa modelu Lite, nie Pro z review", async () => {
    let seenModel = "";
    const generate = vi.fn(async (input: { model: string }) => {
      seenModel = input.model;
      return judge("confirmed", 0);
    }) as unknown as GenerateFn;

    await verifyExternalAtoms(ATOMS, {
      generate,
      provider: "deepseek",
      model: "gemini-3.8-flash",
      judgeModel: "gemini-3.1-flash-lite",
      search: async () => results(),
    });

    expect(seenModel).toBe("gemini-3.1-flash-lite");
  });

  it("Fetch padnie przy pustych summary → uncertain bez wołania sędziego", async () => {
    let judgeCalled = false;
    const generate = vi.fn(async () => {
      judgeCalled = true;
      return judge("confirmed", 0);
    }) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, {
      generate,
      provider: "deepseek",
      search: async () => results("").map((r) => ({ ...r, snippet: "" })),
      fetchPage: async () => {
        throw new Error("fetch failed");
      },
    });

    expect(judgeCalled).toBe(false);
    if (result.status === "ok") expect(result.result.results[0]?.verdict).toBe("uncertain");
  });

  it("cap atomów: nadmiar → uncertain bez wyszukiwania", async () => {
    const atoms: R2Atom[] = [
      { text: "Fakt pierwszy o rynku.", type: "external", evidence: "" },
      { text: "Fakt drugi o rynku.", type: "external", evidence: "" },
      { text: "Fakt trzeci o rynku.", type: "external", evidence: "" },
    ];
    const search = vi.fn(async () => results());
    const generate = vi.fn(async () => JSON.stringify({ results: [{ claim: "x", verdict: "uncertain", source_index: null }] })) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(atoms, { generate, provider: "deepseek", search, maxAtoms: 2 });

    expect(search).toHaveBeenCalledTimes(2);
    if (result.status === "ok") {
      expect(result.result.results).toHaveLength(3);
      expect(result.result.results[2]?.verdict).toBe("uncertain");
    }
  });

  it("search DeepSeek pada → SERP fallback", async () => {
    const serp = vi.fn(async () => results());
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;
    const search = vi.fn(async () => {
      throw new Error("402");
    });

    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search, serp });
    expect(serp).toHaveBeenCalled();
    expect(result.status).toBe("ok");
  });

  it("search + SERP padają → error (draft)", async () => {
    const search = vi.fn(async () => {
      throw new Error("402");
    });
    const serp = vi.fn(async () => {
      throw new Error("SERP down");
    });
    const result = await verifyExternalAtoms(ATOMS, { generate: async () => "{}", provider: "deepseek", search, serp });
    expect(result.status).toBe("error");
  });

  it("puste summary → Fetch strony, treść trafia do sędziego", async () => {
    let prompt = "";
    const generate = vi.fn(async (input: { prompt: string }) => {
      prompt = input.prompt;
      return judge("confirmed", 0);
    }) as unknown as GenerateFn;
    const fetchPage = vi.fn(async () => "Treść strony potwierdza 40% udziału firmy X.");

    const result = await verifyExternalAtoms(ATOMS, {
      generate,
      provider: "deepseek",
      search: async () => results("").map((result) => ({ ...result, snippet: "" })),
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledWith("https://example.com/raport");
    expect(prompt).toContain("Treść strony potwierdza");
    expect(result.status).toBe("ok");
  });
});
