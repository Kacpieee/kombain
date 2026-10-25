import { pathToFileURL } from "node:url";
import { createPool } from "@kombain/db";
import { loadConfig } from "./config.js";
import { runOnce } from "./orchestrator.js";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const pool = createPool(config.DIRECT_DATABASE_URL);

  try {
    const report = await runOnce(pool, config);
    console.log(JSON.stringify({ event: "worker_done", published: report.published, draft: report.draft, rejected: report.rejected, errors: report.errors.length }));
    return 0;
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ event: "worker_fatal", error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    });
}
