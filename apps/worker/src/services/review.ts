import { parseHTML } from "linkedom";
import {
  R1Schema,
  R2Schema,
  buildR1Prompt,
  buildR2Prompt,
} from "../prompts.js";
import type { EditorOut, R1Decision, R2Atom, RepairIssue, ResearchFact } from "../prompts.js";
import { verifyExternalAtoms } from "./factcheck.js";
import type { FactcheckOutcome, VerifyReason, VerifyStats } from "./factcheck.js";
import { DEFAULT_EDITOR_MODEL, createGenerator, formatLlmError } from "./llm.js";
import type { GenerateFn } from "./llm.js";
import { parseSynthesisJson } from "./ingestion.js";

export const EDITOR_ALLOWED_TAGS = ["p", "h2", "h3", "strong", "em", "ul", "ol", "li"] as const;
const ALLOWED = new Set<string>(EDITOR_ALLOWED_TAGS);

const R1_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: { pass: { type: "BOOLEAN" }, issues: { type: "ARRAY", items: { type: "STRING" } } },
  required: ["pass", "issues"],
} as const;

const R2_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    atoms: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          type: { type: "STRING", enum: ["supported", "external", "inference"] },
          evidence: { type: "STRING" },
        },
        required: ["text", "type", "evidence"],
      },
    },
  },
  required: ["atoms"],
} as const;

export type ExternalVerdict = {
  claim: string;
  verdict: "confirmed" | "refuted" | "uncertain";
  evidence_url: string;
  reason?: VerifyReason;
};

export interface ReviewDeps {
  generate?: GenerateFn;
  model?: string;
  /** Fakty z researchu — atomy pokryte briefem nie idą do R3. */
  researchBrief?: ResearchFact[];
  /** Jednorazowy retry Redaktora po failu R1 (AGENTS §2.7). */
  regenerate?: (issues: string[], previousArticle: EditorOut) => Promise<EditorOut>;
  runR1?: (article: EditorOut) => Promise<R1Decision>;
  runR2?: (article: EditorOut, sourceText: string) => Promise<R2Atom[]>;
  verifyExternal?: (atoms: R2Atom[]) => Promise<FactcheckOutcome>;
  /** Limit atomów R3 z AppConfig (jedno źródło prawdy). */
  verifyMaxAtoms?: number;
}

export interface ReviewOutcome {
  status: "published" | "draft";
  needsHumanCheck: boolean;
  stage: "R1" | "R2" | "R3" | null;
  issues: string[];
  repairIssues?: RepairIssue[];
  cleanedHtml: string;
  removedInferences: string[];
  external: ExternalVerdict[];
  verify?: VerifyStats;
  article: EditorOut;
}

/** Sanityzacja HTML Redaktora do allowlisty p, h2, h3, strong, em, ul, ol, li (bez atrybutów). */
export function sanitizeEditorHtml(html: string): string {
  const { document } = parseHTML(`<div id="__root">${html}</div>`);
  const root = document.getElementById("__root");
  if (!root) return "";

  for (let pass = 0; pass < 5; pass++) {
    if (!cleanOnePass(root)) break;
  }
  return root.innerHTML.trim().replace(/ {2,}/g, " ");
}

function cleanOnePass(node: Element): boolean {
  let changed = false;

  for (const child of [...node.children]) {
    const tag = child.tagName.toLowerCase();

    if (!ALLOWED.has(tag)) {
      if (tag === "script" || tag === "style" || tag === "iframe") {
        child.remove();
      } else {
        const parent = child.parentNode;
        const doc = child.ownerDocument;
        if (!parent || !doc) continue;
        if (child.firstChild) parent.insertBefore(doc.createTextNode(" "), child);
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
      }
      changed = true;
      continue;
    }

    for (const attribute of [...child.attributes]) child.removeAttribute(attribute.name);
    if (cleanOnePass(child)) changed = true;
  }

  return changed;
}

