import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { EditorOut } from "./prompts.js";
import { processArticle } from "./pipeline.js";
import type { PipelineOverrides } from "./pipeline.js";
import type { GatekeeperOutcome, EditorOutcome } from "./services/llm.js";
import type { ScrapeOutcome } from "./services/scraper.js";

const POOL = {} as Pool;
const CANDIDATE = { sourceId: "s1", originalTitle: "Oryginalny tytuł", sourceUrl: "https://example.com/a" };

const ARTICLE: EditorOut = {
  title: "Drony RTK",
  content_html: "<h2>Wstęp</h2><p>Treść</p>",
  tldr: ["a", "b", "c"],
  tags: ["drony"],
  tech_summary: { podmiot: "Firma", technologia: "drony", cel_wdrozenia: "oszczędność" },
  slug: "drony-rtk",
  external_refs: [],
};

const SCRAPED_OK: ScrapeOutcome = {
  status: "ok",
  article: {
    sourceUrl: CANDIDATE.sourceUrl,
    title: "Drony RTK",
    text: "Długi tekst źródłowy ".repeat(60),
    contentHtml: "<p>treść</p>",
    ogImage: "https://cdn.example.com/a.jpg",
    charCount: 1200,
    fetchedVia: "direct",
  },
};

const GATE_OK = {
  status: "accepted" as const,
  decision: {
    is_duplicate: false,
    is_relevant: true,
    reason: "ok",
    category: "Inteligentne Maszyny i Drony" as const,
  },
};

function base(overrides: PipelineOverrides = {}): PipelineOverrides {
  return {
    duplicateCheck: vi.fn(async () => false),
    scrape: vi.fn(async () => SCRAPED_OK),
    history: vi.fn(async () => []),
    classify: vi.fn(async () => GATE_OK),
    synthesize: vi.fn(async () => ({ status: "ok" as const, article: ARTICLE })),
    research: vi.fn(async () => ({ status: "ok" as const, facts: [] })),
    review: vi.fn(async () => ({
      status: "published" as const,
      needsHumanCheck: false,
      stage: null,
      issues: [],
      cleanedHtml: ARTICLE.content_html,
      removedInferences: [],
      external: [],
      article: ARTICLE,
    })),
    media: vi.fn(async () => ({ url: "https://media.kombain.pl/articles/drony-rtk.webp", via: "r2" as const })),
    save: vi.fn(async () => ({ status: "published" as const, articleId: "art-1", slug: "drony-rtk" })),
    reject: vi.fn(async () => ({ status: "rejected" as const, articleId: "rej-1", dropped: false })),
    ...overrides,
  };
}

