import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "./queries.js";

export const FAILURE_MAX_ATTEMPTS = 3;
export const FAILURE_BACKOFF_DAYS = 7;

export interface FailureRow {
  source_url: string;
  attempts: number;
  last_stage: string | null;
  last_error: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

export type FailureQueryable = Queryable & {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
};

/** Aktywna porażka (w oknie backoffu); `null` gdy brak lub wygasła. */
export async function getFailure(db: FailureQueryable, sourceUrl: string): Promise<FailureRow | null> {
  const { rows } = await db.query<FailureRow>(
    `SELECT source_url, attempts, last_stage, last_error, first_seen_at, last_seen_at
     FROM article_failures
     WHERE source_url = $1 AND last_seen_at > NOW() - ($2 || ' days')::interval`,
    [sourceUrl, FAILURE_BACKOFF_DAYS]
  );
  return rows[0] ?? null;
}

/** Backoff: po 3 nieudanych próbach link jest pomijany do wygaśnięcia okna. */
export function shouldSkipFailure(row: FailureRow | null): boolean {
  return row !== null && row.attempts >= FAILURE_MAX_ATTEMPTS;
}

export async function recordFailure(
  db: FailureQueryable,
  input: { sourceUrl: string; stage: string; error: string }
): Promise<void> {
  await db.query(
    `INSERT INTO article_failures (source_url, attempts, last_stage, last_error, last_seen_at)
     VALUES ($1, 1, $2, $3, NOW())
     ON CONFLICT (source_url) DO UPDATE SET
       attempts = article_failures.attempts + 1,
       last_stage = EXCLUDED.last_stage,
       last_error = EXCLUDED.last_error,
       last_seen_at = NOW()`,
    [input.sourceUrl, input.stage, input.error.slice(0, 2000)]
  );
}

export async function clearFailure(db: FailureQueryable, sourceUrl: string): Promise<void> {
  await db.query(`DELETE FROM article_failures WHERE source_url = $1`, [sourceUrl]);
}
