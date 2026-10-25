import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import type { SourceForIngestion, RawArticleCandidate } from "./services/ingestion.js";
import { runOnce } from "./orchestrator.js";
import type { ArticleOutcome } from "./pipeline.js";

const POOL = {} as Pool;
const CONFIG: AppConfig = {
  DIRECT_DATABASE_URL: "postgres://x",
  GEMINI_API_KEY: "k",
  GEMINI_LITE_MODEL: "lite",
  GEMINI_PRO_MODEL: "pro",
  SCRAPINGANT_API_KEY: undefined,
  DEEPSEEK_API_KEY: undefined,
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  SEARCH_PROVIDER: "deepseek",
  VERIFY_PROVIDER: "deepseek",
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

const SOURCES: SourceForIngestion[] = [
  { id: "s1", name: "A", url: "https://a.example/feed", type: "rss", link_selector: null },
  { id: "s2", name: "B", url: "https://b.example/feed", type: "rss", link_selector: null },
];

const candidate = (id: string, url: string) => ({ sourceId: id, originalTitle: `T ${url}`, sourceUrl: url });

function published(): ArticleOutcome {
  return { status: "published", articleId: "a", slug: "s", via: "direct", imageVia: "r2" };
}
function draft(): ArticleOutcome {
  return { status: "draft", articleId: "d", slug: "s", via: "scrapingant" };
}

describe("runOnce", () => {
  it("deduplikuje URL w obrębie runu (między źródłami)", async () => {
    const ingest = vi.fn(async (source: SourceForIngestion) =>
      source.id === "s1"
        ? { sourceId: "s1", type: "rss" as const, candidates: [candidate("s1", "https://x/1"), candidate("s1", "https://x/2")], error: null }
        : { sourceId: "s2", type: "rss" as const, candidates: [candidate("s2", "https://x/1")], error: null }
    );
    const process = vi.fn(async () => published());

    const report = await runOnce(POOL, CONFIG, { loadSources: async () => SOURCES, ingest, process, log: () => {} });

    expect(process).toHaveBeenCalledTimes(2);
    expect(report.links).toBe(2);
    expect(report.dropped_silent).toBe(1);
  });

  it("zatrzymuje run po MAX_PUBLISHED_PER_RUN", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1"), candidate("s1", "https://x/2"), candidate("s1", "https://x/3")],
      error: null,
    }));
    const process = vi.fn(async () => published());

    const report = await runOnce(POOL, CONFIG, { loadSources: async () => [SOURCES[0]!], ingest, process, log: () => {} });

    expect(process).toHaveBeenCalledTimes(2);
    expect(report.published).toBe(2);
  });

  it("agreguje liczniki i fallback_used", async () => {
    const outcomes: ArticleOutcome[] = [
      published(),
      draft(),
      { status: "rejected", articleId: "r", via: "direct" },
      { status: "dropped", reason: "semantic_duplicate" },
      { status: "error", stage: "gate", error: "429" },
    ];
    let index = 0;
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: outcomes.map((_, i) => candidate("s1", `https://x/${i}`)),
      error: null,
    }));
    const process = vi.fn(async () => outcomes[index++]!);

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process,
      log: () => {},
    });

    expect(report.published).toBe(1);
    expect(report.draft).toBe(1);
    expect(report.rejected).toBe(1);
    expect(report.dropped_silent).toBe(1);
    expect(report.errors).toEqual(["gate: 429"]);
    expect(report.fallback_used).toBe(1);
  });

  it("błąd źródła nie przerywa runu i jest liczony", async () => {
    const ingest = vi.fn(async (source: SourceForIngestion) => {
      if (source.id === "s1") throw new Error("RSS down");
      return { sourceId: "s2", type: "rss" as const, candidates: [candidate("s2", "https://x/9")], error: null };
    });
    const process = vi.fn(async () => published());
    const events: Array<Record<string, unknown>> = [];

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => SOURCES,
      ingest,
      process,
      log: (event) => events.push(event),
    });

    expect(report.source_errors).toBe(1);
    expect(report.published).toBe(1);
    expect(events.some((event) => event.event === "source_error")).toBe(true);
    expect(events.some((event) => event.event === "run_summary")).toBe(true);
  });

  it("wyjątek w pipeline → error zamiast wywalenia runu", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const process = vi.fn(async () => {
      throw new Error("boom");
    });

    const report = await runOnce(POOL, CONFIG, { loadSources: async () => [SOURCES[0]!], ingest, process, log: () => {} });

    expect(report.errors).toEqual(["pipeline: boom"]);
    expect(report.published).toBe(0);
  });

  it("źródło z error w wyniku ingestu też jest liczone", async () => {
    const ingest = vi.fn(async (source: SourceForIngestion) => ({
      sourceId: source.id,
      type: "rss" as const,
      candidates: [],
      error: source.id === "s1" ? "ECONNRESET" : null,
    }));

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => SOURCES,
      ingest,
      process: vi.fn(async () => published()),
      log: () => {},
    });

    expect(report.source_errors).toBe(1);
    expect(report.links).toBe(0);
  });

  it("przekazuje MAX_LINKS_PER_SOURCE do ingestion", async () => {
    const ingest = vi.fn(async () => ({ sourceId: "s1", type: "rss" as const, candidates: [], error: null }));
    await runOnce(POOL, { ...CONFIG, MAX_LINKS_PER_SOURCE: 5 }, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(async () => published()),
      log: () => {},
    });

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), { maxLinks: 5 });
  });

  it("loguje ciche porzucenia (JSONL) z powodem", async () => {
    const events: Array<Record<string, unknown>> = [];
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));

    await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(async (): Promise<ArticleOutcome> => ({ status: "dropped", reason: "semantic_duplicate" })),
      log: (event) => events.push(event),
    });

    expect(events.some((event) => event.event === "dropped" && event.reason === "semantic_duplicate")).toBe(true);
  });

  it("liczy image_fallback_used", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(
        async (): Promise<ArticleOutcome> => ({
          status: "published",
          articleId: "a",
          slug: "s",
          via: "direct",
          imageVia: "default",
        })
      ),
      log: () => {},
    });

    expect(report.image_fallback_used).toBe(1);
  });

  it("--url: pomija źródła i przetwarza pojedynczy link", async () => {
    const loadSources = vi.fn(async () => SOURCES);
    const process = vi.fn(async (_pool: Pool, _candidate: RawArticleCandidate) => published());

    const report = await runOnce(POOL, CONFIG, {
      loadSources,
      url: "https://example.com/jeden",
      process,
      log: () => {},
    });

    expect(loadSources).not.toHaveBeenCalled();
    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]?.[1]).toMatchObject({ sourceUrl: "https://example.com/jeden", sourceId: null });
    expect(report.links).toBe(1);
  });

  it("sourceId filtruje źródła przed ingestion", async () => {
    const ingest = vi.fn(async (source: SourceForIngestion) => ({
      sourceId: source.id,
      type: "rss" as const,
      candidates: [],
      error: null,
    }));

    await runOnce(POOL, CONFIG, {
      loadSources: async () => SOURCES,
      ingest,
      process: vi.fn(async () => published()),
      sourceId: "s2",
      log: () => {},
    });

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]?.[0]).toMatchObject({ id: "s2" });
  });

  it("nieznany sourceId → error, bez ingestion", async () => {
    const ingest = vi.fn(async () => ({ sourceId: "x", type: "rss" as const, candidates: [], error: null }));

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => SOURCES,
      ingest,
      process: vi.fn(async () => published()),
      sourceId: "nie-ma",
      log: () => {},
    });

    expect(ingest).not.toHaveBeenCalled();
    expect(report.errors.join(" ")).toContain("nie-ma");
  });

  it("maxProcessed zatrzymuje run niezależnie od publikacji", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1"), candidate("s1", "https://x/2"), candidate("s1", "https://x/3")],
      error: null,
    }));
    const process = vi.fn(
      async (): Promise<ArticleOutcome> => ({ status: "draft", articleId: "d", slug: "s", via: "direct" })
    );
    const events: Array<Record<string, unknown>> = [];

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process,
      maxProcessed: 2,
      log: (event) => events.push(event),
    });

    expect(process).toHaveBeenCalledTimes(2);
    expect(report.processed).toBe(2);
    expect(events.some((event) => event.event === "run_processed_limit")).toBe(true);
  });

  it("dryRun przekazuje persist:false i liczy dry_run", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const process = vi.fn(
      async (_pool: Pool, _candidate: RawArticleCandidate, _options?: { persist?: boolean }): Promise<ArticleOutcome> => ({
        status: "dry_run",
        wouldBe: "published",
        via: "direct",
      })
    );
    const events: Array<Record<string, unknown>> = [];

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process,
      dryRun: true,
      log: (event) => events.push(event),
    });

    expect(process.mock.calls[0]?.[2]).toEqual({ persist: false });
    expect(report.dry_run).toBe(1);
  });

  it("dry_run loguje etap i powody review (diagnostyka draftu)", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const events: Array<Record<string, unknown>> = [];

    await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(
        async (): Promise<ArticleOutcome> => ({
          status: "dry_run",
          wouldBe: "draft",
          via: "direct",
          review: {
            status: "draft",
            needsHumanCheck: true,
            stage: "R3",
            issues: ["uncertain: firma X ma 40% rynku"],
            cleanedHtml: "<p>x</p>",
            removedInferences: [],
            external: [],
            article: {
              title: "T",
              content_html: "<p>x</p>",
              tldr: ["a", "b", "c"],
              tags: ["t"],
              tech_summary: { podmiot: "p", technologia: "t", cel_wdrozenia: "c" },
              slug: "t",
              external_refs: [],
            },
          },
        })
      ),
      dryRun: true,
      log: (event) => events.push(event),
    });

    const dry = events.find((event) => event.event === "dry_run");
    expect(dry).toMatchObject({ wouldBe: "draft", stage: "R3", needsHumanCheck: true });
    expect(dry?.issues).toEqual(["uncertain: firma X ma 40% rynku"]);
  });

  it("realny run przekazuje notify do pipeline, dry-run tylko persist:false", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const notify = vi.fn(async (_text: string) => true);
    const process = vi.fn(
      async (_pool: Pool, _candidate: RawArticleCandidate, _options?: { persist?: boolean; notify?: unknown }) =>
        published()
    );
    const infra = {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process,
      getFailure: async () => null,
      recordFailure: async () => {},
      clearFailure: async () => {},
      notify,
      healthcheck: async () => true,
      log: () => {},
    };

    await runOnce(POOL, CONFIG, infra);
    expect(process.mock.calls[0]?.[2]).toEqual({ notify });

    process.mockClear();
    await runOnce(POOL, CONFIG, { ...infra, dryRun: true });
    expect(process.mock.calls[0]?.[2]).toEqual({ persist: false });
  });

  it("backoff: link po 3 próbach jest pomijany bez pipeline", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/backoff")],
      error: null,
    }));
    const process = vi.fn(async () => published());
    const events: Array<Record<string, unknown>> = [];

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process,
      getFailure: async () => ({
        source_url: "https://x/backoff",
        attempts: 3,
        last_stage: "gate",
        last_error: "429",
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      }),
      recordFailure: async () => {},
      clearFailure: async () => {},
      notify: async () => true,
      healthcheck: async () => true,
      log: (event) => events.push(event),
    });

    expect(process).not.toHaveBeenCalled();
    expect(report.dropped_silent).toBe(1);
    expect(events.some((event) => event.event === "dropped" && event.reason === "failure_backoff")).toBe(true);
  });

  it("błąd pipeline zapisuje porażkę, sukces czyści", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const recordFailure = vi.fn(async () => {});
    const clearFailure = vi.fn(async () => {});
    const infra = {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      getFailure: async () => null,
      recordFailure,
      clearFailure,
      notify: async () => true,
      healthcheck: async () => true,
      log: () => {},
    };

    await runOnce(POOL, CONFIG, {
      ...infra,
      process: vi.fn(async (): Promise<ArticleOutcome> => ({ status: "error", stage: "gate", error: "429" })),
    });
    expect(recordFailure).toHaveBeenCalledWith(POOL, {
      sourceUrl: "https://x/1",
      stage: "gate",
      error: "429",
    });

    await runOnce(POOL, CONFIG, { ...infra, process: vi.fn(async () => published()) });
    expect(clearFailure).toHaveBeenCalledWith(POOL, "https://x/1");
  });

  it("wysyła jedno podsumowanie i pinguje healthcheck start/success", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const notifySpy = vi.fn(async (_text: string) => true);
    const hc: string[] = [];

    await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(async () => published()),
      getFailure: async () => null,
      recordFailure: async () => {},
      clearFailure: async () => {},
      notify: notifySpy,
      healthcheck: async (state) => {
        hc.push(state);
        return true;
      },
      log: () => {},
    });

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]?.[0]).toContain("published: 1");
    expect(hc).toEqual(["start", "success"]);
  });

  it("alert trafia do tej samej wiadomości przy 3+ błędach", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [1, 2, 3].map((i) => candidate("s1", `https://x/${i}`)),
      error: null,
    }));
    const notifySpy = vi.fn(async (_text: string) => true);

    await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(async (): Promise<ArticleOutcome> => ({ status: "error", stage: "gate", error: "429" })),
      getFailure: async () => null,
      recordFailure: async () => {},
      clearFailure: async () => {},
      notify: notifySpy,
      healthcheck: async () => true,
      log: () => {},
    });

    expect(notifySpy.mock.calls[0]?.[0]).toContain("ALERT");
  });

  it("dry-run nie woła notify/healthcheck/failure store", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const notifySpy = vi.fn(async (_text: string) => true);
    const hcSpy = vi.fn(async () => true);
    const getFailureSpy = vi.fn(async () => null);

    await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(async (): Promise<ArticleOutcome> => ({ status: "dry_run", wouldBe: "published", via: "direct" })),
      dryRun: true,
      getFailure: getFailureSpy,
      notify: notifySpy,
      healthcheck: hcSpy,
      log: () => {},
    });

    expect(notifySpy).not.toHaveBeenCalled();
    expect(hcSpy).not.toHaveBeenCalled();
    expect(getFailureSpy).not.toHaveBeenCalled();
  });

  it("soft timeout zatrzymuje run przed pipeline", async () => {
    let tick = 0;
    const base = 1_700_000_000_000;
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const process = vi.fn(async () => published());

    const report = await runOnce(POOL, { ...CONFIG, RUN_TIMEOUT_MS: 60_000 }, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process,
      getFailure: async () => null,
      recordFailure: async () => {},
      clearFailure: async () => {},
      notify: async () => true,
      healthcheck: async () => true,
      now: () => new Date(base + tick++ * 120_000),
      log: () => {},
    });

    expect(process).not.toHaveBeenCalled();
    expect(report.errors.join(" ")).toContain("timeout");
  });

  it("błąd failure-store nie wywala runu (event + licznik błędu)", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1")],
      error: null,
    }));
    const events: Array<Record<string, unknown>> = [];

    const report = await runOnce(POOL, CONFIG, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process: vi.fn(async (): Promise<ArticleOutcome> => ({ status: "error", stage: "gate", error: "429" })),
      getFailure: async () => null,
      recordFailure: async () => {
        throw new Error("permission denied for table article_failures");
      },
      clearFailure: async () => {},
      notify: async () => true,
      healthcheck: async () => true,
      log: (event) => events.push(event),
    });

    expect(report.errors).toEqual(["gate: 429"]);
    expect(events.some((event) => event.event === "failure_store_error" && event.op === "record")).toBe(true);
  });

  it("MAX_PROCESSED_PER_RUN pochodzi z configu (bez deps.maxProcessed)", async () => {
    const ingest = vi.fn(async () => ({
      sourceId: "s1",
      type: "rss" as const,
      candidates: [candidate("s1", "https://x/1"), candidate("s1", "https://x/2")],
      error: null,
    }));
    const process = vi.fn(
      async (): Promise<ArticleOutcome> => ({ status: "draft", articleId: "d", slug: "s", via: "direct" })
    );
    const events: Array<Record<string, unknown>> = [];

    const report = await runOnce(POOL, { ...CONFIG, MAX_PROCESSED_PER_RUN: 1 }, {
      loadSources: async () => [SOURCES[0]!],
      ingest,
      process,
      getFailure: async () => null,
      recordFailure: async () => {},
      clearFailure: async () => {},
      notify: async () => true,
      healthcheck: async () => true,
      log: (event) => events.push(event),
    });

    expect(process).toHaveBeenCalledTimes(1);
    expect(report.processed).toBe(1);
    expect(events.some((event) => event.event === "run_processed_limit")).toBe(true);
  });
});
