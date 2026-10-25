# Final report — F2-T10c (Bounded repair loop + guardy)

## Status
Done (Mode: CRITICAL)

## Pre-mortem (przed kodem)
- **UX:** repair może skrócić artykuł lub usunąć dobry fakt, którego R3 nie potwierdziło. Guardy: minimalna długość po repair, deterministyczny zakaz nowych liczby/encji, ponowny pełny R1→R2→R3.
- **Publikacja:** auto-publish po clean repair oznacza, że człowiek nie widzi usuniętego faktu — `repairedClaims` trafia do JSONL, a `repair_*` do `run_summary`.
- **LLM:** maks. 1 repair (config 0–2), brak rekurencji; `search_error`, `max_atoms_cap`, błąd LLM, 0 atomów R2 i fail R1 nie kwalifikują się do repair.
- **Sync/PG:** bez DDL; `coveredByResearch` wymaga pokrycia encji, żeby repair/R3 nie pomijały nowych nazw własnych.
- **Pytania TERAZ-vs-KIEDYŚ:** domyślnie 1 próba; pomiar A/B na VPS po wdrożeniu. Brak blokerów.

## Summary
Review ma teraz ograniczoną pętlę naprawczą: po `refuted`/`uncertain` z R3 albo niewyciętym `inference` z R2 Redaktor dostaje strukturalny feedback, a cały artykuł przechodzi ponownie R1→R2→R3. Publikacja następuje tylko po czystym przebiegu; guardy blokują zbyt krótki tekst i nowe encje/liczby. `REPAIR_MAX_ATTEMPTS` płynie z configu, a `repair_*` są liczone także w dry-run.

## Changes
- `apps/worker/src/config.ts` + testy — `REPAIR_MAX_ATTEMPTS` (0–2, default 1); `.env.example`, `deploy/README.md`, `cli.ts` mask
- `apps/worker/src/services/review.ts`:
  - `reviewOnce` + pętla `reviewArticle` (max 0/1/2, bez rekurencji)
  - `ReviewDeps.repair`, `maxRepairAttempts`, `minRepairedChars`
  - `canRepair` (R2 `inference_missed`, R3 `refuted`/`uncertain`; blokada `search_error`/`max_atoms_cap`)
  - guard długości: pre≥600 → ≥600; krótkie fixture’y → 60%
  - guard nowych encji/liczb przed drugim review
  - `coveredByResearch(claim, facts, sourceText)` — exact, pokrycie encji, 75% rdzeni
  - `repairAttempts`, `repaired`, `repairedClaims`; `mergeVerifyStats`
- `apps/worker/src/pipeline.ts` — `maxRepairAttempts`, `repair` przez `synthesize` z `EditorFeedback`; pola repair w wyniku
- `apps/worker/src/orchestrator.ts` — `repair_attempts/success/failed`, liczenie w dry-run, `repairedClaims` w evencie
- `AGENTS.md` §2.7–2.8 — bounded repair 1× przed draftem
- Testy: config 5, review 77, pipeline 26, orchestrator 31; pełny zestaw **345 unit**
- `docs/plans.md` (T10c usunięte; TERAZ → OPS/F3-T2), `docs/STATUS.md`

## Verification (liczbowo)
- `scripts/verify.sh`: **PASS** (exit 0)
- `tsc --noEmit`: **0 błędów**
- `vitest`: **345 passed / 0 failed / 33 skipped**
- PG (podman, postgres:16): **33 passed**
- Zero sieci w testach

## Review Loop Audit
- Liczba rund Reviewera: 1/3 Request changes (visibleText/stoplista/testy guardów) → poprawki; 2/3 Request changes (guard opener / test Kanada) → poprawki; 3/3 Request changes (test granicy bloków/akronimu) → poprawki; 4/3 (wyjątek zatwierdzony) → **Approve**

## Risks
- Guard nowych encji ignoruje pojedynczy wyraz na początku zdania (np. „Kolejny”), żeby nie blokować legalnych openerów; R3 nadal weryfikuje treść. Nazwy wielowyrazowe, akronimy i liczby blokują twardo.
- `coveredByResearch` liczy 75% rdzeni względem faktu, więc atom rozszerzony o nową treść lowercase (bez encji/liczby) może zostać uznany za pokryty — świadomy kompromis; testy pokrywają Canada/Kanada/liczbę.
- Repair usuwa fakty, których R3 nie potwierdziło; przy fałszywym `uncertain` może usunąć prawdziwy fakt. Mierzyć `draft_rate` i `repairedClaims` w A/B.
- `REPAIR_MAX_ATTEMPTS=2` oznacza do 3 przebiegów review; domyślnie 1.
- `checkUrlDuplicate` nadal blokuje realny `run --url` dla istniejącego draftu; dry-run ma obejście, realny retry wymaga T10c/OPT poza zakresem.
- Prompt repair rośnie o poprzedni JSON (~8k HTML); koszt mierzyć w OPS.
- Draft po guardzie zapisuje `repairedHtml` z zakwestionowanymi encjami (nie wersję pre-repair); człowiek widzi go z etykietą w `rejection_reason` — kandydat na OPT.

## Next steps
- OPS: lokalne A/B 3–5 runów AgFunder, potem VPS (rebuild + `REPAIR_MAX_ATTEMPTS=1`) i pomiar `draft_rate`/`repair_*`/`verify_*`.
- F3-T2: `media.kombain.pl`, defaulty kategorii, webhook purge.
