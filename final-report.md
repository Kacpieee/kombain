# Final report — F3-T2 (R2 media, defaulty kategorii, webhook)

## Status
Done (Mode: SAFE)

## Pre-mortem
- **UX:** 6 defaultów musi odpowiadać kategoriom i URL-om w `media.ts`; inaczej publikacje bez `og:image` dostaną 404.
- **R2:** skrypt waliduje webp 1200×675 przed uploadem, używa wspólnego `uploadToR2` (cache immutable), nie dotyka artykułów.
- **Webhook:** Directus → Cloudflare Pages deploy hook jest konfiguracją po stronie paneli; w repo tylko runbook i zmienna, bez sekretu.
- **Cache:** deploy hook nie purguje SSR cache; opisane ograniczenie i docelowy purge.

## Summary
Dodano 6 gotowych grafik defaultowych per kategoria, skrypt walidujący i wgrywający je na R2 oraz runbook dla `media.kombain.pl`, uploadu defaultów i webhooka Directus → Pages. `uploadToR2` jest współdzielony z uploadem artykułów.

## Changes
- `apps/worker/assets/defaults/*.webp` — 6 grafik 1200×675 (webp, branded)
- `apps/worker/src/services/media.ts` — `uploadToR2` wyeksportowany; media artykułów używa go dalej
- `apps/worker/src/scripts/upload-defaults.ts` — mapowanie kategoria→slug, walidacja sharp, upload `defaults/{slug}.webp`, CLI
- `apps/worker/src/scripts/upload-defaults.test.ts` — 4 testy: mapowanie URL, pliki webp 1200×675, pre-walidacja przed uploadem, 6 kluczy uploadu
- `apps/worker/package.json` — `media:defaults`
- `deploy/README.md` §15 — R2 custom domain, upload defaultów, Directus Flow → Pages deploy hook, cache
- `docs/plans.md` (F3-T2 usunięte), `docs/STATUS.md`

## Verification (liczbowo)
- `scripts/verify.sh`: **PASS**
- `tsc --noEmit`: **0 błędów**
- `vitest`: **356 passed / 0 failed / 33 skipped**
- PG (podman, postgres:16): **33 passed**
- Zero sieci w testach (upload wstrzykiwany)

## Review Loop Audit
- Liczba rund Reviewera: F3-T2 1/3 Request changes (docker upload/runbook) → **2/3 Approve**; hotfix guardu 1/3 Request changes → 2/3 Request changes → 3/3 Request changes (cytat z nazwą) → poprawki; 4/3 (wyjątek) **Approve**.

## Risks
- Assety i skrypt są gotowe, ale **nie wykonano uploadu na R2** — brak kluczy w dev-harness; wymaga `bun apps/worker/src/scripts/upload-defaults.ts` na VPS z `deploy/worker.env`.
- `media.kombain.pl` (custom domain R2) i Directus Flow nie są skonfigurowane zdalnie; runbook opisuje kroki. Flow Directusa nie odpala się na bezpośrednie zapisy workera do PG — dotyczy ręcznych edycji.
- Deploy hook odświeża Pages, ale nie purguje SSR cache (`s-maxage=3600` + SWR); docelowo purge w tym samym Flow.
- Defaulty są proste brandingowo; podmiana pod tą samą nazwą wymaga purge (cache `immutable`) albo nowej nazwy/version.

## Next steps
- OPS: lokalne A/B + wdrożenie F2-T9b/T10 na VPS, upload defaultów, konfiguracja R2 domain i webhooka.

## Post-release A/B (2026-11-22) + guard hotfix

Po wdrożeniu F3-T2 wykonano 14 lokalnych dry-runów AgFunder (`run --dry-run --url`, `REPAIR_MAX_ATTEMPTS=1`); pierwsze 3 odrzucono, bo lokalny Postgres był zatrzymany (11 ważnych).

- `wouldBe=published`: **5/11**
- `wouldBe=draft`: **6/11**
- `repair_attempts`: **8**, `repair_success`: **2**, `repair_failed`: **6**
- `verify_fetches`: 2 w jednym runie; reszta 0; brak `search_error`.

Drafty: guard nowych encji złapał m.in. „agtech”, „zmagaj”, „jednocześnie”, „trudny środek”; po złagodzeniu guardu zostały realne `uncertain` (Hatch Blue/SBA, Wielkie Jeziora) i jeden `refuted` (70–80% importu). Guard: pojedyncze nazwy własne nie blokują repair (R3 je weryfikuje); nadal blokują liczby (także w cytatach), akronimy i nazwy wielowyrazowe. `INITIAL_STOPWORDS`/`COMMON_TITLE_WORDS` rozszerzone. Próbka jest mała — nie dostrajać dalej bez kolejnych 10+ runów.

## OPS release helper (po F3-T2)

`deploy/scripts/release-worker.sh` automatyzuje transfer repo → VPS (bez `.env*` i `worker.env*`), remote `docker compose build`, `check-env` i `upload-defaults`. Dodaje brakujące `VERIFY_MAX_ATOMS=8`/`REPAIR_MAX_ATTEMPTS=1` tylko po pełnej linii (nie skleja zmiennych przy braku końcowego newline), waliduje `VPS_USER/HOST/DIR`, nie uruchamia pipeline’u ani crona. README §11.1a.
