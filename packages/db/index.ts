import { Pool } from "pg";
import * as queries from "./queries.js";

export const pool = new Pool({
  connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  max: 5,
  statement_timeout: 5000,
  idle_in_transaction_session_timeout: 10000,
});

export * from "./queries.js";
export { queries };
export type ArticleStatus = "published" | "rejected" | "draft";
