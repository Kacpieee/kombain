# Ideas — R3 repair loop: feedback Reviewera do Redaktora

Status: pomysł do analizy, niezatwierdzony. Nie implementować bez decyzji.
Data: 2026-10-25

## Problem

Obecny pipeline przy problemach R3 od razu przechodzi do `draft`:

- `refuted` → `draft` (bez `needs_human_check`),
- `uncertain` → `draft + needs_human_check`.

Artykuł nie jest kasowany, ale wymaga ręcznej pracy. Przy artykułach, w których
Redaktor dodał 1–3 twierdzenia spoza źródła, cały materiał trafia do człowieka,
mimo że wystarczyłoby usunąć lub złagodzić te konkretne zdania.

Dodatkowo R1 retry jest dziś ślepy: `pipeline.ts` przekazuje `issues` do
`regenerate`, ale callback ich nie używa i woła ten sam prompt drugi raz.

## Dowody z lokalnego debugowania (AgFunder, 2026-10-25)

Artykuł: `https://agfundernews.com/us-aquaculture-needs-more-than-vc-dollars-to-grow-report`

- Źródło **nie zawiera** statystyki 70–80%, „Wielkich Jezior”, centrów hodowli
  zarodowej, wylęgarni, chłodni ani zakładów przetwórczych.
- Redaktor mimo to dodał takie twierdzenia do treści.
- R3 oznaczył je jako `external` i zwrócił `uncertain`/`refuted`.
- Lokalnie: 2 atomy, `searches=2`, `serp=1`, `fetches=0`, `confirmed=0`,
  `uncertain=2` → draft.
- Na VPS ten sam URL: `1 confirmed / 1 refuted / 3 uncertain` → draft.
- Różne atomy między runami = normalny niedeterminizm LLM.

Wniosek: to nie jest przede wszystkim problem recallu R3. R3 działa poprawnie.
Problemem jest grounding Redaktora i brak pętli naprawczej.

## Obecny przepływ

1. R1 lokalny + LLM; fail → jeden retry (`retried`).
2. R2: atomy `supported/external/inference`; `inference` bez dowodu jest
   wycinany; brak możliwości wycięcia → draft.
3. R3: `external` → search/fetch/judge.
4. `refuted` → draft; `uncertain` → draft + `needs_human_check`.
5. `rejection_reason` przy `refuted` zawiera tylko `refuted` (wczesny return),
   więc `uncertain` giną z pola widocznego dla człowieka.

## Cel

Zmniejszyć `draft_rate` bez publikowania niezweryfikowanych faktów:

- dać Redaktorowi konkretny feedback z R2/R3,
- pozwolić mu naprawić artykuł (usunąć/oprzeć na źródle zakwestionowane zdania),
- ponownie przepuścić cały review,
- publikować tylko wtedy, gdy po naprawie R1/R2/R3 są czyste.

## Warianty

### A. Konserwatywny — repair tylko `refuted`

- `refuted` → 1 repair → ponowny review → publish jeśli clean.
- `uncertain` nadal draft + human.
- Zaleta: małe ryzyko, usuwa tylko jawnie fałszywe twierdzenia.
- Wada: większość draftów to `uncertain`, więc efekt mały.

### B. Zalecany — repair `refuted` + `uncertain`, max 1 próba

- Feedback zawiera claim, werdykt i evidence URL (dla `refuted`).
- Instrukcja: usuń lub oprzyj wyłącznie na źródle; nie dodawaj nowych faktów.
- Po repair: R1 → R2 → R3; clean → publish, inaczej draft.
- `search_error` / błąd LLM → od razu draft, bez repair.
- Zaleta: realnie zmniejsza draft_rate.
- Wada: Redaktor może usunąć za dużo; trzeba mierzyć długość i jakość.

### C. Agresywny — deterministyczne wycięcie zakwestionowanych zdań

- Kod usuwa zdania z `cleanedHtml` (jak `stripInferences`), potem R1.
- Zaleta: brak nowych halucynacji, tanie.
- Wada: może wyciąć kontekst i zostawić „dziurawy” artykuł; ryzyko utraty sensu.

### D. Status quo + lepszy feedback ręczny

- Bez auto-repair.
- Pełny `rejection_reason` (`refuted` + `uncertain` + evidence URL).
- Zaleta: zero ryzyka publikacyjnego.
- Wada: draft_rate bez zmian.

## Rekomendacja

**B z limitem 1 repair** + poprawka R1 feedbacku + pełne logowanie.
Ewentualnie C jako fallback, gdy repair nie usunie problemu, ale dopiero po
osobnej decyzji.

## Proponowany przepływ

