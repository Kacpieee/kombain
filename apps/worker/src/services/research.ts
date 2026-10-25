import { DistillSchema, ResearchSchema, buildResearchPrompt, buildDistillPrompt } from "../prompts.js";
import type { Category, DistillFact, ResearchFact, ResearchInput } from "../prompts.js";
import { DEFAULT_EDITOR_MODEL, createGenerator, formatLlmError } from "./llm.js";
import type { GenerateFn } from "./llm.js";
import { parseSynthesisJson } from "./ingestion.js";
import { deepseekSearch, serpSearch } from "./search/deepseek.js";
import type { SearchResult } from "./search/deepseek.js";

export const MAX_RESEARCH_FACTS = 10;
const MAX_RESULTS_FOR_DISTILL = 15;

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

const DISTILL_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    facts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { claim: { type: "STRING" }, source_index: { type: "INTEGER" } },
        required: ["claim", "source_index"],
      },
    },
  },
  required: ["facts"],
} as const;

export type ResearchProvider = "deepseek" | "gemini" | "off";

export interface ResearchDeps {
  generate?: GenerateFn;
  model?: string;
  provider?: ResearchProvider;
  /** Wstrzykiwane w testach. */
  search?: (query: string) => Promise<SearchResult[]>;
  serp?: (query: string) => Promise<SearchResult[]>;
}

export type ResearchOutcome = { status: "ok"; facts: ResearchFact[] } | { status: "error"; error: string };

/**
 * Research: DeepSeek Search + distylacja Flash-Lite (główna ścieżka),
 * fallback SERP (DuckDuckGo przez ScrapingAnt), a przy `gemini` — stary grounding Pro.
 */
export async function researchTopic(input: ResearchInput, deps: ResearchDeps = {}): Promise<ResearchOutcome> {
  const provider = deps.provider ?? (process.env.SEARCH_PROVIDER as ResearchProvider | undefined) ?? "deepseek";
  if (provider === "off") return { status: "ok", facts: [] };
  if (provider === "gemini") return researchWithGemini(input, deps);

  try {
    return { status: "ok", facts: await searchAndDistill(input, deps) };
  } catch (primaryError) {
    try {
      return { status: "ok", facts: await searchAndDistill(input, deps, true) };
    } catch (fallbackError) {
      return {
        status: "error",
        error: `search: ${message(primaryError)} | serp: ${message(fallbackError)}`,
      };
    }
  }
}

/** Dwie krótkie kwerendy: tytuł oraz kategoria + sygnały faktograficzne (bez treści artykułu). */
export function buildResearchQueries(input: Pick<ResearchInput, "title" | "category">): string[] {
  const title = truncate(input.title, 120);
  const second = truncate(`${categoryTerms(input.category)} raport dane`, 110);
  return [title, `${second} after:2025`].filter((query) => query.trim().length > 3);
}

export function factsFromDistill(facts: DistillFact[], results: SearchResult[]): ResearchFact[] {
  const seen = new Set<string>();
  const output: ResearchFact[] = [];

  for (const fact of facts) {
    const claim = fact.claim.trim().replace(/\s+/g, " ");
    const source = results[fact.source_index];
    if (!source || claim.length < 10) continue;
    if (!/^https?:\/\//i.test(source.url)) continue;

    const key = claim.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    output.push({
      claim,
      url: source.url,
      source_type: source.site_name ? `search:${source.site_name}` : "search",
    });
    if (output.length >= MAX_RESEARCH_FACTS) break;
  }

  return output;
}

async function searchAndDistill(input: ResearchInput, deps: ResearchDeps, useSerp = false): Promise<ResearchFact[]> {
  const searches = buildResearchQueries(input);
  const search = useSerp ? deps.serp ?? ((query: string) => serpSearch(query)) : deps.search ?? ((query: string) => deepseekSearch(query));

  const batches = await Promise.allSettled(searches.map((query) => search(query)));
  const fulfilled = batches.flatMap((batch) => (batch.status === "fulfilled" ? batch.value : []));
  if (fulfilled.length === 0) {
    const rejected = batches.find((batch) => batch.status === "rejected");
    if (rejected && rejected.status === "rejected") throw rejected.reason;
    throw new Error("brak wyników wyszukiwania");
  }

  const results = dedupeResults(fulfilled).slice(0, MAX_RESULTS_FOR_DISTILL);
  if (results.length === 0) throw new Error("brak wyników wyszukiwania");

  const generate = deps.generate ?? createGenerator();
  const model = deps.model ?? process.env.GEMINI_LITE_MODEL ?? "gemini-3.1-flash-lite";
  const raw = await generate({
    model,
    prompt: buildDistillPrompt(
      results.map((result) => ({
        title: result.title,
        url: result.url,
        summary: result.summary || result.snippet,
        site_name: result.site_name,
        authority: result.authority,
      }))
    ),
    responseSchema: DISTILL_RESPONSE_SCHEMA,
  });

  const parsed = DistillSchema.parse(parseSynthesisJson(raw));
  const facts = factsFromDistill(parsed.facts, results);
  if (facts.length === 0) throw new Error("dystylacja nie zwróciła faktów");
  return facts;
}

/** Stara ścieżka: Gemini Pro + search grounding (rollback przez SEARCH_PROVIDER=gemini). */
async function researchWithGemini(input: ResearchInput, deps: ResearchDeps): Promise<ResearchOutcome> {
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

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results
    .filter((result) => {
      if (seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    })
    .sort((a, b) => b.authority - a.authority || b.rerank_score - a.rerank_score);
}

function categoryTerms(category: Category): string {
  return category;
}

function truncate(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
