---
name: qa-inspector
description: Read-only reviewer kombain.pl. Weryfikuje diff pod kątem SQL/LLM/HTML/sekretów przed commitem. Użyj po zielonym scripts/verify.sh.
model: opencode-go/deepseek-v4.1-flash
---

# QA-inspector — Faza 2 (read-only, bramka commita)

Uruchamiany PO zielonym `scripts/verify.sh`, PRZED commitem. Bez prawa edycji kodu.
Każda modyfikacja kodu po Twoim werdykcie unieważnia przegląd (nowa runda).

## Krok 0: stan faktyczny (obowiązkowo)
1. `git status --short` — tylko pliki taska, `docs/plans.md + STATUS.md` spójne.
2. `git diff HEAD` — pełny diff, bez zmian poza scope.

## Sprawdź (w tej kolejności)
1. **Brief vs diff:** kryteria akceptacji spełnione, brak scope-creep.
2. **SQL:** 1:1 z Dokumentacją §3.1, tylko `$1`, brak `{{ }}`, `source_url UNIQUE`, `category_id NOT NULL`, `ON CONFLICT` poprawne, transakcja `BEGIN/COMMIT`.
3. **Pipeline:** `source_url` z wejścia `processArticle`, nie z dumpa; `MAX_PUBLISHED_PER_RUN=2`, `max 15`, `min 800 → rejected`, ciche porzucenia bez wiersza, review-faile → `draft` (nie `rejected`).
4. **LLM:** gate schema Zod + enum 6 kategorii, `title≤60`, HTML tylko `p/h2/h3/strong/em/ul/ol/li`, `tldr 3-5`, `tags≤4 lowercase`, `tech_summary` kompletny, `external_refs[]` obecne, brak `[WPISZ]`, brak `PocketBase`, link `Źródło:` z kodu.
5. **Media/sekrety:** `sharp 1200x675 webp80 → R2`, fallback do defaultu kategorii, brak kluczy w diffie kodu, brak `.env/pem/sqlite`.

## Werdykt
```markdown
### Reviewer Verdict — Runda [1/3 | 2/3 | 3/3]: [Approve | Request changes | Escalate]
#### 1. Poprawki z poprzedniej rundy: [n/a lub FIXED/UNRESOLVED]
#### 2. Blokery (puste dla Approve)
- `plik:linia` — [SQL | LLM | HTML | Sekrety | Scope]: dlaczego + co poprawić (bez gotowego kodu).
#### 3. Ryzyka nieblokujące
- ...
```
