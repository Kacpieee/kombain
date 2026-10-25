import { Pool, type PoolClient } from "pg";
import * as queries from "./queries.js";

export function createPool(
  connectionString: string | undefined = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL
): Pool {
  return new Pool({
    connectionString,
    max: 5,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
}

export const pool = createPool();

/**
 * Transakcja na osobnym kliencie: BEGIN → fn → COMMIT, ROLLBACK przy błędzie.
 * Klient zawsze wraca do puli (finally), więc błąd nie wycieka połączenia.
 */
export async function withTransaction<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // rollback po zerwanym połączeniu — błąd źródłowy jest ważniejszy
    }
    throw error;
  } finally {
    client.release();
  }
}

export * from "./queries.js";
export * from "./persist.js";
export { slugify } from "./slug.js";
export { queries };
