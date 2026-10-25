# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] OPS (użytkownik, VPS): wdrożenie F2-T9b — transfer `apps/worker`, `VERIFY_MAX_ATOMS=8`, rebuild obrazu, `run --dry-run`, pomiar `draft_rate` i `verify_*` (brak dostępu SSH z dev-harness)
- [ ] F3-T1 `apps/web` Astro Hybrid + `directus.ts` + strony `/`, `/kategoria/[slug]`, `/artykul/[slug]` + Cache headers — [SAFE]

## KIEDYŚ

- [ ] F3-T2 R2 `media.kombain.pl` + defaulty kategorii (6 plików `defaults/*.webp`) + webhook deploy — [SAFE]
- [ ] OPT: licznik `research_failed` + `draft_rate` w `run_summary` (research ma dziś tylko alert, brak licznika) — [SAFE]
- [ ] OPT: M2M alias „tags” w Directusie (edycja tagów w widoku artykułu) — [SAFE]
- [ ] OPT: naprawa `scripts/verify.sh` (maskowanie exit code, martwy glob `prompts/*.md`, sekrety w `deploy/`, false-positive na literały testów) — [SAFE]
- [ ] OPT: bramka R3 — stoplista all-caps rzeczowników, wymóg encji nieliczbowej, ≥2 rdzenie spoza top-100 PL (FP), oraz recall akronimów na początku zdania i `raw[1]` przy pustym `raw[0]` — [SAFE]
- [ ] OPT: metryki R3 — `verify_*` także przy błędzie R3, `fetch_attempts/fetch_fail`, jedno źródło `VERIFY_MAX_ATOMS` (config → serwis) — [SAFE]
- [ ] OPT: indeks `article_tags(tag_id)` (przyszłe „artykuły po tagu”) — [CRITICAL]
- [ ] OPT: czyszczenie wygasłych `article_failures` (>30 dni) — [SAFE]
