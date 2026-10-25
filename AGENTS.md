# AGENTS.md — kombain.pl (automatyzacja AgTech bez n8n)

Jesteś agentem kodującym w monorepo **kombain.pl**.
Budujesz deterministyczny pipeline TypeScript zastępujący `Stary workflow - baza/master workflow.txt` + `worker.txt`.

Źródło prawdy funkcjonalnej: **wyłącznie** `Dokumentacja Techniczna Projektu kombain.pl.md` (§3 DDL, §4 pipeline, §5 monorepo, §6 roadmap).
Źródło reverse-engineeringu: `Stary workflow - baza/*.txt` (10 nodów mastera, 27 nodów workera — nie kopiować bugów 1:1, patrz §2).
Kolejka: `docs/plans.md` (najwyższy TERAZ) + `docs/STATUS.md` (dziennik). Jeden task na raz.

Dev-harness (to środowisko, Opencode): default `opencode-go/deepseek-v4.1-flash` z `opencode.jsonc`. Nie musisz ręcznie ustawiać modelu.
Runtime (VPS, poza tym środowiskiem): generacja — Google API (`gemini-3.1-flash-lite` bramkarz/dystylacja, `gemini-3.8-flash` redaktor); **research i weryfikacja faktów — DeepSeek Search/Fetch API** (`api.deepseek.com/v1/tools/*`, szeroki zasięg źródeł, fallback SERP przez ScrapingAnt). Review R3 domyślnie DeepSeek + Flash-Lite; `VERIFY_PROVIDER=gemini` jako rollback z groundingiem. deepseek-v4.1 (dev-harness) NIE jest używany na VPS.

Remote: `git@github.com:Kacpieee/kombain.git` (SSH). Po każdym tasku: pętla `scripts/verify.sh` ↔ `Reviewer` → 1 commit Conventional → `git push origin`.

---

## 0. Architektura docelowa (z Dokumentacji §2)

- **VPS (Caddy):** PostgreSQL 16+ + Directus CMS (`https://cms.kombain.pl`, rola read-only `DIRECTUS_PUBLIC_READ_TOKEN`) + Worker Docker/Bun (cron ~6h, bezpośredni PG w sieci wewnętrznej).
- **Cloudflare:** Pages + Functions (Astro Hybrid SSR, `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`) + R2 (`https://media.kombain.pl`, webp).
- **Monorepo:**
  - `packages/db/{schema.sql,index.ts,queries.ts}`
  - `apps/worker/src/{index.ts,config.ts,orchestrator.ts,pipeline.ts,prompts.ts,services/ingestion.ts,services/scraper.ts,services/llm.ts,services/media.ts,services/review.ts,services/factcheck.ts}`
  - `apps/web/src/{lib/directus.ts,layouts/,components/,pages/}`

## 1. Tech stack (twardy)

| Warstwa | Wybór |
|---|---|
| Runtime worker | Bun / Node 20 + TypeScript strict |
| DB | `pg` Pool (writer TCP na VPS/Actions, reader przez Directus REST na web) |
| RSS | `rss-parser` |
| Scrape listy | `ScrapingAnt API` + `cheerio` |
| Scrape artykułu | `fetch` UA Chrome 10s → fallback ScrapingAnt przy `403/429/CF-Just a moment` → `linkedom + @mozilla/readability` → `sanitize-html` |
| LLM | `@google/genai`, `gemini-3.1-flash-lite` (gate + dystylacja researchu) + `gemini-3.8-flash` (synteza + review z search grounding); **DeepSeek Search/Fetch** (`api.deepseek.com/v1/tools/*`) do researchu i weryfikacji faktów, fallback SERP (ScrapingAnt + DuckDuckGo HTML), walidacja `zod` |
| Media | `sharp` 1200x675 `webp q80` → S3 SDK na R2 `articles/{slug}.webp` |
| Web | Astro + `@astrojs/cloudflare`, `output: server` |
| Lint/test | `tsc --noEmit`, `vitest`, `eslint`/`biome` |

## 2. Twarde reguły pipeline (łamanie = fail taska)

1. **Limity:** `MAX_PUBLISHED_PER_RUN=2`, max 15 URL/źródło, `p-limit(5)` na fan-out.
2. **URL:** względne → bezwzględne, strip `utm_*/fbclid/&amp;`, dedup w pamięci + `SELECT 1 FROM articles WHERE source_url=$1` przed scrapem.
3. **Scrape:** standardowy `fetch` najpierw, ScrapingAnt tylko jako fallback. Licznik `scrape_fallback_used` na run.
4. **Ekstrakcja:** `og:image` na bok, czysty tekst ≥800 znaków, inaczej `rejected` z `rejection_reason='Tekst zbyt krótki'`. Bez regex-stripów menu/stopek.
5. **Bramkarz (3.1 Flash-Lite, historia 30d):** schema `{is_duplicate,is_relevant,reason,category: enum 6}`. `is_duplicate||!is_relevant` → `rejected` z `reason`. Kategoria spoza enuma → blokada persist.
6. **Redaktor (3.8 Flash, 1 szablon × 6 person CATEGORY_PERSONAS):** `content_html` tylko `p/h2/h3/strong/em/ul/ol/li`, `title≤60`, `slug` bez PL, `tldr` 3-5, `tags≤4` lowercase, `tech_summary{podmiot,technologia,cel_wdrozenia}`. Link `Źródło:` doklejany z `source_url` w kodzie, nigdy z LLM. Redaktor zwraca też `external_refs[]` do review.
7. **Review 3-stopniowe (3.8 Flash, blokujące do `draft`, nie do `rejected`):**
   - R1 technical (bez searchu): HTML/meta/struktura. Fail → 1x retry.
   - R2 extract (bez searchu): atomy `supported-by-source/external/inference`. `inference` bez dowodu → do wycięcia.
   - R3 verify (DeepSeek Search+Fetch + Flash-Lite; rollback `gemini-3.8-flash` z search grounding): tylko atomy `external` → `{confirmed/refuted/uncertain + evidence URL}`. `refuted` → 1× repair Redaktora, `uncertain` → 1× repair, potem `draft` (+ `needs_human_check` dla `uncertain`).
   - **Bounded repair (`REPAIR_MAX_ATTEMPTS=1`)**: R1 retry i repair po R2/R3 dostają `EditorFeedback` (poprzedni artykuł + issues). Po repair pełny `R1 → R2 → R3`; publikacja tylko gdy clean. `search_error`/`max_atoms_cap`/błąd LLM/R1 fail = draft bez repair.
