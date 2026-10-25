# Final report — F2-T5 (`media.ts` + `persist`)

## Status
Done (Mode: CRITICAL)

## Summary
Powstał zapis artykułu w transakcji: kategoria z enuma → slug (+4-znakowy suffix przy kolizji) → insert/upsert po `source_url` → tagi (`ON CONFLICT (slug)`) → linki (`ON CONFLICT` para), ze stanami `published`/`draft`/`rejected` (duplikat → `dropped`, zła kategoria → `blocked`). Media: `og:image` → sharp 1200×675 webp q80 → R2 `articles/{slug}.webp`, każdy błąd → grafika domyślna kategorii.

## Changes
- `packages/db/persist.ts` — `saveArticle` (transakcja, SAVEPOINT na retry sluga, `rejected` blokuje), `rejectArticle`, `PersistOutcome`
- `packages/db/schema.pg.test.ts` — +8 testów persistu (published z tagami/obrazem, draft, kolizja sluga, 5. kolizja → `blocked`, zła kategoria, rejected retry, upsert po URL, duplikat rejected) → 30 PG
- `apps/worker/src/services/media.ts` — `processArticleImage`, `renderWebp`, `DEFAULT_CATEGORY_IMAGES`, S3 SDK → R2 z env `R2_*`
- `apps/worker/src/services/media.test.ts` — 8 testów (defaulty 6 kategorii, 1200×675 webp q80, upload key/type, błędy pobrania/uploadu/nie-obraz, brak env R2)
- `apps/worker/src/services/persist.resolve.test.ts` — eksport `persist` z roota i subpathu pakietu
- `apps/worker/package.json` — `@aws-sdk/client-s3` (R2, AGENTS §1)
- `.env.example` — `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL` (placeholdery)
- `docs/plans.md` (F2-T5 usunięty, TERAZ → F2-T6), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **136 passed, 0 failed, 30 skipped** (slug 12 + parser 10 + queries 10 + ingestion 20 + scraper 20 + gatekeeper 16 + review 35 + factcheck 4 + media 8 + export 1)
- PG-docker (podman, `postgres:16`): **30 passed** (w tym 8 persistu, m.in. 5. kolizja sluga → `blocked`)
- Zero sieci w testach: media używa wstrzykiwanych `fetchImage`/`upload`, sharp pracuje lokalnie

## Review Loop Audit
- Liczba rund Reviewera: 3
- Przebieg rund:
  - Runda 1: Request changes — 4 blokery (brak eksportu `persist`; ostatnia kolizja sluga rzucała `23505`; test wymiarów porównywał stałe; test retry nie dowodził `draft→published`)
  - Runda 2: Request changes — 1 bloker (brak testu regresyjnego 5. kolizji sluga)
  - Runda 3: **Approve** — 0 blokerów; mutacje M1/M3 czerwienieją, test deterministyczny (`Math.random` mock + `mockRestore`)
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- `articles/{slug}.webp` nadpisze istniejący plik przy retry tego samego sluga — zamierzone (idempotencja), ale `Cache-Control: immutable` sprawia, że klienci/CDN mogą trzymać starą grafikę; rozważyć hash w kluczu lub krótszy max-age.
- Fallback kategorii wskazuje `https://media.kombain.pl/defaults/*.webp`, pliki powstaną w F3-T2; do tego czasu default = 404.
- Błędy pobrania/uploadu obrazu są połykane (fallback) bez licznika — `image_fallback_used` do dodania w orchestratorze (F2-T6).
- `syncTags` tylko dodaje linki; przy retry ze zmienionym zestawem tagów stare linki zostają (brak mirror/delete).
- Zapis `published → draft` zostawia `published_at` (dziś nieosiągalne przez dedupe URL, ale kontrakt tego nie zabrania).
- Tagi dłuższe niż 100 znaków są ucinane przed zapisem (ochrona przed wywaleniem transakcji).
- Eksport `@kombain/db/persist` wskazuje plik `.ts` — działa w Bun (runtime VPS) i w vitest; czysty Node bez loadera TS go nie zaimportuje (świadome: brak buildu w monorepo).
- Domyślne `defaultFetchImage`/`defaultUpload` pokryte tylko testem braku env R2; realny upload weryfikuje się na VPS w F2-T6.
- `scripts/verify.sh` krok 4 (lint promptów) jest pomijany przez martwy glob `prompts/*.md`; exit 0 potwierdzony bezpośrednio (`bash scripts/verify.sh` → 0), ale guard PocketBase/WPISZ realnie nie działa (OPT w `plans.md`).

## Out of scope (celowo nietknięte)
- Orchestrator/pipeline, Dockerfile/cron, Astro, wgranie plików default na R2.

## Next steps
- F2-T6: orchestrator + pipeline + `index.ts` + `config.ts` + Dockerfile + cron, dedupe run-level, hardening logów, run na żywych źródłach (limit 1-2).
