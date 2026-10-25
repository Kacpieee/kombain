# Final report — F2-T1 (`ingestion.ts`)

## Status
Done (Mode: CRITICAL)

## Summary
Powstał moduł pobierania linków: routing źródła (`rss`/`scraper`), normalizacja URL (względne → bezwzględne, bez `utm_*`/`fbclid`/`gclid`, `&amp;`, fragmentów), RSS przez `rss-parser`, scraper przez ScrapingAnt + cheerio (selektor z DB, fallback `a[href]`), dedupe w pamięci i limit 15 pozycji na źródło. Błąd źródła nie przerywa runu.

## Changes
- `apps/worker/src/services/ingestion.ts` — `routeSource`, `normalizeUrl`, `extractLinks`, `buildScrapingAntUrl`, `ingestSource`, typy `SourceForIngestion`/`RawArticleCandidate`/`IngestionResult`; `fetchText` wstrzykiwany (testy bez sieci), domyślnie UA Chrome + timeout 10 s
- `apps/worker/src/services/ingestion.links.test.ts` — 20 testów (routing, normalizacja, selektory, dedupe, limit, błędy RSS/ScrapingAnt, redakcja klucza)
- `docs/plans.md` (F2-T1 usunięty), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **52 passed, 0 failed, 22 skipped** (slug 12 + parser 10 + queries 10 + ingestion 20)
- PG-docker: **22 passed** (bez zmian po F1-T2)
- Bez sieci: wszystkie testy ingestion używają fixture'ów XML/HTML i wstrzykiwanego `fetchText`; brak wołań Gemini/ScrapingAnt

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 1 bloker (klucz ScrapingAnt w komunikacie błędu → log JSONL)
  - Runda 2: **Approve** (0 blokerów; poprawka docs-only: licznik testów w `STATUS.md` 18 → 20)
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- `normalizeUrl` nie usuwa trailing slash ani nie kanonikalizuje ścieżek — dwa warianty tego samego artykułu mogą przejść dedupe (dedup DB i tak złapie `source_url`).
- Dedupe jest **per źródło**; ten sam URL z dwóch źródeł przejdzie dwukrotnie — dedup run-level wpisany do F2-T6.
- `extractLinks` wymaga tytułu ≥3 znaki; linki bez tekstu (ikony) są pomijane — zamierzone.
- Scraper zależy od klucza `SCRAPINGANT_API_KEY`; brak klucza = `error` w wyniku (nie wyjątek), więc orchestrator musi to zliczyć. Klucz jest w query (wymóg API), ale komunikaty błędów są bez query, a klucz jest redagowany w `error`.
- `redactSecret` nie redaguje formy percent-encoded (klucz z `+ / =`); klucze ScrapingAnt są hex/alnum, więc produkcja bezpieczna — hardening w F2-T6.
- Warstwa „bez query w komunikacie” nie ma osobnego testu (maskowana przez redakcję) — do dopięcia razem z hardeningiem.
- RSS `link` bywa pusty (niektóre feedy używają `guid`) — takie pozycje są pomijane; fallback na `guid` dopiero gdy źródło tego wymaga.
- Nieaktualny `link_selector` daje `candidates: []` i `error: null` (ciche zero) — do obsługi licznikiem w F2-T6.

## Out of scope (celowo nietknięte)
- `scraper.ts` (Readability/og:image/800), gatekeeper, redaktor, review, media/R2, Astro, `deploy/`.

## Next steps
- F2-T2 `scraper.ts`: fetch UA 10 s → fallback ScrapingAnt przy 403/429/503/CF, Readability, `og:image`, hard filter 800 → `rejected`.
