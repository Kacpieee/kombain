import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPool } from "@kombain/db";
import { CATEGORIES, buildEditorPrompt, buildGatekeeperPrompt, buildR1Prompt, buildR2Prompt, buildR3Prompt } from "./prompts.js";
import type { Category, EditorOut } from "./prompts.js";
import { loadConfig } from "./config.js";
import { runOnce } from "./orchestrator.js";
import { notify, pingHealthcheck } from "./services/notify.js";

type PreviewKind = "gate" | "editor" | "r1" | "r2" | "r3";

export type CliArgs =
  | {
      command: "run";
      dryRun: boolean;
      json: boolean;
      limit?: number;
      maxLinks?: number;
      sourceId?: string;
      url?: string;
    }
  | { command: "preview-prompt"; kind: PreviewKind; category: Category; title: string; textFile?: string }
  | { command: "check-env"; json: boolean }
  | { command: "help" };

export class CliUsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") return { command: "help" };

  if (command === "run") {
    const args: Extract<CliArgs, { command: "run" }> = { command: "run", dryRun: false, json: false };
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i]!;
      switch (flag) {
        case "--dry-run":
          args.dryRun = true;
          break;
        case "--json":
          args.json = true;
          break;
        case "--limit":
          args.limit = intValue(rest[++i], "--limit", 1, 2);
          break;
        case "--max-links":
          args.maxLinks = intValue(rest[++i], "--max-links", 1, 15);
          break;
        case "--source-id":
          args.sourceId = value(rest[++i], "--source-id");
          break;
        case "--url":
          args.url = value(rest[++i], "--url");
          break;
        default:
          throw new CliUsageError(`Nieznana flaga: ${flag}`);
      }
    }
    return args;
  }

  if (command === "preview-prompt") {
    let kind: PreviewKind = "editor";
    let category: Category = CATEGORIES[0];
    let title = "Przykładowy tytuł artykułu";
    let textFile: string | undefined;

    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i]!;
      if (flag === "--kind") {
        const raw = value(rest[++i], "--kind");
        if (!["gate", "editor", "r1", "r2", "r3"].includes(raw)) throw new CliUsageError(`Nieznany --kind: ${raw}`);
        kind = raw as PreviewKind;
      } else if (flag === "--category") {
        const raw = value(rest[++i], "--category");
        if (!CATEGORIES.includes(raw as Category)) throw new CliUsageError(`Kategoria spoza enuma: ${raw}`);
        category = raw as Category;
      } else if (flag === "--title") {
        title = value(rest[++i], "--title");
      } else if (flag === "--text-file") {
        textFile = value(rest[++i], "--text-file");
      } else {
        throw new CliUsageError(`Nieznana flaga: ${flag}`);
      }
    }
    return { command: "preview-prompt", kind, category, title, textFile };
  }

  if (command === "check-env") {
    return { command: "check-env", json: rest.includes("--json") };
  }

  throw new CliUsageError(`Nieznana komenda: ${command}`);
}

export function renderPreview(args: Extract<CliArgs, { command: "preview-prompt" }>, text: string): string {
  const sampleArticle: EditorOut = {
    title: args.title,
    content_html: `<h2>Wstęp</h2><p>${text.slice(0, 300)}</p>`,
    tldr: ["a", "b", "c"],
    tags: ["agtech"],
    tech_summary: { podmiot: "Firma", technologia: "technologia", cel_wdrozenia: "cel" },
    slug: "przykladowy-tytul",
    external_refs: [],
  };

  switch (args.kind) {
    case "gate":
      return buildGatekeeperPrompt({ title: args.title, text, sourceUrl: "https://example.com/preview", history: [] });
    case "editor":
      return buildEditorPrompt({ category: args.category, originalTitle: args.title, articleText: text });
    case "r1":
      return buildR1Prompt(sampleArticle);
    case "r2":
      return buildR2Prompt(sampleArticle, text);
    case "r3":
      return buildR3Prompt([{ text: "Firma X ma 40% rynku.", type: "external", evidence: "" }]);
  }
}

