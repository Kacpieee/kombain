import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    await db.query("TRUNCATE article_tags, articles, tags, sources RESTART IDENTITY CASCADE");
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

  it("linkArticleTags: idempotentny (ON CONFLICT DO NOTHING)", async () => {
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
});
