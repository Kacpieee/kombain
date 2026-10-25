#!/usr/bin/env bash
# worker-cron.sh — cron wrapper: twardy timeout + alert przy 124.
# Uruchamiaj z crona: 0 */6 * * * flock -n /tmp/kombain-worker.lock /home/ubuntu/kombain/deploy/scripts/worker-cron.sh >> /home/ubuntu/kombain-worker.log 2>&1
set -uo pipefail

ROOT="${KOMBAIN_DIR:-$HOME/kombain}"
cd "$ROOT" || exit 1

set -a
# shellcheck disable=SC1091
. deploy/worker.env
set +a

timeout 1800 docker compose -f deploy/worker.compose.yml run --rm worker
code=$?

if [ "$code" -eq 124 ]; then
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=⏱️ worker timeout po 30 min — sprawdź logi" >/dev/null 2>&1 || true
  fi
  if [ -n "${HEALTHCHECKS_PING_URL:-}" ]; then
    curl -s -m 5 "${HEALTHCHECKS_PING_URL%/}/fail" >/dev/null 2>&1 || true
  fi
fi

exit "$code"
