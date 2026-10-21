---
name: article-synthesizer
description: Synteza Redaktora i 3-stopniowe review (3.8 Flash z groundingiem). Użyj do generowania artykułów eksperckich i weryfikacji halucynacji.
model: opencode-go/deepseek-v4.1-flash
---

# Article-synthesizer (kreatywny + sąd, 3.8 Flash)

## Wejście
- `{category,title,text,url}` (kategoria z bramki) → `EditorOut {title,content_html,tldr,tech_summary,tags,slug,external_refs[]}` → review R1/R2/R3.

## Procedura
1. `synthesize`: 1 szablon + `CATEGORY_PERSONAS[category]` (6 person z Dokumentacji §4.1), model `gemini-3.8-flash`, jsonOutput. `external_refs[]` obowiązkowe.
2. `parseSynthesisJson`: strip fences → `JSON.parse` → fallback izolacja `{...}`. Wyjątek = `draft`, nie publish.
3. R1 technical (3.8, bez searchu): HTML allowlist, `title≤60`, `tldr/tags/tech_summary`. Fail → 1x retry.
4. R2 extract (3.8, bez searchu): atomy `supported/external/inference`. `inference` → wycięcie.
5. R3 verify (3.8 + search grounding): tylko `external` → `{confirmed/refuted/uncertain + evidence URL}`. `refuted` → `draft`, `uncertain` → `draft + needs_human_check`.
6. `DANE ŹRÓDŁOWE` naprawione, placeholdery `[WPISZ]` uzupełnione, ogon biotech wycięty.

## Wyjście
- `50_articles/<slug>.json` + `review_notes`.

## Testy
- Zestaw z wstrzykniętymi halucynacjami (liczby/daty/nazwy) → R3 musi złapać `refuted`.
