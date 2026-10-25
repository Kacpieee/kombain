import { describe, expect, it } from "vitest";
import { CATEGORIES, GatekeeperSchema, buildGatekeeperPrompt } from "../prompts.js";
import { GATEKEEPER_RESPONSE_SCHEMA, classifyArticle, validateGate, type GenerateFn } from "./llm.js";

const ARTICLE = {
  title: "Drony RTK w sadownictwie",
  text: "Artykuł o autonomicznych dronach opryskujących sady z dokładnością RTK.",
  sourceUrl: "https://example.com/drony-rtk",
};

const HISTORY = [
  { title: "Autonomiczny ciągnik X", tech_summary: { podmiot: "Firma X", technologia: "autonomia", cel_wdrozenia: "mniej paliwa" } },
];

function generateReturning(raw: string): { fn: GenerateFn; calls: Array<{ model: string; prompt: string }> } {
  const calls: Array<{ model: string; prompt: string }> = [];
  const fn: GenerateFn = async ({ model, prompt }) => {
    calls.push({ model, prompt });
    return raw;
  };
  return { fn, calls };
}

const validDecision = {
  is_duplicate: false,
  is_relevant: true,
  reason: "Twardy AgTech: autonomiczne drony.",
  category: "Inteligentne Maszyny i Drony",
};

describe("GatekeeperSchema", () => {
  it("akceptuje poprawną decyzję", () => {
    expect(GatekeeperSchema.parse(validDecision)).toMatchObject({ category: "Inteligentne Maszyny i Drony" });
  });

  it("odrzuca kategorię spoza enuma 6 działów", () => {
    expect(() => GatekeeperSchema.parse({ ...validDecision, category: "AI i automatyzacja" })).toThrow();
    expect(() => GatekeeperSchema.parse({ ...validDecision, category: "Rolnictwo" })).toThrow();
  });

  it("wymaga wszystkich czterech pól", () => {
    expect(() => GatekeeperSchema.parse({ is_duplicate: false, is_relevant: true })).toThrow();
  });

  it("responseSchema dla Gemini ma dokładnie 6 kategorii i wszystkie pola wymagane", () => {
    const schema = GATEKEEPER_RESPONSE_SCHEMA as unknown as {
      properties: { category: { enum: readonly string[] } };
      required: readonly string[];
    };
    expect(schema.properties.category.enum).toEqual([...CATEGORIES]);
    expect(schema.required).toEqual(["is_duplicate", "is_relevant", "reason", "category"]);
  });
});

describe("buildGatekeeperPrompt", () => {
  it("zawiera tytuł, treść, historię 30 dni i URL — bez PocketBase", () => {
    const prompt = buildGatekeeperPrompt({ ...ARTICLE, history: HISTORY });

    expect(prompt).toContain("Drony RTK w sadownictwie");
    expect(prompt).toContain("https://example.com/drony-rtk");
    expect(prompt).toContain("Autonomiczny ciągnik X");
    expect(prompt).toContain("30 dni");
    expect(prompt).not.toMatch(/pocketbase/i);
    for (const category of CATEGORIES) expect(prompt).toContain(category);
  });

  it("pusta historia ma jawny komunikat zamiast pustej sekcji", () => {
    const prompt = buildGatekeeperPrompt({ ...ARTICLE, history: [] });
    expect(prompt).toMatch(/brak opublikowanych/i);
  });
});

describe("classifyArticle", () => {
  it("akceptuje twardy AgTech i zwraca decyzję", async () => {
    const { fn, calls } = generateReturning(JSON.stringify(validDecision));
    const result = await classifyArticle({ ...ARTICLE, history: HISTORY }, { generate: fn, model: "test-model" });

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") expect(result.decision.category).toBe("Inteligentne Maszyny i Drony");
    expect(calls[0]?.model).toBe("test-model");
    expect(calls[0]?.prompt).toContain("Drony RTK w sadownictwie");
  });

  it("is_duplicate=true → rejected z powodem z modelu", async () => {
    const { fn } = generateReturning(
      JSON.stringify({ ...validDecision, is_duplicate: true, reason: "Ten sam podmiot i technologia co wpis z 12.10" })
    );
    const result = await classifyArticle({ ...ARTICLE, history: HISTORY }, { generate: fn });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toContain("Ten sam podmiot");
  });

  it("is_relevant=false → rejected (nie error)", async () => {
    const { fn } = generateReturning(
      JSON.stringify({ ...validDecision, is_relevant: false, reason: "Ceny płodów rolnych" })
    );
    const result = await classifyArticle({ ...ARTICLE, history: [] }, { generate: fn });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("Ceny płodów rolnych");
  });

  it("JSON w fence jest akceptowany", async () => {
    const { fn } = generateReturning("```json\n" + JSON.stringify(validDecision) + "\n```");
    await expect(classifyArticle({ ...ARTICLE, history: [] }, { generate: fn })).resolves.toMatchObject({
      status: "accepted",
    });
  });

  it("kategoria spoza enuma → error (blokada persist), nie accepted", async () => {
    const { fn } = generateReturning(JSON.stringify({ ...validDecision, category: "AI i automatyzacja" }));
    const result = await classifyArticle({ ...ARTICLE, history: [] }, { generate: fn });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toMatch(/kategor|walidac/i);
  });

  it("nieparsowalna odpowiedź → error", async () => {
    const { fn } = generateReturning("Przepraszam, nie potrafię.");
    const result = await classifyArticle({ ...ARTICLE, history: [] }, { generate: fn });

    expect(result.status).toBe("error");
  });

  it("błąd modelu → error z komunikatem, bez wyjątku", async () => {
    const fn: GenerateFn = async () => {
      throw new Error("429 quota exceeded");
    };
    const result = await classifyArticle({ ...ARTICLE, history: [] }, { generate: fn });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("429");
  });

  it("brak klucza API → error, nie wyjątek", async () => {
    const result = await classifyArticle({ ...ARTICLE, history: [] }, { apiKey: "" });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("GEMINI_API_KEY");
  });

  it("dodatkowe pola od modelu nie wywalają walidacji", async () => {
    const { fn } = generateReturning(JSON.stringify({ ...validDecision, confidence: 0.9 }));
    await expect(classifyArticle({ ...ARTICLE, history: [] }, { generate: fn })).resolves.toMatchObject({
      status: "accepted",
    });
  });

  it("validateGate zostaje jako strażnik typów", () => {
    expect(validateGate(validDecision).category).toBe("Inteligentne Maszyny i Drony");
  });
});