/** R1 lokalny (deterministyczny): HTML/meta/struktura bez wołania modelu. */
export function validateTechnical(article: EditorOut): { pass: boolean; issues: string[] } {
  const issues: string[] = [];
  const html = article.content_html;

  if (!article.title.trim()) issues.push("Pusty tytuł");
  if (article.title.length > 60) issues.push(`Tytuł ma ${article.title.length} znaków (limit 60)`);

  const tags = [...html.matchAll(/<\/?([a-zA-Z0-9]+)[^>]*>/g)].map((match) => match[1]!.toLowerCase());
  const disallowed = [...new Set(tags.filter((tag) => !ALLOWED.has(tag)))];
  if (disallowed.length > 0) issues.push(`Niedozwolone tagi: ${disallowed.join(", ")}`);
  if (/\son[a-z]+\s*=/i.test(html)) issues.push("Atrybuty zdarzeń w HTML");

  if (article.tldr.length < 3 || article.tldr.length > 5) issues.push("TL;DR musi mieć 3-5 pozycji");
  if (article.tags.length === 0 || article.tags.length > 4) issues.push("Tagi: 1-4");
  if (article.tags.some((tag) => tag !== tag.toLowerCase())) issues.push("Tagi muszą być małymi literami");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) issues.push("Slug spoza [a-z0-9-]");
  if (!article.tech_summary.podmiot || !article.tech_summary.technologia || !article.tech_summary.cel_wdrozenia) {
    issues.push("tech_summary niekompletne");
  }
  if (/Źródło:/i.test(html)) issues.push("Link źródła dokleja kod, nie model");
  if (/https?:\/\//i.test(html)) issues.push("URL w treści (ryzyko halucynacji)");

  return { pass: issues.length === 0, issues };
}

/** Wycina zdania-wnioski bez dowodu. Zdanie przecięte tagiem = `missed` (recenzja → draft). */
export function stripInferences(
  html: string,
  inferences: R2Atom[],
  allAtoms: R2Atom[] = []
): { html: string; removed: string[]; missed: string[] } {
  const targets = inferences
    .filter((atom) => atom.type === "inference")
    .map((atom) => atom.text.trim())
    .filter(Boolean);
  const protectedTexts = allAtoms
    .filter((atom) => atom.type !== "inference")
    .map((atom) => normalizeText(atom.text))
    .filter((text) => text.length > 0);

  const parts = html.split(/(<[^>]+>)/g);
  const removed: string[] = [];
  const missed: string[] = [];

  for (const sentence of targets) {
    let found = false;
    const flexible = new RegExp(escapeRegex(sentence).replace(/\s+/g, "\\s+"), "i");

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.startsWith("<")) continue;

      if (part.includes(sentence)) {
        parts[i] = part.split(sentence).join("");
        found = true;
      }

      // Fallback działa też na fragmencie po exact-match (warianty case/whitespace w tym samym węźle).
      const current = parts[i]!;
      if (flexible.test(current)) {
        parts[i] = current.split(flexible).join("");
        found = true;
      }
    }

    if (!found) found = removeFuzzySentences(parts, sentence, protectedTexts);
    if (!found) found = removeByVisibleText(parts, sentence, protectedTexts);

    (found ? removed : missed).push(sentence);
  }

  const cleaned = parts
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+<\//g, "</")
    .replace(/<h([23])>\s*<\/h\1>/g, "")
    .replace(/<p>\s*<\/p>/g, "")
    .trim();

  return { html: cleaned, removed, missed };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FUZZY_THRESHOLD = 0.75;

/** Dopasowanie parafraz: iteracyjnie usuwa WSZYSTKIE zdania >= 0.75, pomijając zdania będące atomami supported/external. */
function removeFuzzySentences(parts: string[], target: string, protectedTexts: string[]): boolean {
  const targetWords = words(target);
  if (targetWords.size < 4) return false;

  let found = false;

  for (;;) {
    let bestIndex = -1;
    let bestSentence = "";
    let bestScore = 0;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.startsWith("<")) continue;

      for (const sentence of part.split(/(?<=[.!?…])\s+/)) {
        if (sentence.trim().length === 0) continue;
        if (isProtectedSentence(sentence, protectedTexts)) continue;

        const score = similarity(words(sentence), targetWords);
        if (score < FUZZY_THRESHOLD || score <= bestScore) continue;

        bestIndex = i;
        bestSentence = sentence;
        bestScore = score;
      }
    }

    if (bestIndex < 0) return found;
    parts[bestIndex] = parts[bestIndex]!.replace(bestSentence, "");
    found = true;
  }
}

