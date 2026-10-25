import type { Schema } from "@google/genai";
import { ZodError } from "zod";
import { CATEGORIES, EditorSchema, GatekeeperSchema, buildEditorPrompt, buildGatekeeperPrompt } from "../prompts.js";
import type {
  EditorOut,
  EditorPromptInput,
  GatekeeperDecision,
  GatekeeperPromptInput,
} from "../prompts.js";
import { parseSynthesisJson } from "./ingestion.js";
import { slugify } from "./ingestion.js";

export const DEFAULT_GATEKEEPER_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_EDITOR_MODEL = "gemini-3.8-flash";

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

export type GenerateFn = (input: {
  model: string;
  prompt: string;
  responseSchema?: unknown;
  search?: boolean;
}) => Promise<string>;

export interface GatekeeperDeps {
  generate?: GenerateFn;
  model?: string;
  apiKey?: string;
}

export interface EditorDeps {
  generate?: GenerateFn;
  model?: string;
  apiKey?: string;
}

export type EditorOutcome = { status: "ok"; article: EditorOut } | { status: "error"; error: string };

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
    return { status: "error", error: formatLlmError(error) };
  }
}

export const EDITOR_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    content_html: { type: "STRING" },
    tldr: { type: "ARRAY", items: { type: "STRING" } },
    tags: { type: "ARRAY", items: { type: "STRING" } },
    tech_summary: {
      type: "OBJECT",
      properties: {
        podmiot: { type: "STRING" },
        technologia: { type: "STRING" },
        cel_wdrozenia: { type: "STRING" },
      },
      required: ["podmiot", "technologia", "cel_wdrozenia"],
    },
    slug: { type: "STRING" },
    external_refs: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          claim: { type: "STRING" },
          type: { type: "STRING", enum: ["external", "supported"] },
          source: { type: "STRING" },
        },
        required: ["claim", "type", "source"],
      },
    },
  },
  required: ["title", "content_html", "tldr", "tags", "tech_summary", "slug", "external_refs"],
} as const;

/** Redaktor (Dokumentacja §4 KROK 4): 1 szablon × persona działu, walidacja Zod, normalizacja metadanych. */
export async function synthesizeArticle(input: EditorPromptInput, deps: EditorDeps = {}): Promise<EditorOutcome> {
  const apiKey = deps.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = deps.model ?? process.env.GEMINI_PRO_MODEL ?? DEFAULT_EDITOR_MODEL;
  const generate = deps.generate ?? defaultGenerate(apiKey);

  try {
    const raw = await generate({
      model,
      prompt: buildEditorPrompt(input),
      responseSchema: EDITOR_RESPONSE_SCHEMA,
    });
    const parsed = EditorSchema.parse(parseSynthesisJson(raw));
    return { status: "ok", article: EditorSchema.parse(normalizeEditorOutput(parsed)) };
  } catch (error) {
    return { status: "error", error: formatLlmError(error) };
  }
}

function normalizeEditorOutput(article: EditorOut): EditorOut {
  const tags = [...new Set(article.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 4);
  const title = article.title.trim();
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) ? article.slug : slugify(title);

  return {
    ...article,
    title,
    slug,
    tags,
    tldr: article.tldr.map((item) => item.trim()).filter(Boolean),
    tech_summary: {
      podmiot: article.tech_summary.podmiot.trim(),
      technologia: article.tech_summary.technologia.trim(),
      cel_wdrozenia: article.tech_summary.cel_wdrozenia.trim(),
    },
    external_refs: article.external_refs
      .map((ref) => ({ claim: ref.claim.trim(), type: ref.type, source: ref.source.trim() }))
      .filter((ref) => ref.claim.length > 0),
  };
}

function defaultGenerate(apiKey: string): GenerateFn {
  return async ({ model, prompt, responseSchema, search }) => {
    if (!apiKey) throw new Error("Brak GEMINI_API_KEY");

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema as Schema | undefined,
        temperature: 0,
        ...(search ? { tools: [{ googleSearch: {} }] } : {}),
      },
    });

    const text = response.text;
    if (!text) throw new Error("Pusta odpowiedź modelu (brak text)");
    return text;
  };
}

export function createGenerator(apiKey: string = process.env.GEMINI_API_KEY ?? ""): GenerateFn {
  return defaultGenerate(apiKey);
}

export function formatLlmError(error: unknown, label = "Bramkarza"): string {
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    return `Walidacja odpowiedzi ${label}: ${issues}`;
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
