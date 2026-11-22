#!/usr/bin/env bash
# release-worker.sh — lokalny release workera na VPS: transfer → build → check-env → defaulty.
# Wymaga działającego SSH do VPS. Sekrety zostają w deploy/worker.env po stronie VPS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${VPS_USER:?Ustaw VPS_USER, np. VPS_USER=ubuntu}"
: "${VPS_HOST:?Ustaw VPS_HOST, np. VPS_HOST=1.2.3.4}"
VPS_DIR="${VPS_DIR:-/home/$VPS_USER/kombain}"
case "$VPS_DIR" in
  *" "*|*"'"*) echo "VPS_DIR nie może zawierać spacji/apostrofa: $VPS_DIR" >&2; exit 1 ;;
esac

echo "== release: $VPS_USER@$VPS_HOST:$VPS_DIR"

ssh "$VPS_USER@$VPS_HOST" "mkdir -p '$VPS_DIR'"

echo "== transfer"
tar czf - \
  --exclude='deploy/worker.env*' \
  --exclude='.env' \
  --exclude='.env.*' \
  package.json tsconfig.json .dockerignore packages apps/worker deploy \
| ssh "$VPS_USER@$VPS_HOST" "tar xzf - -C '$VPS_DIR'"

echo "== remote: env + build + check + defaulty"
ssh "$VPS_USER@$VPS_HOST" "set -euo pipefail
cd '$VPS_DIR'
test -f deploy/worker.env || { echo 'BRAK deploy/worker.env — utwórz go wg README §11.2'; exit 1; }
chmod 600 deploy/worker.env

# append tylko po pełnej linii — brak końcowego newline nie może skleić zmiennych
[ -z \"\$(tail -c1 deploy/worker.env)\" ] || printf '\\n' >> deploy/worker.env

grep -q '^VERIFY_MAX_ATOMS=' deploy/worker.env || echo 'VERIFY_MAX_ATOMS=8' >> deploy/worker.env
grep -q '^REPAIR_MAX_ATTEMPTS=' deploy/worker.env || echo 'REPAIR_MAX_ATTEMPTS=1' >> deploy/worker.env

docker compose -f deploy/worker.compose.yml build
docker compose -f deploy/worker.compose.yml run --rm worker bun src/cli.ts check-env
docker compose -f deploy/worker.compose.yml run --rm worker bun src/scripts/upload-defaults.ts
"

echo "== OK. Następny krok:"
echo "   ssh $VPS_USER@$VPS_HOST 'cd $VPS_DIR && docker compose -f deploy/worker.compose.yml run --rm worker bun src/cli.ts run --dry-run --limit 1 --json'"
