import { GatekeeperSchema, EditorSchema } from "../prompts.js";
import type { GatekeeperDecision, EditorOut } from "../prompts.js";
import { parseSynthesisJson } from "./ingestion.js";

// Strażnik typów dla calle LLM. Runtime woła @google/genai (VPS), tu tylko parsing/walidacja (testowalne bez API).
export function validateGate(raw: unknown): GatekeeperDecision {
  return GatekeeperSchema.parse(raw);
}

export function validateEditor(rawText: string): EditorOut {
  return EditorSchema.parse(parseSynthesisJson(rawText));
}
