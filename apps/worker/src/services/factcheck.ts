import { JudgeSchema, R3Schema, buildJudgePrompt, buildR3Prompt } from "../prompts.js";
import type { EvidenceItem, R2Atom, R3Result } from "../prompts.js";
import { DEFAULT_EDITOR_MODEL, formatLlmError } from "./llm.js";
import type { GenerateFn } from "./llm.js";
import { parseSynthesisJson } from "./ingestion.js";
import { deepseekFetch, deepseekSearch, serpSearch } from "./search/deepseek.js";
import type { SearchResult } from "./search/deepseek.js";
import {
  buildClaimQuery,
  extractClaimEntities,
  isAcronym,
  significantWords,
  stem,
} from "./search/query.js";

export { buildClaimQuery, extractClaimEntities } from "./search/query.js";

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

export type VerifyReason =
  | "confirmed"
  | "refuted"
  | "no_evidence"
  | "judge_uncertain"
  | "search_error"
  | "max_atoms_cap";

export type FactcheckVerdict = R3Result["results"][number] & { reason?: VerifyReason };

export interface FactcheckResult {
  results: FactcheckVerdict[];
}

export interface VerifyStats {
  searches: number;
  serp: number;
  fetches: number;
  confirmed: number;
  refuted: number;
  uncertain: number;
}

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

export type FactcheckErrorCode = "search_error" | "llm_error";

export type FactcheckOutcome =
  | { status: "ok"; result: FactcheckResult; stats?: VerifyStats }
  | { status: "error"; code: FactcheckErrorCode; error: string; stats?: VerifyStats };

const DEFAULT_MAX_ATOMS = 8;

/** R3: weryfikacja atomów `external`. DeepSeek Search+Fetch+Flash-Lite (domyślnie) albo Gemini grounding. */
export async function verifyExternalAtoms(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  if (atoms.length === 0) return { status: "ok", result: { results: [] }, stats: emptyStats() };

  const provider = deps.provider ?? (process.env.VERIFY_PROVIDER as VerifyProvider | undefined) ?? "deepseek";
  if (provider === "gemini") return verifyWithGemini(atoms, deps);
  return verifyWithSearch(atoms, deps);
}

/** Dowód pasuje, gdy zawiera liczbę/rok/cytat z claimu, akronim lub ≥2 nazwy własne albo ≥2 wspólne rdzenie słów. */
export function isRelevantEvidence(claim: string, evidence: EvidenceItem): boolean {
  const text = `${evidence.title} ${evidence.summary}`.toLowerCase();
  const entities = extractClaimEntities(claim);

  if (entities.quoted.some((quoted) => text.includes(quoted.toLowerCase()))) return true;
  if (entities.numeric.some((numeric) => text.includes(numeric.toLowerCase()))) return true;

  const properHits = entities.proper.filter((proper) => text.includes(proper.toLowerCase()));
  if (properHits.length >= 2) return true;
  if (properHits.some(isAcronym)) return true;

  const claimStems = new Set(significantWords(claim).map(stem));
  const evidenceStems = new Set(significantWords(`${evidence.title} ${evidence.summary}`).map(stem));
  let shared = 0;
  for (const word of claimStems) if (evidenceStems.has(word)) shared += 1;
  return shared >= 2;
}

