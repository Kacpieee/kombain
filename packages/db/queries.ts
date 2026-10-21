import type { QueryResult, QueryResultRow } from "pg";

// 8 zapytań 1:1 z n8n, wyłącznie parametry dolarowe (Dokumentacja §3 + §4).

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export type SourceType = "rss" | "scraper";
export type ArticleStatus = "published" | "rejected" | "draft";

export interface SourceRow {
  id: string;
  name: string;
  url: string;
  type: SourceType;
  link_selector: string | null;
}

export interface TagInput {
  name: string;
  slug: string;
}

export interface TagRow {
  id: string;
  name: string;
  slug: string;
}

export interface InsertArticleInput {
  status: Exclude<ArticleStatus, "rejected">;
  sourceId: string | null;
  categoryId: string;
  title: string;
  slug: string | null;
  sourceUrl: string;
  imageUrl?: string | null;
  textHtml?: string | null;
  tldr?: unknown;
  techSummary?: unknown;
  rejectionReason?: string | null;
  needsHumanCheck?: boolean;
}

const json = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));

// 1. Aktywne źródła (ingestion.ts)
export async function fetchActiveSources(db: Queryable): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(
    `SELECT id, name, url, type, link_selector FROM sources WHERE is_active = true ORDER BY name`
  );
  return rows;
}

// 2. Deduplikacja URL przed scrapem (SELECT 1 ... LIMIT 1)
export async function checkUrlDuplicate(db: Queryable, sourceUrl: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 AS found FROM articles WHERE source_url = $1 LIMIT 1`, [sourceUrl]);
  return result.rowCount !== null && result.rowCount > 0;
}

// 3. Kontekst historyczny Bramkarza (30 dni, tylko published)
export async function fetchHistoricalContext30d(
  db: Queryable
): Promise<Array<{ title: string; tech_summary: unknown }>> {
  const { rows } = await db.query<{ title: string; tech_summary: unknown }>(
    `SELECT title, tech_summary FROM articles WHERE status = 'published' AND created_at > NOW() - INTERVAL '30 days'`
  );
  return rows;
}

// 4. Odrzut permanentny (za krótki / gatekeeper) — dedup blokuje ponowienie
export async function insertRejected(
  db: Queryable,
  p: { title: string; sourceUrl: string; reason: string; sourceId: string | null }
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO articles (title, source_url, status, rejection_reason, source_id)
     VALUES ($1, $2, 'rejected', $3, $4)
     ON CONFLICT (source_url) DO NOTHING
     RETURNING id`,
    [p.title, p.sourceUrl, p.reason, p.sourceId]
  );
  return rows[0]?.id ?? null;
}

// 5. Kategoria po nazwie z enuma Bramkarza
export async function getCategoryId(db: Queryable, name: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM categories WHERE name = $1 LIMIT 1`, [name]);
  return rows[0]?.id ?? null;
}

// 6. Zapis published/draft z retry po source_url; rejected jest nieodwracalny
export async function insertArticle(db: Queryable, p: InsertArticleInput): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO articles (
       source_id, category_id, status, title, slug, source_url,
       image_url, text_content, tldr, tech_summary, rejection_reason, needs_human_check, published_at
     )
     VALUES (
       $1, $2, $3::varchar, $4, $5, $6,
       $7, $8, $9::jsonb, $10::jsonb, $11, $12,
       CASE WHEN $3::varchar = 'published' THEN NOW() ELSE NULL END
     )
     ON CONFLICT (source_url) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       category_id = EXCLUDED.category_id,
       status = EXCLUDED.status,
       title = EXCLUDED.title,
       slug = EXCLUDED.slug,
       image_url = EXCLUDED.image_url,
       text_content = EXCLUDED.text_content,
       tldr = EXCLUDED.tldr,
       tech_summary = EXCLUDED.tech_summary,
       rejection_reason = EXCLUDED.rejection_reason,
       needs_human_check = EXCLUDED.needs_human_check,
       published_at = CASE WHEN EXCLUDED.status = 'published' THEN NOW() ELSE articles.published_at END
     WHERE articles.status <> 'rejected'
     RETURNING id`,
    [
      p.sourceId,
      p.categoryId,
      p.status,
      p.title,
      p.slug,
      p.sourceUrl,
      p.imageUrl ?? null,
      p.textHtml ?? null,
      json(p.tldr),
      json(p.techSummary),
      p.rejectionReason ?? null,
      p.needsHumanCheck ?? false,
    ]
  );
  return rows[0]?.id ?? null;
}

// 7. Upsert tagów po slug (lowercase + dedupe po slug)
export async function syncTags(db: Queryable, tags: TagInput[]): Promise<TagRow[]> {
  const normalized = new Map<string, string>();
  for (const tag of tags) {
    const slug = tag.slug.trim().toLowerCase();
    if (!slug || normalized.has(slug)) continue;
    normalized.set(slug, tag.name.trim().toLowerCase());
  }

  const result: TagRow[] = [];
  for (const [slug, name] of normalized) {
    const { rows } = await db.query<TagRow>(
      `INSERT INTO tags (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, slug`,
      [name, slug]
    );
    if (rows[0]) result.push(rows[0]);
  }
  return result;
}

// 8. Link artykuł–tag (idempotentny)
export async function linkArticleTags(db: Queryable, articleId: string, tagId: string): Promise<void> {
  await db.query(`INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    articleId,
    tagId,
  ]);
}
