---
name: article-editorial
description: Bramkarz (3.1 Flash-Lite) + Redaktor i 3x review (3.8 Flash z groundingiem). Użyj przy klasyfikacji i syntezie artykułów AgTech. Re-run: popraw review, sprawdź halucynacje. Nie używaj do tłumaczenia 1:1 (szablon tego zakazuje).
---

# Article-editorial

## Wejście
- `{title,text,history30d}` → gate `{dup,rel,reason,category}` → `{EditorOut + external_refs[]}` → R1/R2/R3.

## Procedura
1. Gate (3.1 Flash-Lite, Zod): HARD FILTER AgTech, enum 6 kategorii, `PocketBase→PG`, `DANE ŹRÓDŁOWE` z triggera.
2. Synteza (3.8 Flash): 1 szablon × `CATEGORY_PERSONAS`, `title≤60`, HTML allowlist, `tldr 3-5`, `tags≤4`, `tech_summary`, `external_refs[]` obowiązkowe.
3. Parse: strip fences → JSON → izolacja klamer. Wyjątek → `draft`.
4. R1 technical (3.8): meta/HTML/struktura, 1x retry.
5. R2 extract (3.8): atomy `supported/external/inference`.
6. R3 verify (3.8 + search grounding): tylko `external` → `{confirmed/refuted/uncertain + URL}`. `refuted` → `draft`, `uncertain` → `draft + needs_human_check`.

## Błędy
- Zły JSON → log + `draft`. Zła kategoria → blokada persist.

## Testy
- Off-topic (dopłaty) → `is_relevant=false`. Duplikat 30d → `is_duplicate=true`. Wstrzyknięta liczba → R3 `refuted`.
