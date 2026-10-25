import { R3Schema, buildR3Prompt } from "../prompts.js";
import type { R2Atom, R3Result } from "../prompts.js";
import { DEFAULT_EDITOR_MODEL, formatLlmError } from "./llm.js";
import type { GenerateFn } from "./llm.js";
import { parseSynthesisJson } from "./ingestion.js";

export const R3_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    results: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          claim: { type: "STRING" },
          verdict: { type: "STRING", enum: ["confirmed", "refuted", "uncertain"] },
          evidence_url: { type: "STRING" },
        },
        required: ["claim", "verdict", "evidence_url"],
      },
    },
  },
  required: ["results"],
} as const;

export interface FactcheckDeps {
  generate: GenerateFn;
  model?: string;
}

export type FactcheckOutcome = { status: "ok"; result: R3Result } | { status: "error"; error: string };

/** R3: verify wyłącznie atomów `external`, z search grounding (Dokumentacja §4 + AGENTS §2.7). */
export async function verifyExternalAtoms(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  if (atoms.length === 0) return { status: "ok", result: { results: [] } };

  try {
    const raw = await deps.generate({
      model: deps.model ?? process.env.GEMINI_PRO_MODEL ?? DEFAULT_EDITOR_MODEL,
      prompt: buildR3Prompt(atoms),
      responseSchema: R3_RESPONSE_SCHEMA,
      search: true,
    });
    return { status: "ok", result: R3Schema.parse(parseSynthesisJson(raw)) };
  } catch (error) {
    return { status: "error", error: formatLlmError(error, "R3") };
  }
}
