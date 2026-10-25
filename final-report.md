# Final report — F2-T4 (`editor + review + factcheck`)

## Status
Done (Mode: CRITICAL)

## Summary
Powstał tor redakcyjny: jeden szablon promptu × 6 person (`CATEGORY_PERSONAS`), walidacja i normalizacja wyjścia Redaktora, sanityzacja HTML do allowlisty, R1 (lokalny + LLM, retry przez `regenerate`), R2 (atomy `supported/external/inference`, wycinanie wniosków bez dowodu), R3 (search grounding tylko dla `external`, `refuted` → `draft`, `uncertain` → `draft + needs_human_check`). Link „Źródło:” dokleja kod, nigdy model.

## Changes
- `apps/worker/src/prompts.ts` — `buildEditorPrompt` (persona + tech_context, zakaz linku źródła), `buildR1Prompt`, `buildR2Prompt`, `buildR3Prompt`, schematy `R1Schema`/`R2Schema`/`R3Schema`, `external_refs` z typem `external|supported`
- `apps/worker/src/services/llm.ts` — `synthesizeArticle` (3.8 Flash, normalizacja tagów/sluga/tech_summary), `EDITOR_RESPONSE_SCHEMA`, `createGenerator`, `formatLlmError`, `search` w `GenerateFn`
- `apps/worker/src/services/review.ts` — `sanitizeEditorHtml`, `validateTechnical`, `stripInferences`, `buildSourceLink`, `reviewArticle` (R1 → R2 → R3, stany `published`/`draft` + `needsHumanCheck`)
- `apps/worker/src/services/factcheck.ts` — `verifyExternalAtoms` (R3, `search: true`, schemat + Zod)
- `apps/worker/src/services/review.test.ts` — 35 testów bez API
- `apps/worker/src/services/factcheck.test.ts` — 4 testy (search grounding, pusta lista, Zod z etykietą R3, błąd modelu)
- `docs/plans.md` (F2-T4 usunięty, TERAZ → F2-T5), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **127 passed, 0 failed, 22 skipped** (slug 12 + parser 10 + queries 10 + ingestion 20 + scraper 20 + gatekeeper 16 + review 35 + factcheck 4)
- PG-docker: **22 passed** (bez zmian)
- Zero wywołań Gemini w testach (wstrzykiwany `generate`, `runR1`/`runR2`/`verifyExternal`)

## Review Loop Audit
- Liczba rund Reviewera: 3
- Przebieg rund:
  - Runda 1: Request changes — 4 blokery (R3 bez pokrycia 1:1 atomów; lokalny fail R1 omijał retry; `external_refs[]` poza R3; brak testów inwariantów)
  - Runda 2: Request changes — 3 blokery (sprzeczne werdykty R3 rozstrzygane kolejnością tablicy; etykieta błędu R3 jako „Bramkarza”; brak testów retry „oba” i zachowania metadanych w `draft()`)
  - Runda 3: **Approve** — 0 blokerów; mutacje potwierdziły, że agregacja werdyktów, etykieta R3 i nowe testy inwariantów realnie czerwienieją po cofnięciu poprawek
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- R2 wycina inference tylko przy dokładnym dopasowaniu zdania w węźle tekstowym; zdanie przecięte tagiem → `missed` → `draft` (bezpieczne, ale wymaga ręcznej korekty).
- „Dowód” inference musi mieć ≥20 znaków i ≥3 słowa oraz pierwsze 40 znaków obecne w źródle — parafrazy mogą zostać odrzucone (bezpieczny kierunek).
- R3 ufa etykietom R2 (`supported/external`); błędna etykieta `supported` dla faktu spoza źródła omija weryfikację sieciową.
- Duplikaty werdyktów R3 rozstrzyga najgorszy (`refuted` > `uncertain` > `confirmed`); `confirmed` wymaga `http(s)` URL.
- Brak limitu domen dla `evidence_url` i brak walidacji treści dowodu.
- Retry R1 działa tylko, gdy pipeline poda `regenerate`; błąd API (np. 429) zużywa jedyny retry.
- Sanityzacja rozpina niedozwolone tagi (zachowuje tekst) i usuwa atrybuty; `<script>/<iframe>/<style>` usuwane w całości.
- `buildSourceLink` nie jest jeszcze wołany w pipeline (F2-T5/T6 zdecyduje: `text_content` vs render w Astro).
- Brak minimalnej struktury treści w lokalnym R1 (`<p></p>` przechodzi meta-check; decyduje LLM R1).
- Test pokrywa zachowanie `external` w drafcie tylko dla `refuted`; gałąź `uncertain` nie ma asercji (kod poprawny — limit 3 rund Reviewera).
- `mergeExternalAtoms` nie ogranicza liczby `external_refs[]` wchodzących do R3 (koszt search groundingu).

## Out of scope (celowo nietknięte)
- `media.ts`, `persist`, orchestrator/pipeline, Astro, `deploy/`.

## Next steps
- F2-T5: `media.ts` (sharp 1200×675 webp80 → R2, fallback default kategorii) + `persist` (transakcja, slug + suffix, tag sync, draft-vs-rejected) + testy PG.
