# Final report — F3-T1 (Astro Hybrid + Directus + strony)

## Status
Done (Mode: SAFE)

## Summary
`apps/web` to Astro 4 SSR z adapterem `@astrojs/cloudflare`. Strony `/`, `/kategoria/[slug]`, `/artykul/[slug]` i `404` pobierają wyłącznie opublikowane artykuły z Directus REST (read-only token), ustawiają cache brzegowy `public, s-maxage=3600, stale-while-revalidate=86400`, a link „Źródło:” jest doklejany w kodzie z `source_url` (nigdy z LLM).

## Changes
- `apps/web/astro.config.mjs` — `output: "server"`, `@astrojs/cloudflare`, `site`
- `apps/web/src/lib/directus.ts` — config z walidacją, auth Bearer, filtry `status=published`, sort `-published_at`, mapowanie kategorii, normalizacja `tldr`/`tech_summary`, `safeSourceUrl` (tylko http/https), `excerpt`, cache headers
- `apps/web/src/layouts/MainLayout.astro` + `components/{ArticleCard,TldrBox,TechSummaryBox}.astro` — layout, nawigacja 6 działów, karty, TL;DR, Tech summary, responsywny CSS
- `apps/web/src/pages/{index,404}.astro`, `pages/kategoria/[slug].astro`, `pages/artykul/[slug].astro` — SSR, 404 z `no-store`, cache na sukces
- `apps/web/src/env.d.ts`, `tsconfig.json`, `.env.example`, `public/favicon.svg`
- `apps/web/package.json` — `@astrojs/cloudflare@^11.2.0` (Astro 4 peer)
- `tsconfig.json` — typecheck obejmuje `apps/web/src/**/*.ts`
- `scripts/verify.sh` — krok 6: `astro build`
- `deploy/README.md` — §14 Cloudflare Pages (build/output/env/cache/smoke)
- Testy: `apps/web/src/lib/directus.test.ts` — 15 testów (auth, filtry, 403, slug, normalizacja, źródło, cache, excerpt)

## Verification (liczbowo)
- `scripts/verify.sh`: **PASS** (exit 0, w tym `astro build`)
- `tsc --noEmit`: **0 błędów**
- `vitest`: **300 passed / 0 failed / 33 skipped**
- PG (podman, postgres:16): **33 passed**
- `astro build`: **Complete** (server entrypoints, adapter Cloudflare)
- Zero sieci w testach: `fetch` mockowany

## Review Loop Audit
- Liczba rund Reviewera: **1/3 Approve** (weryfikacja E2E na zbudowanym `_worker.js` + mock Directus; mutacje filtra statusu/auth/cache/source URL czerwienieją testy)

## Risks (w tym nieblokujące z review)
- `set:html` ufa `text_content` z DB — worker sanityzuje, ale ręczna edycja/import w Directusie może wstrzyknąć HTML; brak CSP i nagłówków bezpieczeństwa (kandydat na F3-T2/OPT).
- Podwójny `Cache-Control: no-store` na 404 (Astro dokłada własny) — kosmetyka.
- Stale do 1h po unpublish; purge to F3-T2.
- Listy pobierają pełny `text_content`, by wyciąć 145 znaków — kandydat na osobne pole `summary`/TL;DR.
- Brak paginacji na `/` i kategoriach.
- Build ostrzega o niekompatybilnym image service Sharp (dziś nieużywany; F3-T2 wymusi noop/compile).
- Brak lockfile'a — zależności floating (stan zastany).
- Nie testowałem stron przeciw żywemu Directusowi; założenie: `category_id` jest zwracane jako UUID, a `categories` dostępne dla tokenu (F1-T2: `articles=200`, `sources=403`).
- Brak aliasu M2M `tags` — artykuły nie pokazują tagów (OPT w `plans.md`).
- `Astro.locals.runtime.env` wymaga env w Cloudflare Pages; build-time `import.meta.env` jest fallbackiem dla lokalnego SSR.
- Brak `og:image` per artykuł i sitemap (poza zakresem F3-T1).
- Cache czyści się TTL-em; webhook purge to F3-T2.
- `astro check` nie jest wpięty (wymaga `@astrojs/check`); `.astro` weryfikuje build, nie pełny typecheck frontmattera.

## Next steps
- F3-T2: `media.kombain.pl`, defaulty kategorii, webhook purge cache.
