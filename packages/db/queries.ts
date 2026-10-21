import type { Pool } from "pg";

// 8 zapytań 1:1 z n8n, tylko parametry dolarowe. Dokumentacja §4 + §3.

export const fetchActiveSources = (db: Pool) =>
  db.query<{ id: string; url: string; type: string; link_selector: string | null }>(
    `SELECT id, url, type, link_selector FROM sources WHERE is_active = true`
  );

export const checkUrlDuplicate = (db: Pool, link: string) =>
  db.query<{ czujnik_duplikatu: string }>(
    `SELECT COUNT(id) AS czujnik_duplikatu FROM articles WHERE source_url = $1`,
    [link]
  );

export const fetchHistoricalContext = (db: Pool) =>
  db.query<{ title: string; tech_summary: unknown }>(
    `SELECT title, tech_summary FROM articles WHERE status = 'published' AND created_at > NOW() - INTERVAL '30 days'`
  );

export const insertRejected = (db: Pool, p: { title: string; link: string; reason: string; sourceId: string | null }) =>
  db.query(
    `INSERT INTO articles (title, source_url, status, text_content, source_id)
     VALUES ($1, $2, 'rejected', $3, $4) ON CONFLICT (source_url) DO NOTHING`,
    [p.title, p.link, p.reason, p.sourceId]
  );

export const getCategoryId = (db: Pool, name: string) =>
  db.query<{ id: string }>(`SELECT id FROM categories WHERE name = $1 LIMIT 1`, [name]);

export const insertArticle = (
  db: Pool,
  p: { sourceId: string | null; title: string; textHtml: string; tldr: unknown; techSummary: unknown; sourceUrl: string; categoryId: string }
) =>
  db.query<{ id: string }>(
    `INSERT INTO articles (source_id, title, text_content, tldr, tech_summary, status, source_url, category_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'published', $6, $7)
     ON CONFLICT (source_url) DO UPDATE SET
       title = EXCLUDED.title, text_content = EXCLUDED.text_content,
       tldr = EXCLUDED.tldr, tech_summary = EXCLUDED.tech_summary
     RETURNING id`,
    [p.sourceId, p.title, p.textHtml, JSON.stringify(p.tldr), JSON.stringify(p.techSummary), p.sourceUrl, p.categoryId]
  );

export const upsertDraft = (
  db: Pool,
  p: { sourceId: string | null; title: string; textHtml: string; sourceUrl: string; reason: string }
) =>
  db.query<{ id: string }>(
    `INSERT INTO articles (source_id, title, text_content, status, source_url, rejection_reason, needs_human_check)
     VALUES ($1, $2, $3, 'draft', $4, $5, true)
     ON CONFLICT (source_url) DO UPDATE SET
       title = EXCLUDED.title, text_content = EXCLUDED.text_content,
       rejection_reason = EXCLUDED.rejection_reason, needs_human_check = true
     RETURNING id`,
    [p.sourceId, p.title, p.textHtml, p.sourceUrl, p.reason]
  );

export const linkArticleTags = (db: Pool, articleId: string, tagId: string) =>
  db.query(`INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [articleId, tagId]);
