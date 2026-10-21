# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] F1-T2 Directus: relacje wizualne + rola read-only + token + seed 2-3 źródeł w `sources` — [CRITICAL]
- [ ] F2-T1 `ingestion.ts` (rss-parser + ScrapingAnt + cheerio, max 15, normalizacja URL, `route-source`) + testy — [CRITICAL]
- [ ] F2-T2 `scraper.ts` (fetch UA 10s → fallback, Readability, og:image, hard filter 800) + testy — [CRITICAL]

## KIEDYŚ

- [ ] F1-T3 deploy: nowa baza `kombain` + role + `schema.sql` na VPS (nowy compose obok n8n, reuse postgres:16 + Caddy) — [CRITICAL]
- [ ] F2-T3 `llm.ts + gatekeeper` (3.1 Flash-Lite, Zod, historia 30d) + testy schematu — [CRITICAL]
- [ ] F2-T4 `editor + review + factcheck` (3.8 Flash, 1 szablon × 6 person, R1/R2/R3 z groundingiem) + `prompts/*.md` + testy na wstrzykniętych halucynacjach — [CRITICAL]
- [ ] F2-T5 `media.ts` (sharp → R2) + `persist` (transakcja, slugify, tag sync, draft-vs-rejected) + testy PG — [CRITICAL]
- [ ] F2-T6 `orchestrator + pipeline + index + config + Dockerfile + cron VPS` + run testowy na żywych źródłach (limit 1-2) — [CRITICAL]
- [ ] F3-T1 `apps/web` Astro Hybrid + `directus.ts` + strony `/`, `/kategoria/[slug]`, `/artykul/[slug]` + Cache headers — [SAFE]
- [ ] F3-T2 R2 `media.kombain.pl` + defaulty kategorii + webhook deploy — [SAFE]
- [ ] OPT późn.: ewaluacja Deepseek V4.1 + Search jako alternatywy R3 (poza zakresem MVP)
