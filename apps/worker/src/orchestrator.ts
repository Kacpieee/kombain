import type { Pool } from "pg";
import pLimit from "p-limit";
import { fetchActiveSources } from "@kombain/db";
import type { AppConfig } from "./config.js";
import { processArticle } from "./pipeline.js";
import type { ArticleOutcome } from "./pipeline.js";
import { ingestSource } from "./services/ingestion.js";
import type { RawArticleCandidate, SourceForIngestion } from "./services/ingestion.js";

export interface RunReport {
  started_at: string;
  finished_at: string;
  sources: number;
  links: number;
  published: number;
  rejected: number;
  draft: number;
  dropped_silent: number;
  errors: string[];
  fallback_used: number;
  image_fallback_used: number;
  source_errors: number;
}

export interface OrchestratorDeps {
  loadSources?: (db: Pool) => Promise<SourceForIngestion[]>;
  ingest?: typeof ingestSource;
  process?: typeof processArticle;
  log?: (event: Record<string, unknown>) => void;
  now?: () => Date;
}

/**
 * Jeden run: źródła → linki (dedupe run-level) → pipeline, stop po MAX_PUBLISHED_PER_RUN.
 * Błąd źródła/artykułu nie przerywa runu; wszystko ląduje w licznikach i logu JSONL.
 */
export async function runOnce(pool: Pool, config: AppConfig, deps: OrchestratorDeps = {}): Promise<RunReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
  const loadSources = deps.loadSources ?? ((db: Pool) => fetchActiveSources(db));
  const ingest = deps.ingest ?? ingestSource;
  const process = deps.process ?? processArticle;

  const startedAt = now().toISOString();
  const report: RunReport = {
    started_at: startedAt,
    finished_at: startedAt,
    sources: 0,
    links: 0,
    published: 0,
    rejected: 0,
    draft: 0,
    dropped_silent: 0,
    errors: [],
    fallback_used: 0,
    image_fallback_used: 0,
    source_errors: 0,
  };

  const sources = await loadSources(pool);
  report.sources = sources.length;

  const limit = pLimit(config.FETCH_CONCURRENCY);
  const perSource = await Promise.all(
    sources.map((source) =>
      limit(async () => {
        try {
          const result = await ingest(source, { maxLinks: config.MAX_LINKS_PER_SOURCE });
          if (result.error) {
            report.source_errors += 1;
            log({ event: "source_error", sourceId: source.id, name: source.name, error: result.error });
          }
          return result.candidates;
        } catch (error) {
          report.source_errors += 1;
          log({
            event: "source_error",
            sourceId: source.id,
            name: source.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      })
    )
  );

  const seen = new Set<string>();
  const candidates: RawArticleCandidate[] = [];
  for (const links of perSource) {
    for (const candidate of links) {
      if (seen.has(candidate.sourceUrl)) {
        report.dropped_silent += 1;
        log({ event: "dropped", reason: "run_duplicate", sourceUrl: candidate.sourceUrl });
        continue;
      }
      seen.add(candidate.sourceUrl);
      candidates.push(candidate);
    }
  }
  report.links = candidates.length;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    if (report.published >= config.MAX_PUBLISHED_PER_RUN) {
      log({ event: "run_limit_reached", published: report.published, remaining: candidates.length - index });
      break;
    }

    let outcome: ArticleOutcome;
    try {
      outcome = await process(pool, candidate);
    } catch (error) {
      outcome = {
        status: "error",
        stage: "pipeline",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    countOutcome(report, outcome);
    if (outcome.status === "dropped") {
      log({ event: "dropped", reason: outcome.reason, sourceUrl: candidate.sourceUrl });
    } else {
      log({ event: "article", sourceUrl: candidate.sourceUrl, ...outcome });
    }
  }

  report.finished_at = now().toISOString();
  log({ event: "run_summary", ...report });
  return report;
}

function countOutcome(report: RunReport, outcome: ArticleOutcome): void {
  switch (outcome.status) {
    case "published":
      report.published += 1;
      if (outcome.via === "scrapingant") report.fallback_used += 1;
      if (outcome.imageVia === "default") report.image_fallback_used += 1;
      break;
    case "draft":
      report.draft += 1;
      if (outcome.via === "scrapingant") report.fallback_used += 1;
      break;
    case "rejected":
      report.rejected += 1;
      if (outcome.via === "scrapingant") report.fallback_used += 1;
      break;
    case "dropped":
      report.dropped_silent += 1;
      break;
    case "error":
      report.errors.push(`${outcome.stage}: ${outcome.error}`);
      break;
  }
}
