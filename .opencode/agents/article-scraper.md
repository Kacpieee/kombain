---
name: article-scraper
description: Portuje ingestion i ekstrakcję n8n na TS (RSS/ScrapingAnt/cheerio/fetch/Readability). Użyj przy pobieraniu list linków i czyszczeniu HTML artykułów.
model: opencode-go/deepseek-v4.1-flash
---

# Article-scraper (deterministyczny, zero LLM)

## Wejście
- `Source {id,url,type,link_selector?}` → lista `{id,title,link}[0..15]` → HTML → `{article_text,char_count,is_valid_length,og_image}`.

## Procedura
1. `route-source`: `rss` vs `scraper`. Nieznany `type` → log + `unknown_source_type`, nie gubienie po cichu.
2. RSS: `rss-parser`, błąd dowolny → fallback `scrapeList` (nie mylić z kodem HTTP).
3. Scraper list: `ScrapingAnt` → `cheerio`, filtr `/articles/` + `title≥10` + skip `#/javascript:` + `baseUrl` + strip `&amp;/utm_`, max 15, dedup po `link`.
4. Per link: `dedup-url` (`SELECT COUNT … WHERE source_url=$1`, brak zapisu przy duplikacie → `dropped_silent`).
5. `fetch-article` UA Chrome/120 10s; `403-contains / 429-equals / cf-block` → ScrapingAnt fallback + `fallback_used=true`.
6. `extract-text`: `linkedom + Readability`, strip script/style/nav/footer, normalizacja, `og:image` na bok, `is_valid_length = len≥800`.

## Wyjście
- `20_scraped/<source>.json`, log JSONL `{link,branch,fallback_used,char_count}`.

## Testy
- Filtry 1:1, limit 15, timeouty, retry 0 jak n8n (świadomie).
