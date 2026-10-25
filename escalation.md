# Eskalacja — F2-T9b (R3 recall tuning), Runda 3/3

Data: 2026-10-25
Status: STOP zgodnie z AGENTS.md §6 (`Request changes` w rundzie 3/3).

## Stan
- Kod produkcyjny F2-T9b gotowy: query builder, bramka trafności, warunkowy Fetch (search + SERP), statystyki `verify_*`, `VERIFY_MAX_ATOMS`.
- `scripts/verify.sh`: **PASS** (exit 0).
- `tsc --noEmit`: **0 błędów**.
- `vitest`: **282 passed / 0 failed / 33 skipped**.
- PG (podman, postgres:16): **33 passed**.
- Brak sekretów w diffie; scope 16 plików; brak commitów dla F2-T9b.

## Bloker (B4, wyłącznie testowy)
Reviewer w rundzie 3/3 potwierdził, że cofnięcie wiringu `const query = buildClaimQuery(atom.text)` → `atom.text.slice(0, 128)` **nie czerwieni żadnego testu** (282/282 zielone), bo claim testowy ma 88 znaków i po slicie nadal zawiera NOAA/USDA/EDA/2021.

Dodatkowo:
- asercje w `factcheck.test.ts` (linie ~126, 141, 228, 252) są tylko w `if (result.status === "ok")` bez twardego `expect(result.status).toBe("ok")` — wynik `error` przechodzi „na pusto”;
- brak testu regresji dla filtra liczb z cytatu (B2) i dla wiringu `VERIFY_MAX_ATOMS` (B5).

## Proponowana poprawka (minimalna, test-only)
1. Dodać claim >128 znaków z encją po 128. znaku.
2. `expect(search).toHaveBeenCalledWith(buildClaimQuery(claim))` + `expect(query).not.toBe(claim.slice(0, 128))`.
3. Twarde `expect(result.status).toBe("ok")` przed każdym `if` w testach deepseek.
4. Test `buildClaimQuery` dla cytatu z liczbami (`40%`, `2021` występują raz).

Weryfikacja po poprawce: `npx tsc --noEmit`, `npx vitest run`, `scripts/db-test.sh`, `scripts/verify.sh`.

## Ryzyka nieblokujące (do decyzji, nie blokują publikacji)
- `config.VERIFY_MAX_ATOMS` nie jest przekazywany do serwisu (dwa źródła prawdy: config vs `process.env`).
- `isAcronym` + skip sentence-start: akronim na początku zdania traci recall; all-caps rzeczownik w środku zdania może dać false-positive (sędzia weryfikuje).
- `raw[0]` z pustym summary kończy atom jako `uncertain`, mimo że `raw[1]` może mieć treść.
- `verify` nie trafia do `run_summary` przy błędzie R3 (liczniki 0 przy awarii).
- `fetch` liczy tylko sukcesy.

## Decyzja wymagana
Zgodnie z AGENTS §6 potrzebna jest zgoda człowieka na jedną z opcji:
- **A (rekomendowana):** pozwolić na poprawkę testów B4 + Rundę 4/3 (wyjątek od limitu), potem commit.
- **B:** zaakceptować ryzyko testowe i commitować obecny stan (bez poprawki B4).
- **C:** cofnąć F2-T9b i wrócić do planu.

Bez decyzji nie wykonuję commita ani dalszych zmian.
