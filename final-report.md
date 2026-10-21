# Final report — F1-T2 kit (baza `kombain` + seed + runbook Directus)

## Status
Done with risks (Mode: CRITICAL) — część repo-side gotowa i przetestowana; wykonanie na VPS należy do użytkownika (brak dostępu SSH z tego środowiska).

## Summary
Powstał wykonywalny kit deployu: idempotentny `init-db.sh` z allowlistą bazy `kombain` (zero `DROP`, zero operacji na `n8n`/`postgres`/kcal), seed 3 działających źródeł RSS, zapytania weryfikacyjne oraz runbook repointu Directusa 10.13 z backupem, preflightem rotacji hasła i pełnym rollbackiem.

## Changes
- `deploy/scripts/init-db.sh` — allowlist `kombain` (+`KOMBAIN_ALLOW_TEST_DB=1` dla `kombain_test*`), preflight połączenia superusera, detekcja 5 tabel przez `to_regclass`, stop przy częściowym schemacie, test logowania ownera (pg_hba), `--seed` = tylko seed, odrzucanie nieznanego pierwszego argumentu (`--seed` jedyną flagą)
- `deploy/sql/seed-sources.sql` — AgFunderNews, Future Farming, PrecisionAg (HTTP 200 + itemy); `ON CONFLICT (url) DO NOTHING`
- `deploy/sql/verify.sql` — liczniki tabel + constrainty; `to_regclass` zamiast `::regclass`
- `deploy/README.md` — placeholdery zamiast IP/ścieżek, backup `pg_dump`, preflight `DB_POSTGRESDB_USER` + `pg_stat_activity`, trzy pola env, rollback z przywróceniem hasła roli, fallback „Refresh schema”, 403 **albo** 200 puste
- `packages/db/schema.pg.test.ts` — +2 testy seeda (idempotencja, brak nadpisania `is_active=false`)
- `.gitignore` — `deploy/.env`, `deploy/*.local.yml`
- `docs/plans.md`, `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass** (brak sekretów; seed i verify bez interpolacji)
- tsc --noEmit: **pass**
- vitest: **32 passed, 0 failed, 21 skipped** (PG gated)
- PG-docker (podman, `postgres:16`): **21 passed, 0 failed**
- E2E `init-db.sh`: default → 5 tabel, 6 kategorii, 3 źródła, 2 constrainty; `--seed` → bez zmian; `KOMBAIN_DB=kombain_db` → **exit 1**; `kombain_test_1` bez gate → **exit 1**, z gate → OK; w kontenerze tylko `kombain`, `kombain_test_1`, `n8n`, `postgres`

## Review Loop Audit
- Liczba rund Reviewera: 3
- Przebieg rund:
  - Runda 1: Request changes — 5 blokerów (allowlist bazy, `DB_PASSWORD`, rollback hasła, preflight n8n, brak `pg_dump`)
  - Runda 2: Request changes — 2 blokery (rollback nadal nie przywracał hasła roli; niespójny final-report)
  - Runda 3: **Approve** (0 blokerów; 6 ryzyk nieblokujących)
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Rotacja hasła `kombain_user` wymaga przywrócenia hasła roli przy rollbacku (sekcja 9 runbooka); okno niedostępności CMS = kilkadziesiąt sekund.
- Preflight `pg_stat_activity` widzi tylko żywe sesje — połączenia on-demand spoza n8n nie będą wykryte.
- `init-db.sh` nie tworzy ról (świadomie) i zakłada `local ... trust` w `pg_hba.conf`; przy innym auth skrypt zatrzyma się z czytelnym komunikatem.
- Directus 10.13 na PG 16.14 — kompatybilność niepotwierdzona w repo; rollback = przywrócenie hasła roli + compose + restart Directusa (okno kilkudziesięciu sekund).
- `scripts/verify.sh` maskuje kody wyjścia `tsc`/`vitest` pipe'em — bug zastany, poza scope; liczby potwierdzone osobnymi uruchomieniami.
- Stara `kombain_db` czeka na `pg_dump` po stronie VPS (komenda w runbooku, sekcja 2).

## Out of scope (celowo nietknięte)
- Wykonanie na VPS (baza/Directus/token) — po stronie użytkownika.
- Upgrade Directusa do 11, `media.ts`/R2, prompty/LLM, `apps/web`, KIEDYŚ.
- Bazy `n8n`, `postgres`, stack kcal (kontener `kcal-*`, port 5433).

## Next steps
1. Lokalnie: `tar | ssh` z sekcji 1 runbooka.
2. VPS: `bash deploy/scripts/init-db.sh` (baza + schemat + seed) → wklej output weryfikacji.
3. VPS: preflight n8n, `\password kombain_user`, zmiana 3 pól w compose, restart Directusa, logi.
4. UI: relacje, rola `Public API`, token → env VPS.
5. Po zielonej weryfikacji: F1-T2 zamknięty, kolejka → F2-T1 `ingestion.ts`.
