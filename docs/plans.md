# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] OPS (użytkownik, VPS): lokalne A/B na AgFunderze (3–5 runów `run --dry-run --url`), a następnie wdrożenie F2-T9b + F2-T10a/b/c na VPS (`VERIFY_MAX_ATOMS=8`, `REPAIR_MAX_ATTEMPTS=1`, rebuild obrazu, pomiar `draft_rate`, `repair_*` i `verify_*`)
- [ ] F3-T2 R2 `media.kombain.pl` + defaulty kategorii (6 plików `defaults/*.webp`) + webhook deploy — [SAFE]

## KIEDYŚ
- [ ] OPT: licznik `research_failed` + `draft_rate` w `run_summary` (research ma dziś tylko alert, brak licznika) — [SAFE]
- [ ] OPT: M2M alias „tags” w Directusie (edycja tagów w widoku artykułu) — [SAFE]
- [ ] OPT: naprawa `scripts/verify.sh` (maskowanie exit code, martwy glob `prompts/*.md`, sekrety w `deploy/`, false-positive na literały testów) — [SAFE]
- [ ] OPT: bramka R3 — wymóg encji nieliczbowej i ≥2 rdzenie spoza top-100 PL (FP) — [SAFE]
- [ ] OPT: metryki R3 — `fetch_attempts/fetch_fail` — [SAFE]
- [ ] OPT: indeks `article_tags(tag_id)` (przyszłe „artykuły po tagu”) — [CRITICAL]
- [ ] OPT: czyszczenie wygasłych `article_failures` (>30 dni) — [SAFE]