8. **Stany (krytyczne — chroni przed utratą dobrego tematu):**
   - `rejected` = tylko permanentne: za krótki, `is_relevant=false`, `is_duplicate=true`. Dedup blokuje ponowienie.
   - `draft`/`needs_human_check` = fail review po nieudanym repair, błąd LLM, `refuted/uncertain`. Dedup NIE blokuje: retry robi `ON CONFLICT(source_url) DO UPDATE`.
   - `published` = tylko po zielonym R1+R2+R3.
   - Ciche porzucenia (duplikat URL, duplikat semantyczny bramki) = licznik + log JSONL, bez wiersza w DB.
9. **Persist:** `category_id NOT NULL`, `slug UNIQUE` (kolizja → 4-znak suffix), tagi `ON CONFLICT(slug)`, link `ON CONFLICT DO NOTHING`, całość w `BEGIN/COMMIT`. `source_url` zawsze z wejścia `processArticle(link)`, nigdy z dumpa historii ani `Loop Over Items`.
10. **Odpady:** `text_content` = HTML redaktora po sanityzacji, `image_url` = R2 lub default kategorii, `published_at=NOW()` przy publish.

## 3. Tryby `[SAFE]` vs `[CRITICAL]`

- `[SAFE]` (Astro UI, CSS, copy, `directus.ts` read): mini-brief + kod + testy, bez pre-mortem.
- `[CRITICAL]` (DB DDL, `queries.ts`, prompty, `llm.ts/review.ts/factcheck.ts`, `media.ts/R2`, cron, sekrety): przed kodem analiza pre-mortem (ux check + ryzyka sync/PG/LLM + pytania TERAZ-vs-KIEDYŚ). Bloker decyzyjny → STOP + escalation.

## 4. Sekrety (twarde)

Nigdy w repo ani w diffie: `.env`, `GEMINI_API_KEY`, `SCRAPINGANT_API_KEY`, `DEEPSEEK_API_KEY`, `DIRECTUS_PUBLIC_READ_TOKEN`, JWT, `*.pem/*.key`, `*.sqlite`.
`GEMINI/SCRAPINGANT/DEEPSEEK` tylko VPS/Docker env. `DATABASE_URL` (reader) vs `DIRECT_DATABASE_URL` (writer TCP). Strona/Functions używa wyłącznie Directus REST read-only.

## 5. Git, commity, kolejka

1. Bootstrap: `AGENTS.md → docs/STATUS.md → docs/plans.md → git log -10 + git status`.
2. Weź najwyższy TERAZ z `docs/plans.md`. Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ.
3. Po zielonej pętli: usuń plan z `plans.md` w całości → 1 linijka do `STATUS.md Działa` → `final-report.md` → commit Conventional (`feat:/fix:/test:/refactor:/chore:/docs:`), 1 task = 1 commit → `git push origin`. Zakaz `--force/--no-verify`.

## 6. Weryfikacja (obowiązkowa)

`scripts/verify.sh` z roota. Brak `exit 0` lub brak `Approve` po ostatniej zmianie = zakaz commita.
Repair: `reproduce → minimal fix → regression test → rerun, max 3 → 4. fail = STOP + escalation.md`.
Review: `verify.sh → Reviewer Runda X/3 → Request changes (runda<3) → poprawki → verify.sh → Runda X+1 → Approve → commit`. `Request changes` w 3/3 lub `Escalate` → STOP.
Zakazy: nie wyłączaj testu/linta, nie refaktoryzuj poza scope, nie dodawaj dep bez uzasadnienia, nie zmieniaj DDL/API bez zgody, raportuj liczbowo.

## 7. Dokumenty do czytania przed kodem

| Temat | Plik |
|---|---|
| Spec pełna | `Dokumentacja Techniczna Projektu kombain.pl.md` |
| Nody n8n | `Stary workflow - baza/master workflow.txt`, `worker.txt` |
| Kolejka/dziennik | `docs/plans.md`, `docs/STATUS.md` |
| Prompty | `apps/worker/src/prompts.ts` + `prompts/*.md` |
| Wzorce harnessu | `.opencode/skills/*/SKILL.md` |
