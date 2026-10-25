# Final report — F1-T2 (Directus + baza `kombain` na VPS)

## Status
Done (Mode: CRITICAL) — wykonane na VPS przez użytkownika, potwierdzone outputami; repo dogoniło produkcję.

## Summary
Nowa baza `kombain` (5 tabel, 6 kategorii, 3 źródła) na istniejącym PostgreSQL 16, Directus 10.13 przestawiony z archiwalnej `kombain_db`, 5 kolekcji zarejestrowanych w metadanych, rola `Public API` + token read-only. `article_tags` dostał `id` PK wymagany przez Directusa.

## Changes (repo)
- `packages/db/schema.sql` — `article_tags.id UUID PK` + `UNIQUE(article_id, tag_id)` (zatwierdzona zmiana DDL)
- `packages/db/queries.ts` — `linkArticleTags` z `ON CONFLICT (article_id, tag_id) DO NOTHING`
- `packages/db/schema.pg.test.ts` — +1 test (duplikat pary → `23505`, `id` = UUID); 22/22
- `deploy/scripts/register-collections.sh` — idempotentna rejestracja 5 kolekcji przez `PATCH /collections/:name` z `meta` (POST zwraca 400 dla istniejących tabel); hasło przez `read -s`
- `deploy/README.md` — sekcja rejestracji kolekcji, relacje z FK, ograniczenie M2M, rola bez „User Type”, token przez `read -s`, troubleshooting „0 kolekcji”
- `docs/plans.md` (F1-T2 usunięty), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **32 passed, 0 failed, 22 skipped** (PG gated)
- PG-docker (podman, `postgres:16`): **22 passed, 0 failed**
- E2E `register-collections.sh` (Directus 10.13 + PG 16): run 1 i run 2 → 5/5 `ok`, `zarejestrowane: article_tags, articles, categories, sources, tags`, 29 tabel bez zmian
- VPS (potwierdzone przez użytkownika): `kombain` = 5 tabel / 6 kategorii / 3 źródeł; `kombain_db` = 29 tabel (nietknięta); `Public API`: `articles=200`, `sources=403`; dump `kombain_db` 93K, `TABLE DATA=29`, `DUMP OK`, SHA-256 zapisany

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 2 blokery (false-green rejestracji: PATCH nieistniejącej kolekcji tworzył fantom; token w historii powłoki + `>` obcinał `.env`)
  - Runda 2: **Approve** — 0 blokerów; blokery potwierdzone eksperymentalnie (m.in. usunięcie `ensure_table` odtwarza fantom, `DROP TABLE` → exit 3 bez PATCH)
- Po werdykcie: wyłącznie zmiany docs-only w `deploy/README.md` (eksport env przed `curl`, sekcja migracji legacy `article_tags`, ostrzeżenie o haśle w §9); zero zmian w kodzie/SQL/testach; `verify.sh` uruchomiony ponownie
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- **M2M alias „tags”** w widoku artykułu nie istnieje — Directus nie pozwala dopiąć junction do relacji wyprowadzonej z FK (403). Tagi: edycja przez kolekcję `article_tags`, odczyt przez `article_tags.tag_id.name`. Osobny task OPT.
- `PUBLIC_URL` warning w logach Directusa — kosmetyka, do dopisania w compose.
- Directus 10.13 jest 55 wersji za aktualną — upgrade osobnym taskiem.
- `scripts/verify.sh` nadal maskuje exit code `tsc`/`vitest` pipe'em; liczby potwierdzane osobno.
- Stara `kombain_db` czeka na decyzję o usunięciu po cutoverze (dump poza VPS do zrobienia po stronie użytkownika).
- Skrypt rejestracji nie wykrywa **zastanych** fantomów (`directus_collections` bez tabeli) — sprząta je tylko ręcznie; na VPS fantomów nie było (5/5 z `schema`).
- Brak indeksu po `article_tags.tag_id` — przyszłe „artykuły po tagu” zrobią seq scan; osobna zgoda na DDL, jeśli zajdzie potrzeba.

## Out of scope (celowo nietknięte)
- Upgrade Directusa, M2M alias, `media.ts`/R2, prompty/LLM, `apps/web`, F2+.
- Bazy `n8n`, `postgres`, stack kcal.

## Next steps
- F2-T1 `ingestion.ts` (rss-parser + ScrapingAnt + cheerio, max 15, normalizacja URL) + testy.
