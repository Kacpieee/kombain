import { describe, expect, it, vi } from "vitest";
import type { R2Atom } from "../prompts.js";
import { buildClaimQuery, extractClaimEntities, isRelevantEvidence, verifyExternalAtoms } from "./factcheck.js";
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

describe("buildClaimQuery / isRelevantEvidence", () => {
  it("wyciąga encje, liczby i rok, cięcie na granicy słowa", () => {
    const claim =
      'Raport „Unlocking Investment in U.S. Aquaculture” zrealizowany dzięki NOAA, USDA (NIFA) oraz EDA w 2021 roku akcentuje potrzebę kapitału katalitycznego i cierpliwego finansowania.';
    const query = buildClaimQuery(claim);

    expect(query.length).toBeLessThanOrEqual(128);
    expect(query).toMatch(/Aquaculture|NOAA|USDA|EDA|2021/);
    expect(query.endsWith(" ")).toBe(false);
  });

  it("dowód z liczbą z claimu jest trafny", () => {
    expect(
      isRelevantEvidence("Firma X ma 40% rynku.", {
        title: "Raport",
        url: "https://e.com",
        summary: "Udział firmy X to 40% w 2025 roku.",
        authority: 3,
      })
    ).toBe(true);
  });

  it("dowód bez encji i bez wspólnych słów nie jest trafny", () => {
    expect(
      isRelevantEvidence("Firma X ma 40% rynku.", {
        title: "Pogoda",
        url: "https://e.com",
        summary: "Prognoza opadów na jutro.",
        authority: 1,
      })
    ).toBe(false);
  });

  it("jedna pospolita nazwa własna nie wystarcza (brak fałszywego confirmed)", () => {
    expect(
      isRelevantEvidence("Raport pokazuje wzrost sprzedaży ciągników w Europie.", {
        title: "Pogoda w Europie",
        url: "https://weather.example",
        summary: "Jutro słońce, bez opadów.",
        authority: 3,
      })
    ).toBe(false);
  });

  it("pierwszy wyraz po kropce też nie jest nazwą własną", () => {
    expect(
      isRelevantEvidence("Inwestycje w OZE rosną. Ponadto Europa zwiększa wydatki.", {
        title: "Ponadto Europa: susza i upały",
        url: "https://weather.example",
        summary: "Prognoza pogody.",
        authority: 3,
      })
    ).toBe(false);
  });

  it("pojedynczy akronim organizacji jest trafny (recall NIFA)", () => {
    expect(
      isRelevantEvidence("Z raportu NIFA wynika wzrost akwakultury.", {
        title: "NIFA report",
        url: "https://nifa.example",
        summary: "Funding opportunities.",
        authority: 3,
      })
    ).toBe(true);
  });

  it("odmiana polskich słów liczona po rdzeniu", () => {
    expect(
      isRelevantEvidence("Inwestycje w akwakulturę rosną.", {
        title: "Inwestycja w akwakulturze",
        url: "https://e.com",
        summary: "Nowe źródła finansowania.",
        authority: 3,
      })
    ).toBe(true);
  });

  it("query zawiera wszystkie encje z claimu (NOAA/USDA/EDA/2021)", () => {
    const claim =
      'Raport „Unlocking Investment in U.S. Aquaculture: Barriers, Opportunities and Pathways Forward” zrealizowany dzięki NOAA, USDA (NIFA) oraz EDA w 2021 roku.';
    const query = buildClaimQuery(claim);

    for (const entity of ["NOAA", "USDA", "EDA", "2021"]) expect(query).toContain(entity);
    expect(query.length).toBeLessThanOrEqual(128);
  });

  it("akronim na początku zdania jest encją (NOAA)", () => {
    const entities = extractClaimEntities("NOAA finansuje infrastrukturę akwakultury.");

    expect(entities.proper).toContain("NOAA");
  });

  it("ALL-CAPS rzeczownik pospolity nie jest encją (stoplista)", () => {
    const entities = extractClaimEntities("WZROST sprzedaży dotacji w 2025 roku.", {
      includeSentenceStart: true,
    });

    expect(entities.proper).not.toContain("WZROST");
    expect(entities.numeric).toContain("2025");
  });

  it("includeSentenceStart widzi nazwę własną na początku, default nie", () => {
    expect(extractClaimEntities("Kanada importuje owoce morza.").proper).not.toContain("Kanada");
    expect(
      extractClaimEntities("Kanada importuje owoce morza.", { includeSentenceStart: true }).proper
    ).toContain("Kanada");
  });

  it("POLSKA nie jest stoplistowana (nazwa geograficzna)", () => {
    expect(
      extractClaimEntities("POLSKA eksportuje zboże.", { includeSentenceStart: true }).proper
    ).toContain("POLSKA");
  });
});

