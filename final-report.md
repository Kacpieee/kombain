# Final report — F2-T8 (research stage przed Redaktorem)

## Status
Done (Mode: CRITICAL — zmiana pipeline'u i promptów)

## Summary
Między Bramkarzem a Redaktorem wszedł etap **research**: Gemini Pro z search grounding zbiera 5–10 weryfikowalnych faktów z URL-ami (szeroki zasięg: oficjalne, prasa, blogi eksperckie, agregatory). Redaktor dostaje brief i **nie wolno mu wprowadzać faktów spoza źródła i briefu**; atomy `external` pokryte briefem nie idą do R3, więc mniej fałszywych `uncertain → draft`. Błąd researchu nie blokuje artykułu (brief pusty, zachowanie jak dotychczas).

## Changes
- `apps/worker/src/prompts.ts` — `ResearchSchema`/`ResearchFact`, `buildResearchPrompt`, `EditorPromptInput.researchBrief`, sekcja „USTALONE FAKTY” + twarda zasada „zero nowych faktów”, reguła `external_refs` tylko z briefu
- `apps/worker/src/services/research.ts` — `researchTopic` (`search: true`), `normalizeFacts` (http(s), dedupe po claim, min. 10 znaków, cap 10)
- `apps/worker/src/pipeline.ts` — research po Bramkarzu, brief przekazany do `synthesize` i `review`; błąd researchu → pusty brief
- `apps/worker/src/services/review.ts` — `ReviewDeps.researchBrief`; atomy external pokryte briefem pomijają R3 (`coveredByResearch`)
- Testy: `research.test.ts` (5), pipeline +3 (brief, fallback, kolejność), review +3 (brief pomija R3, atom szerszy → R3, krótki atom → R3), editor prompt +2
- `docs/plans.md`, `docs/STATUS.md`, `final-report.md`

## Verification (liczbowo)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **235 passed, 0 failed, 33 skipped**
- PG-docker: **33 passed** (bez zmian)
- Zero sieci w testach (research/LLM przez wstrzykiwany `generate`)

## Review Loop Audit
- Liczba rund Reviewera: 2
- Przebieg rund:
  - Runda 1: Request changes — 1 bloker (`coveredByResearch` akceptował atom szerszy niż fakt z briefu → dodatkowy fakt omijał R3)
  - Runda 2: **Approve** — 0 blokerów; mutacje M1/M2 czerwienieją, testy brzegowe (długie/krótkie atomy) potwierdzone
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Research szeroki (blogi/agregatory) → możliwe słabe źródła; liczby nadal warto potwierdzać w R3, ale brief je pomija (świadoma decyzja: mniej draftów kosztem ryzyka).
- Błąd researchu jest cichy — pipeline jedzie dalej bez briefu, bez licznika `research_failed` w `run_summary` (do dodania).
- Prompt injection z wyników wyszukiwania: brief trafia do promptu Redaktora jako dane; brak twardej sanityzacji treści faktów.
- `coveredByResearch` ufa briefowi: atom zawarty w fakcie z researchu nie wraca do R3, więc błędny fakt z researchu (halucynacja groundingu) trafi do publikacji bez niezależnej weryfikacji — mitygacja tylko promptowa.
- Brief nie jest zapisywany w DB (brak audytu „skąd Redaktor wziął fakt”); `external_refs` z URL są w treści/draftach, ale bez pełnej listy faktów.
- Koszt: +1 wywołanie Pro z groundingiem na artykuł (~20–40 s).

## Out of scope
- F3 (Astro), zmiana R3 na mniej rygorystyczny, zapis briefu w DB, UI do researchu.

## Next steps
- F3-T1: Astro Hybrid + `directus.ts` + strony + cache headers. Po pierwszym pełnym runie z researchem ocenić `draft_rate`.
