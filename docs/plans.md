# Plany — kombain.pl

Zasada: najwyższy TERAZ = jeden task na raz. Zrobione znika w całości → 1 linijka do `STATUS.md Działa`.
Nowy pomysł bez werdyktu → dopytaj TERAZ-vs-KIEDYŚ, nie dopisuj w ciemno.

## TERAZ

- [ ] **F2-T10b: Feedback plumbing, synchronizacja HTML i diagnostyka (`prompts.ts`, `review.ts`, `pipeline.ts`, `orchestrator.ts`, `config.ts`)** — `[CRITICAL]`
  - **Problem:**
    1. `regenerate` w R1 ([`pipeline.ts`](file:///home/Kacper/Projects/Kombain%20-%20automatyzacja/apps/worker/src/pipeline.ts#L170-L174)) ignoruje `issues` i nie przekazuje poprzedniego artykułu do [`synthesizeArticle`](file:///home/Kacper/Projects/Kombain%20-%20automatyzacja/apps/worker/src/services/llm.ts#L127).
    2. `sanitizeEditorHtml` i `stripInferences` w [`review.ts`](file:///home/Kacper/Projects/Kombain%20-%20automatyzacja/apps/worker/src/services/review.ts#L343-L405) aktualizują tylko `cleanedHtml`, zostawiając w `article.content_html` nieoczyszczony HTML i wycięte wnioski `inference`.
    3. W R3 ([`review.ts`](file:///home/Kacper/Projects/Kombain%20-%20automatyzacja/apps/worker/src/services/review.ts#L426-L443)) wczesny `return` dla `refuted` ucina z `issues` wszystkie `uncertain` i gubi strukturalne dane (`evidence_url`, `stage`, `reason`).
    4. `VERIFY_MAX_ATOMS` jest czytane z `process.env` w `factcheck.ts` zamiast płynąć z `AppConfig`, `orchestrator.ts` nie zlicza `verify_*` w trybie `dry_run`, a `run --dry-run --url <url>` jest blokowane przez `checkUrlDuplicate`.
  - **Rozwiązanie i testy (TDD):**
    1. **Struktury feedbacku i cięcie HTML po blokach (`prompts.ts`, `review.ts`):**
       - Dodać w `prompts.ts`:
         - `RepairIssue`: `{ stage: "R1" | "R2" | "R3"; claim: string; verdict: "refuted" | "uncertain" | "inference_missed" | "technical"; evidence_url?: string; reason?: string }`,
         - `EditorFeedback`: `{ previousArticle: EditorOut; issues: RepairIssue[] }`,
         - `EditorPromptInput.feedback?: EditorFeedback`.
       - W `buildEditorPrompt` (gdy podano `feedback`) doklejać sekcję `TRYB POPRAWY (POPRZEDNIA WERSJA I UWAGI REVIEWERA)`:
         - `previousArticle.content_html` obcinać do maks. `8000` znaków **na granicy tagu zamykającego blok** (`</p>`, `</h2>`, `</h3>`, `</ul>`, `</ol>`), aby nigdy nie przeciąć znacznika HTML w połowie,
         - sanityzować `evidence_url` (`^https?:\/\/`, maks. `200` znaków, bez białych znaków/nowych linii).
       - W `ReviewOutcome` zachować `issues: string[]` (pełna lista: wszystkie `refuted` z URL + wszystkie `uncertain`) i dodać `repairIssues: RepairIssue[]`, przewlekając oba pola przez helper `draft()`.
    2. **R1 `regenerate(issues, previousArticle)` i sync HTML (`review.ts`, `pipeline.ts`):**
       - Zmienić sygnaturę `ReviewDeps.regenerate?: (issues: string[], previousArticle: EditorOut) => Promise<EditorOut>` i zaktualizować wszystkie wywołania oraz testy.
       - Zaraz po `sanitizeEditorHtml` (przed `validateTechnical` i `runR1`) oraz po `stripInferences` aktualizować `article = { ...article, content_html: cleanedHtml }`.
       - W `pipeline.ts` podpiąć w `regenerate` wywołanie `synthesize({ ...editorInput, feedback: { previousArticle, issues: issues.map(...) } })`.
    3. **Przewleczenie konfiguracji i diagnostyki (`orchestrator.ts`, `pipeline.ts`, `review.ts`):**
       - Przekazać `verifyMaxAtoms: cfg.VERIFY_MAX_ATOMS` z `runOnce` → `PipelineOverrides` → `ReviewDeps` → `FactcheckDeps`.
       - W `orchestrator.ts`: w `countOutcome` dla `case "dry_run":` wywoływać `countVerify(report, outcome.review?.verify)`; w `runOnce` przy `options.dryRun && options.url` przekazywać `skipDuplicateCheck: true` do `processArticle`, aby `--dry-run --url` zawsze przechodziło pełny potok.

- [ ] **F2-T10c: Bounded Repair Loop po R2/R3 + deterministyczne guardy bezpieczeństwa (`config.ts`, `review.ts`, `pipeline.ts`, `orchestrator.ts`, `AGENTS.md`)** — `[CRITICAL]`
  - **Problem:**
    - Po przygotowaniu plumbingu (`F2-T10b`) artykuły z pojedynczym `refuted`/`uncertain` (`no_evidence`/`judge_uncertain`) z R3 lub niewyciętym `inference` z R2 (`stripped.missed`) nadal od razu spadają do `draft`.
  - **Rozwiązanie i testy (TDD):**
    1. **Konfiguracja i przewleczenie (`config.ts`, `orchestrator.ts`, `pipeline.ts`, `review.ts`):**
       - Dodać w `config.ts`: `REPAIR_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(2).default(1)`.
       - Przewlec `maxRepairAttempts: cfg.REPAIR_MAX_ATTEMPTS` przez `runOnce` → `PipelineOverrides.maxRepairAttempts` → `ReviewDeps.maxRepairAttempts` (zero czytania `process.env` w `review.ts`).
       - Kontrakt liczby przebiegów w pętli `for (let attempt = 0; attempt <= maxRepairAttempts; attempt++)`:
         - `REPAIR_MAX_ATTEMPTS = 0` → `1` przebieg `reviewOnce` (repair wyłączony),
         - `REPAIR_MAX_ATTEMPTS = 1` (domyślnie) → maks. `2` przebiegi `reviewOnce` (pierwotny + 1 po naprawie),
         - `REPAIR_MAX_ATTEMPTS = 2` → maks. `3` przebiegi `reviewOnce`.
    2. **Twardy guard encji w `coveredByResearch` z uwzględnieniem początku zdania (`review.ts`):**
       - Użyć `extractClaimEntities(claim, { includeSentenceStart: true })` (bez pomijania wyrazów na początku zdania, z odfiltrowaniem krótkiej listy częstych polskich spójników/przysłówków inicjalnych jak `Ponadto`, `Jednak`, `Według`, `Dlatego`, `Obecnie`, `Wówczas`, `Natomiast`):
         1. Jeśli zachodzi dokładne zawieranie `factText.includes(normalized)` (przy `normalized.length >= 10`) → `true`.
         2. W przeciwnym razie wyciągnąć wszystkie encje z `claim` (`numeric`, `proper` w tym na początku zdania, `quoted`, akronimy) i sprawdzić, czy **każda** z nich występuje w `fact.claim` lub w `sourceText`. Jeśli w `claim` jest jakakolwiek nowa liczba, rok, nazwa własna (np. `"Canada"` albo `"Kanada importuje..."` na początku zdania) lub akronim spoza `fact.claim` i `sourceText` → natychmiast `false` (atom musi iść do R3).
         3. Dopiero gdy wszystkie encje są pokryte, sprawdzić pokrycie rdzeni słów (`stem` >= 75% słów znaczących z `fact.claim`).
       - Dodać testy regresyjne: (a) `"US aquaculture imports 70–80% of seafood, mainly from Canada"` → `false`; (b) `"Kanada odpowiada za 70–80% importu w US aquaculture"` (nazwa własna na początku zdania) → `false`.
    3. **Pętla naprawcza `reviewOnce` i deterministyczne guardy po naprawie (`review.ts`):**
       - Wydzielić `reviewOnce(article, sourceText, deps, allowR1Retry)` i wołać w `reviewArticle` w pętli `for (let attempt = 0; attempt <= maxRepairAttempts; attempt++)`:
         - **Kwalifikacja do `repair` (`canRepair`):**
           - `true` wyłącznie, gdy `stage === "R2"` z powodu `inference_missed` albo `stage === "R3"`, gdzie wszystkie niepotwierdzone atomy mają `verdict === "refuted"` lub `verdict === "uncertain"` z `reason === "no_evidence" | "judge_uncertain"`,
           - **wykluczone z `repair` (`canRepair = false` → natychmiastowy `draft`):** `factcheck.status === "error"`, jakikolwiek atom z `reason === "search_error"` lub `reason === "max_atoms_cap"`, błąd LLM R2, `0` atomów R2, fail R1.
         - **Dwa deterministyczne guardy po `deps.repair(feedback)` (PRZED drugim uruchomieniem `reviewOnce`, bez marnowania tokenów R1/R2/R3):**
           1. **Guard długości:** dla artykułów, które przed naprawą miały `preVisibleLen >= 600` znaków, wymagać twardo `postVisibleLen >= (deps.minRepairedChars ?? 600)` znaków (więc `700` znaków przed naprawą wymaga `>= 600`, a nie `420`!). Dla krótkich fixture'ów testowych (`preVisibleLen < 600`) wymagać `postVisibleLen >= (deps.minRepairedChars ?? Math.floor(preVisibleLen * 0.6))`. Niespełnienie → natychmiastowy `draft("R3", [..., "Artykuł po naprawie zbyt krótki"])`.
           2. **Deterministyczny guard nowych encji/liczb:** użyć `extractClaimEntities(repairedHtmlText, { includeSentenceStart: true })` i porównać ze zbiorem dozwolonych encji z `(previousArticle.content_html + sourceText + researchBrief)`. Jeśli `repair` wprowadził nową liczbę, rok, akronim lub nazwę własną → natychmiastowy `draft` z powodem `"Repair wprowadził nowe fakty/encje spoza źródła: ..."` bez wołania R2/R3 (+ dedykowany test jednostkowy).
         - Publikacja (`status: "published"`) wyłącznie wtedy, gdy po przejściu obu guardów cały ponowny przebieg `reviewOnce` (`R1 [allowR1Retry=false] → R2 → R3`) jest czysty.
       - Sumować statystyki `verify` ze wszystkich przebiegów (`mergeVerifyStats`), zwracać w `ReviewOutcome`: `repairAttempts: number`, `repaired: boolean`, `repairedClaims: string[]`.
    4. **Metryki i dokumentacja (`orchestrator.ts`, `AGENTS.md`):**
       - Dodać do `RunReport`: `repair_attempts`, `repair_success`, `repair_failed` (zliczane również w `dry_run`, tak jak `verify_*`) oraz logować `repairedClaims` w evencie `article` / `dry_run`.
       - Zaktualizować `AGENTS.md` §2.7–2.8 o opis 1× bounded repair przed `draft`.

- [ ] OPS (użytkownik, VPS): lokalne A/B na AgFunderze (3–5 runów `run --dry-run --url`), a następnie wdrożenie F2-T9b + F2-T10a/b/c na VPS (`VERIFY_MAX_ATOMS=8`, `REPAIR_MAX_ATTEMPTS=1`, rebuild obrazu, pomiar `draft_rate`, `repair_*` i `verify_*`)
- [ ] F3-T2 R2 `media.kombain.pl` + defaulty kategorii (6 plików `defaults/*.webp`) + webhook deploy — [SAFE]

## KIEDYŚ
- [ ] OPT: licznik `research_failed` + `draft_rate` w `run_summary` (research ma dziś tylko alert, brak licznika) — [SAFE]
- [ ] OPT: M2M alias „tags” w Directusie (edycja tagów w widoku artykułu) — [SAFE]
- [ ] OPT: naprawa `scripts/verify.sh` (maskowanie exit code, martwy glob `prompts/*.md`, sekrety w `deploy/`, false-positive na literały testów) — [SAFE]
- [ ] OPT: bramka R3 — wymóg encji nieliczbowej i ≥2 rdzenie spoza top-100 PL (FP) — [SAFE]
- [ ] OPT: metryki R3 — `fetch_attempts/fetch_fail`, jedno źródło `VERIFY_MAX_ATOMS` (config → serwis; reszta w F2-T10b) — [SAFE]
- [ ] OPT: indeks `article_tags(tag_id)` (przyszłe „artykuły po tagu”) — [CRITICAL]
- [ ] OPT: czyszczenie wygasłych `article_failures` (>30 dni) — [SAFE]
