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

export type FactcheckOutcome =
  | { status: "ok"; result: R3Result; stats?: VerifyStats }
  | { status: "error"; error: string };

const DEFAULT_MAX_ATOMS = 8;
const MAX_QUERY_LENGTH = 128;
const STOPWORDS = new Set([
  "oraz", "przez", "które", "który", "która", "dla", "jest", "jako", "nie", "się", "ale", "także", "ponadto",
  "that", "with", "from", "this", "have", "were", "will", "their", "about", "into", "more", "than",
]);

/** R3: weryfikacja atomów `external`. DeepSeek Search+Fetch+Flash-Lite (domyślnie) albo Gemini grounding. */
export async function verifyExternalAtoms(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  if (atoms.length === 0) return { status: "ok", result: { results: [] }, stats: emptyStats() };

  const provider = deps.provider ?? (process.env.VERIFY_PROVIDER as VerifyProvider | undefined) ?? "deepseek";
  if (provider === "gemini") return verifyWithGemini(atoms, deps);
  return verifyWithSearch(atoms, deps);
}

/** Zapytanie do wyszukiwania: encje/liczby/lata/nazwy własne + słowa kluczowe, cięte na granicy słowa. */
export function buildClaimQuery(claim: string): string {
  const entities = extractClaimEntities(claim);
  const quoted = entities.quoted[0];
  const quotedLower = quoted ? quoted.toLowerCase() : "";
  const words = claim
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}%]/gu, ""))
    .filter((word) => word.length > 4 && !STOPWORDS.has(word.toLowerCase()) && !quotedLower.includes(word.toLowerCase()));

  const parts = [...(quoted ? [`"${quoted}"`] : []), ...entities.numeric, ...entities.proper, ...words];
  const seen = new Set<string>();
  let query = "";

  for (const part of parts) {
    const key = part.toLowerCase();
    if (!part || seen.has(key)) continue;
    const candidate = query ? `${query} ${part}` : part;
    if (candidate.length > MAX_QUERY_LENGTH) continue;
    seen.add(key);
    query = candidate;
  }

  if (!query) query = claim.replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH).trim();
  return query;
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

/** Akronim/organizacja (NOAA, USDA, EDA, NIFA) — pojedyncza nazwa wystarcza za trafność. */
function isAcronym(value: string): boolean {
  const letters = value.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters.length <= 6 && letters === letters.toUpperCase();
}

async function verifyWithSearch(atoms: R2Atom[], deps: FactcheckDeps): Promise<FactcheckOutcome> {
  const maxAtoms = deps.maxAtoms ?? parseMaxAtoms(process.env.VERIFY_MAX_ATOMS);
  const model = deps.judgeModel ?? process.env.GEMINI_LITE_MODEL ?? "gemini-3.1-flash-lite";
  const search = deps.search ?? ((query: string) => deepseekSearch(query));
  const serp = deps.serp ?? ((query: string) => serpSearch(query));
  const fetchPage = deps.fetchPage ?? ((url: string) => deepseekFetch(url));

  const results: R3Result["results"] = [];
  const stats = emptyStats();

  for (const [index, atom] of atoms.entries()) {
    if (index >= maxAtoms) {
      stats.uncertain += 1;
      results.push({ claim: atom.text, verdict: "uncertain", evidence_url: "" });
      continue;
    }

    const query = buildClaimQuery(atom.text);

    let raw: EvidenceItem[] = [];
    try {
      stats.searches += 1;
      raw = pickEvidence(await search(query));
    } catch {
      // DeepSeek padł — spróbujemy SERP niżej.
    }

    if (raw.length > 0) await fillEvidence(atom.text, raw, fetchPage, stats);

    if (raw.length > 0 && raw[0]!.summary.trim().length === 0) {
      // Dowód bez treści nie może potwierdzić faktu.
      stats.uncertain += 1;
      results.push({ claim: atom.text, verdict: "uncertain", evidence_url: "" });
      continue;
    }

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
        return { status: "error", error: `verify: ${message(error)}` };
      }
    }

    if (relevant.length === 0) {
      stats.uncertain += 1;
      results.push({ claim: atom.text, verdict: "uncertain", evidence_url: "" });
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
      return { status: "error", error: formatLlmError(error, "R3") };
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
  if (evidence.length === 0 || !needsFetch(claim, evidence)) return;
  try {
    const content = await fetchPage(evidence[0]!.url);
    stats.fetches += 1;
    evidence[0] = { ...evidence[0]!, summary: content.slice(0, 1200) };
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

interface ClaimEntities {
  quoted: string[];
  numeric: string[];
  proper: string[];
}

function extractClaimEntities(claim: string): ClaimEntities {
  const quoted = [...claim.matchAll(/[„"]([^”"]{3,80})[”"]/g)].map((match) => match[1] ?? "").filter(Boolean);
  const quotedLower = quoted.map((item) => item.toLowerCase());

  const numeric = (claim.match(/\b(?:19|20)\d{2}\b|\b\d+(?:[.,]\d+)?\s?(?:%|mln|mld|USD|EUR|ha|tys\.?)?/gi) ?? [])
    .filter((value) => !quotedLower.some((item) => item.includes(value.toLowerCase())));

  const proper: string[] = [];
  for (const match of claim.matchAll(/\b[A-ZĄĆĘŁŃÓŚŹŻ][\p{L}\p{N}-]{2,}\b/gu)) {
    const value = match[0];
    const before = claim.slice(0, match.index ?? 0);
    if ((match.index ?? 0) === 0 || /[.!?]\s*$|\n\s*$/.test(before)) continue;
    const lower = value.toLowerCase();
    if (quotedLower.some((item) => item.includes(lower))) continue;
    proper.push(value);
  }

  return {
    quoted,
    numeric: uniqueValues(numeric),
    proper: uniqueValues(proper),
  };
}

function uniqueValues(values: string[]): string[] {
  const map = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) map.set(trimmed.toLowerCase(), trimmed);
  }
  return [...map.values()];
}

function parseMaxAtoms(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ATOMS;
  return Math.min(parsed, 20);
}

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 4 && !STOPWORDS.has(word));
}

/** Rdzeń do porównania odmiany: pierwsze 6 znaków (akwakultury ≈ akwakulturze). */
function stem(word: string): string {
  return word.slice(0, 6);
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
  if (!source || !/^https?:\/\//i.test(source.url) || source.summary.trim().length === 0) {
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
    const result = R3Schema.parse(parseSynthesisJson(raw));
    const stats = emptyStats();
    for (const item of result.results) {
      if (item.verdict === "confirmed") stats.confirmed += 1;
      else if (item.verdict === "refuted") stats.refuted += 1;
      else stats.uncertain += 1;
    }
    return { status: "ok", result, stats };
  } catch (error) {
    return { status: "error", error: formatLlmError(error, "R3") };
  }
}

function emptyStats(): VerifyStats {
  return { searches: 0, serp: 0, fetches: 0, confirmed: 0, refuted: 0, uncertain: 0 };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
