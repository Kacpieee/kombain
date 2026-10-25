# Final report — F2-T10b (Feedback plumbing, sync HTML, diagnostyka)

## Status
Done (Mode: CRITICAL)

## Pre-mortem (przed kodem)
- **UX:** feedback do Redaktora może wydłużyć prompt; `content_html` jest cięty do 8000 znaków na granicy bloku, a `evidence_url` tylko http(s) ≤200 znaków. Bez zmiany polityki publikacji.
- **Sync/PG:** bez DDL; `article.content_html` jest synchronizowane z `cleanedHtml`, żeby przyszły repair nie przywracał wyciętych wniosków.
- **LLM:** `RepairIssue`/`EditorFeedback` są kontraktem promptu, nie schematem odpowiedzi; model nadal zwraca ten sam JSON. Brak nowych wywołań LLM w tym tasku.
- **Pytania TERAZ-vs-KIEDYŚ:** `REPAIR_MAX_ATTEMPTS` i pętla pozostają w F2-T10c; tutaj tylko plumbing.

## Summary
Redaktor dostaje realny feedback (issues + poprzednia wersja) zarówno przy retry R1, jak i pod przyszły repair. `ReviewOutcome` zawiera pełną listę `refuted`/`uncertain` z URL oraz strukturalne `repairIssues`. `VERIFY_MAX_ATOMS` płynie z configu, dry-run zlicza `verify_*`, a `--dry-run --url` omija dedup URL, żeby można było diagnozować istniejące drafty.

## Changes
- `apps/worker/src/prompts.ts` — `RepairIssue`, `EditorFeedback`, `EditorPromptInput.feedback`; sekcja `TRYB POPRAWY` z poprzednim JSON-em, cięcie HTML po blokach (8000), sanityzacja `evidence_url`
- `apps/worker/src/services/review.ts` — `ReviewDeps.regenerate(issues, previousArticle)`, `ReviewDeps.verifyMaxAtoms`, `ReviewOutcome.repairIssues`; sync `content_html` po sanityzacji i strip; pełne `issues` (refuted + URL, uncertain); `needsHumanCheck` dla mieszanki refuted+uncertain
- `apps/worker/src/pipeline.ts` — `verifyMaxAtoms`, `skipDuplicateCheck`; `regenerate` przekazuje `EditorFeedback` do `synthesize`
- `apps/worker/src/orchestrator.ts` — `verifyMaxAtoms` z configu, `skipDuplicateCheck` dla `--dry-run --url`, `countVerify` dla `dry_run`
- Testy: review 57 (z 50) + `review.verify-max` 1, pipeline 25, orchestrator 28; pełny zestaw **319 unit**
- `docs/plans.md` (T10b usunięte, TERAZ → T10c), `docs/STATUS.md`

## Verification (liczbowo)
- `scripts/verify.sh`: **PASS** (exit 0)
- `tsc --noEmit`: **0 błędów**
- `vitest`: **319 passed / 0 failed / 33 skipped**
- PG (podman, postgres:16): **33 passed**
- Zero sieci w testach

## Review Loop Audit
- Liczba rund Reviewera: 1/3 Request changes (truncateHtml/testy) → poprawki → **2/3 Approve**

## Risks
- `ReviewOutcome.repairIssues` jest opcjonalne (kompatybilność z mockami); T10c musi używać `?? []`.
- Feedback zawiera poprzedni artykuł w JSON; przy bardzo długich artykułach prompt rośnie, ale `content_html` jest cięty.
- `truncateHtml` przy jednym ogromnym bloku bez closera zwraca ~8000 znaków bez domknięcia tagu; testy pokrywają fallback i cięcie po `</p>` z górnym limitem.
- `checkUrlDuplicate` nadal blokuje realny `run --url` dla istniejącego draftu; poza dry-runem retry draftu wymaga obejścia — kandydat na T10c/OPT.
- Bez zmian polityki publikacji — repair loop dopiero w T10c.

## Next steps
- F2-T10c: bounded repair loop, `REPAIR_MAX_ATTEMPTS`, guardy encji/długości, metryki `repair_*`, AGENTS §2.7–2.8.