/** Zdanie pokrywa się z atomem supported/external (containment po normalizacji) — nie ruszamy go. */
function isProtectedSentence(sentence: string, protectedTexts: string[]): boolean {
  const normalized = normalizeText(sentence);
  if (!normalized) return false;
  return protectedTexts.some((text) => text.includes(normalized) || normalized.includes(text));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Atom pokryty faktem z researchu — tylko gdy atom zawiera się w fakcie (bez dodatkowych treści). */
function coveredByResearch(claim: string, facts: ResearchFact[]): boolean {
  const normalized = normalizeText(claim);
  if (normalized.length < 10) return false;

  return facts.some((fact) => {
    const factText = normalizeText(fact.claim);
    return factText.length > 0 && factText.includes(normalized);
  });
}

/**
 * Dopasowanie po widocznym tekście bloku (p/li/h2/h3) — pozwala wyciąć cytat, który w HTML
 * jest przecięty tagiem inline (<strong>/<em>). Formatowanie w tym bloku upraszcza się do tekstu.
 */
function removeByVisibleText(parts: string[], sentence: string, protectedTexts: string[]): boolean {
  const { document } = parseHTML(`<div id="__review_root">${parts.join("")}</div>`);
  const root = document.getElementById("__review_root");
  if (!root) return false;

  const flexible = new RegExp(escapeRegex(sentence).replace(/\s+/g, "\\s+"), "i");
  let found = false;

  for (const block of root.querySelectorAll("p, li, h2, h3")) {
    const text = block.textContent ?? "";
    if (!flexible.test(text)) continue;
    if (isProtectedSentence(text, protectedTexts)) continue;

    block.textContent = text.split(flexible).join("");
    found = true;
  }

  if (found) {
    const updated = root.innerHTML.split(/(<[^>]+>)/g);
    parts.length = 0;
    parts.push(...updated);
  }
  return found;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3)
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Link źródła doklejany przez kod (nie przez LLM), z escapowaniem URL. */
export function buildSourceLink(sourceUrl: string): string {
  const safe = escapeHtml(sourceUrl);
  return `<p><strong>Źródło:</strong> <a href="${safe}" rel="nofollow noopener" target="_blank">${safe}</a></p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** R1 → R2 → R3. `refuted` i błędy → draft; `uncertain` → draft + needs_human_check. */
export async function reviewArticle(
  articleIn: EditorOut,
  sourceText: string,
  deps: ReviewDeps = {}
): Promise<ReviewOutcome> {
  const generate = deps.generate ?? createGenerator();
  const model = deps.model ?? process.env.GEMINI_PRO_MODEL ?? DEFAULT_EDITOR_MODEL;

  const runR1 =
    deps.runR1 ??
    (async (article: EditorOut) =>
      R1Schema.parse(
        parseSynthesisJson(await generate({ model, prompt: buildR1Prompt(article), responseSchema: R1_RESPONSE_SCHEMA }))
      ));
  const runR2 =
    deps.runR2 ??
    (async (article: EditorOut, text: string) =>
      R2Schema.parse(
        parseSynthesisJson(await generate({ model, prompt: buildR2Prompt(article, text), responseSchema: R2_RESPONSE_SCHEMA }))
      ).atoms);
  const verify =
    deps.verifyExternal ??
    ((atoms: R2Atom[]) =>
      verifyExternalAtoms(atoms, { generate, model, maxAtoms: deps.verifyMaxAtoms }));

  let article = articleIn;
  let cleanedHtml = sanitizeEditorHtml(article.content_html);
  article = { ...article, content_html: cleanedHtml };
  let retried = false;

  // R1: lokalny meta-check + LLM. Dokładnie jeden retry Redaktora (AGENTS §2.7).
  const local = validateTechnical(article);
  if (!local.pass) {
    if (!deps.regenerate) return draft("R1", local.issues, article, cleanedHtml);

    retried = true;
    const regenerated = await runRegenerate(deps.regenerate, local.issues, article);
    if (!regenerated.ok) return draft("R1", [regenerated.error], article, cleanedHtml);

    article = regenerated.article;
    cleanedHtml = sanitizeEditorHtml(article.content_html);
    article = { ...article, content_html: cleanedHtml };
    const localRetry = validateTechnical(article);
    if (!localRetry.pass) return draft("R1", localRetry.issues, article, cleanedHtml);
  }

  let r1 = await safeR1(runR1, article);
  if (!r1.pass && deps.regenerate && !retried) {
    retried = true;
    const regenerated = await runRegenerate(deps.regenerate, r1.issues, article);
    if (!regenerated.ok) return draft("R1", [regenerated.error], article, cleanedHtml);

    article = regenerated.article;
    cleanedHtml = sanitizeEditorHtml(article.content_html);
    article = { ...article, content_html: cleanedHtml };
    const localRetry = validateTechnical(article);
    if (!localRetry.pass) return draft("R1", localRetry.issues, article, cleanedHtml);

    r1 = await safeR1(runR1, article);
  }
  if (!r1.pass) return draft("R1", r1.issues, article, cleanedHtml);

  let atoms: R2Atom[];
  try {
    atoms = await runR2(article, sourceText);
  } catch (error) {
    return draft("R2", [formatLlmError(error, "R2")], article, cleanedHtml);
  }
  if (atoms.length === 0) return draft("R2", ["R2 nie zwrócił atomów"], article, cleanedHtml);

  const inferences = atoms.filter((atom) => atom.type === "inference" && !hasProof(atom, sourceText));
  let removedInferences: string[] = [];
  if (inferences.length > 0) {
    const stripped = stripInferences(cleanedHtml, inferences, atoms);
    cleanedHtml = stripped.html;
    article = { ...article, content_html: cleanedHtml };
    removedInferences = stripped.removed;
    if (stripped.missed.length > 0) {
      const samples = stripped.missed
        .slice(0, 3)
        .map((text) => `${text.slice(0, 120)}…`)
        .join(" | ");
      const suffix = stripped.missed.length > 3 ? ` … (+${stripped.missed.length - 3})` : "";
      return draft(
        "R2",
        [`Nie udało się wyciąć ${stripped.missed.length} wniosków bez dowodu: ${samples}${suffix}`],
        article,
        cleanedHtml,
        {
          removedInferences,
          repairIssues: stripped.missed.map((text) => ({
            stage: "R2",
            claim: text,
            verdict: "inference_missed",
          })),
        }
      );
    }
  }

  if (cleanedHtml.replace(/<[^>]+>/g, "").trim().length === 0) {
    return draft("R2", ["Po wycięciu wniosków treść jest pusta"], article, cleanedHtml, { removedInferences });
  }

  const externalAtoms = mergeExternalAtoms(atoms, article.external_refs).filter(
    (atom) => !coveredByResearch(atom.text, deps.researchBrief ?? [])
  );
  let external: ExternalVerdict[] = [];
  let verifyStats: VerifyStats | undefined;

  if (externalAtoms.length > 0) {
    const factcheck = await verify(externalAtoms);
    if (factcheck.status === "error") {
      return draft("R3", [factcheck.error], article, cleanedHtml, {
        removedInferences,
        verify: factcheck.stats,
      });
    }

    external = reconcileVerdicts(externalAtoms, factcheck.result.results);
    verifyStats = factcheck.stats;

    const refuted = external.filter((item) => item.verdict === "refuted");
    const uncertain = external.filter((item) => item.verdict === "uncertain");
    if (refuted.length > 0 || uncertain.length > 0) {
      const issues = [
        ...refuted.map((item) => {
          const url = item.evidence_url ? ` (${item.evidence_url})` : "";
          return `refuted: ${item.claim}${url}`;
        }),
        ...uncertain.map((item) => `uncertain: ${item.claim}`),
      ];
      const repairIssues: RepairIssue[] = [
        ...refuted.map((item) => ({
          stage: "R3" as const,
          claim: item.claim,
          verdict: "refuted" as const,
          evidence_url: item.evidence_url,
          reason: item.reason,
        })),
        ...uncertain.map((item) => ({
          stage: "R3" as const,
          claim: item.claim,
          verdict: "uncertain" as const,
          evidence_url: item.evidence_url,
          reason: item.reason,
        })),
      ];

      return draft("R3", issues, article, cleanedHtml, {
        removedInferences,
        external,
        verify: verifyStats,
        repairIssues,
        needsHumanCheck: uncertain.length > 0,
      });
    }
  }

  return {
    status: "published",
    needsHumanCheck: false,
    stage: null,
    issues: [],
    repairIssues: [],
    cleanedHtml,
    removedInferences,
    external,
    verify: verifyStats,
    article,
  };
}

/** Dowód inference: min. 20 znaków i realnie obecny w tekście źródłowym (pierwsze 40 znaków). */
function hasProof(atom: R2Atom, sourceText: string): boolean {
  const evidence = atom.evidence.trim();
  if (evidence.length < 20 || evidence.split(/\s+/).length < 3) return false;
  const probe = evidence.slice(0, 40).toLowerCase();
  return sourceText.toLowerCase().includes(probe);
}

/** Atomy external z R2 + deklaracje Redaktora (`external_refs[].type === "external"`), dedupe po treści. */
function mergeExternalAtoms(atoms: R2Atom[], refs: EditorOut["external_refs"] | undefined): R2Atom[] {
  const merged = atoms.filter((atom) => atom.type === "external");
  const seen = new Set(merged.map((atom) => normalizeClaim(atom.text)));

  for (const ref of refs ?? []) {
    if (ref.type !== "external") continue;
    const claim = ref.claim.trim();
    if (!claim || seen.has(normalizeClaim(claim))) continue;
    seen.add(normalizeClaim(claim));
    merged.push({ text: claim, type: "external", evidence: ref.source });
  }
  return merged;
}

/** Każdy atom external musi mieć werdykt; duplikaty rozstrzyga NAJGORSZY (refuted > uncertain > confirmed), confirmed bez URL = uncertain. */
function reconcileVerdicts(
  atoms: R2Atom[],
  results: Array<{
    claim: string;
    verdict: ExternalVerdict["verdict"];
    evidence_url: string;
    reason?: VerifyReason;
  }>
): ExternalVerdict[] {
  return atoms.map((atom) => {
    const matches = results.filter((result) => normalizeClaim(result.claim) === normalizeClaim(atom.text));
    if (matches.length === 0) {
      return { claim: atom.text, verdict: "uncertain", evidence_url: "", reason: "no_evidence" };
    }

    if (matches.some((match) => match.verdict === "refuted")) {
      const match = matches.find((item) => item.verdict === "refuted");
      return { claim: atom.text, verdict: "refuted", evidence_url: firstEvidenceUrl(matches), reason: match?.reason ?? "refuted" };
    }
    if (matches.some((match) => match.verdict === "uncertain")) {
      const match = matches.find((item) => item.verdict === "uncertain");
      return { claim: atom.text, verdict: "uncertain", evidence_url: "", reason: match?.reason ?? "judge_uncertain" };
    }

    const url = firstEvidenceUrl(matches);
    if (!url) return { claim: atom.text, verdict: "uncertain", evidence_url: "", reason: "no_evidence" };
    return { claim: atom.text, verdict: "confirmed", evidence_url: url, reason: "confirmed" };
  });
}

function firstEvidenceUrl(results: Array<{ evidence_url: string }>): string {
  return results.map((result) => result.evidence_url.trim()).find((url) => /^https?:\/\//i.test(url)) ?? "";
}

function normalizeClaim(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function runRegenerate(
  regenerate: (issues: string[], previousArticle: EditorOut) => Promise<EditorOut>,
  issues: string[],
  previousArticle: EditorOut
): Promise<{ ok: true; article: EditorOut } | { ok: false; error: string }> {
  try {
    return { ok: true, article: await regenerate(issues, previousArticle) };
  } catch (error) {
    return { ok: false, error: formatLlmError(error, "Redaktora") };
  }
}

async function safeR1(runR1: (article: EditorOut) => Promise<R1Decision>, article: EditorOut): Promise<R1Decision> {
  try {
    return await runR1(article);
  } catch (error) {
    return { pass: false, issues: [formatLlmError(error, "R1")] };
  }
}

function draft(
  stage: "R1" | "R2" | "R3",
  issues: string[],
  article: EditorOut,
  cleanedHtml: string,
  extra: Partial<
    Pick<ReviewOutcome, "needsHumanCheck" | "removedInferences" | "external" | "verify" | "repairIssues">
  > = {}
): ReviewOutcome {
  return {
    status: "draft",
    needsHumanCheck: extra.needsHumanCheck ?? false,
    stage,
    issues,
    repairIssues: extra.repairIssues ?? [],
    cleanedHtml,
    removedInferences: extra.removedInferences ?? [],
    external: extra.external ?? [],
    verify: extra.verify,
    article,
  };
}
