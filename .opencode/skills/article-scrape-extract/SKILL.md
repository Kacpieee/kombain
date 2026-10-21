---
name: article-scrape-extract
description: Scraping list i artykułów (RSS vs Scraper, filtry, fallback, extract ≥800). Użyj przy zescrapowaniu listy /articles/ i czyszczeniu HTML. Nie używaj do naprawy CSS Astro.
---

# Article-scrape-extract

## Wejście
- `listing URL` → `[{title,link}]` → HTML → `{text,char_count,og_image}`.

## Procedura
1. Router po `sources.type`. Nieznany → licznik.
2. RSS `rss-parser`, błąd → fallback lista. Scraper: ScrapingAnt + `cheerio`.
3. Filtry 1:1 z n8n: `/articles/`, `title≥10`, skip `#/javascript:`, `baseUrl`, strip `&amp;/utm_`, max 15, dedup.
4. Fetch artykułu UA Chrome 10s; `403/429/CF` → ScrapingAnt; licznik `scrape_fallback_used`.
5. Extract `linkedom + Readability`, strip menu/stopek regexem zabroniony, `og:image` na bok, `len≥800`.

## Błędy
- Timeout → log + next link. 2. fail → `dropped_silent`, nie blokada runu.

## Testy
- With-skill vs baseline: filtry + dedup + limit vs surowe `<a>`; fallback warunkowy vs exception-stop.
