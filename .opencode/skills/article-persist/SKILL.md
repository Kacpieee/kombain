---
name: article-persist
description: DDL + 8 zapytań SQL + tag sync + R2 media + stany draft-vs-rejected. Użyj przy zapisie artykułów z upsertem po source_url. Nie używaj do projektowania innego schematu (np. sklepu).
---

# Article-persist

## Wejście
- `EditorOut + {sourceId,sourceUrl,categoryId}` → `article_id`.

## Procedura
1. DDL `packages/db/schema.sql`: `categories/sources/articles/tags/article_tags`, `slug UNIQUE`, `image_url`, `rejection_reason`, `needs_human_check`, `CHECK status IN (published,rejected,draft)`.
2. 8 zapytań `queries.ts` tylko `$1` (bez `{{ }}`): `fetchActiveSources, checkUrlDuplicate, fetchHistoricalContext30d, insertRejected, getCategoryId, insertArticle ON CONFLICT(source_url) DO UPDATE, syncTags ON CONFLICT(slug), linkArticleTags`.
3. Slugify PL + suffix przy kolizji. `sanitize-html` przed zapisem.
4. Media: `og:image` → `sharp 1200x675 webp80` → R2, fail → default kategorii.
5. Transakcja `BEGIN/COMMIT`. `draft` retry przez `DO UPDATE`, `rejected` tylko permanentne.

## Testy
- Retry nie robi dubli. `category_id NOT NULL`. Tagi PL bez dubli.
