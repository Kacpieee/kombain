# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] F2-T7b obserwowalność: Telegram + healthchecks, timeout runu, `MAX_PROCESSED_PER_RUN`, tabela `article_failures` (backoff 3 próby/7 dni) — [CRITICAL]
- [ ] F3-T1 `apps/web` Astro Hybrid + `directus.ts` + strony `/`, `/kategoria/[slug]`, `/artykul/[slug]` + Cache headers — [SAFE]

## KIEDYŚ

- [ ] F3-T2 R2 `media.kombain.pl` + defaulty kategorii (6 plików `defaults/*.webp`) + webhook deploy — [SAFE]
- [ ] OPT późn.: M2M alias „tags” w Directusie (edycja tagów w widoku artykułu) — [SAFE]
- [ ] OPT późn.: naprawa `scripts/verify.sh` (maskowanie exit code, martwy glob `prompts/*.md`, sekrety w `deploy/`) — [SAFE]
- [ ] OPT późn.: indeks `article_tags(tag_id)` (przyszłe „artykuły po tagu”) — [CRITICAL]
- [ ] OPT późn.: ewaluacja Deepseek V4.1 + Search jako alternatywy R3 (poza zakresem MVP)
