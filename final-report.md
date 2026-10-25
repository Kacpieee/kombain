# Final report — F2-T10a (Research & Factcheck recall hardening)

## Status
Done (Mode: CRITICAL)

## Pre-mortem (przed kodem)
- **UX:** lepsza druga kwerenda researchu może zawęzić brief do encji z tytułu; kategoria zostaje w query jako fallback. Stoplista ALL-CAPS może wyciąć legalny akronim — testy na NOAA/NIFA/POLSKA.
- **Sync/PG:** brak zmian DDL i zapytań DB; ryzyko ograniczone do typów odpowiedzi R3.
- **LLM:** `reason` jest wyłącznie w kodzie, nie w schematach Gemini/DeepSeek; model nie może go halucynować. Częściowe `stats` przy błędzie R3 nie zmieniają polityki `draft`.
- **Pytania TERAZ-vs-KIEDYŚ:** bez zmian DDL; T10b/c pozostają w TERAZ. Brak blokerów.

## Summary
Wspólny moduł `services/search/query.ts` obsługuje encje i query dla researchu, factchecku i przyszłego repairu. Research buduje drugą kwerendę z tytułu i początku tekstu, R3 nie gubi `raw[1..4]` przy pustym pierwszym wyniku i zwraca kodowy `reason`, a błąd R3 zachowuje częściowe `verify_*`.

## Changes
- `apps/worker/src/services/search/query.ts` — `extractClaimEntities(claim, {includeSentenceStart})`, `buildClaimQuery`, `isAcronym`, `significantWords`, `stem`; stoplista ALL-CAPS rzeczowników (bez POLSKA/EUROPA)
- `apps/worker/src/services/factcheck.ts` — re-eksport wspólnego query; akronimy na początku zdania; `raw[1..4]` + `fillEvidence` na pierwszym pustym wyniku; `reason` (`search_error`, `no_evidence`, `judge_uncertain`, `max_atoms_cap`, `confirmed`, `refuted`); `FactcheckOutcome` z `code` i częściowymi `stats`
- `apps/worker/src/services/research.ts` — druga kwerenda z encji tytułu + pierwszych 400 znaków tekstu + kategorii, cięcie na granicy słowa, ≤128
- `apps/worker/src/services/review.ts` — `ExternalVerdict.reason`; częściowe `verify` przekazywane do draftu przy błędzie R3
- Testy: factcheck 40 (z 24), research 13; pełny zestaw **307 unit**
- `docs/plans.md` (T10a usunięte, TERAZ → T10b/T10c), `docs/STATUS.md`

## Verification (liczbowo)
- `scripts/verify.sh`: **PASS** (exit 0)
- `tsc --noEmit`: **0 błędów**
- `vitest`: **307 passed / 0 failed / 33 skipped**
- PG (podman, postgres:16): **33 passed**
- Zero sieci: search/serp/fetch/generate wstrzykiwane

## Review Loop Audit
- Liczba rund Reviewera: **1/3 Approve** (mutacje raw[1]/source_index/reason/stoplist/query/stats czerwienieją testy)

## Risks
- Stoplista ALL-CAPS jest heurystyką; `POLSKA`/`EUROPA` celowo poza nią, ale inne akronimy mogą wypaść.
- `includeSentenceStart` jest przygotowane pod T10c; obecny `buildClaimQuery` nadal pomija zwykłe nazwy własne na początku zdania (świadome).
- `search_error` przy primary fail + SERP bez trafnych wyników blokuje repair dopiero w T10c; dziś kończy się `uncertain` → draft.
- `FactcheckOutcome.code` wymaga aktualizacji mocków/testów w T10b/T10c.
- Brak zmian polityki publikacji w tym tasku.
- Stoplista ALL-CAPS jest niepełna (np. POPYT/CENY/PLONY nadal mogą przejść jako akronim) — świadoma heurystyka, kandydat na OPT.
- `fillEvidence` pobiera stronę pierwszego pustego wyniku, nawet gdy `raw[1]` ma już trafne summary — zbędny fetch, nie wpływa na poprawność.
- `isAcronym` dopuszcza 2 litery, ale regex encji wymaga ≥3 znaków, więc `US`/`EU` nie są encjami (stan sprzed tasku); T10c guard i tak łapie `Canada`/liczby.

## Next steps
- F2-T10b: feedback plumbing, sync `content_html`, `VERIFY_MAX_ATOMS` z configu, dry-run `verify_*`, `--url` dedup bypass.
