# Prompt taska (brief wykonawczy — wymagany przed implementacją)

1. Przeczytaj `AGENTS.md` → `docs/STATUS.md` → `docs/plans.md` (najwyższy TERAZ) → `git log -10` + `git status`.
2. Przeczytaj spec wg potrzeby: `Dokumentacja Techniczna Projektu kombain.pl.md` + `Stary workflow - baza/*.txt`.
3. Określ tryb: `[SAFE]` (Astro UI/CSS/copy) lub `[CRITICAL]` (DB/queries/prompty/llm/media/R2/cron/sekrety). Dla `[CRITICAL]` wykonaj pre-mortem (ryzyka PG/LLM/R2 + pytania TERAZ-vs-KIEDYŚ).
4. Napisz mini-brief i trzymaj się go (bez wychodzenia poza scope):

```markdown
## Cel i Tryb
- Tryb: [SAFE | CRITICAL]
- Cel (1-2 zdania): co i po co.

## Kontekst
Pliki / moduły / branch.

## Scope
- ...

## Out of scope (nie ruszać)
- ...

## Kryteria akceptacji + wnioski pre-mortem (mierzalne)
- ...

## Plan testów
- unit/vitest + test PG w Dockerze (gdy DB) + mocki LLM (bez wołania Gemini w verify).

## Ryzyka
- ...

## DoD
- `docs/plans.md` i `docs/STATUS.md` zaktualizowane, `scripts/verify.sh` zielone, ostatnia runda Reviewera = `Approve`, brak zmian poza scope.
```

5. Zrób tylko ten plan (TDD dla parserów/slugify/gate Zod/persistu). Zaktualizuj `docs/plans.md` (usuń wdrożony) i `docs/STATUS.md` (1 linijka w `Działa`).
6. Zamknięta pętla: `scripts/verify.sh (repair max 3) → Reviewer` po każdej poprawce aż do `Approve` (max 3 rundy, inaczej `escalation.md`) → `final-report.md` → commit Conventional → `git push origin`.
