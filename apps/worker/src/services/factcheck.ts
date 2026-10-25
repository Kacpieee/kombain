import { JudgeSchema, R3Schema, buildJudgePrompt, buildR3Prompt } from "../prompts.js";
import type { EvidenceItem, R2Atom, R3Result } from "../prompts.js";
import { DEFAULT_EDITOR_MODEL, formatLlmError } from "./llm.js";
import type { GenerateFn } from "./llm.js";
import { parseSynthesisJson } from "./ingestion.js";
import { deepseekFetch, deepseekSearch, serpSearch } from "./search/deepseek.js";
import type { SearchResult } from "./search/deepseek.js";

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

const JUDGE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    results: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          claim: { type: "STRING" },
          verdict: { type: "STRING", enum: ["confirmed", "refuted", "uncertain"] },
          source_index: { type: "INTEGER", nullable: true },
        },
        required: ["claim", "verdict", "source_index"],
      },
    },
  },
  required: ["results"],
} as const;

export type VerifyProvider = "deepseek" | "gemini";

export interface FactcheckDeps {
  generate: GenerateFn;
  /** Model ścieżki gemini (grounding); domyślnie GEMINI_PRO_MODEL. */
  model?: string;
  /** Model sędziego DeepSeek; domyślnie GEMINI_LITE_MODEL (tani). */
  judgeModel?: string;
  provider?: VerifyProvider;
  /** Wstrzykiwane w testach. */
  search?: (query: string) => Promise<SearchResult[]>;
  serp?: (query: string) => Promise<SearchResult[]>;
  fetchPage?: (url: string) => Promise<string>;
  maxAtoms?: number;
}

export type FactcheckOutcome = { status: "ok"; result: R3Result } | { status: "error"; error: string };

const DEFAULT_MAX_ATOMS = 8;

/** R3: weryfikacja atomów `external`. DeepSeek Search+Fetch+Flash-Lite (domyślnie) albo Gemini grounding. */
export async function verifyExternalAtoms(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  if (atoms.length === 0) return { status: "ok", result: { results: [] } };

  const provider = deps.provider ?? (process.env.VERIFY_PROVIDER as VerifyProvider | undefined) ?? "deepseek";
  if (provider === "gemini") return verifyWithGemini(atoms, deps);
  return verifyWithSearch(atoms, deps);
}

async function verifyWithSearch(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  const maxAtoms = deps.maxAtoms ?? DEFAULT_MAX_ATOMS;
  const model = deps.judgeModel ?? process.env.GEMINI_LITE_MODEL ?? "gemini-3.1-flash-lite";
  const search = deps.search ?? ((query: string) => deepseekSearch(query));
  const serp = deps.serp ?? ((query: string) => serpSearch(query));
  const fetchPage = deps.fetchPage ?? ((url: string) => deepseekFetch(url));

  const results: R3Result["results"] = [];

  for (const [index, atom] of atoms.entries()) {
    if (index >= maxAtoms) {
      results.push({ claim: atom.text, verdict: "uncertain", evidence_url: "" });
      continue;
    }

    let found: SearchResult[];
    try {
      found = await search(atom.text.slice(0, 128));
    } catch {
      try {
        found = await serp(atom.text.slice(0, 128));
      } catch (fallbackError) {
        return { status: "error", error: `verify: ${message(fallbackError)}` };
      }
    }

    const evidence = pickEvidence(found);

    if (evidence.length === 0) {
      results.push({ claim: atom.text, verdict: "uncertain", evidence_url: "" });
      continue;
    }

    if (evidence.every((item) => item.summary.trim().length === 0)) {
      try {
        const content = await fetchPage(evidence[0]!.url);
        evidence[0] = { ...evidence[0]!, summary: content.slice(0, 1200) };
      } catch {
        // Nie udało się pobrać treści — bez dowodu nie ma jak potwierdzić faktu.
        results.push({ claim: atom.text, verdict: "uncertain", evidence_url: "" });
        continue;
      }
    }

    try {
      const raw = await deps.generate({
        model,
        prompt: buildJudgePrompt([atom.text], evidence),
        responseSchema: JUDGE_RESPONSE_SCHEMA,
      });
      const judged = JudgeSchema.parse(parseSynthesisJson(raw)).results[0];
      results.push(reconcile(atom.text, judged, evidence));
    } catch (error) {
      return { status: "error", error: formatLlmError(error, "R3") };
    }
  }

  return { status: "ok", result: { results } };
}

function pickEvidence(results: SearchResult[]): EvidenceItem[] {
  return [...results]
    .sort((a, b) => b.authority - a.authority || b.rerank_score - a.rerank_score)
    .slice(0, 5)
    .map((result) => ({
      title: result.title,
      url: result.url,
      summary: result.summary || result.snippet,
      authority: result.authority,
    }));
}

function reconcile(
  claim: string,
  judged: { verdict: "confirmed" | "refuted" | "uncertain"; source_index: number | null } | undefined,
  evidence: EvidenceItem[]
): R3Result["results"][number] {
  if (!judged || judged.verdict === "uncertain" || judged.source_index === null) {
    return { claim, verdict: "uncertain", evidence_url: "" };
  }

  const source = evidence[judged.source_index];
  if (!source || !/^https?:\/\//i.test(source.url)) {
    return { claim, verdict: "uncertain", evidence_url: "" };
  }
  return { claim, verdict: judged.verdict, evidence_url: source.url };
}

async function verifyWithGemini(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
