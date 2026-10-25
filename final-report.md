# Final report — F2-T8b (research: DeepSeek Search + dystylacja)

## Status
Done (Mode: CRITICAL)

## Summary
Research nie używa już Gemini Pro z groundingiem. Główna ścieżka: **DeepSeek Search** (2 krótkie kwerendy, $0.0015/artykuł) → **dystylacja Flash-Lite** do 5–10 faktów, gdzie URL jest brany z indeksu wyniku (model nie może wymyślić linku). Fallback: **SERP (ScrapingAnt + DuckDuckGo HTML)** → ta sama dystylacja. Gdy oba padną: artykuł leci bez briefu + alert Telegram. Gemini grounding został jako opcja rollbacku (`SEARCH_PROVIDER=gemini`).

## Changes
- `apps/worker/src/services/search/deepseek.ts` — `deepseekSearch` (POST `/v1/tools/search`, Bearer, retry 1× na 429/5xx, 401/402/403 → `SearchConfigError`), `serpSearch` (DDG HTML przez ScrapingAnt, dekodowanie `uddg`, cheerio)
- `apps/worker/src/services/research.ts` — provider `deepseek|gemini|off`, `buildResearchQueries`, `factsFromDistill` (indeks→URL, cap 10, dedupe), fallback chain
- `apps/worker/src/prompts.ts` — `buildDistillPrompt`, `DistillSchema`
- `apps/worker/src/pipeline.ts` — alert przy błędzie researchu (tylko realny run)
- `apps/worker/src/orchestrator.ts` — przekazuje `notify` do pipeline'u
- `apps/worker/src/config.ts`, `.env.example` — `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `SEARCH_PROVIDER`
- `AGENTS.md` — runtime: Gemini (generacja/review) + DeepSeek Search/Fetch (research/weryfikacja), sekrety
- Testy: `search/deepseek.test.ts` (6), `research.test.ts` (13), pipeline +1 (alert/dry-run), orchestrator +1 (notify vs dry-run)
- `docs/plans.md` (F2-T9 R3 DeepSeek przed F3), `docs/STATUS.md`

## Verification (liczbowo)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **251 passed, 0 failed, 33 skipped**
- PG-docker: **33 passed** (bez zmian)
- Zero sieci w testach (mock `fetchImpl`, `search`, `serp`, `generate`)

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 3 blokery (brak `DEEPSEEK_API_KEY` w deploy-doc; nieprzetestowane gałęzie: notify w orchestratorze, guard URL, puste wyniki; sekret poza redakcją/guardem)
  - Runda 2: **Approve** — 0 blokerów; mutacje notify/guard URL/pustych wyników/alertu czerwienieją; dodatkowo dodane testy pustej dystylacji i filtra SERP
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Fallback SERP (DDG przez ScrapingAnt) jest kruchy i może łamać ToS — tylko awaryjnie; bez `SCRAPINGANT_API_KEY` fallback nie zadziała.
- DeepSeek wymaga prepaid; przy 402 research cicho przechodzi w fallback, a bez ScrapingAnta — w brak briefu + alert.
- Wyszukiwanie PL niszowego AgTech może być słabsze niż grounding Gemini → mniej/mniej trafnych faktów; mierzyć `draft_rate`.
- `SEARCH_PROVIDER=deepseek` jest teraz domyślny — na VPS bez `DEEPSEEK_API_KEY` research zawsze padnie (alert przy każdym artykule).
- Kwerendy wysyłają tylko tytuł/kategorię (nie treść), ale dystylacja widzi publiczne snippety — brak treści artykułu u providera.
- Dystylacja używa Flash-Lite; przy słabych wynikach brief może być ubogi (Redaktor napisze ostrożniej).
- Alert `research fallback` i `run_summary` dzielą rate-limit 1/min — przy błędzie na pierwszym artykule podsumowanie może zostać pominięte.
- Pola `SEARCH_PROVIDER`/`DEEPSEEK_*` w configu są walidowane, ale serwisy czytają `process.env` bezpośrednio (dwa źródła prawdy).
- Fakt z briefu jest zaufany: claim może nie odpowiadać treści URL-a (link nie jest halucynowany, ale treść nie jest weryfikowana) — do adresowania w F2-T9.
- `normalizeFacts` (ścieżka gemini rollback) ma testy; `SEARCH_PROVIDER=gemini` pozostaje opcją awaryjną.

## Next steps
- F2-T9: R3 na DeepSeek Search+Fetch + Flash-Lite (fallback SERP), `VERIFY_PROVIDER` do rollbacku.
- Potem F3-T1 (Astro).
