import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CATEGORIES } from "./prompts.js";
import { CliUsageError, buildRunOptions, maskEnv, parseArgs, renderPreview, runCli } from "./cli.js";
import type { RunReport } from "./orchestrator.js";
import type { runOnce } from "./orchestrator.js";
import type { createPool } from "@kombain/db";

const REPORT: RunReport = {
  started_at: "2026-10-25T00:00:00.000Z",
  finished_at: "2026-10-25T00:00:01.000Z",
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
  verify_confirmed: 0,
  verify_refuted: 0,
  verify_uncertain: 0,
  verify_serp_used: 0,
  verify_fetches: 0,
  repair_attempts: 0,
  repair_success: 0,
  repair_failed: 0,
};

describe("parseArgs", () => {
  it("domyślny run: bez dry-run, limit z configu", () => {
    expect(parseArgs(["run"])).toEqual({ command: "run", dryRun: false, json: false });
  });

  it("parsuje flagi run", () => {
    expect(parseArgs(["run", "--dry-run", "--limit", "1", "--max-links", "5", "--source-id", "abc", "--url", "https://x", "--json"]))
      .toEqual({
        command: "run",
        dryRun: true,
        json: true,
        limit: 1,
        maxLinks: 5,
        sourceId: "abc",
        url: "https://x",
      });
  });

  it("odrzuca limit > 2 i max-links > 15", () => {
    expect(() => parseArgs(["run", "--limit", "3"])).toThrow(CliUsageError);
    expect(() => parseArgs(["run", "--max-links", "16"])).toThrow(CliUsageError);
  });

  it("odrzuca nieznaną flagę i brak wartości", () => {
    expect(() => parseArgs(["run", "--foo"])).toThrow(CliUsageError);
    expect(() => parseArgs(["run", "--limit"])).toThrow(CliUsageError);
    expect(() => parseArgs(["run", "--limit", "--dry-run"])).toThrow(CliUsageError);
  });

  it("preview-prompt: domyślny kind i walidacja kategorii", () => {
    expect(parseArgs(["preview-prompt"])).toMatchObject({ command: "preview-prompt", kind: "editor" });
    expect(() => parseArgs(["preview-prompt", "--category", "Rolnictwo"])).toThrow(CliUsageError);
    expect(() => parseArgs(["preview-prompt", "--kind", "r4"])).toThrow(CliUsageError);
  });
});

describe("renderPreview", () => {
  it("gate: zawiera historię 30 dni i 6 kategorii", () => {
    const prompt = renderPreview(
      { command: "preview-prompt", kind: "gate", category: CATEGORIES[0], title: "T", textFile: undefined },
      "Treść"
    );
    expect(prompt).toContain("30 dni");
    for (const category of CATEGORIES) expect(prompt).toContain(category);
  });

  it("editor: zawiera personę wybranej kategorii", () => {
    const prompt = renderPreview(
      { command: "preview-prompt", kind: "editor", category: "Agroenergetyka", title: "T", textFile: undefined },
      "Treść"
    );
    expect(prompt).toContain('Redaktor Działu "Agroenergetyka"');
    expect(prompt).toContain("Agri-PV");
  });

  it("r1/r2/r3 renderują się bez błędu", () => {
    for (const kind of ["r1", "r2", "r3"] as const) {
      const prompt = renderPreview(
        { command: "preview-prompt", kind, category: CATEGORIES[0], title: "T", textFile: undefined },
        "Treść źródłowa"
      );
      expect(prompt.length).toBeGreaterThan(50);
    }
  });
});

