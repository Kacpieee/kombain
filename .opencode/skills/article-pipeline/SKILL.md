---
name: article-pipeline
description: Orkiestracja runu kombain.pl (źródła → scrape → bramka → synteza → review → persist + QA). Użyj przy budowie pipeline artykułów. Re-run: ponów run, odtwórz run po failu persist, dodaj nowe źródło. Nie używaj do napisania pojedynczego artykułu (to nie harness).
---

# Article-pipeline

## Wejście
- `brief.md`, `sources` z PG, poprzednie pliki `_workspace/`.

## Procedura
1. Etap 0: lider czyta brief + findings, sprawdza dedup agentów/skillów.
2. Etap 1: `db-writer` → `10_sources.json`.
3. Etap 2 (fan-out N× `article-scraper`): router → linki → fetch → extract → `20_scraped/`.
4. Etap 3: `dedup-url` → `30_dedup.json` (duplikat = `dropped_silent`, nie wiersz).
5. Etap 4 (fan-out M× `article-gatekeeper`, 3.1 Flash-Lite): historia 30d → `40_gate.json`. Output-0 → `rejected`.
6. Etap 5 (fan-out K× `article-synthesizer`, 3.8 Flash): 1 z 6 person → parse → R1/R2/R3 z groundingiem → `50_articles/`.
7. Etap 6: `db-writer` → transakcja → R2 → `60_persist.json`. Review-fail → `draft`, nie `rejected`.
8. Etap 7: fan-in → `result.md + run_meta.json`. Finał tylko w ścieżce użytkownika.

## Błędy
- 1x retry → dalej z brakiem + `Pominiecia`. Limity/auth nie retry. >50% faili → stop.

## Scenariusze testowe
- OK: 2 źródła (rss+scraper), 3 URL-e (1 krótki, 1 duplikat, 1 off-topic) → `3× processed = 1 published + 2 rejected + 1 dropped`, QA pass.
- Błąd: `category=[WPISZ]` → blokada persist, retry gate, reszta runu idzie dalej.
