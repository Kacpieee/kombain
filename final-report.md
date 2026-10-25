# Final report — F2-T6 (`orchestrator + pipeline + index + config + Docker`)

## Status
Done (Mode: CRITICAL)

## Summary
Pipeline end-to-end: źródła → linki (dedupe run-level, `p-limit(5)`, limit 15/źródło) → dedup URL w DB → scrape → Bramkarz → Redaktor → review R1/R2/R3 → media → persist, ze stopem po `MAX_PUBLISHED_PER_RUN=2` i logiem JSONL. Powstał też obraz Docker workera i compose z cronem.

## Changes
- `apps/worker/src/config.ts` — Zod env: limity (2/15/5), modele, `R2_*`; twarde wymagania `DIRECT_DATABASE_URL` + `GEMINI_API_KEY`
- `apps/worker/src/pipeline.ts` — `processArticle`: `url_duplicate` → silent, scrape `<800` → `rejected`, `!is_relevant` → `rejected`, `is_duplicate` → silent, błąd Redaktora → `draft + needs_human_check` (temat nie ginie), review `draft` → `draft`, `published` → media + persist; `via` do licznika fallbacku
- `apps/worker/src/orchestrator.ts` — `runOnce`: fan-out źródeł, dedupe run-level, sekwencyjny pipeline ze stopem po limicie, liczniki (`published/rejected/draft/dropped_silent/errors/fallback_used/source_errors`), JSONL `source_error`/`article`/`run_summary`
- `apps/worker/src/index.ts` — CLI: config → pool → run → `pool.end()`, exit 1 tylko na fatal
- `apps/worker/Dockerfile`, `.dockerignore`, `deploy/worker.compose.yml`, `deploy/README.md` §11 (env, build, cron co 6 h, grep `run_summary`)
- Testy: `pipeline.test.ts` (12), `orchestrator.test.ts` (9), `config.test.ts` (4) — bez sieci/DB/LLM
- `docs/plans.md` (F2-T6 usunięty, TERAZ → F3-T1), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **162 passed, 0 failed, 30 skipped** (slug 12 + queries 10 + ingestion 31 + scraper 20 + gatekeeper 16 + review 35 + factcheck 4 + media 8 + export 1 + pipeline 12 + orchestrator 9 + config 4)
- PG-docker: **30 passed** (bez zmian)
- Zero sieci w testach pipeline/orchestrator (wstrzykiwane scrape/classify/synthesize/review/media/save/reject)

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 3 blokery (sprzeczna receptura Docker/cron; brak logu JSONL dla cichych porzuceń; martwy `MAX_LINKS_PER_SOURCE`)
  - Runda 2: **Approve** — 0 blokerów; mutacje potwierdziły, że maxLinks, log dropów i `image_fallback_used` są pokryte testami
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Błąd Bramkarza nie tworzy wiersza (brak kategorii dla `draft` przy `category_id` wymaganym przez CHECK) — link wróci w kolejnym runie, o ile nadal jest w źródle; licznik `errors` w logu.
- `MAX_PUBLISHED_PER_RUN` (max 2) i `FETCH_CONCURRENCY` (max 5) są twarde w Zod; `MAX_LINKS_PER_SOURCE` przekazywany do ingestion z twardym capem 15.
- Pipeline przetwarza artykuły sekwencyjnie (fan-out tylko na źródłach) — prostsze egzekwowanie limitu, wolniejsze przy wielu linkach.
- `main()` ustawia `process.exitCode = 0` także przy błędach źródła/artykułu (raport w logu); cron nie alertuje.
- Dedup URL jest status-blind, więc istniejący `draft` blokuje automatyczny retry (konflikt AGENTS §2.8 vs Dokumentacja §2) — do decyzji przy cutoverze.
- `is_duplicate` → ciche porzucenie (§2.8) vs Dokumentacja §4 KROK 3 (wiersz `rejected`) — wybrano §2.8; do potwierdzenia.
- Docker: `bun install` bez lockfile (brak w repo) — niereprodukowalne wersje; osobny task.
- Cron używa `flock -n`, więc nakładające się runy są blokowane; brak timeoutu LLM nadal grozi zawieszeniem pojedynczego runu.
- `buildSourceLink` nadal niepodłączony w pipeline — atrybucja źródła do zrobienia w F3.
- `index.ts` (exit code, `pool.end()`), `FETCH_CONCURRENCY` i realny `docker build` nie mają testów — weryfikacja na VPS.
- Brak testów regresyjnych dla: capów configu (`50 → throw`), `remaining` w `run_limit_reached`, logu `run_duplicate` (mutacje przechodzą na zielono).
- `R2_*` w `config.ts` są nieużywane — `media.ts` czyta `process.env` bezpośrednio (dwa źródła prawdy).
- Kopia repo na VPS przez `tar` wymaga jawnego `.dockerignore` (dodane do komendy); `.git` nie jest kopiowany.
- Run na żywych źródłach (limit 1–2) nie został wykonany — wymaga sekretów VPS; obowiązkowy przed włączeniem crona.

## Out of scope (celowo nietknięte)
- Astro (F3), R2 defaulty (F3-T2), deploy na VPS (po stronie użytkownika), lockfile, alerting.

## Next steps
- F3-T1: Astro Hybrid + `directus.ts` (read-only token) + `/`, `/kategoria/[slug]`, `/artykul/[slug]` + Cache headers.
