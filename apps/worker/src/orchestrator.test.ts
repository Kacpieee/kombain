import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import type { SourceForIngestion } from "./services/ingestion.js";
import { runOnce } from "./orchestrator.js";
import type { ArticleOutcome } from "./pipeline.js";

const POOL = {} as Pool;
const CONFIG: AppConfig = {
  DIRECT_DATABASE_URL: "postgres://x",
  GEMINI_API_KEY: "k",
  GEMINI_LITE_MODEL: "lite",
  GEMINI_PRO_MODEL: "pro",
  SCRAPINGANT_API_KEY: undefined,
  MAX_PUBLISHED_PER_RUN: 2,
  MAX_LINKS_PER_SOURCE: 15,
  FETCH_CONCURRENCY: 5,
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
});
