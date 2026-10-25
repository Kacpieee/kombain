import type { Schema } from "@google/genai";
import { ZodError } from "zod";
import { CATEGORIES, EditorSchema, GatekeeperSchema, buildGatekeeperPrompt } from "../prompts.js";
import type { EditorOut, GatekeeperDecision, GatekeeperPromptInput } from "../prompts.js";
import { parseSynthesisJson } from "./ingestion.js";

export const DEFAULT_GATEKEEPER_MODEL = "gemini-3.1-flash-lite";

/** JSON Schema dla Gemini Structured Outputs — 1:1 z GatekeeperSchema (Zod waliduje odpowiedź). */
export const GATEKEEPER_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_duplicate: {
      type: "BOOLEAN",
      description: "True, jeśli ten sam podmiot i technologia istnieją w bazie wiedzy z 30 dni.",
    },
    is_relevant: {
      type: "BOOLEAN",
      description: "True tylko dla twardego AgTech (AI, IoT, autonomia, drony, robotyka, biotech, agroenergetyka).",
    },
    reason: { type: "STRING", description: "Krótkie uzasadnienie decyzji." },
    category: {
      type: "STRING",
      enum: [...CATEGORIES],
      description: "Dokładna nazwa kategorii ze sztywnej listy sześciu działów.",
    },
  },
  required: ["is_duplicate", "is_relevant", "reason", "category"],
} as const;

export type GenerateFn = (input: { model: string; prompt: string; responseSchema: unknown }) => Promise<string>;

export interface GatekeeperDeps {
  generate?: GenerateFn;
  model?: string;
  apiKey?: string;
}

export type GatekeeperOutcome =
  | { status: "accepted"; decision: GatekeeperDecision }
  | { status: "rejected"; reason: string; decision: GatekeeperDecision }
  | { status: "error"; error: string };

/**
 * Bramkarz (Dokumentacja §4 KROK 3): dedup semantyczny + hard filter + kategoria.
 * Błąd modelu lub kategoria spoza enuma = `error` (blokada persist, nie `rejected`).
 */
export async function classifyArticle(
  input: GatekeeperPromptInput,
  deps: GatekeeperDeps = {}
): Promise<GatekeeperOutcome> {
  const apiKey = deps.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = deps.model ?? process.env.GEMINI_LITE_MODEL ?? DEFAULT_GATEKEEPER_MODEL;
  const generate = deps.generate ?? defaultGenerate(apiKey);

  try {
    const raw = await generate({
      model,
      prompt: buildGatekeeperPrompt(input),
      responseSchema: GATEKEEPER_RESPONSE_SCHEMA,
    });
    const decision = GatekeeperSchema.parse(parseSynthesisJson(raw));

    if (decision.is_duplicate || !decision.is_relevant) {
      return { status: "rejected", reason: decision.reason, decision };
    }
    return { status: "accepted", decision };
  } catch (error) {
    return { status: "error", error: describeError(error) };
  }
}

function defaultGenerate(apiKey: string): GenerateFn {
  return async ({ model, prompt, responseSchema }) => {
    if (!apiKey) throw new Error("Brak GEMINI_API_KEY");

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema as Schema,
        temperature: 0,
      },
    });

    const text = response.text;
    if (!text) throw new Error("Pusta odpowiedź modelu (brak text)");
    return text;
  };
}

function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    return `Walidacja odpowiedzi Bramkarza: ${issues}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// Strażnicy typów dla calle LLM (runtime woła @google/genai; tu parsing/walidacja, testowalne bez API).
export function validateGate(raw: unknown): GatekeeperDecision {
  return GatekeeperSchema.parse(raw);
}

export function validateEditor(rawText: string): EditorOut {
  return EditorSchema.parse(parseSynthesisJson(rawText));
}
