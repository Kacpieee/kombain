# Eskalacja — F2-T10c (Runda 3/3)

Data: 2026-10-25
Status: ROZWIĄZANE — test dodany, Runda 4/3 **Approve**, commit po verify.

## Stan
- Implementacja F2-T10c kompletna: bounded repair loop, guardy, metryki, AGENTS §2.7–2.8.
- `verify.sh`: **PASS** (exit 0).
- `tsc`: **0 błędów**.
- `vitest`: **345 passed / 0 failed / 33 skipped**.
- PG (podman, postgres:16): **33 passed**.
- Brak sekretów, scope 19 plików.

## Bloker (test-only)
Reviewer potwierdził, że kod jest poprawny, ale mutacje:
- `visibleText` → `root.textContent` (bez separatora bloków),
- `visibleText` → `join("")`,
- `guardEntityKeys` bez wyjątku `isAcronym`

przeżywają testy (0/76 czerwonych). Sonda poza repo: nowy akronim po `<h2>` (`NOAA`) przechodzi do `published`, mimo że guard powinien zgłosić nową encję.

Brakuje jednego testu:
```ts
it("nowy akronim na początku akapitu po h2 → draft", async () => {
  // repair: "<h2>Wstęp</h2><p>NOAA prowadzi program dla sadowników.</p>..."
  expect(result.status).toBe("draft");
  expect(result.issues.join(" ")).toContain("nowe fakty");
});
```

## Decyzja
- **A (rekomendowana):** dodać test + Rundę 4/3 (wyjątek), potem commit.
- **B:** zaakceptować ryzyko i commitować bez testu.
- **C:** cofnąć F2-T10c.

Decyzja: A — test „nowy akronim po h2” + Runda 4/3. Reviewer: **Approve**.
