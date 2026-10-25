# STATUS — kombain.pl

## Działa
- Harness: AGENTS.md + docs/plans.md + opencode.jsonc (Deepseek V4.1 Flash default, runtime Gemini)
- F1-T1: DDL + pakiet DB — `packages/db/{schema.sql,index.ts,queries.ts,slug.ts}`, 8 zapytań parametryzowanych, slugify PL; testy: 32 unit + 22 PG (postgres:16)
- F1-T2: baza `kombain` na VPS (5 tabel, 6 kategorii, 3 źródła), Directus 10.13 repointowany, 5 kolekcji z metadanymi, rola `Public API` + token (200/403); kit `deploy/` (init-db, register-collections, seed, runbook); `article_tags.id` PK + `UNIQUE(article_id, tag_id)`

## W trakcie
- (pusto)

## Następne (z plans.md TERAZ)
- F2-T1 `ingestion.ts`
- F2-T2 `scraper.ts`
