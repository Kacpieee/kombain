# Final report — F1-T1 (DDL + pakiet DB)

## Status
Done (Mode: CRITICAL)

## Summary
Powstała warstwa DB: DDL z Dokumentacji §3.1 + 2 zatwierdzone rozszerzenia (`needs_human_check`, `chk_articles_category`), 8 parametryzowanych zapytań z nieodwracalnym `rejected` i retry `draft` przez `ON CONFLICT`, `slugify` PL oraz `withTransaction`. Testy: 32 unit + 19 integracyjnych PG na `postgres:16`.

## Changes
- `packages/db/schema.sql` — 5 tabel, 3 indeksy, seed 6 kategorii (`ON CONFLICT (slug) DO NOTHING`)
- `packages/db/queries.ts` — 8 zapytań (`$n`, bez interpolacji); `insertArticle` z guardem `WHERE articles.status <> 'rejected'`
- `packages/db/index.ts` — `createPool` + `withTransaction` (BEGIN/COMMIT/ROLLBACK, `release` w `finally`)
- `packages/db/slug.ts` — slugify PL; re-export przez `@kombain/db/slug` w `apps/worker/src/services/ingestion.ts`
- `apps/worker/src/services/ingestion.ts` — `parseSynthesisJson` z brace-scanning (fence/proza/klamy)
- Testy: `packages/db/{slug,queries,schema.pg}.test.ts`, `apps/worker/src/services/ingestion.test.ts`
- `scripts/db-test.sh` — jednorazowy `postgres:16` (docker/podman, port 55432, tmpfs, trap)
- Root: `package.json` (test/test:db/typecheck), `tsconfig.json`, `vitest.config.ts`
- `docs/plans.md` (usunięty F1-T1), `docs/STATUS.md`, `.gitignore` (`docs/vps-inventory.md`)
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0, RESULT: PASS)
- guardrails (sekrety/SQL): **pass** (brak sekretów; brak `{{ }}` i `${` w queries.ts)
- tsc --noEmit: **pass**
- vitest: **32 passed, 0 failed, 19 skipped** (3 pliki)
- PG-docker (podman, `postgres:16`): **19 passed, 0 failed** (`scripts/db-test.sh`)

## Review Loop Audit
- Liczba rund Reviewera: 1
- Przebieg rund:
  - Runda 1: **Approve** (0 blokerów; 7 ryzyk nieblokujących)
- Ostatni werdykt (po ostatniej edycji plików i ostatnim verify.sh): **Approve**

## Risks
- `checkUrlDuplicate` jest status-blind (zgodnie z §4): wiersz `draft` blokuje ponowne przetworzenie — ścieżka retry draftu wymaga decyzji na poziomie pipeline'u (F2-T2).
- Teoretyczne `published → draft` zostawia `published_at`; w praktyce nieosiągalne (dedup), do dopięcia w F2-T5.
- `extractFirstJson` akceptuje też `[`, więc proza `[1]` przed JSON-em może zwrócić tablicę — łapie to walidacja Zod downstream.
- `scripts/verify.sh` maskuje kody wyjścia `tsc`/`vitest` przez pipe (`| head`, `| tail`) — bug zastany, poza scope; do naprawy w osobnym tasku.
- `package-lock.json` niecommitowany (repo deklaruje `packageManager: bun@1`, brak locka jak dotychczas).

## Out of scope (celowo nietknięte)
- F1-T2 Directus/token/seed źródeł, `media.ts`/R2, prompty, `apps/web`, `deploy/`, wszystkie KIEDYŚ.
- VPS nietknięty: żadnych `CREATE DATABASE`, `DROP`, restartów kontenerów.

## Next steps
- F1-T2: Directus — nowa baza `kombain`, role, relacje wizualne, rola read-only + token, seed 2–3 źródeł.
- F1-T3 (KIEDYŚ, do werdyktu): deploy na VPS wg `docs/vps-inventory.md` (lokalny, gitignored).
