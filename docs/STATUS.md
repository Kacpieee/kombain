# STATUS — kombain.pl

## Działa
- Harness: AGENTS.md + docs/plans.md + opencode.jsonc (Deepseek V4.1 Flash default, runtime Gemini)
- F1-T1: DDL + pakiet DB — `packages/db/{schema.sql,index.ts,queries.ts,slug.ts}`, 8 zapytań parametryzowanych, slugify PL; testy: 32 unit + 29 PG (postgres:16)
- F1-T2: baza `kombain` na VPS (5 tabel, 6 kategorii, 3 źródła), Directus 10.13 repointowany, 5 kolekcji z metadanymi, rola `Public API` + token (200/403); kit `deploy/` (init-db, register-collections, seed, runbook); `article_tags.id` PK + `UNIQUE(article_id, tag_id)`
- F2-T1: `ingestion.ts` — `routeSource`, normalizacja URL (utm/fbclid/gclid, `&amp;`, fragmenty), RSS (rss-parser), scraper (ScrapingAnt + cheerio, selektor z DB), dedupe + limit 15; 20 testów bez sieci
- F2-T2: `scraper.ts` — smart fetch (UA 10 s → fallback ScrapingAnt przy 403/429/503/CF), Readability (linkedom), `og:image` z fallbackiem na obraz artykułu (`data-src`), hard filter 800 → `rejected`, nie-2xx i ściana po fallbacku → `error`; 20 testów bez sieci
- F2-T3: `llm.ts + gatekeeper` — `buildGatekeeperPrompt` (historia 30 dni, bez PocketBase), `GATEKEEPER_RESPONSE_SCHEMA` dla Gemini, `classifyArticle` z DI (accepted/rejected/error, kategoria spoza enuma → error); 16 testów bez API
- F2-T4: `editor + review + factcheck` — 1 szablon × 6 person, normalizacja tagów/sluga, sanityzacja HTML do allowlisty, R1 (lokalny + LLM, retry przez `regenerate`), R2 (atomy; inference bez dowodu wycinany), R3 (search grounding; refuted → draft, uncertain → draft+needs_human_check), `buildSourceLink` w kodzie; 35 testów review + 4 factcheck, bez API
- F2-T5: `media.ts` + `persist` — sharp 1200×675 webp80 → R2 `articles/{slug}.webp` z fallbackiem default kategorii; transakcja z savepointem, slug + 4-znakowy suffix przy kolizji, tag sync, `published`/`draft`/`rejected`/`dropped`/`blocked`; 30 testów PG (w tym 8 persistu) + 8 media

## W trakcie
- (pusto)

## Następne (z plans.md TERAZ)
- F2-T6 `orchestrator + pipeline + index + config + Dockerfile + cron VPS`
