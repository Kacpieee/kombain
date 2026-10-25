import type { Pool } from "pg";
import {
  checkUrlDuplicate,
  fetchHistoricalContext30d,
  rejectArticle,
  saveArticle,
} from "@kombain/db";
import type { RawArticleCandidate } from "./services/ingestion.js";
import { classifyArticle, synthesizeArticle } from "./services/llm.js";
import { processArticleImage } from "./services/media.js";
import { researchTopic } from "./services/research.js";
import { reviewArticle } from "./services/review.js";
import { scrapeArticle } from "./services/scraper.js";
import type { ReviewOutcome } from "./services/review.js";
import type { VerifyStats } from "./services/factcheck.js";
import type { EditorOut } from "./prompts.js";

export type ArticleOutcome =
  | {
      status: "published";
      articleId: string;
      slug: string;
      via: "direct" | "scrapingant" | null;
      imageVia: "r2" | "default";
      verify?: VerifyStats;
    }
  | { status: "draft"; articleId: string; slug: string; via: "direct" | "scrapingant" | null; imageVia?: "r2" | "default"; verify?: VerifyStats }
  | { status: "rejected"; articleId: string | null; via: "direct" | "scrapingant" | null }
  | { status: "dropped"; reason: "url_duplicate" | "semantic_duplicate" | "rejected_exists" }
  | { status: "error"; stage: "scrape" | "gate" | "editor" | "review" | "persist" | "pipeline"; error: string }
  | {
      status: "dry_run";
      wouldBe: "published" | "draft" | "rejected";
      article?: EditorOut;
      review?: ReviewOutcome;
      reason?: string;
      via: "direct" | "scrapingant" | null;
    };

export interface PipelineOverrides {
  /** `false` = dry-run: bez media, bez save/reject (tylko odczyt DB). */
  persist?: boolean;
  /** Alert (np. research fallback) — wstrzykiwany przez orchestrator. */
  notify?: (text: string) => Promise<unknown>;
  duplicateCheck?: (link: string) => Promise<boolean>;
  /** Diagnostyka `--dry-run --url`: pozwala przetworzyć URL już zapisany w DB. */
  skipDuplicateCheck?: boolean;
  /** Limit atomów R3 z AppConfig. */
  verifyMaxAtoms?: number;
  scrape?: typeof scrapeArticle;
  history?: typeof fetchHistoricalContext30d;
  classify?: typeof classifyArticle;
  synthesize?: typeof synthesizeArticle;
  research?: typeof researchTopic;
  review?: typeof reviewArticle;
  media?: typeof processArticleImage;
  save?: typeof saveArticle;
  reject?: typeof rejectArticle;
}

/**
 * Pojedynczy link (Dokumentacja §4 KROKI 2-5):
 * dedup URL → scrape → Bramkarz → Redaktor → review R1/R2/R3 → media → persist.
 */
