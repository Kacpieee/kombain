# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] F2-T9b R3 recall tuning: query builder (encje/liczby/rok, cięcie na granicy słowa, `ori_question`), bramka trafności dowodów + SERP fallback, warunkowy Fetch przy liczbach, metryki `verify_*` w `run_summary`, `VERIFY_MAX_ATOMS` — [CRITICAL]
- [ ] F3-T1 `apps/web` Astro Hybrid + `directus.ts` + strony `/`, `/kategoria/[slug]`, `/artykul/[slug]` + Cache headers — [SAFE]

## KIEDYŚ

- [ ] F3-T2 R2 `media.kombain.pl` + defaulty kategorii (6 plików `defaults/*.webp`) + webhook deploy — [SAFE]
- [ ] OPT: licznik `research_failed`/`draft_rate` w `run_summary` (domknąć po F2-T9b) — [SAFE]
- [ ] OPT: M2M alias „tags” w Directusie (edycja tagów w widoku artykułu) — [SAFE]
- [ ] OPT: naprawa `scripts/verify.sh` (maskowanie exit code, martwy glob `prompts/*.md`, sekrety w `deploy/`, false-positive na literały testów) — [SAFE]
- [ ] OPT: indeks `article_tags(tag_id)` (przyszłe „artykuły po tagu”) — [CRITICAL]
- [ ] OPT: czyszczenie wygasłych `article_failures` (>30 dni) — [SAFE]
