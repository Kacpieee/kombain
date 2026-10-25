# Final report — F2-T9b (R3 recall tuning)

## Status
Done (Mode: CRITICAL)

## Summary
R3 lepiej trafia w dowody bez zmiany polityki (`uncertain → draft`): zapytania budowane z encji/liczb/lat/nazw własnych (cięte na granicy słowa), bramka trafności dowodów (encja/rok/≥2 wspólne słowa) z SERP fallbackiem, warunkowy Fetch przy liczbach/datach, a statystyki weryfikacji trafiają do `run_summary`.

## Changes
- `apps/worker/src/services/factcheck.ts` — `buildClaimQuery` (encje, cytaty, liczby, stopwords, ≤128 na granicy słowa), `isRelevantEvidence` (encje albo ≥2 wspólne słowa), gate + SERP fallback, `needsFetch` (puste summary lub brak liczby z claimu), `VerifyStats` w wyniku
- `apps/worker/src/services/review.ts` — `ReviewOutcome.verify` (statystyki R3)
- `apps/worker/src/pipeline.ts` — `verify` w wyniku published/draft
- `apps/worker/src/orchestrator.ts` — `verify_confirmed/refuted/uncertain/serp_used/fetches` w `run_summary`
- `config.ts`/`.env.example`/`deploy/README.md` — `VERIFY_MAX_ATOMS` (1–20, default 8)
- Testy: factcheck +5 (query builder, relevance, SERP gate, stats, cap), pipeline +1, orchestrator +1
- `docs/plans.md` (T9b usunięty, TERAZ → F3-T1), `docs/STATUS.md`

## Poprawki po Rundzie 1 (blokery B1–B5)
- **B1** bramka trafności: pojedyncza pospolita nazwa własna nie wystarcza — wymagana liczba/rok/cytat z claimu, ≥2 nazwy własne albo ≥2 wspólne słowa >4 znaków; pierwszy wyraz zdania nie jest „nazwą własną”.
- **B2** query builder: cytat + encje numeryczne + nazwy własne przed słowami; encje będące częścią cytatu nie są duplikowane; wszystkie NOAA/USDA/EDA/NIFA/2021 mieszczą się w 128 znakach.
- **B3** Fetch: po nieudanym Fetchu przy pustym summary wynik to `uncertain` (bez sędziego i bez SERP), nie `confirmed`.
- **B4** testy twarde: fałszywy confirmed (pospolita nazwa), komplet encji w query, fetch-fail → uncertain + `fetches=0`, stats `fetches/refuted/uncertain/cap`, `VERIFY_MAX_ATOMS=""`, review `verify`, orchestrator draft `verify_*`.
- **B5** `VERIFY_MAX_ATOMS` parsowany bezpiecznie (`parseMaxAtoms`): `""`/NaN/<1 → 8, cap 20.

## Poprawki po Rundzie 2
- **B3 (SERP)**: puste summary z SERP też przechodzi przez warunkowy Fetch; dowód bez treści jest odfiltrowany przed sędzią, a `reconcile` odrzuca `source` z pustym summary → `uncertain` (nie `confirmed`).
- **B2 (liczby)**: encje numeryczne zawarte w cytacie nie są duplikowane w query (jak nazwy własne).
- **B1 (zdania/recall)**: pierwszy wyraz po `[.!?]`/newline nie jest nazwą własną; pojedynczy akronim (NOAA/USDA/EDA/NIFA) wystarcza za trafność; dopasowanie słów po rdzeniu (6 znaków) łapie odmianę PL.
- **B4**: twarde `expect(search).toHaveBeenCalledWith` z encjami; testy SERP+Fetch (sukces i fail), akronim, odmiana PL, granica zdania.
- **B5**: `VERIFY_MAX_ATOMS` w `config.ts` ma `.catch(8)` — `""`/`abc`/`0`/`999` nie wywalają startu workera.

## Poprawki po Rundzie 3 (B4 test-only)
- Test wiringu: claim >128 znaków z `NOAA`/`2021` po 128. znaku → `expect(search).toHaveBeenCalledWith(buildClaimQuery(longClaim))`; mutacja `buildClaimQuery` → `slice(0,128)` czerwieni test (zweryfikowane).
- Twarde `expect(result.status).toBe("ok")` przed `if` w testach deepseek.
- Regresja B2: liczby z cytatu (`40%`, `2021`) występują w query dokładnie raz.
- `VERIFY_MAX_ATOMS="1"` → tylko 1 search, 2 atomu `uncertain`.

## Verification (liczbowo)
- scripts/verify.sh: **pass** (exit 0)
- guardrails (sekrety/SQL): **pass**
- tsc --noEmit: **pass**
- vitest: **285 passed, 0 failed, 33 skipped**
- PG-docker: **33 passed** (bez zmian)
- Zero sieci: search/serp/fetch/generate wstrzykiwane

## Review Loop Audit
- Liczba rund Reviewera: 1/3 Request changes (B1–B5) → poprawki; 2/3 Request changes (B1/B2/B3) → poprawki; 3/3 Request changes (B4 test-only) → poprawki; 4/3 (wyjątek zatwierdzony przez człowieka) → **Approve**

## Risks
- Bramka trafności opiera się na tokenach; parafrazy (bez wspólnych słów/encji) nadal mogą iść do `uncertain`.
- `buildClaimQuery` może gubić ważne słowa przy bardzo długich claimach (limit 128) — priorytet mają encje/liczby.
- Więcej zapytań przy nietrafnych dowodach (+SERP) → wyższy koszt, nadal grosze.
- `fetch` liczy tylko udane pobrania; awarie Fetcha nie mają osobnego licznika.
- `VERIFY_MAX_ATOMS` walidowany w configu, ale serwis nadal czyta `process.env` (znany dług).
- Statystyki verify dotyczą tylko ścieżki DeepSeek; rollback `gemini` raportuje same verdicty (stats liczone z wyników).
- `VERIFY_MAX_ATOMS` czytany z `process.env` w serwisie (config waliduje, ale nie przekazuje) — znany dług „dwa źródła prawdy”.

## Review — Runda 4/3 (Approve)
- Mutacja B4 (`buildClaimQuery` → `slice(0,128)`) czerwieni test wiringu — potwierdzone.
- Mutacje B1a/B1b/B1c/B2/B3a/B3b czerwienieją; 285 unit / 33 PG; verify exit 0.
- Ryzyka nieblokujące przeniesione do `plans.md` (OPT).

## Next steps
- F3-T1: Astro Hybrid + `directus.ts` + strony + cache; po wdrożeniu zmierzyć `draft_rate`.
