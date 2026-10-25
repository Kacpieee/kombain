# Final report — F2-T3 (`llm.ts + gatekeeper`)

## Status
Done (Mode: CRITICAL)

## Summary
Powstał Bramkarz: prompt z bazą wiedzy z 30 dni (bez PocketBase), JSON Schema dla Gemini Structured Outputs 1:1 z Zod, `classifyArticle` z wstrzykiwanym `generate` (testy bez API). `is_duplicate || !is_relevant` → `rejected` z powodem; kategoria spoza enuma / błędny JSON / błąd modelu → `error` (blokada persist), nigdy cichy publish.

## Changes
- `apps/worker/src/prompts.ts` — `GatekeeperPromptInput`, `buildGatekeeperPrompt` (reguły hard filtru, pełna lista 6 kategorii, historia 30 dni skrócona do 300 znaków na wpis)
- `apps/worker/src/services/llm.ts` — `GATEKEEPER_RESPONSE_SCHEMA`, `GenerateFn`, `classifyArticle` (accepted/rejected/error), `defaultGenerate` (dynamiczny import `@google/genai`, `responseMimeType: application/json`, `temperature: 0`), `describeError` (Zod issues bez wycieku promptu)
- `apps/worker/src/services/llm.test.ts` — 16 testów schematu/promptu/routingu stanów, zero wołań Gemini
- `docs/plans.md` (F2-T3 usunięty, TERAZ → F2-T4), `docs/STATUS.md`
- Branch: `main`

## Verification (liczbowo, po ostatniej poprawce)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **88 passed, 0 failed, 22 skipped** (slug 12 + parser 10 + queries 10 + ingestion 20 + scraper 20 + gatekeeper 16)
- PG-docker: **22 passed** (bez zmian)
- Zero wywołań Gemini/ScrapingAnt w testach (wstrzykiwany `generate`)

## Review Loop Audit
- Liczba rund Reviewera: 1
- Przebieg rund:
  - Runda 1: **Approve** (0 blokerów; 8 ryzyk nieblokujących)
- Ostatni werdykt (po ostatniej edycji kodu i ostatnim verify.sh): **Approve**

## Risks
- Prompt nie przycina treści artykułu — przy bardzo długich tekstach rośnie koszt tokenów; limit długości wejścia do ustalenia w F2-T6 (config).
- `GatekeeperSchema` dopuszcza dodatkowe pola i pusty `reason`; dla `rejected` pusty powód trafi do DB jako `""` — do zaostrzenia (`reason.min(1)`) po decyzji, czy chcemy blokować takie odpowiedzi.
- Brak retry Bramkarza (zgodnie ze specyfikacją): błąd modelu = `draft`, więc temat nie ginie, ale wymaga kolejnego runu.
- `responseSchema` jest ręcznym odpowiednikiem Zod (bez generatora) — rozjazd możliwy przy zmianie enuma; pilnuje tego test porównujący 6 kategorii.
- `defaultGenerate` tworzy nowego klienta `GoogleGenAI` na każde wywołanie — do cache'owania w F2-T6, jeśli run będzie miał wiele artykułów.
- Konflikt AGENTS §2.5 vs §2.8 dla `is_duplicate=true` (wiersz `rejected` vs ciche porzucenie) — `classifyArticle` zwraca całą decyzję, więc rozstrzygnięcie zapada w F2-T5/T6; musi być jawne, inaczej duplikat semantyczny zablokuje ponowienie.
- Hard filter w promptcie nie jest asertowany w testach (tylko tytuł/URL/30 dni/enum) — przyszła edycja promptu może go wykasować bez czerwonego testu; do dopięcia przy F2-T4.
- `describeError` przepuszcza surowy `message` z SDK — jeśli Gemini zwróci fragment promptu w błędzie, trafi on do logów; redakcja w F2-T6.

## Out of scope (celowo nietknięte)
- Redaktor/review/factcheck (F2-T4), persist, media/R2, Astro, `deploy/`.

## Next steps
- F2-T4 `editor + review + factcheck`: 1 szablon × 6 person, `external_refs[]`, R1/R2/R3 z groundingiem, `refuted/uncertain` → `draft` (+`needs_human_check`).
