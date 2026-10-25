import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import {
  checkUrlDuplicate,
  fetchActiveSources,
  fetchHistoricalContext30d,
  getCategoryId,
  insertArticle,
  insertRejected,
  linkArticleTags,
  syncTags,
} from "./queries.js";
import { createPool, withTransaction } from "./index.js";
import { clearFailure, getFailure, recordFailure, shouldSkipFailure } from "./failures.js";
import { rejectArticle, saveArticle } from "./persist.js";
import type { Pool } from "pg";

const connectionString = process.env.TEST_DATABASE_URL;
const describePg = connectionString ? describe : describe.skip;

const BASE = {
  status: "published" as const,
  sourceId: null,
  categoryId: "",
  title: "Test",
  slug: "test",
  imageUrl: null,
  textHtml: "<p>Treść</p>",
  tldr: ["a", "b", "c"],
  techSummary: { podmiot: "P", technologia: "T", cel_wdrozenia: "C" },
};

describePg("PG: schema + 8 zapytań (integracja)", () => {
  let db: Client;
  let txPool: Pool;
  let categoryId: string;

  beforeAll(async () => {
    txPool = createPool(connectionString);
    db = new Client({ connectionString });
    await db.connect();
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    await db.query(schema);
    const { rows } = await db.query<{ id: string }>("SELECT id FROM categories WHERE slug = 'agroenergetyka'");
    categoryId = rows[0]!.id;
  });

  afterAll(async () => {
    await db.end();
    await txPool.end();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE article_tags, articles, tags, sources, article_failures RESTART IDENTITY CASCADE");
    const { rows } = await db.query<{ id: string }>("SELECT id FROM categories WHERE slug = 'agroenergetyka'");
    categoryId = rows[0]!.id;
  });

  async function insertSource(name: string, type: "rss" | "scraper" = "rss", active = true): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sources (name, url, type, link_selector, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, `https://example.com/${name}`, type, type === "scraper" ? "article a" : null, active]
    );
    return rows[0]!.id;
  }

  it("seed: 6 kategorii ze słownika Bramkarza", async () => {
    const { rows } = await db.query<{ name: string; slug: string }>("SELECT name, slug FROM categories ORDER BY name");
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.name)).toEqual([
      "Agroenergetyka",
      "AI i Automatyzacja",
      "Biotechnologia i Nauka",
      "Biznes AgTech i Prawo",
      "Inteligentne Maszyny i Drony",
      "Rolnictwo Precyzyjne",
    ]);
  });

  it("seed jest idempotentny (re-run nie duplikuje)", async () => {
    await db.query(
      `INSERT INTO categories (name, slug, description) VALUES ('Agroenergetyka', 'agroenergetyka', 'x')
       ON CONFLICT (slug) DO NOTHING`
    );
    const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM categories");
    expect(rows[0]!.count).toBe("6");
  });

  it("CHECK status: tylko published/rejected/draft", async () => {
    await expect(
      db.query(
        `INSERT INTO articles (status, title, source_url) VALUES ('garbage', 'T', 'https://a.pl/bad')`
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("CHECK category: published bez kategorii odrzucony", async () => {
    await expect(
      db.query(
        `INSERT INTO articles (status, title, source_url) VALUES ('published', 'T', 'https://a.pl/no-cat')`
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("CHECK category: rejected bez kategorii dozwolony", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO articles (status, title, source_url, rejection_reason)
       VALUES ('rejected', 'T', 'https://a.pl/rejected-ok', 'Tekst zbyt krótki') RETURNING id`
    );
    expect(rows[0]!.id).toBeTruthy();
  });

  it("insertRejected zapisuje powód, RETURING id i nie dubluje po source_url", async () => {
    const id = await insertRejected(db, {
      title: "Krótki",
      sourceUrl: "https://a.pl/short",
      reason: "Tekst zbyt krótki (<800 znaków)",
      sourceId: null,
    });
    const again = await insertRejected(db, {
      title: "Krótki",
      sourceUrl: "https://a.pl/short",
      reason: "Tekst zbyt krótki (<800 znaków)",
      sourceId: null,
    });

    expect(id).toBeTruthy();
    expect(again).toBeNull();
    const { rows } = await db.query<{ status: string; rejection_reason: string; text_content: string | null }>(
      "SELECT status, rejection_reason, text_content FROM articles WHERE id = $1",
      [id]
    );
    expect(rows[0]!.status).toBe("rejected");
    expect(rows[0]!.rejection_reason).toBe("Tekst zbyt krótki (<800 znaków)");
    expect(rows[0]!.text_content).toBeNull();
  });

  it("insertArticle: published ustawia published_at i needs_human_check=false", async () => {
    const id = await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Drony RTK",
      slug: "drony-rtk",
      sourceUrl: "https://a.pl/drony-rtk",
    });

    const { rows } = await db.query<{ status: string; published_at: Date | null; needs_human_check: boolean; tldr: unknown }>(
      "SELECT status, published_at, needs_human_check, tldr FROM articles WHERE id = $1",
      [id]
    );
    expect(rows[0]!.status).toBe("published");
    expect(rows[0]!.published_at).toBeInstanceOf(Date);
    expect(rows[0]!.needs_human_check).toBe(false);
    expect(rows[0]!.tldr).toEqual(["a", "b", "c"]);
  });

  it("insertArticle: retry published aktualizuje ten sam wiersz (ON CONFLICT)", async () => {
    const first = await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Wersja 1",
      slug: "wersja-1",
      sourceUrl: "https://a.pl/retry",
    });
    const second = await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Wersja 2",
      slug: "wersja-2",
      sourceUrl: "https://a.pl/retry",
    });

    expect(second).toBe(first);
    const { rows } = await db.query<{ count: string; title: string; slug: string }>(
      "SELECT COUNT(*)::text AS count, MIN(title) AS title, MIN(slug) AS slug FROM articles WHERE source_url = 'https://a.pl/retry'"
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("insertArticle: draft → published przechodzi, ustawia published_at", async () => {
    const draftId = await insertArticle(db, {
      ...BASE,
      status: "draft",
      categoryId,
      title: "Szkic",
      slug: "szkic",
      sourceUrl: "https://a.pl/draft-to-pub",
      needsHumanCheck: true,
    });
    const publishedId = await insertArticle(db, {
      ...BASE,
      status: "published",
      categoryId,
      title: "Publikacja",
      slug: "publikacja",
      sourceUrl: "https://a.pl/draft-to-pub",
    });

    expect(publishedId).toBe(draftId);
    const { rows } = await db.query<{ status: string; published_at: Date | null; needs_human_check: boolean }>(
      "SELECT status, published_at, needs_human_check FROM articles WHERE id = $1",
      [draftId]
    );
    expect(rows[0]!.status).toBe("published");
    expect(rows[0]!.published_at).toBeInstanceOf(Date);
    expect(rows[0]!.needs_human_check).toBe(false);
  });

  it("insertArticle: rejected blokuje retry (nie wskrzesza wiersza)", async () => {
    const rejectedId = await insertRejected(db, {
      title: "Odrzucony",
      sourceUrl: "https://a.pl/rejected-retry",
      reason: "is_relevant=false",
      sourceId: null,
    });
    const attempt = await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Próba publikacji",
      slug: "proba",
      sourceUrl: "https://a.pl/rejected-retry",
    });

    expect(attempt).toBeNull();
    const { rows } = await db.query<{ status: string; title: string }>(
      "SELECT status, title FROM articles WHERE id = $1",
      [rejectedId]
    );
    expect(rows[0]!.status).toBe("rejected");
    expect(rows[0]!.title).toBe("Odrzucony");
  });

  it("getCategoryId: istniejąca i nieistniejąca kategoria", async () => {
    await expect(getCategoryId(db, "Agroenergetyka")).resolves.toBe(categoryId);
    await expect(getCategoryId(db, "Nie ma takiej")).resolves.toBeNull();
  });

  it("syncTags: idempotentny, lowercase, PL bez dubli", async () => {
    const first = await syncTags(db, [
      { name: "Drony", slug: "drony" },
      { name: "Rolnictwo Precyzyjne", slug: "rolnictwo-precyzyjne" },
    ]);
    const second = await syncTags(db, [
      { name: "DRONY", slug: "DRONY" },
      { name: "rolnictwo precyzyjne", slug: "rolnictwo-precyzyjne" },
    ]);

    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
    const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM tags");
    expect(rows[0]!.count).toBe("2");
    expect(first.map((t) => t.name)).toContain("rolnictwo precyzyjne");
  });

  it("linkArticleTags: idempotentny po parze (article_id, tag_id)", async () => {
    const articleId = await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Z tagami",
      slug: "z-tagami",
      sourceUrl: "https://a.pl/tags",
    });
    const [tag] = await syncTags(db, [{ name: "drony", slug: "drony" }]);

    await linkArticleTags(db, articleId!, tag!.id);
    await linkArticleTags(db, articleId!, tag!.id);

    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM article_tags WHERE article_id = $1",
      [articleId]
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("article_tags: duplikat pary rzuca 23505, wiersz ma UUID id", async () => {
    const articleId = await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Para",
      slug: "para",
      sourceUrl: "https://a.pl/para",
    });
    const [tag] = await syncTags(db, [{ name: "rtk", slug: "rtk" }]);

    await linkArticleTags(db, articleId!, tag!.id);

    await expect(
      db.query("INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2)", [articleId, tag!.id])
    ).rejects.toMatchObject({ code: "23505" });

    const { rows } = await db.query<{ id: string }>("SELECT id FROM article_tags WHERE article_id = $1", [articleId]);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("fetchHistoricalContext30d: tylko published z 30 dni", async () => {
    await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Świeży",
      slug: "swiezy",
      sourceUrl: "https://a.pl/fresh",
    });
    await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Stary",
      slug: "stary",
      sourceUrl: "https://a.pl/old",
    });
    await db.query("UPDATE articles SET created_at = NOW() - INTERVAL '40 days' WHERE slug = 'stary'");
    await insertRejected(db, {
      title: "Odrzucony",
      sourceUrl: "https://a.pl/rejected-ctx",
      reason: "x",
      sourceId: null,
    });

    const rows = await fetchHistoricalContext30d(db as never);
    const titles = rows.map((r) => r.title);
    expect(titles).toContain("Świeży");
    expect(titles).not.toContain("Stary");
    expect(titles).not.toContain("Odrzucony");
  });

  it("fetchActiveSources: pomija nieaktywne, zwraca name i selector", async () => {
    await insertSource("aktywne-rss", "rss", true);
    await insertSource("nieaktywne-rss", "rss", false);
    await insertSource("aktywne-scraper", "scraper", true);

    const rows = await fetchActiveSources(db as never);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(["aktywne-rss", "aktywne-scraper"]);
    expect(rows.find((r) => r.name === "aktywne-scraper")?.link_selector).toBe("article a");
  });

  it("checkUrlDuplicate: wykrywa rejected (dedup blokuje ponowienie)", async () => {
    await insertRejected(db, {
      title: "Odrzucony",
      sourceUrl: "https://a.pl/dup-rejected",
      reason: "x",
      sourceId: null,
    });
    await expect(checkUrlDuplicate(db, "https://a.pl/dup-rejected")).resolves.toBe(true);
    await expect(checkUrlDuplicate(db, "https://a.pl/nie-ma")).resolves.toBe(false);
  });

  it("slug UNIQUE: kolizja slug rzuca 23505", async () => {
    await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Pierwszy",
      slug: "kolizja",
      sourceUrl: "https://a.pl/kolizja-1",
    });
    await expect(
      insertArticle(db, {
        ...BASE,
        categoryId,
        title: "Drugi",
        slug: "kolizja",
        sourceUrl: "https://a.pl/kolizja-2",
      })
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("withTransaction: rollback nie zostawia wiersza", async () => {
    await expect(
      withTransaction(txPool, async (client) => {
        await client.query(
          `INSERT INTO articles (status, title, source_url, category_id) VALUES ('published', 'TX', 'https://a.pl/tx-rollback', $1)`,
          [categoryId]
        );
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM articles WHERE source_url = 'https://a.pl/tx-rollback'"
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("withTransaction: commit utrwala i zwraca wynik", async () => {
    const result = await withTransaction(txPool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO articles (status, title, source_url, category_id) VALUES ('published', 'TX', 'https://a.pl/tx-commit', $1) RETURNING id`,
        [categoryId]
      );
      return rows[0]!.id;
    });

    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM articles WHERE id = $1",
      [result]
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("seed-sources.sql: 3 źródła RSS i re-run bez dubli", async () => {
    const seed = readFileSync(new URL("../../deploy/sql/seed-sources.sql", import.meta.url), "utf8");

    await db.query(seed);
    await db.query(seed);

    const { rows } = await db.query<{ name: string; type: string; is_active: boolean }>(
      "SELECT name, type, is_active FROM sources ORDER BY name"
    );
    expect(rows.map((r) => r.name)).toEqual(["AgFunderNews", "Future Farming", "PrecisionAg"]);
    expect(rows.every((r) => r.type === "rss" && r.is_active)).toBe(true);
  });

  it("seed nie nadpisuje ręcznie wyłączonego źródła", async () => {
    const seed = readFileSync(new URL("../../deploy/sql/seed-sources.sql", import.meta.url), "utf8");

    await db.query(seed);
    await db.query("UPDATE sources SET is_active = false WHERE name = 'PrecisionAg'");
    await db.query(seed);

    const { rows } = await db.query<{ is_active: boolean; total: string }>(
      "SELECT is_active, (SELECT COUNT(*)::text FROM sources) AS total FROM sources WHERE name = 'PrecisionAg'"
    );
    expect(rows[0]!.is_active).toBe(false);
    expect(rows[0]!.total).toBe("3");
  });

  it("saveArticle: published z tagami, obrazem i published_at", async () => {
    const result = await saveArticle(txPool, {
      status: "published",
      sourceId: null,
      sourceUrl: "https://a.pl/persist-pub",
      categoryName: "Agroenergetyka",
      title: "Agri-PV w praktyce",
      contentHtml: "<p>Treść</p>",
      tldr: ["a", "b", "c"],
      techSummary: { podmiot: "P", technologia: "T", cel_wdrozenia: "C" },
      imageUrl: "https://media.kombain.pl/articles/agri-pv.webp",
      tags: ["Agri-PV", "agri-pv", "OZE"],
    });

    expect(result).toMatchObject({ status: "published", slug: "agri-pv-w-praktyce" });
    if (result.status !== "published") return;

    const { rows } = await db.query<{
      status: string;
      published_at: Date | null;
      category_id: string;
      image_url: string;
      count: string;
    }>(
      `SELECT a.status, a.published_at, a.category_id, a.image_url,
              (SELECT COUNT(*)::text FROM article_tags t WHERE t.article_id = a.id) AS count
       FROM articles a WHERE a.id = $1`,
      [result.articleId]
    );
    expect(rows[0]!.status).toBe("published");
    expect(rows[0]!.published_at).toBeInstanceOf(Date);
    expect(rows[0]!.category_id).toBe(categoryId);
    expect(rows[0]!.image_url).toContain("media.kombain.pl");
    expect(rows[0]!.count).toBe("2");
  });

  it("saveArticle: draft ma needs_human_check i brak published_at", async () => {
    const result = await saveArticle(txPool, {
      status: "draft",
      sourceId: null,
      sourceUrl: "https://a.pl/persist-draft",
      categoryName: "Agroenergetyka",
      title: "Szkic",
      contentHtml: "<p>Treść</p>",
      needsHumanCheck: true,
    });

    expect(result.status).toBe("draft");
    if (result.status !== "draft") return;

    const { rows } = await db.query<{ published_at: Date | null; needs_human_check: boolean; status: string }>(
      "SELECT published_at, needs_human_check, status FROM articles WHERE id = $1",
      [result.articleId]
    );
    expect(rows[0]).toMatchObject({ published_at: null, needs_human_check: true, status: "draft" });
  });

  it("saveArticle: kolizja sluga → 4-znakowy suffix, oba wiersze zostają", async () => {
    const first = await saveArticle(txPool, {
      status: "published",
      sourceId: null,
      sourceUrl: "https://a.pl/slug-1",
      categoryName: "Agroenergetyka",
      title: "Ten sam tytuł",
      contentHtml: "<p>A</p>",
    });
    const second = await saveArticle(txPool, {
      status: "published",
      sourceId: null,
      sourceUrl: "https://a.pl/slug-2",
      categoryName: "Agroenergetyka",
      title: "Ten sam tytuł",
      contentHtml: "<p>B</p>",
    });

    expect(first.status).toBe("published");
    expect(second.status).toBe("published");
    if (second.status !== "published") return;
    expect(second.slug).toMatch(/^ten-sam-tytul-[a-z0-9]{4}$/);

    const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM articles");
    expect(rows[0]!.count).toBe("2");
  });

  it("saveArticle: kategoria spoza enuma → blocked, bez wiersza", async () => {
    const result = await saveArticle(txPool, {
      status: "published",
      sourceId: null,
      sourceUrl: "https://a.pl/bad-category",
      categoryName: "Rolnictwo",
      title: "Zła kategoria",
      contentHtml: "<p>A</p>",
    });

    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toContain("Rolnictwo");

    const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM articles");
    expect(rows[0]!.count).toBe("0");
  });

  it("saveArticle: rejected blokuje retry (dropped, stary wiersz nietknięty)", async () => {
    await rejectArticle(txPool, {
      title: "Odrzucony",
      sourceUrl: "https://a.pl/persist-rejected",
      reason: "is_relevant=false",
      sourceId: null,
    });
    const result = await saveArticle(txPool, {
      status: "published",
      sourceId: null,
      sourceUrl: "https://a.pl/persist-rejected",
      categoryName: "Agroenergetyka",
      title: "Próba",
      contentHtml: "<p>A</p>",
    });

    expect(result.status).toBe("dropped");
    const { rows } = await db.query<{ status: string; title: string }>(
      "SELECT status, title FROM articles WHERE source_url = 'https://a.pl/persist-rejected'"
    );
    expect(rows[0]).toMatchObject({ status: "rejected", title: "Odrzucony" });
  });

  it("saveArticle: retry tego samego URL aktualizuje wiersz (bez dubli)", async () => {
    const first = await saveArticle(txPool, {
      status: "draft",
      sourceId: null,
      sourceUrl: "https://a.pl/persist-retry",
      categoryName: "Agroenergetyka",
      title: "Wersja 1",
      contentHtml: "<p>A</p>",
    });
    const second = await saveArticle(txPool, {
      status: "published",
      sourceId: null,
      sourceUrl: "https://a.pl/persist-retry",
      categoryName: "Agroenergetyka",
      title: "Wersja 2",
      contentHtml: "<p>B</p>",
    });

    expect(first.status).toBe("draft");
    expect(second.status).toBe("published");
    if (first.status !== "draft" || second.status !== "published") return;
    expect(second.articleId).toBe(first.articleId);

    const { rows } = await db.query<{
      status: string;
      title: string;
      slug: string;
      published_at: Date | null;
      needs_human_check: boolean;
    }>("SELECT status, title, slug, published_at, needs_human_check FROM articles WHERE id = $1", [second.articleId]);

    expect(rows[0]).toMatchObject({
      status: "published",
      title: "Wersja 2",
      slug: "wersja-2",
      needs_human_check: false,
    });
    expect(rows[0]!.published_at).toBeInstanceOf(Date);

    const { rows: countRows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM articles");
    expect(countRows[0]!.count).toBe("1");
  });

  it("saveArticle: piąta kolizja sluga → blocked bez wyjątku i bez nowego wiersza", async () => {
    await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Ten sam tytuł",
      slug: "ten-sam-tytul",
      sourceUrl: "https://a.pl/collision-1",
    });
    await insertArticle(db, {
      ...BASE,
      categoryId,
      title: "Ten sam tytuł",
      slug: "ten-sam-tytul-0000",
      sourceUrl: "https://a.pl/collision-2",
    });

    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const result = await saveArticle(txPool, {
        status: "published",
        sourceId: null,
        sourceUrl: "https://a.pl/collision-3",
        categoryName: "Agroenergetyka",
        title: "Ten sam tytuł",
        contentHtml: "<p>A</p>",
      });

      expect(result).toEqual({ status: "blocked", reason: "Nie udało się dobrać unikalnego slug" });
    } finally {
      random.mockRestore();
    }

    const { rows } = await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM articles");
    expect(rows[0]!.count).toBe("2");

    const next = await saveArticle(txPool, {
      status: "published",
      sourceId: null,
      sourceUrl: "https://a.pl/collision-4",
      categoryName: "Agroenergetyka",
      title: "Inny tytuł",
      contentHtml: "<p>B</p>",
    });
    expect(next.status).toBe("published");
  });

  it("rejectArticle: duplikat URL → dropped bez nowego wiersza", async () => {
    const first = await rejectArticle(txPool, {
      title: "Krótki",
      sourceUrl: "https://a.pl/reject-dup",
      reason: "Tekst zbyt krótki (<800 znaków)",
      sourceId: null,
    });
    const second = await rejectArticle(txPool, {
      title: "Krótki 2",
      sourceUrl: "https://a.pl/reject-dup",
      reason: "x",
      sourceId: null,
    });

    expect(first.dropped).toBe(false);
    expect(first.articleId).toBeTruthy();
    expect(second.dropped).toBe(true);
    expect(second.articleId).toBeNull();
  });

  it("article_failures: record inkrementuje attempts, get zwraca wpis", async () => {
    await recordFailure(db, { sourceUrl: "https://a.pl/f1", stage: "gate", error: "429" });
    await recordFailure(db, { sourceUrl: "https://a.pl/f1", stage: "scrape", error: "403" });

    const row = await getFailure(db, "https://a.pl/f1");
    expect(row).toMatchObject({ attempts: 2, last_stage: "scrape", last_error: "403" });
    expect(shouldSkipFailure(row)).toBe(false);
  });

  it("article_failures: 3 próby aktywują backoff, clearFailure czyści", async () => {
    for (const stage of ["scrape", "gate", "editor"]) {
      await recordFailure(db, { sourceUrl: "https://a.pl/f2", stage, error: `${stage} error` });
    }

    const row = await getFailure(db, "https://a.pl/f2");
    expect(row?.attempts).toBe(3);
    expect(shouldSkipFailure(row)).toBe(true);

    await clearFailure(db, "https://a.pl/f2");
    await expect(getFailure(db, "https://a.pl/f2")).resolves.toBeNull();
  });

  it("article_failures: wpis starszy niż 7 dni nie liczy się do backoffu", async () => {
    await recordFailure(db, { sourceUrl: "https://a.pl/f3", stage: "gate", error: "x" });
    await db.query("UPDATE article_failures SET last_seen_at = NOW() - INTERVAL '8 days' WHERE source_url = 'https://a.pl/f3'");

    await expect(getFailure(db, "https://a.pl/f3")).resolves.toBeNull();
  });
});