export async function processArticle(
  pool: Pool,
  candidate: RawArticleCandidate,
  overrides: PipelineOverrides = {}
): Promise<ArticleOutcome> {
  const duplicateCheck = overrides.duplicateCheck ?? ((link: string) => checkUrlDuplicate(pool, link));
  const scrape = overrides.scrape ?? scrapeArticle;
  const history = overrides.history ?? ((...args: Parameters<typeof fetchHistoricalContext30d>) => fetchHistoricalContext30d(...args));
  const classify = overrides.classify ?? classifyArticle;
  const synthesize = overrides.synthesize ?? synthesizeArticle;
  const research = overrides.research ?? researchTopic;
  const review = overrides.review ?? reviewArticle;
  const media = overrides.media ?? processArticleImage;
  const save = overrides.save ?? saveArticle;
  const reject = overrides.reject ?? rejectArticle;

  if (!overrides.skipDuplicateCheck && (await duplicateCheck(candidate.sourceUrl))) {
    return { status: "dropped", reason: "url_duplicate" };
  }

  const scraped = await scrape(candidate.sourceUrl);
  const via =
    scraped.status === "error" ? null : scraped.status === "ok" ? scraped.article.fetchedVia : scraped.fetchedVia;
  const persist = overrides.persist ?? true;

  if (scraped.status === "error") {
    return { status: "error", stage: "scrape", error: scraped.error };
  }
  if (scraped.status === "rejected") {
    if (!persist) return { status: "dry_run", wouldBe: "rejected", reason: scraped.reason, via };

    const result = await reject(pool, {
      title: scraped.title || candidate.originalTitle,
      sourceUrl: candidate.sourceUrl,
      reason: scraped.reason,
      sourceId: candidate.sourceId,
    });
    return { status: "rejected", articleId: result.articleId, via };
  }

  const historyRows = await history(pool);
  const gate = await classify({
    title: scraped.article.title || candidate.originalTitle,
    text: scraped.article.text,
    sourceUrl: candidate.sourceUrl,
    history: historyRows,
  });

  if (gate.status === "error") {
    return { status: "error", stage: "gate", error: gate.error };
  }
  if (gate.status === "rejected") {
    // Duplikat semantyczny = ciche porzucenie (AGENTS §2.8); nieistotny temat = rejected.
    if (gate.decision.is_duplicate) return { status: "dropped", reason: "semantic_duplicate" };
    if (!persist) return { status: "dry_run", wouldBe: "rejected", reason: gate.reason, via };

    const result = await reject(pool, {
      title: scraped.article.title || candidate.originalTitle,
      sourceUrl: candidate.sourceUrl,
      reason: gate.reason,
      sourceId: candidate.sourceId,
    });
    return { status: "rejected", articleId: result.articleId, via };
  }

  const category = gate.decision.category;
  const originalTitle = scraped.article.title || candidate.originalTitle;
  const brief = await research({ title: originalTitle, text: scraped.article.text, category });
  const researchFacts = brief.status === "ok" ? brief.facts : [];
  if (brief.status === "error" && persist && overrides.notify) {
    await overrides.notify(`⚠️ research fallback: ${brief.error}`);
  }
  const editorInput = {
    category,
    originalTitle,
    articleText: scraped.article.text,
    researchBrief: researchFacts,
  };
  const edited = await synthesize(editorInput);

  if (edited.status === "error") {
    // Błąd Redaktora nie może zgubić tematu: zapisujemy draft do ręcznej korekty (AGENTS §2.8).
    if (!persist) {
      return { status: "dry_run", wouldBe: "draft", reason: `Błąd Redaktora: ${edited.error}`, via };
    }

    const saved = await save(pool, {
      status: "draft",
      sourceId: candidate.sourceId,
      sourceUrl: candidate.sourceUrl,
      categoryName: category,
      title: fallbackTitle(originalTitle),
      contentHtml: `<p>${escapeHtml(scraped.article.text.slice(0, 2000))}</p>`,
      tldr: null,
      techSummary: null,
      imageUrl: null,
      tags: [],
      rejectionReason: `Błąd Redaktora: ${edited.error}`,
      needsHumanCheck: true,
    });

    if (saved.status === "draft") {
      return { status: "draft", articleId: saved.articleId, slug: saved.slug, via };
    }
    return persistFailure(saved.status, "reason" in saved ? saved.reason : undefined);
  }

  const reviewed = await review(edited.article, scraped.article.text, {
    researchBrief: researchFacts,
    verifyMaxAtoms: overrides.verifyMaxAtoms,
    regenerate: async (issues: string[], previousArticle: EditorOut): Promise<EditorOut> => {
      const retry = await synthesize({
        ...editorInput,
        feedback: {
          previousArticle,
          issues: issues.map((issue) => ({ stage: "R1", claim: issue, verdict: "technical" })),
        },
      });
      if (retry.status === "error") throw new Error(`Retry Redaktora nieudany (${issues.length} uwag): ${retry.error}`);
      return retry.article;
    },
  });

  if (reviewed.status === "draft") {
    if (!persist) {
      return { status: "dry_run", wouldBe: "draft", article: reviewed.article, review: reviewed, via };
    }

    const saved = await save(pool, {
      status: "draft",
      sourceId: candidate.sourceId,
      sourceUrl: candidate.sourceUrl,
      categoryName: category,
      title: reviewed.article.title,
      contentHtml: reviewed.cleanedHtml,
      tldr: reviewed.article.tldr,
      techSummary: reviewed.article.tech_summary,
      imageUrl: null,
      tags: reviewed.article.tags,
      rejectionReason: reviewed.issues.join("; ") || `Review ${reviewed.stage}`,
      needsHumanCheck: reviewed.needsHumanCheck || reviewed.stage !== null,
    });

    if (saved.status === "draft") {
      return { status: "draft", articleId: saved.articleId, slug: saved.slug, via, verify: reviewed.verify };
    }
    return persistFailure(saved.status);
  }

  if (!persist) {
    return { status: "dry_run", wouldBe: "published", article: reviewed.article, review: reviewed, via };
  }

  const image = await media({
    slug: reviewed.article.slug,
    ogImage: scraped.article.ogImage,
    category,
  });

  const saved = await save(pool, {
    status: "published",
    sourceId: candidate.sourceId,
    sourceUrl: candidate.sourceUrl,
    categoryName: category,
    title: reviewed.article.title,
    contentHtml: reviewed.cleanedHtml,
    tldr: reviewed.article.tldr,
    techSummary: reviewed.article.tech_summary,
    imageUrl: image.url,
    tags: reviewed.article.tags,
  });

  if (saved.status === "published") {
    return {
      status: "published",
      articleId: saved.articleId,
      slug: saved.slug,
      via,
      imageVia: image.via,
      verify: reviewed.verify,
    };
  }
  return persistFailure(saved.status);
}

function persistFailure(status: "published" | "draft" | "blocked" | "dropped", reason?: string): ArticleOutcome {
  if (status === "dropped") return { status: "dropped", reason: "rejected_exists" };
  return { status: "error", stage: "persist", error: reason ?? `Nieoczekiwany status zapisu: ${status}` };
}

function fallbackTitle(title: string): string {
  return title.slice(0, 60);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
