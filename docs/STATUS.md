# STATUS — kombain.pl

## Działa
- Harness: AGENTS.md + docs/plans.md + opencode.jsonc (Deepseek V4.1 Flash default, runtime Gemini)
- F1-T1: DDL + pakiet DB — `packages/db/{schema.sql,index.ts,queries.ts,slug.ts}`, 8 zapytań parametryzowanych, slugify PL; testy: 32 unit + 30 PG (postgres:16)
- F1-T2: baza `kombain` na VPS (5 tabel, 6 kategorii, 3 źródła), Directus 10.13 repointowany, 5 kolekcji z metadanymi, rola `Public API` + token (200/403); kit `deploy/` (init-db, register-collections, seed, runbook); `article_tags.id` PK + `UNIQUE(article_id, tag_id)`
- F2-T1: `ingestion.ts` — `routeSource`, normalizacja URL (utm/fbclid/gclid, `&amp;`, fragmenty), RSS (rss-parser), scraper (ScrapingAnt + cheerio, selektor z DB), dedupe + limit 15; 20 testów bez sieci
- F2-T2: `scraper.ts` — smart fetch (UA 10 s → fallback ScrapingAnt przy 403/429/503/CF), Readability (linkedom), `og:image`, hard filter 800 → `rejected`, nie-2xx/ściana po fallbacku → `error`; 20 testów bez sieci
- F2-T3: `llm.ts + gatekeeper` — prompt 30 dni, `GATEKEEPER_RESPONSE_SCHEMA`, `classifyArticle` (accepted/rejected/error); 16 testów bez API
- F2-T4: `editor + review + factcheck` — 1 szablon × 6 person, sanityzacja HTML, R1 (lokalny + LLM, max 1 retry), R2 (atomy, wycinanie inference), R3 (search grounding; `refuted` → draft, `uncertain` → draft + needs_human_check); 35 + 4 testy
- F2-T5: `media.ts` + `persist` — sharp 1200×675 webp80 → R2, fallback default kategorii; transakcja z savepointem, slug + suffix, tag sync, stany `published`/`draft`/`rejected`/`dropped`/`blocked`; 30 testów PG + 8 media
- F2-T6: `orchestrator + pipeline + index + config` — dedupe run-level, `p-limit(5)`, stop po `MAX_PUBLISHED_PER_RUN=2`, log JSONL (w tym ciche porzucenia), liczniki `fallback_used`/`image_fallback_used`/`source_errors`; Dockerfile + `deploy/worker.compose.yml` + cron z `flock`; 25 testów (pipeline 12 + orchestrator 9 + config 4)

- F2-T7a: CLI workera — `run --dry-run` (bez media/save/reject, `wouldBe`), `--url` (pojedynczy link), `--limit/--max-links/--source-id`, `preview-prompt` (gate/editor/r1/r2/r3 z tych samych builderów), `check-env` (maskowane); `scripts/worker-run.sh`; 18 testów CLI

