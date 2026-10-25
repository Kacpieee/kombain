# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] F2-T5 `media.ts` (sharp → R2) + `persist` (transakcja, slugify, tag sync, draft-vs-rejected) + testy PG — [CRITICAL]

## KIEDYŚ

- [ ] F2-T6 `orchestrator + pipeline + index + config + Dockerfile + cron VPS` + dedupe run-level + hardening logów (redakcja percent-encoded, markery ścian bez `<noscript>`) + run testowy na żywych źródłach (limit 1-2) — [CRITICAL]
- [ ] F3-T1 `apps/web` Astro Hybrid + `directus.ts` + strony `/`, `/kategoria/[slug]`, `/artykul/[slug]` + Cache headers — [SAFE]
- [ ] F3-T2 R2 `media.kombain.pl` + defaulty kategorii + webhook deploy — [SAFE]
- [ ] OPT późn.: M2M alias „tags” w Directusie (edycja tagów w widoku artykułu) — [SAFE]
- [ ] OPT późn.: naprawa `scripts/verify.sh` (maskowanie exit code przez `| head`/`| tail`) — [SAFE]
- [ ] OPT późn.: indeks `article_tags(tag_id)` (przyszłe „artykuły po tagu”) — [CRITICAL]
- [ ] OPT późn.: ewaluacja Deepseek V4.1 + Search jako alternatywy R3 (poza zakresem MVP)
