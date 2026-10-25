import { describe, expect, it } from "vitest";
import type { R2Atom } from "../prompts.js";
import { verifyExternalAtoms } from "./factcheck.js";
import type { GenerateFn } from "./llm.js";

const ATOMS: R2Atom[] = [{ text: "Firma X ma 40% rynku.", type: "external", evidence: "" }];

describe("verifyExternalAtoms (R3)", () => {
  it("pusta lista nie woła modelu", async () => {
    let called = false;
    const generate: GenerateFn = async () => {
      called = true;
      return "{}";
    };

    const result = await verifyExternalAtoms([], { generate });
    expect(called).toBe(false);
    expect(result).toEqual({ status: "ok", result: { results: [] } });
  });

  it("woła model z search grounding i domyślnym modelem 3.8", async () => {
    let seen: { model: string; search?: boolean; prompt: string } | null = null;
    const generate: GenerateFn = async ({ model, prompt, search }) => {
      seen = { model, prompt, search };
      return JSON.stringify({
        results: [{ claim: "Firma X ma 40% rynku.", verdict: "confirmed", evidence_url: "https://e.com/a" }],
      });
    };

    const result = await verifyExternalAtoms(ATOMS, { generate });

    expect(seen!.search).toBe(true);
    expect(seen!.model).toContain("flash");
    expect(seen!.prompt).toContain("Firma X ma 40% rynku.");
    expect(result.status).toBe("ok");
  });

  it("werdykt spoza enuma → error (Zod)", async () => {
    const generate: GenerateFn = async () =>
      JSON.stringify({ results: [{ claim: "x", verdict: "maybe", evidence_url: "" }] });

    const result = await verifyExternalAtoms(ATOMS, { generate });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toMatch(/Walidacja odpowiedzi R3/);
  });

  it("błąd modelu → error, nie wyjątek", async () => {
    const generate: GenerateFn = async () => {
      throw new Error("500 upstream");
    };

    const result = await verifyExternalAtoms(ATOMS, { generate });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("500");
  });
});
