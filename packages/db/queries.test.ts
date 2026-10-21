import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  checkUrlDuplicate,
  fetchActiveSources,
  fetchHistoricalContext30d,
  getCategoryId,
  insertArticle,
  insertRejected,
  linkArticleTags,
  syncTags,
  type Queryable,
} from "./queries.js";

type Call = { sql: string; values?: unknown[] };

function makeDb(rows: QueryResultRow[] = []): { db: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
      calls.push({ sql, values });
      return { rows: rows as R[], rowCount: rows.length, command: "", oid: 0, fields: [] };
    },
  };
  return { db, calls };
}

const EVIL = "'; DROP TABLE articles;--";

describe("queries: parametryzacja i kontrakt SQL", () => {
  it("fetchActiveSources: tylko aktywne źródła, z nazwą i selektorem", async () => {
    const { db, calls } = makeDb([{ id: "s1", name: "AgFunder", url: "https://x", type: "rss", link_selector: null }]);
    const rows = await fetchActiveSources(db);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("AgFunder");
    expect(calls[0]?.sql).toContain("FROM sources");
    expect(calls[0]?.sql).toContain("is_active = true");
    expect(calls[0]?.sql).toContain("name");
    expect(calls[0]?.values).toBeUndefined();
  });

  it("checkUrlDuplicate: $1 i link trafia do values, nie do SQL", async () => {
    const { db, calls } = makeDb([{ found: 1 }]);
    const duplicate = await checkUrlDuplicate(db, EVIL);

    expect(duplicate).toBe(true);
    expect(calls[0]?.sql).toContain("FROM articles WHERE source_url = $1");
    expect(calls[0]?.sql).not.toContain("DROP TABLE");
    expect(calls[0]?.values).toEqual([EVIL]);
  });

  it("checkUrlDuplicate: brak wiersza = brak duplikatu", async () => {
    const { db } = makeDb([]);
    await expect(checkUrlDuplicate(db, "https://a.pl/x")).resolves.toBe(false);
  });

  it("fetchHistoricalContext30d: published z okna 30 dni, bez parametrów", async () => {
    const { db, calls } = makeDb();
    await fetchHistoricalContext30d(db);

    expect(calls[0]?.sql).toContain("status = 'published'");
    expect(calls[0]?.sql).toContain("INTERVAL '30 days'");
    expect(calls[0]?.sql).toContain("tech_summary");
    expect(calls[0]?.values).toBeUndefined();
  });

  it("insertRejected: powód w rejection_reason, nie w text_content", async () => {
    const { db, calls } = makeDb([{ id: "a1" }]);
    const id = await insertRejected(db, {
      title: "Krótki",
      sourceUrl: "https://a.pl/1",
      reason: "Tekst zbyt krótki (<800 znaków)",
      sourceId: null,
    });

    expect(id).toBe("a1");
    expect(calls[0]?.sql).toContain("rejection_reason");
    expect(calls[0]?.sql).not.toContain("text_content");
    expect(calls[0]?.sql).toContain("ON CONFLICT (source_url) DO NOTHING");
    expect(calls[0]?.values).toEqual(["Krótki", "https://a.pl/1", "Tekst zbyt krótki (<800 znaków)", null]);
  });

  it("getCategoryId: $1 po nazwie kategorii", async () => {
    const { db, calls } = makeDb([{ id: "c1" }]);
    await expect(getCategoryId(db, "Agroenergetyka")).resolves.toBe("c1");

    expect(calls[0]?.sql).toContain("FROM categories WHERE name = $1");
    expect(calls[0]?.values).toEqual(["Agroenergetyka"]);
  });

  it("insertArticle: status jako parametr, JSONB stringify, guard na rejected", async () => {
    const { db, calls } = makeDb([{ id: "a2" }]);
    const id = await insertArticle(db, {
      status: "published",
      sourceId: "s1",
      categoryId: "c1",
      title: "Tytuł",
      slug: "tytul",
      sourceUrl: "https://a.pl/2",
      imageUrl: "https://media.kombain.pl/articles/tytul.webp",
      textHtml: "<p>Treść</p>",
      tldr: ["a", "b", "c"],
      techSummary: { podmiot: "X", technologia: "Y", cel_wdrozenia: "Z" },
    });

    expect(id).toBe("a2");
    const sql = calls[0]?.sql ?? "";
    expect(sql).toContain("ON CONFLICT (source_url) DO UPDATE");
    expect(sql).toContain("WHERE articles.status <> 'rejected'");
    expect(sql).toContain("published_at");
    expect(calls[0]?.values?.[2]).toBe("published");
    expect(calls[0]?.values?.[8]).toBe(JSON.stringify(["a", "b", "c"]));
    expect(calls[0]?.values?.[11]).toBe(false);
  });

  it("syncTags: lowercase + dedupe po slug, ON CONFLICT (slug)", async () => {
    const { db, calls } = makeDb([{ id: "t1", name: "drony", slug: "drony" }]);
    const tags = await syncTags(db, [
      { name: "Drony", slug: "DRONY" },
      { name: " drony ", slug: "drony" },
      { name: "RTK", slug: "rtk" },
    ]);

    expect(tags).toHaveLength(2);
    expect(tags[0]).toEqual({ id: "t1", name: "drony", slug: "drony" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("ON CONFLICT (slug) DO UPDATE");
    expect(calls[0]?.values).toEqual(["drony", "drony"]);
    expect(calls[1]?.values).toEqual(["rtk", "rtk"]);
  });

  it("linkArticleTags: ON CONFLICT DO NOTHING, oba id w values", async () => {
    const { db, calls } = makeDb();
    await linkArticleTags(db, "a1", "t1");

    expect(calls[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(calls[0]?.values).toEqual(["a1", "t1"]);
  });

  it("źródło queries.ts nie zawiera interpolacji SQL", () => {
    const source = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
    expect(source).not.toContain("{{");
    expect(source).not.toContain("${");
  });
});
