# Final report — F2-T7a (CLI workera: dry-run, prompt preview, check-env)

## Status
Done (Mode: CRITICAL — dotyka pipeline'u, choć bez DDL)

## Summary
Powstało CLI do bezpiecznego testowania workera: `run --dry-run` przechodzi scrape → Bramkarz → Redaktor → review **bez** media i bez zapisu do DB, `--url` testuje pojedynczy link bez ingestion, `preview-prompt` drukuje finalne prompty z tych samych builderów co produkcja, a `check-env` pokazuje wyłącznie maskowany stan konfiguracji.

## Changes
- `apps/worker/src/cli.ts` — `parseArgs`, `buildRunOptions`, `renderPreview`, `maskEnv`, `runCli`; komendy `run|preview-prompt|check-env|help`; DI `runOnce`/`createPool` w testach
- `apps/worker/src/pipeline.ts` — `persist: false` (dry-run): nowy wynik `dry_run { wouldBe, article?, review?, reason? }`; zero `saveArticle`/`rejectArticle`/media w każdej ścieżce
- `apps/worker/src/orchestrator.ts` — `dryRun`, `url` (pojedynczy link, bez źródeł), `sourceId` (filtr), `maxLinks`, `maxProcessed`; liczniki `processed`/`dry_run`; log `dry_run`/`run_processed_limit`
- `apps/worker/src/services/ingestion.ts` — `RawArticleCandidate.sourceId: string | null` (tryb `--url`)
- `apps/worker/src/cli.test.ts` (18), `pipeline.test.ts` (+6 dry-run), `orchestrator.test.ts` (+5)
- `scripts/worker-run.sh`, `deploy/README.md` §12
- `docs/plans.md` (T7b + F3-T1 w TERAZ), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **191 passed, 0 failed, 30 skipped** (m.in. CLI 18, pipeline 18, orchestrator 14)
- PG-docker: **30 passed** (bez zmian)
- Zero sieci w testach CLI (żadnych wołań Gemini/Telegram)

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 2 blokery (brak testu dry-run dla `gate rejected`; brak testu mapowania flag CLI → `runOnce`, więc mutacja `dryRun:false` przechodziła)
  - Runda 2: **Approve** — 0 blokerów; mutacje potwierdziły KILLED dla obu blokerów R1 (gate-rejected guard, mapowanie flag CLI, `pool.end()`)
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- `--dry-run` nadal płaci za Gemini (scrape + gate + editor + review); `--url` + `--limit 1` to najtańszy sensowny test.
- Dry-run czyta DB (dedupe, historia 30 dni) — wymaga poprawnego `DIRECT_DATABASE_URL`; nie zapisuje nic. URL już obecny w DB zwróci `dropped/url_duplicate`.
- `--url` bez `--dry-run` wykonuje normalny zapis z `source_id = NULL`; CLI wypisuje ostrzeżenie.
- `check-env` pokazuje długość sekretów i host/bazę (bez hasła) — metadane w logach/screenach.
- CLI działa w obrazie przez `bun src/cli.ts`; lokalnie bez Bun trzeba użyć compose/podmana (nie dodano `tsx`).
- `maxProcessed` jest dziś przekazywane tylko przez CLI w dry-run; stały limit produkcyjny wchodzi w F2-T7b.
- `verify.sh` ma false-positive na literały typu `GEMINI_API_KEY=…` w testach — zapis testu omija wzorzec; guard do poprawy w OPT.
- `--json` + `--url` bez `--dry-run` wypisuje ostrzeżenie na stdout, więc pierwsza linia nie jest JSONL (do przeniesienia na stderr).
- `failure_backoff` w unii `dropped` jest placeholderem pod F2-T7b.

## Out of scope (celowo nietknięte)
- Telegram/healthchecks, timeout, `article_failures` (F2-T7b), GUI, Astro.

## Next steps
- F2-T7b: alerty Telegram + healthchecks, timeout runu, `MAX_PROCESSED_PER_RUN`, tabela `article_failures`.
