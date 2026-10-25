# Final report — F2-T2 (`scraper.ts`)

## Status
Done (Mode: CRITICAL)

## Summary
Powstał smart fetch artykułu: bezpośredni `fetch` z UA Chrome i timeoutem 10 s, fallback na ScrapingAnt przy `403/429/503` lub sygnaturze Cloudflare (timeout 30 s), ekstrakcja przez `linkedom + @mozilla/readability`, `og:image` z fallbackiem na pierwszy obraz w artykule oraz twardy filtr `<800` znaków → `rejected` z dokładnym powodem. Odpowiedzi nie-2xx (poza blokadami) oraz ściana CF po fallbacku kończą się `error`, nie `ok`/`rejected`.

## Changes
- `apps/worker/src/services/scraper.ts` — `isBlockedResponse` (szersze markery ścian), `extractOgImage` (tylko obrazy z `<article>`, `data-src`/`data-original`), `scrapeArticle`; wynik `ok | rejected | error`, `fetchedVia` do licznika `scrape_fallback_used`
- `apps/worker/src/services/scraper.test.ts` — 20 testów bez sieci (blokady, fallback, 404/500, ściana po fallbacku, brak klucza, ekstrakcja, og:image, próg 800)
- `apps/worker/package.json` — `linkedom ^0.18`, `@mozilla/readability ^0.6` (Dokumentacja §4 KROK 2 / AGENTS §1)
- `docs/plans.md` (F2-T2 usunięty, TERAZ → F2-T3), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **72 passed, 0 failed, 22 skipped** (slug 12 + parser 10 + queries 10 + ingestion 20 + scraper 20)
- PG-docker: **22 passed** (bez zmian)
- Wszystkie testy scrapera na fixture'ach HTML i wstrzykiwanych `fetchDirect`/`fetchScrapingAnt`; zero sieci

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 3 blokery (nie-2xx z długim body → `ok`/`rejected`; brak re-checku ściany CF po fallbacku; brak testów tych ścieżek)
  - Runda 2: **Approve** — 0 blokerów; wszystkie 3 blokery potwierdzone jako FIXED, w tym przez symulację „bez poprawki”
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Readability bywa czuły na nietypowy HTML (SPA/AMP) → `error`, nie `rejected`; orchestrator musi rozróżniać te stany (dobry temat nie może trafić do `rejected`).
- Klucz ScrapingAnt w query (wymóg API), ale komunikaty błędów są bez query, a klucz redagowany także w formie percent-encoded.
- Ściana Cloudflare z markerem spoza listy i krótką treścią może nadal wyjść jako `rejected` — lista markerów jest rozszerzana reaktywnie; docelowo licznik „podejrzanie krótkich” w F2-T6.
- `charCount` liczony po normalizacji białych znaków (`replace(/\s+/g," ")`) — minimalnie bardziej restrykcyjny niż `textContent.trim().length` ze specyfikacji.
- Względny `og:image` rozwiązywany względem `sourceUrl`, nie finalnego URL po redirectach.
- `title` z Readability może wyjść pusty (brak `<title>`/`h1`) — fallback na `originalTitle` musi być w pipeline (F2-T6).
- Allowlista tagów HTML wraca jako wymóg R1 w F2-T4 (sanityzacja `content_html`).

## Out of scope (celowo nietknięte)
- `llm.ts`/gatekeeper, redaktor/review, media/R2, persist, Astro, `deploy/`.

## Next steps
- F2-T3 `llm.ts + gatekeeper`: 3.1 Flash-Lite, Zod enum 6 kategorii, historia 30 dni, `is_duplicate || !is_relevant` → `rejected`.