/** Maskowany health-check env — nigdy nie wypisuje wartości sekretów. */
export function maskEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const secret = (name: string): string => (env[name] ? `set(len=${env[name]!.length})` : "not set");
  const dbHost = (() => {
    const url = env.DIRECT_DATABASE_URL;
    if (!url) return "not set";
    try {
      const parsed = new URL(url);
      return `set(host=${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname})`;
    } catch {
      return "set(nieparsowalny URL)";
    }
  })();

  return {
    DIRECT_DATABASE_URL: dbHost,
    GEMINI_API_KEY: secret("GEMINI_API_KEY"),
    GEMINI_LITE_MODEL: env.GEMINI_LITE_MODEL ?? "gemini-3.1-flash-lite",
    GEMINI_PRO_MODEL: env.GEMINI_PRO_MODEL ?? "gemini-3.8-flash",
    SCRAPINGANT_API_KEY: secret("SCRAPINGANT_API_KEY"),
    DEEPSEEK_API_KEY: secret("DEEPSEEK_API_KEY"),
    SEARCH_PROVIDER: env.SEARCH_PROVIDER ?? "deepseek",
    TELEGRAM_BOT_TOKEN: secret("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_CHAT_ID: secret("TELEGRAM_CHAT_ID"),
    HEALTHCHECKS_PING_URL: secret("HEALTHCHECKS_PING_URL"),
    R2_ENDPOINT: secret("R2_ENDPOINT"),
    R2_BUCKET: env.R2_BUCKET ?? "articles",
    MAX_PUBLISHED_PER_RUN: env.MAX_PUBLISHED_PER_RUN ?? "2",
    MAX_LINKS_PER_SOURCE: env.MAX_LINKS_PER_SOURCE ?? "15",
    FETCH_CONCURRENCY: env.FETCH_CONCURRENCY ?? "5",
  };
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: (line: string) => void;
  /** Wstrzykiwane w testach (bez DB). */
  runOnce?: typeof runOnce;
  createPool?: typeof createPool;
}

/** Mapowanie flag CLI → config/opcje orchestratora (testowalne bez DB). */
export function buildRunOptions(
  args: Extract<CliArgs, { command: "run" }>,
  config: ReturnType<typeof loadConfig>
): { config: ReturnType<typeof loadConfig>; options: Parameters<typeof runOnce>[2] } {
  const limit = args.limit ?? config.MAX_PUBLISHED_PER_RUN;
  return {
    config: { ...config, MAX_PUBLISHED_PER_RUN: limit },
    options: {
      dryRun: args.dryRun,
      sourceId: args.sourceId,
      url: args.url,
      maxLinks: args.maxLinks ?? config.MAX_LINKS_PER_SOURCE,
      maxProcessed: args.dryRun ? limit : undefined,
    },
  };
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((line: string) => console.log(line));

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stdout(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (args.command === "help") {
    stdout(
      [
        "Użycie:",
        "  run [--dry-run] [--limit 1..2] [--max-links 1..15] [--source-id UUID] [--url URL] [--json]",
        "  preview-prompt --kind gate|editor|r1|r2|r3 [--category ...] [--title ...] [--text-file PATH]",
        "  check-env [--json]",
      ].join("\n")
    );
    return 0;
  }

  if (args.command === "check-env") {
    const masked = maskEnv(env);
    stdout(args.json ? JSON.stringify(masked, null, 2) : Object.entries(masked).map(([k, v]) => `${k}=${v}`).join("\n"));
    return 0;
  }

  if (args.command === "preview-prompt") {
    let text = "Przykładowa treść źródłowa o technologii AgTech. ".repeat(10);
    if (args.textFile) {
      try {
        text = readFileSync(args.textFile, "utf8");
      } catch (error) {
        stdout(`Nie mogę odczytać ${args.textFile}: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    }
    stdout(renderPreview(args, text));
    return 0;
  }

  const config = loadConfig(env);
  const { config: runConfig, options } = buildRunOptions(args, config);
  if (args.url && !args.dryRun) {
    stdout("UWAGA: --url bez --dry-run wykona normalny zapis (source_id = NULL). Rozważ --dry-run.");
  }
  const makePool = deps.createPool ?? createPool;
  const run = deps.runOnce ?? runOnce;
  const pool = makePool(runConfig.DIRECT_DATABASE_URL);
  const humanLog = (event: Record<string, unknown>) => {
    const { event: name, ...rest } = event;
    stdout(`${String(name)} ${JSON.stringify(rest)}`);
  };

  try {
    const report = await run(pool, runConfig, {
      ...options,
      log: args.json ? undefined : humanLog,
      ...(args.dryRun ? {} : { notify: (text: string) => notify(text), healthcheck: (state: "start" | "success" | "fail") => pingHealthcheck(state) }),
    });

    if (args.dryRun) {
      stdout(
        JSON.stringify({
          event: "dry_run_done",
          processed: report.processed,
          dryRunOutcomes: report.dry_run,
          errors: report.errors,
        })
      );
    }
    return 0;
  } finally {
    await pool.end();
  }
}

function value(raw: string | undefined, flag: string): string {
  if (!raw || raw.startsWith("--")) throw new CliUsageError(`Brak wartości dla ${flag}`);
  return raw;
}

function intValue(raw: string | undefined, flag: string, min: number, max: number): number {
  const parsed = Number(value(raw, flag));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliUsageError(`${flag} musi być liczbą ${min}..${max}`);
  }
  return parsed;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
