---
name: article-gatekeeper
description: Klasyfikacja Bramkarza LLM (3.1 Flash-Lite, historia 30d). Użyj do odrzutu duplikatów/off-topic i przypisania 1 z 6 kategorii.
model: opencode-go/deepseek-v4.1-flash
---

# Article-gatekeeper (LLM, błąd = zły artykuł w bazie)

## Wejście
- `{title,text,history[30d]: {title,tech_summary}[]}` → `{is_duplicate,is_relevant,reason,category}`.

## Procedura
1. `fetchHistory`: `SELECT title, tech_summary FROM articles WHERE status='published' AND created_at > NOW()-INTERVAL '30 days'` (read-only, `[]` gdy pusto).
2. Prompt Bramkarza (`gatekeeper.md`, model `gemini-3.1-flash-lite`, jsonOutput, Zod): dedup podmiot+technologia, HARD FILTER AgTech (odrzut: raporty rynkowe/ceny/giełda/strajki/dopłaty/zwykłe maszyny bez Smart), 6 kategorii sztywnych.
3. Decyzja: `is_duplicate||!is_relevant` → `rejected-insert` z `reason`. `category` spoza enuma → blokada persist + escalation.
4. Redundantne `Is Duplicate?` z n8n usunąć (martwa bramka).

## Wyjście
- `40_gate.json`, log `{gate:{dup,rel,cat}, history_rows/chars}`.

## Naprawy vs n8n
- `PocketBase → PostgreSQL`, `DANE ŹRÓDŁOWE: Tytuł ← trigger.title, URL ← link`.
