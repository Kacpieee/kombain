import { describe, expect, it, vi } from "vitest";
import { MAX_RESEARCH_FACTS, normalizeFacts, researchTopic } from "./research.js";
import type { GenerateFn } from "./llm.js";

describe("normalizeFacts", () => {
  it("odrzuca nie-http URL, krótkie claimy i duplikaty", () => {
    const facts = normalizeFacts([
      { claim: "To jest poprawny fakt o rynku.", url: "https://example.com/a", source_type: "press" },
      { claim: "To jest poprawny fakt o rynku.", url: "https://duplikat.example/b", source_type: "blog" },
      { claim: "Krótki", url: "https://example.com/c", source_type: "other" },
      { claim: "Fakt zły URL.", url: "ftp://example.com/d", source_type: "other" },
    ]);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ claim: "To jest poprawny fakt o rynku.", url: "https://example.com/a" });
  });

  it("obcina do limitu", () => {
    const input = Array.from({ length: 15 }, (_, i) => ({
      claim: `Fakt numer ${i} o technologii AgTech.`,
      url: `https://example.com/${i}`,
      source_type: "press",
    }));
    expect(normalizeFacts(input)).toHaveLength(MAX_RESEARCH_FACTS);
  });
});

describe("researchTopic", () => {
  const input = { title: "Drony RTK", text: "Treść źródłowa", category: "Inteligentne Maszyny i Drony" as const };

  it("woła model z search:true i zwraca fakty", async () => {
    let seen: { search?: boolean; model: string; prompt: string } | null = null;
    const generate: GenerateFn = async ({ search, model, prompt }) => {
      seen = { search, model, prompt };
      return JSON.stringify({
        facts: [{ claim: "Rynek dronów rolniczych wzrósł o 20% w 2025.", url: "https://example.com/raport", source_type: "research" }],
      });
    };

    const result = await researchTopic(input, { generate });

    expect(seen!.search).toBe(true);
    expect(seen!.prompt).toContain("Drony RTK");
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.facts).toHaveLength(1);
  });

  it("błąd modelu → error (pipeline leci dalej bez briefu)", async () => {
    const generate: GenerateFn = async () => {
      throw new Error("429");
    };
    const result = await researchTopic(input, { generate });
    expect(result.status).toBe("error");
  });

  it("niepoprawny JSON → error", async () => {
    const generate: GenerateFn = async () => "brak json";
    const result = await researchTopic(input, { generate });
    expect(result.status).toBe("error");
  });
});
