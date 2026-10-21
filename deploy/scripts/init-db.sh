#!/usr/bin/env bash
# init-db.sh — F1-T2 krok 0: nowa baza `kombain` na istniejącym PG (VPS).
# Bezpieczeństwo: ZERO DROP, ZERO operacji klasterowych, TYLKO baza `kombain`.
# Nie dotyka baz n8n/postgres/template*/kcal* ani kontenera kcal.
#
# Użycie:
#   bash deploy/scripts/init-db.sh          # baza + schemat (jeśli brak) + seed
#   bash deploy/scripts/init-db.sh --seed   # tylko seed (baza i schemat muszą istnieć)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DB_NAME="${KOMBAIN_DB:-kombain}"
DB_OWNER="${KOMBAIN_DB_OWNER:-kombain_user}"
PG_CONTAINER="${PG_CONTAINER:-n8n-docker-postgres-1}"
PG_SUPERUSER="${PG_SUPERUSER:-n8n}"
SCHEMA="${SCHEMA_PATH:-packages/db/schema.sql}"
SEED="deploy/sql/seed-sources.sql"
VERIFY="deploy/sql/verify.sql"

SEED_ONLY=0
case "${1:-}" in
  "") ;;
  --seed) SEED_ONLY=1 ;;
  *) echo "FAIL: nieznany argument '$1' (dozwolone: --seed)"; exit 1 ;;
esac

fail() { echo "FAIL: $*"; exit 1; }

# --- allowlist bazy: wyłącznie `kombain`; testy lokalne tylko za jawnym env-gatem ---
if [ "$DB_NAME" != "kombain" ]; then
  if [ "${KOMBAIN_ALLOW_TEST_DB:-0}" != "1" ]; then
    fail "dozwolona jest wyłącznie baza 'kombain' (otrzymano '$DB_NAME'); testy: KOMBAIN_ALLOW_TEST_DB=1"
  fi
  case "$DB_NAME" in
    kombain_test|kombain_test_*) ;;
    *) fail "niedozwolona nazwa testowej bazy '$DB_NAME'" ;;
  esac
fi
case "$DB_NAME" in *[!a-z0-9_]*) fail "niedozwolone znaki w nazwie bazy" ;; esac
case "$DB_OWNER" in *[!a-z0-9_]*) fail "niedozwolone znaki w nazwie roli '$DB_OWNER'" ;; esac

RUNNER=""
for candidate in docker podman; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNNER="$candidate"; break; fi
done
[ -n "$RUNNER" ] || fail "brak docker/podman"

[ -f "$SCHEMA" ] || fail "brak $SCHEMA (uruchom z roota repo)"
[ -f "$SEED" ] || fail "brak $SEED"

"$RUNNER" inspect "$PG_CONTAINER" >/dev/null 2>&1 || fail "brak kontenera $PG_CONTAINER"

psql_postgres() { "$RUNNER" exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d postgres -tAc "$1"; }
psql_db() { "$RUNNER" exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$DB_NAME" -tAc "$1"; }

# --- preflight połączenia (odróżnia złe credentials od braku roli) ---
if ! psql_postgres "SELECT 1" >/dev/null 2>&1; then
  fail "nie mogę połączyć się jako superuser '$PG_SUPERUSER' do kontenera $PG_CONTAINER (sprawdź PG_SUPERUSER)"
fi

role_exists="$(psql_postgres "SELECT 1 FROM pg_roles WHERE rolname = '$DB_OWNER'")"
[ "$role_exists" = "1" ] || fail "rola $DB_OWNER nie istnieje (skrypt świadomie nie tworzy ról)"

db_exists="$(psql_postgres "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")"

if [ "$db_exists" != "1" ]; then
  if [ "$SEED_ONLY" = "1" ]; then
    fail "baza $DB_NAME nie istnieje — uruchom bez --seed, żeby ją utworzyć"
  fi
  echo "== tworzę bazę $DB_NAME (owner $DB_OWNER)"
  "$RUNNER" exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $DB_NAME OWNER $DB_OWNER" >/dev/null
fi

# --- stan schematu: liczymy obecność NASZYCH 5 tabel ---
tables_present="$(psql_db "SELECT count(*) FROM (VALUES
  (to_regclass('public.categories')), (to_regclass('public.sources')), (to_regclass('public.articles')),
  (to_regclass('public.tags')), (to_regclass('public.article_tags'))
) AS t(x) WHERE x IS NOT NULL" | tr -d ' ')"

if [ "$tables_present" = "0" ]; then
  if [ "$SEED_ONLY" = "1" ]; then
    fail "baza $DB_NAME nie ma schematu — uruchom bez --seed"
  fi
  echo "== extension uuid-ossp (superuser)"
  "$RUNNER" exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
    -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' >/dev/null
  echo "== schema.sql jako $DB_OWNER"
  "$RUNNER" exec -i "$PG_CONTAINER" psql -U "$DB_OWNER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <"$SCHEMA" >/dev/null
elif [ "$tables_present" != "5" ]; then
  fail "częściowy schemat w $DB_NAME ($tables_present/5 tabel) — wymaga ręcznej decyzji, nie ruszam"
else
  echo "== schemat już jest (5/5 tabel) — nie ruszam"
fi

# --- rola właściciela musi móc łączyć się przez socket lokalny ---
if ! "$RUNNER" exec "$PG_CONTAINER" psql -U "$DB_OWNER" -d "$DB_NAME" -tAc "SELECT 1" >/dev/null 2>&1; then
  fail "rola $DB_OWNER nie łączy się lokalnie do $DB_NAME (pg_hba: local trust?) — sprawdź konfigurację PG"
fi

echo "== seed źródeł (idempotentny ON CONFLICT DO NOTHING)"
"$RUNNER" exec -i "$PG_CONTAINER" psql -U "$DB_OWNER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <"$SEED" >/dev/null

echo "== weryfikacja"
"$RUNNER" exec -i "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <"$VERIFY"
echo "OK: $DB_NAME gotowa (bez DROP, bez zmian w innych bazach)"