```text
reviewOnce(article):
  R1 local + LLM
  R2 atoms (strip inference)
  R3 external verify
  return published | draft(feedback)

reviewArticle:
  result = reviewOnce(article)
  if published: return
  if error/search_error: return draft
  if repairAttempts >= MAX: return draft
  article = repair(article, result.feedback)
  result = reviewOnce(article)   // bez kolejnej rekurencji
  if published: return
  return draft
```

Twarde zasady:

- MAX_REPAIR_ATTEMPTS = 1 (konfigurowalne, domyślnie 1).
- Brak rekurencji; pętla `for attempt in 0..MAX`.
- Po nieudanym repair nie ma drugiego repair.
- `search_error`, błąd LLM, błąd R2 → draft bez repair.
- Repair nie może dodać nowych faktów; jeśli doda, R2/R3 je złapią.
- Feedback nie może zawierać treści dowodu jako „do skopiowania”; tylko URL
  i polecenie usunięcia/oparcia na źródle.

## Format feedbacku

```json
{
  "issues": [
    {
      "claim": "dokładny claim",
      "verdict": "refuted",
      "evidence_url": "https://..."
    },
    {
      "claim": "dokładny claim",
      "verdict": "uncertain",
      "evidence_url": ""
    }
  ],
  "instruction": "Usuń lub oprzyj wyłącznie na tekście źródłowym. Nie dodawaj nowych faktów, liczb, nazw miejsc ani instytucji. Zachowaj strukturę i zwróć pełny JSON."
}
```

## Zmiany w kodzie (propozycja)

- `prompts.ts`:
  - `EditorPromptInput.feedback?`,
  - `buildEditorPrompt` dokleja sekcję `UWAGI REVIEWERA`,
  - ewentualnie osobny `buildRepairPrompt` z tym samym kontekstem.
- `review.ts`:
  - `ReviewDeps.repair(article, feedback)`,
  - `RepairFeedback` / `RepairIssue`,
  - wydzielenie `reviewOnce`,
  - limit prób i metryki.
- `pipeline.ts`:
  - `repair` woła `synthesize` z feedbackiem i poprzednim artykułem,
  - poprawka: R1 `regenerate` ma przekazywać `issues`.
- `orchestrator.ts`:
  - `repair_attempts`, `repair_success`, `repair_failed`,
  - `verify_*` liczone łącznie z próbami repair.
- `factcheck.ts`:
  - rozróżnić `uncertain` od `search_error` (np. `reason` w werdykcie),
  - `search_error` nie kwalifikuje się do repair.
- `config.ts`:
  - `REPAIR_ENABLED` (domyślnie true?),
  - `REPAIR_MAX_ATTEMPTS` (1–2).
- `AGENTS.md` §2.7/2.8:
  - jawny zapis „R3 repair 1× przed draftem”,
  - `uncertain` po nieudanym repair nadal `draft + needs_human_check`.

## Metryki

- `repair_attempts`
- `repair_success`
- `repair_failed`
- `repair_removed_claims` (liczba)
- `verify_*` łącznie ze wszystkich prób
- `draft_after_repair`
- czas runu

## Pre-mortem

- **UX:** artykuł może zrobić się krótszy lub „dziurawy”. R1 sprawdza
  strukturę, ale nie sens. Mierzyć długość i czytać próbki.
- **Publikacja:** auto-publish po repair oznacza, że człowiek nie widzi
  usuniętego faktu. Logować usunięte claimy.
- **LLM:** Redaktor może „naprawić” przez dodanie nowych faktów. R2/R3
  ponownie weryfikują, ale koszt rośnie.
- **Recall R3:** `uncertain` może oznaczać, że R3 nie znalazło dowodu, mimo że
  fakt jest prawdziwy. Repair usunie wtedy dobry fakt. To kompromis do zmierzenia.
- **Koszty:** +1 editor + R1/R2/R3 na artykuł, który i tak by nie przeszedł.
  Limit 1 próby i flaga wyłączająca.
- **Pętla:** bez twardego limitu i bez rekurencji.
- **DB:** bez zmian DDL. `published` po clean repair; `draft` po nieudanym.
- **Sekrety:** feedback zawiera URL-e, nie klucze.

## Plan testów

- R1: `regenerate` dostaje issues i prompt zawiera feedback.
- R3 `refuted` → repair → clean → published; repair wołane raz.
- R3 `uncertain` → repair → clean → published (wariant B).
- Repair nadal `refuted`/`uncertain` → draft, brak drugiej próby.
- Repair rzuca błąd → draft.
- `search_error` → draft bez repair.
- R2 missed inference → repair lub draft (zgodnie z decyzją).
- Metryki `repair_*` i `verify_*`.
- Brak sieci w testach; `generate`/`verify` wstrzykiwane.
- Lokalne A/B: 3 runy AgFunder przed i 3 po; porównać `published/draft`,
  `verify_*`, długość artykułu.