describe("verifyExternalAtoms — relevance gate i statystyki", () => {
  it("nietrafny DeepSeek → SERP po trafny dowód", async () => {
    const search = vi.fn(async () => [
      { ...results()[0]!, title: "Pogoda", summary: "Prognoza opadów.", site_name: "weather.example" },
    ]);
    const serp = vi.fn(async () => results());
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search, serp });

    expect(serp).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("confirmed");
      expect(result.stats?.serp).toBe(1);
      expect(result.stats?.confirmed).toBe(1);
    }
  });

  it("stats: searches/fetches/confirmed", async () => {
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, {
      generate,
      provider: "deepseek",
      search: async () => results(),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.stats).toMatchObject({ searches: 1, fetches: 0, confirmed: 1, serp: 0 });
    }
  });

  it("search dostaje zapytanie z encjami (nie surowy claim)", async () => {
    const atom: R2Atom = {
      text: 'Raport „Aquaculture outlook” zrealizowany dzięki NOAA, USDA (NIFA) oraz EDA w 2021 roku.',
      type: "external",
      evidence: "",
    };
    const search = vi.fn(async (_query: string) => results());
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    await verifyExternalAtoms([atom], { generate, provider: "deepseek", search });

    const query = search.mock.calls[0]?.[0] ?? "";
    for (const entity of ["NOAA", "USDA", "EDA", "2021"]) expect(query).toContain(entity);
    expect(query.length).toBeLessThanOrEqual(128);
  });

  it("wiring: search dostaje buildClaimQuery, nie slice(0,128) claimu", async () => {
    const padding = Array.from({ length: 20 }, (_, i) => `slowo${i}`).join(" ");
    const longClaim = `Analiza ${padding} NOAA 2021 akwakultura.`;
    expect(longClaim.length).toBeGreaterThan(128);
    expect(longClaim.indexOf("NOAA")).toBeGreaterThan(128);

    const atom: R2Atom = { text: longClaim, type: "external", evidence: "" };
    const search = vi.fn(async (_query: string) => results());
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    await verifyExternalAtoms([atom], { generate, provider: "deepseek", search });

    const query = search.mock.calls[0]?.[0] ?? "";
    expect(search).toHaveBeenCalledWith(buildClaimQuery(longClaim));
    expect(query).not.toBe(longClaim.slice(0, 128));
    expect(query).toContain("NOAA");
    expect(query).toContain("2021");
  });

  it("B2: liczby z cytatu nie są dublowane w query", () => {
    const claim = 'Raport „wzrost o 40% w 2021 roku” potwierdza trend.';
    const query = buildClaimQuery(claim);

    expect(query.match(/40%/g)).toHaveLength(1);
    expect(query.match(/2021/g)).toHaveLength(1);
  });
});

