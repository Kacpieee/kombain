# STATUS — kombain.pl

## Działa
- Harness: AGENTS.md + docs/plans.md + opencode.jsonc (Deepseek V4.1 Flash default, runtime Gemini)
- F1-T1: DDL + pakiet DB — `packages/db/{schema.sql,index.ts,queries.ts,slug.ts}`, 8 zapytań parametryzowanych, slugify PL; testy: 32 unit + 21 PG (postgres:16)
- F1-T2 kit: `deploy/scripts/init-db.sh` (create DB + schema + seed, zero DROP), `deploy/sql/{seed-sources,verify}.sql`, `deploy/README.md`; E2E sprawdzony na podmanie

## W trakcie
- F1-T2 na VPS: uruchomić `init-db.sh` (bez `--seed`), repoint Directusa 10.13 na `kombain`, relacje + rola read-only + token

## Następne (z plans.md TERAZ)
- F1-T2 (dokończenie na VPS)
- F2-T1 `ingestion.ts`
