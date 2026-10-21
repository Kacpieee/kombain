#!/usr/bin/env bash
# db-test.sh — testy integracyjne PG (F1-T1) na jednorazowym kontenerze.
# Parity z VPS: obraz postgres:16 (Debian). Nie dotyka lokalnych baz użytkownika.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "== używam TEST_DATABASE_URL z env (bez kontenera)"
  exec npx vitest run packages/db/schema.pg.test.ts
fi

RUNNER=""
for candidate in docker podman; do
  if command -v "$candidate" >/dev/null 2>&1; then RUNNER="$candidate"; break; fi
done
if [ -z "$RUNNER" ]; then
  echo "FAIL: brak docker/podman — ustaw TEST_DATABASE_URL albo zainstaluj runner"
  exit 1
fi

PORT="${TEST_PG_PORT:-55432}"
NAME="kombain-pg-test-$$"
cleanup() { "$RUNNER" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== $RUNNER: $NAME (postgres:16) na 127.0.0.1:$PORT"
"$RUNNER" run -d --rm --name "$NAME" \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=kombain_test \
  -e POSTGRES_DB=kombain_test \
  -p "127.0.0.1:$PORT:5432" \
  postgres:16 >/dev/null

for _ in $(seq 1 60); do
  if "$RUNNER" exec "$NAME" pg_isready -U postgres -d kombain_test >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! "$RUNNER" exec "$NAME" pg_isready -U postgres -d kombain_test >/dev/null 2>&1; then
  echo "FAIL: PG nie wstał w 60s"
  exit 1
fi

TEST_DATABASE_URL="postgresql://postgres:kombain_test@127.0.0.1:$PORT/kombain_test" \
  npx vitest run packages/db/schema.pg.test.ts