## Otwarte pytania

1. Wariant A, B czy C?
2. Max 1 czy 2 próby?
3. Czy `uncertain` po repair może publikować, czy zawsze draft?
4. Czy repair ma być domyślnie włączony, czy za flagą?
5. Czy przy nieudanym repair stosować deterministyczne wycięcie (C) jako fallback?
6. Czy `rejection_reason` ma zawierać wszystkie `refuted` + `uncertain` + URL?
7. Czy potrzebna jest osobna kolumna/JSON na historię repair, czy wystarczą logi?

## Non-goals

- Nie zmieniamy definicji `rejected` (tylko permanentne).
- Nie publikujemy `refuted`/`uncertain` bez ponownej weryfikacji.
- Nie dodajemy nowych źródeł ani nie zmieniamy DDL w tym tasku.

## Kryteria akceptacji

- R1 feedback realnie trafia do promptu.
- Repair jest bounded i nie może wejść w pętlę.
- `search_error` nie jest „naprawiany”.
- Po repair publikacja tylko przy czystym R1/R2/R3.
- Wszystkie testy i `verify.sh` zielone.
- Lokalne A/B pokazuje wpływ na draft_rate i długość artykułów.

---

# Prompt startowy dla modelu analizującego

Skopiuj poniższy prompt do nowej sesji modelu, który ma przeanalizować temat.

```text
Jesteś architektem systemu i reviewerem technicznym projektu kombain.pl.
Pracujesz w trybie read-only: NIE modyfikuj plików, NIE commituj, NIE uruchamiaj
płatnych API. Możesz czytać kod, uruchamiać testy i analizować.

Repo: /home/Kacper/Projects/Kombain - automatyzacja

Najpierw zapoznaj się z projektem, w tej kolejności:
1. AGENTS.md
2. Dokumentacja Techniczna Projektu kombain.pl.md (szczególnie §2, §4, §6)
3. docs/STATUS.md
4. docs/plans.md
5. docs/ideas.md  ← analizowany pomysł
6. apps/worker/src/services/review.ts
7. apps/worker/src/prompts.ts
8. apps/worker/src/pipeline.ts
9. apps/worker/src/orchestrator.ts
10. apps/worker/src/services/factcheck.ts
11. apps/worker/src/services/review.test.ts
12. apps/worker/src/services/factcheck.test.ts
13. apps/worker/src/pipeline.test.ts
14. apps/worker/src/orchestrator.test.ts

Kontekst:
- Worker generuje artykuły AgTech: Bramkarz → research → Redaktor → R1 → R2 → R3
  → media → persist.
- R1 ma jeden retry, ale obecnie pipeline.ts przekazuje issues do regenerate,
  a callback ich nie używa (ślepy retry).
- R2 wycina inference bez dowodu; R3 weryfikuje external.
- R3 refuted → draft; uncertain → draft + needs_human_check.
- Lokalny debug pokazał, że Redaktor dodaje fakty spoza źródła (np. Wielkie
  Jeziora, wylęgarnie, 70–80% importu), a R3 je wyłapuje. To problem groundingu
  Redaktora, nie przede wszystkim recallu R3.
- Pomysł: bounded repair loop — Reviewer przekazuje feedback do Redaktora,
  Redaktor poprawia, cały review leci ponownie, publish tylko jeśli clean.

Zadanie:
Przeanalizuj pomysł z docs/ideas.md i zaproponuj najlepsze rozwiązanie.

W raporcie zwróć:
A. Diagnozę obecnego przepływu z odwołaniem do konkretnych funkcji/plików.
B. 2–3 warianty realizacji (w tym koszt, ryzyko, wpływ na draft_rate).
C. Rekomendację: wariant, limit prób, zachowanie dla refuted/uncertain/search_error.
D. Pre-mortem: UX, publikacja, LLM, koszty, pętle, DB, bezpieczeństwo.
E. Plan implementacji TDD: pliki, funkcje, testy, kolejność.
F. Zmiany w AGENTS.md/STATUS/plans, jeśli polityka się zmienia.
G. Otwarte pytania decyzyjne, których nie da się rozstrzygnąć bez właściciela produktu.

Ważne:
- Nie zakładaj, że R3 jest winne. Uwzględnij, że R3 może mieć recall problem,
  ale obecne dowody wskazują na halucynacje Redaktora.
- Nie proponuj publikowania refuted/uncertain bez ponownej weryfikacji.
- Nie zmieniaj definicji rejected (tylko permanentne).
- Nie dodawaj DDL bez uzasadnienia.
- Odpowiedz po polsku, konkretnie, z liczbami i nazwami funkcji.
```
