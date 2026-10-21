#!/usr/bin/env bash
# verify.sh — zamknięta pętla kombain.pl (TS/PG/Astro, bez flutter)
# exit 0 = pass, exit !=0 = fail + przyczyna na stdout
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAIL=0

say() { echo "== $*"; }
fail() { echo "FAIL: $*"; FAIL=1; }

say "0. git add -N (nowe pliki widoczne w diffie)"
git add -N . >/dev/null 2>&1 || true

say "1. sekrety w diffie kodu (blokujące, bez docs/*.md)"
if git diff HEAD -- 'packages/**' 'apps/**' ':!*.md' | grep -Ei 'GEMINI_API_KEY=.+|SCRAPINGANT_API_KEY=.+|BEGIN PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.' >/dev/null; then
  fail "sekret w diffie (klucz/JWT)"
else echo "ok: brak sekretów w diffie"; fi
if git diff --cached --name-only | grep -E '(^|/)\.env($|\.)|.*\.pem$|.*\.key$|.*\.sqlite$' >/dev/null; then
  fail "niedozwolony plik w stage (.env/pem/key/sqlite)"
else echo "ok: stage czysty"; fi

say "2. tsc --noEmit (jeśli jest packages/ lub apps/)"
if [ -f package.json ] && [ -d node_modules ]; then
  if npx tsc --noEmit 2>&1 | head -n 50; then echo "ok: tsc"; else fail "tsc"; fi
else echo "skip: brak node_modules (tsc po npm install)"; fi

say "3. vitest (jeśli istnieje)"
if [ -f package.json ] && [ -d node_modules ] && npx vitest --version >/dev/null 2>&1; then
  if npx vitest run 2>&1 | tail -n 30; then echo "ok: vitest"; else fail "vitest"; fi
else echo "skip: vitest niedostępny"; fi

say "4. lint promptów (placeholders, PocketBase, DANE ŹRÓDŁOWE)"
if ls apps/worker/src/prompts/*.md apps/worker/src/prompts.ts 2>/dev/null >/dev/null; then
  if grep -rn 'WPISZ' apps/worker/src/prompts* 2>/dev/null; then fail "placeholder [WPISZ] w promptach"; else echo "ok: brak placeholderów"; fi
  if grep -rni 'pocketbase' apps/worker/src 2>/dev/null; then fail "PocketBase zamiast PG"; else echo "ok: brak PocketBase"; fi
else echo "skip: brak promptów (przed F2-T4)"; fi

say "5. SQL: zakaz interpolacji {{ }} w queries.ts"
if [ -f packages/db/queries.ts ]; then
  if grep -n '{{' packages/db/queries.ts; then fail "interpolacja {{ }} w SQL"; else echo "ok: SQL parametryzowane"; fi
else echo "skip: brak queries.ts (przed F1-T1)"; fi

if [ "$FAIL" -ne 0 ]; then echo "RESULT: FAIL"; exit 1; fi
echo "RESULT: PASS"
