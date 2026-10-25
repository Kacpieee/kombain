#!/usr/bin/env bash
# worker-run.sh — wygodne wywołanie CLI workera na VPS (z roota repo lub przez KOMBAIN_DIR).
# Przykłady:
#   scripts/worker-run.sh check-env
#   scripts/worker-run.sh preview-prompt --kind editor --category "Agroenergetyka"
#   scripts/worker-run.sh run --dry-run --url "https://example.com/artykul"
#   scripts/worker-run.sh run --dry-run --limit 1
set -euo pipefail

ROOT="${KOMBAIN_DIR:-$HOME/kombain}"
cd "$ROOT"

if [ $# -eq 0 ]; then
  echo "Użycie: scripts/worker-run.sh <check-env|preview-prompt|run> [flagi]"
  exit 2
fi

exec docker compose -f deploy/worker.compose.yml run --rm worker bun src/cli.ts "$@"
