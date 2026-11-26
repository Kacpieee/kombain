# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] OPS (użytkownik, VPS): lokalne A/B na AgFunderze wykonane (11 ważnych runów: 5 published / 6 draft), a następnie wdrożenie F2-T9b + F2-T10a/b/c na VPS przez `deploy/scripts/release-worker.sh` (`VERIFY_MAX_ATOMS=8`, `REPAIR_MAX_ATTEMPTS=1`, rebuild, defaulty; pomiar `draft_rate`, `repair_*` i `verify_*`)

## KIEDYŚ
- [ ] OPT: licznik `research_failed` + `draft_rate` w `run_summary` (research ma dziś tylko alert, brak licznika) — [SAFE]
- [ ] OPT: M2M alias „tags” w Directusie (edycja tagów w widoku artykułu) — [SAFE]
- [ ] OPT: naprawa `scripts/verify.sh` (maskowanie exit code, martwy glob `prompts/*.md`, sekrety w `deploy/`, false-positive na literały testów) — [SAFE]
- [ ] OPT: bramka R3 — wymóg encji nieliczbowej i ≥2 rdzenie spoza top-100 PL (FP) — [SAFE]
- [ ] OPT: metryki R3 — `fetch_attempts/fetch_fail` — [SAFE]
- [ ] OPT: indeks `article_tags(tag_id)` (przyszłe „artykuły po tagu”) — [CRITICAL]
- [ ] OPT: czyszczenie wygasłych `article_failures` (>30 dni) — [SAFE]
- [ ] WEB: upgrade Astro 4 → Astro 5 + `@astrojs/cloudflare` (uzasadnienie: Astro 4 EOL; wymaga pre-mortem i testu regresji SSR/adaptera) — [CRITICAL]
- [ ] WEB: paginacja SSR listingu `/` i `/kategoria/[slug]` — uruchomić, gdy `published > limit` (24/30); wymaga decyzji o cache, canonical i `rel=prev/next` — [SAFE]
- [ ] WEB: dark mode (`prefers-color-scheme: dark`, podmiana tokenów `--color-*` razem z decyzją o marce) — [SAFE]
