import { pathToFileURL } from "node:url";
import { createPool } from "@kombain/db";
import { loadConfig } from "./config.js";
import { runOnce } from "./orchestrator.js";
import { notify, pingHealthcheck } from "./services/notify.js";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = loadConfig(env);
  const pool = createPool(config.DIRECT_DATABASE_URL);

  try {
    const report = await runOnce(pool, config, {
      notify: (text) => notify(text),
      healthcheck: (state) => pingHealthcheck(state),
    });
    console.log(JSON.stringify({ event: "worker_done", published: report.published, draft: report.draft, rejected: report.rejected, errors: report.errors.length }));
    return 0;
  } finally {
    await pool.end();
  }
}

export interface FatalDeps {
  notify?: (text: string) => Promise<unknown>;
  healthcheck?: (state: "start" | "success" | "fail") => Promise<unknown>;
  error?: (line: string) => void;
}

/** Fatal runu: wpis do logu + Telegram + healthchecks /fail. Zawsze zwraca 1. */
export async function handleFatal(error: unknown, deps: FatalDeps = {}): Promise<number> {
  const message = error instanceof Error ? error.message : String(error);
  (deps.error ?? ((line: string) => console.error(line)))(JSON.stringify({ event: "worker_fatal", error: message }));
  await (deps.notify ?? ((text: string) => notify(text)))(`❌ worker_fatal: ${message}`);
  await (deps.healthcheck ?? ((state: "start" | "success" | "fail") => pingHealthcheck(state)))("fail");
  return 1;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error: unknown) => {
      process.exitCode = await handleFatal(error);
    });
}