describe("verifyExternalAtoms — gemini (rollback)", () => {
  it("pusta lista nie woła modelu", async () => {
    let called = false;
    const generate: GenerateFn = async () => {
      called = true;
      return "{}";
    };
    const result = await verifyExternalAtoms([], { generate, provider: "gemini" });
    expect(called).toBe(false);
    expect(result).toMatchObject({ status: "ok", result: { results: [] } });
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
        reason: "confirmed",
      });
    }
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("refuted z indeksem → evidence_url z wyniku", async () => {
    const generate = vi.fn(async () => judge("refuted", 0)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search: async () => results() });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("refuted");
      expect(result.stats?.refuted).toBe(1);
    }
  });

  it("uncertain gdy source_index null", async () => {
    const generate = vi.fn(async () => judge("uncertain", null)) as unknown as GenerateFn;
    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search: async () => results() });
    if (result.status === "ok") {
      expect(result.result.results[0]).toEqual({
        claim: "Firma X ma 40% rynku.",
        verdict: "uncertain",
        evidence_url: "",
        reason: "judge_uncertain",
      });
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
      expect(result.result.results[0]).toEqual({
        claim: "Firma X ma 40% rynku.",
        verdict: "uncertain",
        evidence_url: "",
        reason: "judge_uncertain",
      });
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

  it("Fetch padnie przy pustych summary → SERP ratuje dowód", async () => {
    let judgeCalled = false;
    const generate = vi.fn(async () => {
      judgeCalled = true;
      return judge("confirmed", 0);
    }) as unknown as GenerateFn;
    const serp = vi.fn(async () => results());

    const result = await verifyExternalAtoms(ATOMS, {
      generate,
      provider: "deepseek",
      search: async () => results("").map((r) => ({ ...r, snippet: "" })),
      serp,
      fetchPage: async () => {
        throw new Error("fetch failed");
      },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("confirmed");
      expect(result.stats?.confirmed).toBe(1);
      expect(result.stats?.fetches).toBe(0);
      expect(result.stats?.serp).toBe(1);
    }
    expect(judgeCalled).toBe(true);
    expect(serp).toHaveBeenCalledTimes(1);
  });

  it("VERIFY_MAX_ATOMS=\"1\" tnie do jednego atomu", async () => {
    vi.stubEnv("VERIFY_MAX_ATOMS", "1");
    try {
      const atoms: R2Atom[] = Array.from({ length: 3 }, (_, index) => ({
        text: `Fakt ${index + 1}: 40% rynku.`,
        type: "external" as const,
        evidence: "",
      }));
      const search = vi.fn(async (_query: string) => results());
      const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

      const result = await verifyExternalAtoms(atoms, { generate, provider: "deepseek", search });

      expect(search).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.stats?.confirmed).toBe(1);
        expect(result.stats?.uncertain).toBe(2);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pusty raw[0] → używa trafnego raw[1], source_index mapuje na relevant[0]", async () => {
    const search = vi.fn(async () => [
      { ...results()[0]!, url: "https://empty.example", summary: "", snippet: "", authority: 5 },
      { ...results()[0]!, url: "https://second.example", summary: "Raport potwierdza 40% udziału firmy X.", authority: 1 },
    ]);
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, {
      generate,
      provider: "deepseek",
      search,
      fetchPage: async () => {
        throw new Error("fetch failed");
      },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]).toEqual({
        claim: "Firma X ma 40% rynku.",
        verdict: "confirmed",
        evidence_url: "https://second.example",
        reason: "confirmed",
      });
    }
  });

  it("cap atomów: nadmiar → uncertain bez wyszukiwania", async () => {
    const atoms: R2Atom[] = [
      { text: "Fakt pierwszy: 40% rynku.", type: "external", evidence: "" },
      { text: "Fakt drugi: 40% rynku.", type: "external", evidence: "" },
      { text: "Fakt trzeci: 40% rynku.", type: "external", evidence: "" },
    ];
    const search = vi.fn(async () => results());
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(atoms, { generate, provider: "deepseek", search, maxAtoms: 2 });

    expect(search).toHaveBeenCalledTimes(2);
    if (result.status === "ok") {
      expect(result.result.results).toHaveLength(3);
      expect(result.result.results[2]?.verdict).toBe("uncertain");
      expect(result.result.results[2]?.reason).toBe("max_atoms_cap");
      expect(result.stats?.confirmed).toBe(2);
      expect(result.stats?.uncertain).toBe(1);
    }
  });

  it("VERIFY_MAX_ATOMS=\"\" nie ucina atomów (fallback 8)", async () => {
    vi.stubEnv("VERIFY_MAX_ATOMS", "");
    try {
      const atoms: R2Atom[] = Array.from({ length: 3 }, (_, index) => ({
        text: `Fakt ${index + 1}: 40% rynku.`,
        type: "external" as const,
        evidence: "",
      }));
      const search = vi.fn(async () => results());
      const generate = vi.fn(async () => judge("uncertain", null)) as unknown as GenerateFn;

      const result = await verifyExternalAtoms(atoms, { generate, provider: "deepseek", search });

      expect(search).toHaveBeenCalledTimes(3);
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.stats?.uncertain).toBe(3);
    } finally {
      vi.unstubAllEnvs();
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
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("confirmed");
      expect(result.stats?.confirmed).toBe(1);
      expect(result.stats?.serp).toBe(1);
    }
  });

  it("SERP zwraca nietrafne dowody → uncertain + stats", async () => {
    const search = vi.fn(async () => [
      { ...results()[0]!, title: "Pogoda", summary: "Prognoza opadów.", site_name: "weather.example" },
    ]);
    const serp = vi.fn(async () => [
      { ...results()[0]!, title: "Sport", summary: "Wyniki meczu.", site_name: "sport.example" },
    ]);
    let judgeCalled = false;
    const generate = vi.fn(async () => {
      judgeCalled = true;
      return judge("confirmed", 0);
    }) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search, serp });

    expect(judgeCalled).toBe(false);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("uncertain");
      expect(result.result.results[0]?.reason).toBe("no_evidence");
      expect(result.stats?.uncertain).toBe(1);
      expect(result.stats?.serp).toBe(1);
    }
  });

  it("SERP z pustym summary → Fetch przed sędzią", async () => {
    const search = vi.fn(async () => [] as SearchResult[]);
    const serp = vi.fn(async () => [
      {
        ...results()[0]!,
        url: "https://serp.example/a",
        title: "Firma X",
        summary: "",
        snippet: "",
      },
    ]);
    const fetchPage = vi.fn(async () => "Firma X ma 40% rynku.");
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search, serp, fetchPage });

    expect(fetchPage).toHaveBeenCalledWith("https://serp.example/a");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("confirmed");
      expect(result.stats?.fetches).toBe(1);
    }
  });

  it("SERP z pustym summary i nieudanym Fetch → uncertain, bez sędziego", async () => {
    const search = vi.fn(async () => [] as SearchResult[]);
    const serp = vi.fn(async () => [
      { ...results()[0]!, url: "https://serp.example/b", title: "Firma X", summary: "", snippet: "" },
    ]);
    let judgeCalled = false;
    const generate = vi.fn(async () => {
      judgeCalled = true;
      return judge("confirmed", 0);
    }) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, {
      generate,
      provider: "deepseek",
      search,
      serp,
      fetchPage: async () => {
        throw new Error("fetch failed");
      },
    });

    expect(judgeCalled).toBe(false);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("uncertain");
      expect(result.stats?.uncertain).toBe(1);
    }
  });

  it("primary search pada + SERP nietrafny → uncertain z reason search_error (bez naprawy)", async () => {
    const search = vi.fn(async () => {
      throw new Error("402");
    });
    const serp = vi.fn(async () => [
      { ...results()[0]!, title: "Sport", summary: "Wyniki meczu.", site_name: "sport.example" },
    ]);
    const generate = vi.fn(async () => judge("confirmed", 0)) as unknown as GenerateFn;

    const result = await verifyExternalAtoms(ATOMS, { generate, provider: "deepseek", search, serp });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("uncertain");
      expect(result.result.results[0]?.reason).toBe("search_error");
      expect(result.stats?.serp).toBe(1);
    }
  });

  it("search + SERP padają → error search_error z częściowymi stats", async () => {
    const search = vi.fn(async () => {
      throw new Error("402");
    });
    const serp = vi.fn(async () => {
      throw new Error("SERP down");
    });
    const result = await verifyExternalAtoms(ATOMS, { generate: async () => "{}", provider: "deepseek", search, serp });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.code).toBe("search_error");
      expect(result.stats?.searches).toBe(1);
    }
  });

  it("błąd sędziego → error llm_error z częściowymi stats", async () => {
    const result = await verifyExternalAtoms(ATOMS, {
      generate: async () => {
        throw new Error("429");
      },
      provider: "deepseek",
      search: async () => results(),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.code).toBe("llm_error");
      expect(result.stats?.searches).toBe(1);
    }
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
    if (result.status === "ok") {
      expect(result.result.results[0]?.verdict).toBe("confirmed");
      expect(result.stats?.fetches).toBe(1);
      expect(result.stats?.confirmed).toBe(1);
    }
  });
});