- F2-T7b: obserwowalność — Telegram (jedno podsumowanie/run + ALERT przy `errors>=3`/wszystkich źródłach/soft timeout), healthchecks start/success/fail, `worker_fatal` z alertem, twardy timeout 30 min w cronie, `MAX_PROCESSED_PER_RUN` + soft deadline, `article_failures` (backoff 3 próby/7 dni) + migracja; 211 unit + 33 PG
- F2-T9b: R3 recall tuning — query builder (encje/liczby/rok, granica słowa), bramka trafności + SERP fallback, warunkowy Fetch dla search i SERP, metryki `verify_*` w `run_summary`, `VERIFY_MAX_ATOMS`; 285 unit + 33 PG, Reviewer 4/3 Approve
- F2-T10a: research/factcheck recall hardening — wspólny `search/query.ts` (encje, stoplista ALL-CAPS, akronimy na początku zdania), druga kwerenda researchu z encji tytułu/tekstu, `raw[1..4]` + mapowanie `source_index`, `reason` w kodzie (`search_error`/`no_evidence`/`max_atoms_cap`/`judge_uncertain`), częściowe `verify_*` przy błędzie R3; 307 unit + 33 PG
- F2-T10b: feedback plumbing — `RepairIssue`/`EditorFeedback` w promptcie Redaktora (poprzedni JSON, issues, bezpieczny evidence_url, cięcie HTML po blokach), R1 `regenerate(issues, previousArticle)`, sync `article.content_html` po sanityzacji i `stripInferences`, pełne `issues` (`refuted` + URL + `uncertain`), `repairIssues`, `verifyMaxAtoms` z configu, `verify_*` w dry-run, `skipDuplicateCheck` dla `--dry-run --url`; 319 unit + 33 PG
- F2-T10c: bounded repair loop — `REPAIR_MAX_ATTEMPTS=1` z configu, pętla `reviewOnce`, repair po R2/R3 z feedbackiem, deterministyczne guardy długości (≥600 dla pre≥600) i nowych encji, `coveredByResearch` z guardem encji + 75% rdzeni, metryki `repair_*` (także dry-run), AGENTS §2.7–2.8; 345 unit + 33 PG
- F3-T1: `apps/web` Astro SSR + `@astrojs/cloudflare` — `/`, `/kategoria/[slug]`, `/artykul/[slug]`, `404`, `directus.ts` (read-only, filtry, cache `s-maxage=3600`), layout/karty/TL;DR/Tech summary, link „Źródło:” z kodu; 300 unit + 33 PG, `astro build` w verify
- F3-T2: R2/defaulty/webhook — 6 webp 1200×675 w `apps/worker/assets/defaults`, skrypt `upload-defaults.ts` (walidacja sharp + `defaults/*.webp` na R2), `uploadToR2` współdzielony z media, runbook §15 (`media.kombain.pl`, Directus → Pages deploy hook, purge cache); 349 unit + 33 PG
- Hotfix po A/B: repair guard nie blokuje pojedynczych nazw własnych/openerów (liczby, akronimy i nazwy wielowyrazowe nadal blokują); 11 ważnych dry-runów AgFunder: 5 published / 6 draft, repair 8/2/6; 356 unit + 33 PG
- OPS: `deploy/scripts/release-worker.sh` — jednokomendowy transfer + build + check-env + upload defaultów (bez sekretów w repo); brak SSH z dev-harness, skrypt do uruchomienia przez użytkownika
- F3-T3a: `package-lock.json` w roocie monorepo (deterministyczny build Cloudflare Pages, zweryfikowane czystym `npm ci`, Astro 4.16.19 bez zmiany zależności) + 3 pozycje WEB w `plans.md` (`KIEDYŚ`: Astro 5, paginacja, dark mode)
- F3-T3b: `apps/web` responsywny szkielet mobile-first (320–2560 px), `tokens.css`/`global.css` (`--color-*`, `color-scheme: light`, `clamp()`, kontrast ≥4.5:1, `:focus-visible`, `prefers-reduced-motion`), `SiteHeader` (menu mobilne z `aria-expanded` + `Escape`, tap targety ≥44 px), fallback okładek `defaults/{slug}.webp` + `fetchpriority="high"`, TL;DR nad treścią, `TechSummary` tabela/karty, SEO (OG + Twitter Cards + `noindex` 404), `.env.example` bez wartości; 360 unit + 28/28 viewport audit (mock Directus, live `cms.kombain.pl` odroczone do `.env`)

## W trakcie
- (pusto)

## Następne (z plans.md TERAZ)
- OPS (VPS): lokalne A/B + wdrożenie F2-T9b + F2-T10a/b/c i pomiar

## Hotfixy po pierwszym runie na VPS
- dry_run loguje `stage/needsHumanCheck/issues`
- `stripInferences` usuwa wszystkie wystąpienia, fuzzy ≥0.75 z ochroną atomów supported/external
- prompt R2 wymaga **dosłownego cytatu bez tagów HTML** (maks. 20 atomów) — parafrazy powodowały 6/6 draftów
- **F2-T8 research**: Bramkarz → research → Redaktor z briefem i zakazem nowych faktów; atomy pokryte briefem pomijają R3
- **F2-T8b**: research na DeepSeek Search (2 kwerendy) + dystylacja Flash-Lite (URL z indeksu wyniku), fallback SERP (ScrapingAnt + DDG), alert przy błędzie; `SEARCH_PROVIDER=gemini` rollback
- **F2-T9**: R3 na DeepSeek — Search na claim → top-5 dowodów → Fetch przy pustych summary → Flash-Lite sędzia (indeks→URL, cap 8), fallback SERP, `VERIFY_PROVIDER=gemini` rollback