describe("maskEnv", () => {
  it("nigdy nie wypisuje wartości sekretów", () => {
    const masked = maskEnv({
      DIRECT_DATABASE_URL: "postgresql://user:haslo123@db.local:5432/kombain",
      GEMINI_API_KEY: "AIzaSECRET",
      SCRAPINGANT_API_KEY: "sa-secret",
      TELEGRAM_BOT_TOKEN: "123:abc",
      R2_SECRET_ACCESS_KEY: "r2-secret",
    });

    const serialized = JSON.stringify(masked);
    for (const secret of ["haslo123", "AIzaSECRET", "sa-secret", "123:abc", "r2-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(masked.GEMINI_API_KEY).toBe("set(len=10)");
    expect(masked.DIRECT_DATABASE_URL).toContain("db.local");
  });

  it("oznacza brakujące klucze", () => {
    expect(maskEnv({}).GEMINI_API_KEY).toBe("not set");
  });
});

describe("runCli", () => {
  it("help → 0", async () => {
    const out: string[] = [];
    await expect(runCli([], { stdout: (line) => out.push(line) })).resolves.toBe(0);
    expect(out.join("\n")).toContain("preview-prompt");
  });

  it("check-env → 0 i brak sekretów w output", async () => {
    const out: string[] = [];
    const code = await runCli(["check-env"], {
      env: { GEMINI_API_KEY: "AIzaSECRET" },
      stdout: (line) => out.push(line),
    });

    expect(code).toBe(0);
    expect(out.join("\n")).not.toContain("AIzaSECRET");
    expect(out.join("\n")).toContain(["GEMINI_API_KEY", "set(len=10)"].join("="));
  });

  it("preview-prompt → 0", async () => {
    const out: string[] = [];
    const code = await runCli(["preview-prompt", "--kind", "editor", "--category", "Agroenergetyka"], {
      stdout: (line) => out.push(line),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Agroenergetyka");
  });

  it("błędne argumenty → 2", async () => {
    await expect(runCli(["run", "--limit", "9"], { stdout: () => {} })).resolves.toBe(2);
  });

  it("brak pliku tekstowego → 2", async () => {
    await expect(runCli(["preview-prompt", "--text-file", "/nie/ma/takiego"], { stdout: () => {} })).resolves.toBe(2);
  });

  it("buildRunOptions mapuje flagi dry-run na orchestrator", () => {
    const config = {
      DIRECT_DATABASE_URL: "postgres://x",
      GEMINI_API_KEY: "k",
      GEMINI_LITE_MODEL: "lite",
      GEMINI_PRO_MODEL: "pro",
      SCRAPINGANT_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      SEARCH_PROVIDER: "deepseek" as const,
      VERIFY_PROVIDER: "deepseek" as const,
      VERIFY_MAX_ATOMS: 8,
      REPAIR_MAX_ATTEMPTS: 1,
      MAX_PUBLISHED_PER_RUN: 2,
      MAX_LINKS_PER_SOURCE: 15,
      MAX_PROCESSED_PER_RUN: 10,
      FETCH_CONCURRENCY: 5,
      RUN_TIMEOUT_MS: 1_500_000,
      R2_ENDPOINT: undefined,
      R2_BUCKET: "articles",
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      R2_PUBLIC_BASE_URL: "https://media.kombain.pl",
    };

    const dry = buildRunOptions(
      { command: "run", dryRun: true, json: false, limit: 1, maxLinks: 5, sourceId: "src-1", url: "https://x" },
      config
    );
    expect(dry.config.MAX_PUBLISHED_PER_RUN).toBe(1);
    expect(dry.options).toMatchObject({ dryRun: true, maxProcessed: 1, maxLinks: 5, sourceId: "src-1", url: "https://x" });

    const real = buildRunOptions({ command: "run", dryRun: false, json: false, limit: 2 }, config);
    expect(real.options).toMatchObject({ dryRun: false, maxProcessed: undefined, maxLinks: 15 });
  });

  it("runCli przekazuje dryRun/maxProcessed i zamyka pool", async () => {
    const end = vi.fn(async () => {});
    const run = vi.fn(async (..._args: Parameters<typeof runOnce>): Promise<RunReport> => REPORT);
    const makePool = vi.fn(() => ({ end }) as unknown as Pool);

    const code = await runCli(["run", "--dry-run", "--limit", "1", "--max-links", "5"], {
      env: { DIRECT_DATABASE_URL: "postgres://x", GEMINI_API_KEY: "k" },
      stdout: () => {},
      runOnce: run as unknown as typeof runOnce,
      createPool: makePool as unknown as typeof createPool,
    });

    expect(code).toBe(0);
    const call = run.mock.calls[0]!;
    expect(call[1]).toMatchObject({ MAX_PUBLISHED_PER_RUN: 1 });
    expect(call[2]).toMatchObject({ dryRun: true, maxProcessed: 1, maxLinks: 5 });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("runCli bez dry-run nie ustawia maxProcessed", async () => {
    const run = vi.fn(async (..._args: Parameters<typeof runOnce>): Promise<RunReport> => REPORT);
    const makePool = () => ({ end: async () => {} }) as unknown as Pool;

    await runCli(["run", "--limit", "2"], {
      env: { DIRECT_DATABASE_URL: "postgres://x", GEMINI_API_KEY: "k" },
      stdout: () => {},
      runOnce: run as unknown as typeof runOnce,
      createPool: makePool as unknown as typeof createPool,
    });

    expect(run.mock.calls[0]?.[2]).toMatchObject({ dryRun: false, maxProcessed: undefined });
  });
});
