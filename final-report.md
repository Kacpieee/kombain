# Final report — F2-T9 (R3 na DeepSeek)

## Status
Done (Mode: CRITICAL)

## Summary
Weryfikacja R3 nie wymaga już Gemini Pro z groundingiem. Domyślnie: **DeepSeek Search na claim** → top-5 dowodów (authority/rerank) → opcjonalny **DeepSeek Fetch**, gdy summary puste → **Flash-Lite jako sędzia** zwraca `verdict` + `source_index`; URL dowodu jest mapowany z wyników, nie generowany. Fallback: SERP (ScrapingAnt + DDG). `VERIFY_PROVIDER=gemini` zostawia stary grounding (rollback). Nadmiar atomów (cap 8) → `uncertain` (bezpieczny draft).

## Changes
- `apps/worker/src/services/factcheck.ts` — `verifyExternalAtoms` z providerem `deepseek|gemini`, `pickEvidence`, `reconcile` (indeks→URL, `confirmed/refuted` wymagają poprawnego URL), cap atomów, Fetch przy pustych summary
- `apps/worker/src/services/search/deepseek.ts` — `deepseekFetch` (`/v1/tools/fetch`)
- `apps/worker/src/prompts.ts` — `JudgeSchema`, `buildJudgePrompt`
- `config.ts`/`.env.example`/`deploy/README.md` — `VERIFY_PROVIDER`
- `AGENTS.md` — runtime: DeepSeek Search/Fetch także do weryfikacji faktów
- Testy: factcheck 15 (deepseek + gemini rollback), deepseek +2 (Fetch), config/CLI/orchestrator update
- `docs/plans.md` (F2-T9 usunięty, TERAZ → F3-T1), `docs/STATUS.md`

## Verification (liczbowo)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **264 passed, 0 failed, 33 skipped**
- PG-docker: **33 passed** (bez zmian)
- Zero sieci: search/serp/fetch/generate wstrzykiwane w testach

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 2 blokery (sędzia dostawał model Pro zamiast Lite; brak testów bounds/null/negative)
  - Runda 2: **Approve** — 0 blokerów; mutacje judgeModel/bounds/null/negative czerwienieją
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Sędzia Flash-Lite jest słabszy niż Pro z groundingiem — możliwe fałszywe `confirmed`; mitygacja: `verdict` + `source_index` z listy wyników (bez wymogu cytatu w schemacie).
- Koszt: do 8 search + do 8 lite call per artykuł (~$0.006 + tokeny) — nadal tanio, ale rośnie z liczbą atomów.
- Jakość wyszukiwania PL niszowego AgTech może dawać słabe dowody → więcej `uncertain`; mierzyć `draft_rate`.
- Fallback SERP kruchy/ToS; bez `SCRAPINGANT_API_KEY` brak awaryjnej ścieżki.
- Cap 8: nadmiar atomów zawsze `uncertain` (draft), bez wyszukiwania — świadome ograniczenie kosztu.
- `evidence_url` pochodzi z wyników, ale treść dowodu może nie odpowiadać claimowi (sędzia może się pomylić).
- Dwa providery (Gemini + DeepSeek) — dwa klucze, dwa punkty awarii; `VERIFY_PROVIDER=gemini` to rollback.

## Next steps
- F3-T1: Astro Hybrid + strony + cache.
