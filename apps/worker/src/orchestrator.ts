import type { Pool } from "pg";
import pLimit from "p-limit";
import { fetchActiveSources } from "@kombain/db";
import { clearFailure, getFailure, recordFailure, shouldSkipFailure } from "@kombain/db";
import type { AppConfig } from "./config.js";
import { processArticle } from "./pipeline.js";
import type { ArticleOutcome } from "./pipeline.js";
import { ingestSource } from "./services/ingestion.js";
import type { RawArticleCandidate, SourceForIngestion } from "./services/ingestion.js";
import { formatRunSummary, shouldAlert } from "./services/notify.js";

export interface RunReport {
  started_at: string;
  finished_at: string;
  sources: number;
  links: number;
  processed: number;
  published: number;
  rejected: number;
  draft: number;
  dry_run: number;
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
  /** Tryb testowy: pipeline bez media/save/reject. */
  dryRun?: boolean;
  /** Tylko jedno źródło (diagnostyka). */
  sourceId?: string;
  /** Pojedynczy URL z pominięciem ingestion. */
  url?: string;
  /** Override limitu linków na źródło (cap 15). */
  maxLinks?: number;
  /** Twardy limit przetworzonych linków w runie (ochrona kosztów). */
  maxProcessed?: number;
  /** Wstrzykiwane w testach. */
  notify?: (text: string) => Promise<unknown>;
  healthcheck?: (state: "start" | "success" | "fail") => Promise<unknown>;
  getFailure?: typeof getFailure;
  recordFailure?: typeof recordFailure;
  clearFailure?: typeof clearFailure;
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
  const startedMs = now().getTime();
  const report: RunReport = {
    started_at: startedAt,
    finished_at: startedAt,
    sources: 0,
    links: 0,
    processed: 0,
    published: 0,
    rejected: 0,
    draft: 0,
    dry_run: 0,
    dropped_silent: 0,
    errors: [],
    fallback_used: 0,
    image_fallback_used: 0,
    source_errors: 0,
  };

  if (!deps.dryRun && deps.healthcheck) {
    await deps.healthcheck("start");
  }

  if (deps.url) {
    const candidates = [{ sourceId: null, originalTitle: deps.url, sourceUrl: deps.url }];
    report.links = 1;
    return processCandidates(pool, config, candidates, report, deps, log);
  }

  const allSources = await loadSources(pool);
  const sources = deps.sourceId ? allSources.filter((source) => source.id === deps.sourceId) : allSources;
  report.sources = sources.length;
  if (deps.sourceId && sources.length === 0) {
    report.errors.push(`persist: nie znaleziono źródła ${deps.sourceId}`);
  }

  const limit = pLimit(config.FETCH_CONCURRENCY);
  const maxLinks = deps.maxLinks ?? config.MAX_LINKS_PER_SOURCE;
  const perSource = await Promise.all(
    sources.map((source) =>
      limit(async () => {
        try {
          const result = await ingest(source, { maxLinks });
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
  return processCandidates(pool, config, candidates, report, deps, log);

  function processCandidates(
    db: Pool,
    cfg: AppConfig,
    list: RawArticleCandidate[],
    out: RunReport,
    options: OrchestratorDeps,
    emit: (event: Record<string, unknown>) => void
  ): Promise<RunReport> {
    return (async () => {
      const maxProcessed = options.maxProcessed ?? cfg.MAX_PROCESSED_PER_RUN;
      const isDry = options.dryRun === true;

      for (let index = 0; index < list.length; index++) {
        const candidate = list[index]!;

        if (out.published >= cfg.MAX_PUBLISHED_PER_RUN) {
          emit({ event: "run_limit_reached", published: out.published, remaining: list.length - index });
          break;
        }
        if (out.processed >= maxProcessed) {
          emit({ event: "run_processed_limit", processed: out.processed, remaining: list.length - index });
          break;
        }
        if (!isDry && now().getTime() - startedMs > cfg.RUN_TIMEOUT_MS) {
          out.errors.push(`timeout: soft deadline ${cfg.RUN_TIMEOUT_MS}ms`);
          emit({ event: "run_timeout_soft", elapsedMs: now().getTime() - startedMs });
          break;
        }

        if (!isDry) {
          let failure = null;
          try {
            failure = await (options.getFailure ?? getFailure)(db, candidate.sourceUrl);
          } catch (error) {
            emit({ event: "failure_store_error", op: "get", error: error instanceof Error ? error.message : String(error) });
          }
          if (shouldSkipFailure(failure)) {
            out.dropped_silent += 1;
            emit({
              event: "dropped",
              reason: "failure_backoff",
              sourceUrl: candidate.sourceUrl,
              attempts: failure!.attempts,
            });
            continue;
          }
        }

        let outcome: ArticleOutcome;
        try {
          outcome = await process(db, candidate, options.dryRun ? { persist: false } : undefined);
        } catch (error) {
          outcome = {
            status: "error",
            stage: "pipeline",
            error: error instanceof Error ? error.message : String(error),
          };
        }

        out.processed += 1;
        countOutcome(out, outcome);

        if (!isDry) {
          try {
            if (outcome.status === "error") {
              await (options.recordFailure ?? recordFailure)(db, {
                sourceUrl: candidate.sourceUrl,
                stage: outcome.stage,
                error: outcome.error,
              });
            } else {
              await (options.clearFailure ?? clearFailure)(db, candidate.sourceUrl);
            }
          } catch (error) {
            emit({
              event: "failure_store_error",
              op: outcome.status === "error" ? "record" : "clear",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (outcome.status === "dry_run") {
          emit({
            event: "dry_run",
            wouldBe: outcome.wouldBe,
            sourceUrl: candidate.sourceUrl,
            reason: outcome.reason,
            stage: outcome.review?.stage ?? null,
            needsHumanCheck: outcome.review?.needsHumanCheck ?? false,
            issues: outcome.review?.issues ?? [],
          });
        } else if (outcome.status === "dropped") {
          emit({ event: "dropped", reason: outcome.reason, sourceUrl: candidate.sourceUrl });
        } else {
          emit({ event: "article", sourceUrl: candidate.sourceUrl, ...outcome });
        }
      }

      const finished = now();
      out.finished_at = finished.toISOString();
      emit({ event: "run_summary", ...out });

      if (!isDry) {
        const summary = formatRunSummary(out, finished.getTime() - startedMs);
        const needsAlert = shouldAlert(out) || out.errors.some((error) => error.startsWith("timeout:"));
        if (options.notify) await options.notify(needsAlert ? `⚠️ ALERT\n${summary}` : summary);
        if (options.healthcheck) await options.healthcheck("success");
      }

      return out;
    })();
  }
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
    case "dry_run":
      report.dry_run += 1;
      if (outcome.via === "scrapingant") report.fallback_used += 1;
      break;
  }
}
