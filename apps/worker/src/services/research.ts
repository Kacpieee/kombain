import { ResearchSchema, buildResearchPrompt } from "../prompts.js";
import type { ResearchFact, ResearchInput } from "../prompts.js";
import { DEFAULT_EDITOR_MODEL, createGenerator, formatLlmError } from "./llm.js";
import type { GenerateFn } from "./llm.js";
import { parseSynthesisJson } from "./ingestion.js";

export const MAX_RESEARCH_FACTS = 10;

export const RESEARCH_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    facts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          claim: { type: "STRING" },
          url: { type: "STRING" },
          source_type: { type: "STRING" },
        },
        required: ["claim", "url", "source_type"],
      },
    },
  },
  required: ["facts"],
} as const;

export interface ResearchDeps {
  generate?: GenerateFn;
  model?: string;
}

export type ResearchOutcome = { status: "ok"; facts: ResearchFact[] } | { status: "error"; error: string };

/** Research przed Redaktorem (Gemini Pro + search grounding). Szeroki zasięg źródeł, twardy filtr URL. */
export async function researchTopic(input: ResearchInput, deps: ResearchDeps = {}): Promise<ResearchOutcome> {
  const generate = deps.generate ?? createGenerator();
  const model = deps.model ?? process.env.GEMINI_PRO_MODEL ?? DEFAULT_EDITOR_MODEL;

  try {
    const raw = await generate({
      model,
      prompt: buildResearchPrompt(input),
      responseSchema: RESEARCH_RESPONSE_SCHEMA,
      search: true,
    });
    return { status: "ok", facts: normalizeFacts(ResearchSchema.parse(parseSynthesisJson(raw)).facts) };
  } catch (error) {
    return { status: "error", error: formatLlmError(error, "Research") };
  }
}

export function normalizeFacts(facts: ResearchFact[]): ResearchFact[] {
  const seen = new Set<string>();
  const result: ResearchFact[] = [];

  for (const fact of facts) {
    const claim = fact.claim.trim().replace(/\s+/g, " ");
    const url = fact.url.trim();
    if (claim.length < 10 || !/^https?:\/\//i.test(url)) continue;

    const key = claim.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push({ claim, url, source_type: fact.source_type.trim() || "other" });
    if (result.length >= MAX_RESEARCH_FACTS) break;
  }

  return result;
}
