# Final report — F2-T7b (alerty, timeout, backoff)

## Status
Done (Mode: CRITICAL — DDL + sekrety + logika runu)

## Summary
Worker przestał być „niewidoczny”: po każdym runie wysyła jedno podsumowanie na Telegram (z alertem przy `errors>=3` lub awarii wszystkich źródeł), pinguje healthchecks (start/success/fail), ma twardy timeout w cronie, limit przetworzonych linków i soft deadline, a linki, które padły 3 razy, są pomijane przez 7 dni.

## Changes
- `packages/db/schema.sql` + `deploy/sql/migrate-article-failures.sql` — tabela `article_failures` (+ indeks)
- `packages/db/failures.ts` — `getFailure`, `recordFailure` (`attempts+1`), `clearFailure`, `shouldSkipFailure` (3 próby / 7 dni); eksport `@kombain/db/failures`
- `apps/worker/src/services/notify.ts` — Telegram (redakcja sekretów, rate-limit 1/min, no-op bez env), `formatRunSummary`, `shouldAlert`, `pingHealthcheck`
- `apps/worker/src/orchestrator.ts` — healthcheck start/success **wstrzykiwane** (bez ukrytego I/O), backoff przed pipeline, zapis/czyszczenie porażek, `MAX_PROCESSED_PER_RUN`, soft deadline `RUN_TIMEOUT_MS`, jedno podsumowanie/alert na run (timeout też podnosi ALERT); błędy failure-store nie wywalają runu
- `apps/worker/src/index.ts` — `handleFatal` (log + Telegram + `/fail`), wpięte realne `notify`/`healthcheck`
- `apps/worker/src/cli.ts` — realne alerty tylko poza dry-run
- `apps/worker/src/config.ts` — `MAX_PROCESSED_PER_RUN`, `RUN_TIMEOUT_MS`, `TELEGRAM_*`, `HEALTHCHECKS_PING_URL`
- `deploy/scripts/worker-cron.sh` — `timeout 1800` + alert/ping przy 124; README §11.4 i §13 (Telegram, healthchecks, backoff, migracja jako `kombain_user`)
- `deploy/sql/migrate-article-failures.sql` — `OWNER TO kombain_user` (spójność z rolą workera)
- Testy: `notify.test.ts` (11), `index.test.ts` (1, `handleFatal`), orchestrator +9 (backoff, record/clear, failure-store exception, notify/hc, alert, dry-run cisza, timeout, `MAX_PROCESSED` z configu), PG +3
- `docs/plans.md` (T7b usunięty, TERAZ → F3-T1), `docs/STATUS.md`, `.env.example`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **211 passed, 0 failed, 33 skipped**
- PG-docker (podman, `postgres:16`): **33 passed** (w tym 3 failures/backoff)
- Zero sieci: notify/healthcheck testowane przez wstrzykiwane `send`/`fetchImpl`; orkiestrator domyślnie **nie** woła I/O, realne alerty wpinają tylko `index.ts`/`cli.ts` (poza dry-run)

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 4 blokery (migracja jako `n8n` → brak DML dla `kombain_user`; brak testu wyjątku failure-store; brak testu `MAX_PROCESSED_PER_RUN` z configu; brak testu `worker_fatal`)
  - Runda 2: **Approve** — 0 blokerów; mutacje M1–M3b potwierdziły KILLED dla wszystkich poprawek z R1
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Telegram i healthchecks są best-effort — błąd wysyłki jest połykany (alert nie wywala runu, ale może zginąć).
- Rate-limit 1 wiadomość/min: podsumowanie i natychmiastowy `worker_fatal` w tej samej minucie → drugi alert może zostać pominięty.
- `healthcheck success` leci także przy błędach artykułów i po soft timeoucie (alert tylko w treści Telegrama); `/fail` pochodzi z fatala lub wrappera przy 124.
- Twardy timeout w cronie zabija `docker compose run`; kontener potomny może w skrajnym przypadku przeżyć — do potwierdzenia na VPS.
- Backoff kluczuje po `source_url`; po wygaśnięciu okna link dostaje jedną próbę (kolejny błąd znów daje 7 dni przerwy), a `attempts` nie resetuje się.
- Wygasłe wpisy `article_failures` nie są usuwane — rosną; czyszczenie w OPT.
- `RUN_TIMEOUT_MS` sprawdzany między artykułami; pojedyncze zawieszone LLM wymaga twardego timeoutu crona.
- Błędy failure-store trafiają tylko do JSONL (`failure_store_error`), nie do licznika `errors`/Telegramu.
- Wpięcie realnych `notify`/`healthcheck` w `index.ts`/`cli.ts` nie ma testu (mutacja przechodzi) — do domknięcia w OPT.
- Migracja `article_failures` nie jest wykonywana w testach PG (testy aplikują `schema.sql`); plik migracji może się rozjechać.
- `verify.sh` nie uruchamia testów PG (brak `TEST_DATABASE_URL`), więc `exit 0` nie obejmuje integracji — PG potwierdzane osobno (`scripts/db-test.sh`).

## Out of scope (celowo nietknięte)
- GUI, Grafana/Prometheus, alerty per `source_error`, F3.

## Next steps
- F3-T1: Astro Hybrid + `directus.ts` + `/`, `/kategoria/[slug]`, `/artykul/[slug]` + cache headers.

## Hotfix (po pierwszym dry-run na VPS)

`dry_run` w JSONL zawiera teraz `stage`, `needsHumanCheck` i `issues` z review — bez tego nie dało się ustalić, dlaczego artykuł kończy się draftem. Test regresyjny w `orchestrator.test.ts`; `verify.sh` exit 0, Reviewer Approve.

### Hotfix 2 (R2/atomy po pierwszym dry-run)

`stripInferences` usuwa teraz **wszystkie** wystąpienia wniosku (także warianty case/whitespace w tym samym węźle) i pokazuje w `issues` do 3 próbek nieusuniętych zdań. Review: 3 rundy (2 blokery cichych leftovers), końcowo Approve.