async function verifyWithSearch(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  const maxAtoms = deps.maxAtoms ?? parseMaxAtoms(process.env.VERIFY_MAX_ATOMS);
  const model = deps.judgeModel ?? process.env.GEMINI_LITE_MODEL ?? "gemini-3.1-flash-lite";
  const search = deps.search ?? ((query: string) => deepseekSearch(query));
  const serp = deps.serp ?? ((query: string) => serpSearch(query));
  const fetchPage = deps.fetchPage ?? ((url: string) => deepseekFetch(url));

  const results: FactcheckVerdict[] = [];
  const stats = emptyStats();

  for (const [index, atom] of atoms.entries()) {
    if (index >= maxAtoms) {
      stats.uncertain += 1;
      results.push({ claim: atom.text, verdict: "uncertain", evidence_url: "", reason: "max_atoms_cap" });
      continue;
    }

    const query = buildClaimQuery(atom.text);

    let raw: EvidenceItem[] = [];
    let primaryFailed = false;
    try {
      stats.searches += 1;
      raw = pickEvidence(await search(query));
    } catch {
      // DeepSeek padł — spróbujemy SERP niżej.
      primaryFailed = true;
    }

    if (raw.length > 0) await fillEvidence(atom.text, raw, fetchPage, stats);

    let relevant = raw
      .filter((evidence) => evidence.summary.trim().length > 0)
      .filter((evidence) => isRelevantEvidence(atom.text, evidence));

    if (relevant.length === 0) {
      try {
        stats.serp += 1;
        const serpRaw = pickEvidence(await serp(query));
        if (serpRaw.length > 0) await fillEvidence(atom.text, serpRaw, fetchPage, stats);
        relevant = serpRaw
          .filter((evidence) => evidence.summary.trim().length > 0)
          .filter((evidence) => isRelevantEvidence(atom.text, evidence));
      } catch (error) {
        return { status: "error", code: "search_error", error: `verify: ${message(error)}`, stats };
      }
    }

    if (relevant.length === 0) {
      stats.uncertain += 1;
      results.push({
        claim: atom.text,
        verdict: "uncertain",
        evidence_url: "",
        reason: primaryFailed ? "search_error" : "no_evidence",
      });
      continue;
    }

    try {
      const judge = await deps.generate({
        model,
        prompt: buildJudgePrompt([atom.text], relevant),
        responseSchema: JUDGE_RESPONSE_SCHEMA,
      });
      const judged = JudgeSchema.parse(parseSynthesisJson(judge)).results[0];
      const verdict = reconcile(atom.text, judged, relevant);
      if (verdict.verdict === "confirmed") stats.confirmed += 1;
      else if (verdict.verdict === "refuted") stats.refuted += 1;
      else stats.uncertain += 1;
      results.push(verdict);
    } catch (error) {
      return { status: "error", code: "llm_error", error: formatLlmError(error, "R3"), stats };
    }
  }

  return { status: "ok", result: { results }, stats };
}

async function fillEvidence(
  claim: string,
  evidence: EvidenceItem[],
  fetchPage: (url: string) => Promise<string>,
  stats: VerifyStats
): Promise<void> {
  if (evidence.length === 0) return;

  const emptyIndex = evidence.findIndex((item) => item.summary.trim().length === 0);
  const index = emptyIndex >= 0 ? emptyIndex : needsFetch(claim, evidence) ? 0 : -1;
  if (index < 0) return;

  try {
    const content = await fetchPage(evidence[index]!.url);
    stats.fetches += 1;
    evidence[index] = { ...evidence[index]!, summary: content.slice(0, 1200) };
  } catch {
    // brak treści — zostają summary
  }
}

function needsFetch(claim: string, evidence: EvidenceItem[]): boolean {
  if (evidence.every((item) => item.summary.trim().length === 0)) return true;
  const digits = extractClaimEntities(claim).numeric;
  if (digits.length === 0) return false;
  const top = `${evidence[0]!.title} ${evidence[0]!.summary}`.toLowerCase();
  return !digits.some((digit) => top.includes(digit.toLowerCase()));
}

function parseMaxAtoms(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ATOMS;
  return Math.min(parsed, 20);
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
): FactcheckVerdict {
  if (!judged || judged.verdict === "uncertain" || judged.source_index === null) {
    return { claim, verdict: "uncertain", evidence_url: "", reason: "judge_uncertain" };
  }

  const source = evidence[judged.source_index];
  if (!source || !/^https?:\/\//i.test(source.url) || source.summary.trim().length === 0) {
    return { claim, verdict: "uncertain", evidence_url: "", reason: "judge_uncertain" };
  }
  return { claim, verdict: judged.verdict, evidence_url: source.url, reason: judged.verdict };
}

async function verifyWithGemini(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  const stats = emptyStats();
  try {
    const raw = await deps.generate({
      model: deps.model ?? process.env.GEMINI_PRO_MODEL ?? DEFAULT_EDITOR_MODEL,
      prompt: buildR3Prompt(atoms),
      responseSchema: R3_RESPONSE_SCHEMA,
      search: true,
    });
    const result = R3Schema.parse(parseSynthesisJson(raw));
    for (const item of result.results) {
      if (item.verdict === "confirmed") stats.confirmed += 1;
      else if (item.verdict === "refuted") stats.refuted += 1;
      else stats.uncertain += 1;
    }
    return { status: "ok", result, stats };
  } catch (error) {
    return { status: "error", code: "llm_error", error: formatLlmError(error, "R3"), stats };
  }
}

function emptyStats(): VerifyStats {
  return { searches: 0, serp: 0, fetches: 0, confirmed: 0, refuted: 0, uncertain: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