describe("processArticle — ścieżki", () => {
  it("duplikat URL → dropped, bez scrapowania", async () => {
    const deps = base({ duplicateCheck: vi.fn(async () => true) });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toEqual({ status: "dropped", reason: "url_duplicate" });
    expect(deps.scrape).not.toHaveBeenCalled();
  });

  it("błąd scrape → error stage scrape", async () => {
    const deps = base({ scrape: vi.fn(async (): Promise<ScrapeOutcome> => ({ status: "error", sourceUrl: CANDIDATE.sourceUrl, error: "403", fetchedVia: null })) });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "error", stage: "scrape" });
  });

  it("tekst < 800 → rejected przez rejectArticle", async () => {
    const deps = base({
      scrape: vi.fn(async (): Promise<ScrapeOutcome> => ({
        status: "rejected",
        sourceUrl: CANDIDATE.sourceUrl,
        title: "Krótki",
        reason: "Tekst zbyt krótki (<800 znaków)",
        charCount: 100,
        text: "krótki",
        fetchedVia: "direct",
      })),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "rejected", articleId: "rej-1" });
    expect(deps.reject).toHaveBeenCalledWith(POOL, expect.objectContaining({ reason: "Tekst zbyt krótki (<800 znaków)" }));
  });

  it("błąd Bramkarza → error gate, bez wiersza", async () => {
    const deps = base({ classify: vi.fn(async (): Promise<GatekeeperOutcome> => ({ status: "error", error: "429" })) });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "error", stage: "gate" });
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.reject).not.toHaveBeenCalled();
  });

  it("is_relevant=false → rejected z powodem", async () => {
    const deps = base({
      classify: vi.fn(async (): Promise<GatekeeperOutcome> => ({
        status: "rejected",
        reason: "Ceny płodów rolnych",
        decision: { is_duplicate: false, is_relevant: false, reason: "Ceny płodów rolnych", category: "Agroenergetyka" },
      })),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result.status).toBe("rejected");
    expect(deps.reject).toHaveBeenCalledWith(POOL, expect.objectContaining({ reason: "Ceny płodów rolnych" }));
  });

  it("is_duplicate=true → ciche porzucenie (bez wiersza)", async () => {
    const deps = base({
      classify: vi.fn(async (): Promise<GatekeeperOutcome> => ({
        status: "rejected",
        reason: "ten sam podmiot",
        decision: { is_duplicate: true, is_relevant: true, reason: "ten sam podmiot", category: "Agroenergetyka" },
      })),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toEqual({ status: "dropped", reason: "semantic_duplicate" });
    expect(deps.reject).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("błąd Redaktora → draft z needs_human_check (temat nie ginie)", async () => {
    const deps = base({ synthesize: vi.fn(async (): Promise<EditorOutcome> => ({ status: "error", error: "timeout" })) });
    deps.save = vi.fn(async () => ({ status: "draft" as const, articleId: "draft-1", slug: "draft" }));
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "draft", articleId: "draft-1" });
    expect(deps.save).toHaveBeenCalledWith(
      POOL,
      expect.objectContaining({ status: "draft", needsHumanCheck: true, categoryName: "Inteligentne Maszyny i Drony" })
    );
  });

  it("review=draft → zapis draft z powodami i needs_human_check", async () => {
    const deps = base({
      review: vi.fn(async () => ({
        status: "draft" as const,
        needsHumanCheck: true,
        stage: "R3" as const,
        issues: ["uncertain: fakt"],
        cleanedHtml: ARTICLE.content_html,
        removedInferences: [],
        external: [],
        article: ARTICLE,
      })),
    });
    deps.save = vi.fn(async () => ({ status: "draft" as const, articleId: "draft-2", slug: "drony-rtk" }));
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "draft", articleId: "draft-2" });
    expect(deps.save).toHaveBeenCalledWith(
      POOL,
      expect.objectContaining({ status: "draft", needsHumanCheck: true, rejectionReason: "uncertain: fakt" })
    );
  });

  it("review=published → media + zapis published z tagami i obrazem", async () => {
    const deps = base();
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "published", articleId: "art-1", via: "direct" });
    expect(deps.media).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "drony-rtk", ogImage: "https://cdn.example.com/a.jpg" })
    );
    expect(deps.save).toHaveBeenCalledWith(
      POOL,
      expect.objectContaining({
        status: "published",
        imageUrl: "https://media.kombain.pl/articles/drony-rtk.webp",
        tags: ["drony"],
        title: "Drony RTK",
      })
    );
  });

  it("save=blocked → error persist", async () => {
    const deps = base();
    deps.save = vi.fn(async () => ({ status: "blocked" as const, reason: "Kategoria spoza enuma" }));
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "error", stage: "persist" });
  });

  it("save=dropped → dropped rejected_exists", async () => {
    const deps = base();
    deps.save = vi.fn(async () => ({ status: "dropped" as const, reason: "rejected" }));
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toEqual({ status: "dropped", reason: "rejected_exists" });
  });

  it("przekazuje regenerate do review (retry Redaktora)", async () => {
    let retried = 0;
    const deps = base();
    deps.review = vi.fn(async (_article, _text, options) => {
      if (!options?.regenerate) throw new Error("brak regenerate");
      const rebuilt = await options.regenerate(["popraw tytuł"]);
      expect(rebuilt).toBe(ARTICLE);
      retried += 1;
      return {
        status: "published" as const,
        needsHumanCheck: false,
        stage: null,
        issues: [],
        cleanedHtml: ARTICLE.content_html,
        removedInferences: [],
        external: [],
        article: rebuilt,
      };
    });

    const result = await processArticle(POOL, CANDIDATE, deps);
    expect(result.status).toBe("published");
    expect(retried).toBe(1);
    expect(deps.synthesize).toHaveBeenCalledTimes(2);
  });

  it("dry-run: published bez media i bez zapisu", async () => {
    const deps = base({ persist: false });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "dry_run", wouldBe: "published" });
    expect(deps.media).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.reject).not.toHaveBeenCalled();
  });

  it("dry-run: review=draft bez zapisu", async () => {
    const deps = base({
      persist: false,
      review: vi.fn(async () => ({
        status: "draft" as const,
        needsHumanCheck: true,
        stage: "R3" as const,
        issues: ["uncertain"],
        cleanedHtml: ARTICLE.content_html,
        removedInferences: [],
        external: [],
        article: ARTICLE,
      })),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "dry_run", wouldBe: "draft" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("dry-run: scrape < 800 nie tworzy rejected w DB", async () => {
    const deps = base({
      persist: false,
      scrape: vi.fn(async (): Promise<ScrapeOutcome> => ({
        status: "rejected",
        sourceUrl: CANDIDATE.sourceUrl,
        title: "Krótki",
        reason: "Tekst zbyt krótki (<800 znaków)",
        charCount: 100,
        text: "krótki",
        fetchedVia: "direct",
      })),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "dry_run", wouldBe: "rejected" });
    expect(deps.reject).not.toHaveBeenCalled();
  });

  it("dry-run: błąd Redaktora → wouldBe draft bez zapisu", async () => {
    const deps = base({
      persist: false,
      synthesize: vi.fn(async (): Promise<EditorOutcome> => ({ status: "error", error: "timeout" })),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "dry_run", wouldBe: "draft" });
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("dry-run: Bramkarz odrzuca temat bez zapisu rejected", async () => {
    const deps = base({
      persist: false,
      classify: vi.fn(
        async (): Promise<GatekeeperOutcome> => ({
          status: "rejected",
          reason: "Ceny płodów rolnych",
          decision: { is_duplicate: false, is_relevant: false, reason: "Ceny płodów rolnych", category: "Agroenergetyka" },
        })
      ),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "dry_run", wouldBe: "rejected", reason: "Ceny płodów rolnych" });
    expect(deps.reject).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.media).not.toHaveBeenCalled();
  });

  it("dry-run: błąd Bramkarza → error bez zapisu", async () => {
    const deps = base({
      persist: false,
      classify: vi.fn(async (): Promise<GatekeeperOutcome> => ({ status: "error", error: "429" })),
    });
    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result).toMatchObject({ status: "error", stage: "gate" });
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.reject).not.toHaveBeenCalled();
  });

  it("przekazuje research brief do Redaktora i review", async () => {
    const facts = [{ claim: "Rynek dronów wzrósł o 20% w 2025.", url: "https://example.com/raport", source_type: "research" }];
    const deps = base({ research: vi.fn(async () => ({ status: "ok" as const, facts })) });

    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result.status).toBe("published");
    expect(deps.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ researchBrief: facts, category: "Inteligentne Maszyny i Drony" })
    );
    expect(deps.review).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ researchBrief: facts })
    );
  });

  it("błąd researchu nie blokuje artykułu (brief pusty)", async () => {
    const deps = base({
      research: vi.fn(async () => ({ status: "error" as const, error: "402" })),
    });

    const result = await processArticle(POOL, CANDIDATE, deps);

    expect(result.status).toBe("published");
    expect(deps.synthesize).toHaveBeenCalledWith(expect.objectContaining({ researchBrief: [] }));
  });

  it("błąd researchu w realnym runie wysyła alert, w dry-run nie", async () => {
    const notify = vi.fn(async (_text: string) => true);
    const deps = base({
      research: vi.fn(async () => ({ status: "error" as const, error: "402 insufficient balance" })),
      notify,
    });

    await processArticle(POOL, CANDIDATE, deps);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain("research fallback");

    notify.mockClear();
    await processArticle(POOL, CANDIDATE, { ...deps, persist: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it("research jest wołany po Bramkarzu, przed Redaktorem", async () => {
    const deps = base();
    const order: string[] = [];
    deps.classify = vi.fn(async () => {
      order.push("gate");
      return GATE_OK;
    });
    deps.research = vi.fn(async () => {
      order.push("research");
      return { status: "ok" as const, facts: [] };
    });
    deps.synthesize = vi.fn(async () => {
      order.push("editor");
      return { status: "ok" as const, article: ARTICLE };
    });

    await processArticle(POOL, CANDIDATE, deps);
    expect(order).toEqual(["gate", "research", "editor"]);
  });
});
