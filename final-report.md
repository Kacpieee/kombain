# Final report — F3-T3b (Frontend kombain.pl: responsywność, dostępność, fallback okładek i SEO)

## Status
Done (Mode: SAFE)

## Summary
Doprowadzono warstwę prezentacji `apps/web` (Astro 4.16.19 + `@astrojs/cloudflare`, `output: "server"`) do pełnej responsywności mobile-first (320–2560 px), dostępności WCAG AA (kontrast ≥4.5:1, `:focus-visible`, tap targety ≥44 px, semantyka HTML) oraz kompletnego SEO (OG + Twitter Cards + `noindex` dla 404). Wydzielono jeden jasny motyw z custom properties `--color-*`, `<meta name="color-scheme" content="light">`, scentralizowanymi breakpointami i płynną typografią `clamp()`. Dodano fallback okładek artykułów na `https://media.kombain.pl/defaults/{slug}.webp`, nawigację mobilną z `aria-expanded` i obsługą `Escape`, widoczny blok TL;DR nad treścią oraz `TechSummary` jako tabelę na desktopie/tablecie i karty bez poziomego scrolla na mobile. Nagłówki cache i serwerowe użycie tokenu Directusa pozostały nietknięte.

## Changes
- `apps/web/.env.example` — same nazwy zmiennych i komentarze, bez wartości
- `apps/web/src/lib/directus.ts` — helpery `categoryDefaultImage`, `resolveArticleImage`, `articleMetaDescription`, `pluralizeMaterials` (bez zmian cache/auth/zapytań)
- `apps/web/src/lib/directus.test.ts` — +4 testy jednostkowe (łącznie 19 w `directus.test.ts`): fallback okładek, opis SEO, odmiana PL, `SSR_CACHE_CONTROL` + `NO_STORE_CACHE_CONTROL`
- `apps/web/src/styles/tokens.css` — tokeny `--color-*`, `color-scheme: light`, płynna typografia `clamp()`, miara `68ch`, dokumentacja progów responsywności
- `apps/web/src/styles/global.css` — mobile-first layout i komponenty, scentralizowane `@media` (`37.5rem`, `48rem`, `64rem`, `80rem`), `min-inline-size: 0`, `:focus-visible`, `prefers-reduced-motion`, `forced-colors`
- `apps/web/src/components/SiteHeader.astro` — responsywna nawigacja (`button` z `aria-expanded`/`aria-controls` + `Escape` na mobile, poziomy pasek na desktopie, `aria-current="page"`, tap targety ≥44 px)
- `apps/web/src/layouts/MainLayout.astro` — import `tokens.css` + `global.css`, `<meta name="color-scheme" content="light">`, pełne OG/Twitter Cards/`article:published_time`/`noindex`, skip link i `<SiteHeader />`
- `apps/web/src/components/ArticleCard.astro` — fallback okładki na default kategorii, `alt={article.title}`, `1200×675` + `aspect-ratio: 16/9`, `loading="eager"` + `fetchpriority="high"` dla pierwszej karty (`priority`) i `lazy` dla pozostałych
- `apps/web/src/components/TldrBox.astro` — wyraźny blok TL;DR widoczny wysoko także na mobile
- `apps/web/src/components/TechSummaryBox.astro` — semantyczna `<table>` (`caption`, `<th scope="row">`) jako karty (`display: block`) na mobile i tabela 2-kolumnowa na `≥ 600 px`
- `apps/web/src/pages/index.astro`, `apps/web/src/pages/kategoria/[slug].astro`, `apps/web/src/pages/artykul/[slug].astro`, `apps/web/src/pages/404.astro` — semantyka (`<article>`, `<aside>`, 1× `<h1>`, zero przeskoków nagłówków), SEO, fallback hero z `fetchpriority="high"`, link `Źródło:` przez `safeSourceUrl()` (`target="_blank" rel="noopener noreferrer"`)
- `docs/STATUS.md`, `final-report.md`

## Verification (liczbowo)
- `bash scripts/verify.sh`: **RESULT: PASS (exit 0)**
- `npx tsc --noEmit`: **0 błędów**
- `npx vitest run`: **360 passed / 0 failed / 33 skipped** (w tym `apps/web/src/lib/directus.test.ts`: **19 passed**)
- `npm run build --workspace @kombain/web`: **PASS**
- Audyt bundla klienta (`apps/web/dist/_astro/`): **0 wystąpień `DIRECTUS_PUBLIC_READ_TOKEN`/`DIRECTUS_URL`/`Authorization`**
- Audyt headless Chrome (lokalny mock Directusa + `astro dev`):
  - **6/6 tras HTTP:** 200 z `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`, 404 z `Cache-Control: no-store`, 0 wycieków tokenu w HTML
  - **28/28 kombinacji (4 trasy × 7 szerokości: 320, 360, 390, 768, 1024, 1440, 2560 px):** 0 poziomego overflow, 1× `<h1>`, zero przeskoków nagłówków, `body >= 16 px`, tap targety ≥44 px, działające menu mobilne + `Escape`, `TL;DR` nad treścią, `TechSummary` (`block` <600 px / `table-cell` ≥600 px), fallback okładek `media.kombain.pl/defaults/*.webp` i `fetchpriority="high"`, kompletne meta SEO i `noindex` na 404.
  - Inspekcja wizualna 5 zrzutów ekranu (`360`, `768`, `1440 px`).

## Review Loop Audit
- Runda 1/3: **Approve**.

## Risks / Odroczone
- **Weryfikacja na żywych danych z `https://cms.kombain.pl` jest odroczona** — w workspace brak lokalnego pliku `apps/web/.env` z `DIRECTUS_PUBLIC_READ_TOKEN` (zgodnie z ustaleniem token tworzy użytkownik lokalnie). Po utworzeniu `apps/web/.env` należy wykonać smoke test na realnych artykułach z CMS.
- Nie zmieniano `apps/worker`, `packages/db`, promptów, DDL ani `deploy/worker.*`.
