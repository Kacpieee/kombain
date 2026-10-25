#!/usr/bin/env bash
# register-collections.sh — F1-T2: rejestruje 5 istniejących tabel jako kolekcje Directusa.
# Tabele "unmanaged" (meta: null): POST /collections zwraca 400 "already exists",
# więc używamy PATCH /collections/:name z meta. PATCH nieistniejącej nazwy tworzy
# fantom (schema: null) — dlatego najpierw sprawdzamy, że tabela realnie istnieje.
# Hasło i token nie trafiają do argv, historii ani repo.
set -euo pipefail

BASE_URL="${DIRECTUS_URL:-https://cms.kombain.pl}"
ADMIN_EMAIL="${DIRECTUS_ADMIN_EMAIL:-admin@kombain.pl}"

fail() { echo "FAIL: $*"; exit 1; }
command -v curl >/dev/null 2>&1 || fail "brak curl"
command -v python3 >/dev/null 2>&1 || fail "brak python3"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

if [ -z "${DIRECTUS_ADMIN_PASSWORD:-}" ]; then
  [ -t 0 ] || fail "brak TTY — ustaw DIRECTUS_ADMIN_PASSWORD w env (nie w repo)"
  read -rsp "Directus admin password (${ADMIN_EMAIL}): " DIRECTUS_ADMIN_PASSWORD
  echo
fi

LOGIN_JSON="$(printf '%s' "$DIRECTUS_ADMIN_PASSWORD" | python3 -c 'import json,sys
print(json.dumps({"email": sys.argv[1], "password": sys.stdin.read()}))' "$ADMIN_EMAIL")"
TOKEN="$(printf '%s' "$LOGIN_JSON" | curl -sS -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' --data-binary @- \
  | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("data", {}).get("access_token", ""))
except Exception:
    print("")')"
unset DIRECTUS_ADMIN_PASSWORD LOGIN_JSON
[ -n "$TOKEN" ] || fail "logowanie nie zwróciło tokena (zły email/hasło lub konto bez admina)"

printf 'Authorization: Bearer %s' "$TOKEN" >"$TMPDIR/auth.hdr"
chmod 600 "$TMPDIR/auth.hdr"
unset TOKEN

ensure_table() {
  curl -sS -H @"$TMPDIR/auth.hdr" "$BASE_URL/collections/$1" | python3 -c 'import json,sys
name = sys.argv[1]
try:
    data = json.load(sys.stdin)["data"]
except Exception:
    print("FAIL: brak odpowiedzi JSON dla kolekcji", name)
    raise SystemExit(2)
if not data.get("schema"):
    print("FAIL: tabela", name, "nie istnieje w bazie (byłby fantom schema:null)")
    raise SystemExit(3)' "$1"
}

patch_collection() {
  local name="$1" meta="$2" code
  code="$(printf '%s' "{\"meta\":$meta}" | curl -sS -o "$TMPDIR/resp.json" -w '%{http_code}' \
    -X PATCH "$BASE_URL/collections/$name" -H @"$TMPDIR/auth.hdr" \
    -H 'Content-Type: application/json' --data-binary @-)"
  if [ "$code" = "200" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name (http $code)"
    head -c 300 "$TMPDIR/resp.json" 2>/dev/null || true
    echo
    exit 1
  fi
}

for spec in \
  'categories|{"collection":"categories","icon":"category","note":"Działy portalu","display_template":"{{name}}"}' \
  'sources|{"collection":"sources","icon":"rss_feed","note":"Źródła RSS/scraper","display_template":"{{name}}"}' \
  'tags|{"collection":"tags","icon":"sell","note":"Tagi","display_template":"{{name}}"}' \
  'articles|{"collection":"articles","icon":"article","note":"Artykuły","display_template":"{{title}}"}' \
  'article_tags|{"collection":"article_tags","icon":"link","note":"Powiązania artykuł–tag"}'
do
  name="${spec%%|*}"
  meta="${spec#*|}"
  ensure_table "$name"
  patch_collection "$name" "$meta"
done

echo "== weryfikacja"
curl -sS -H @"$TMPDIR/auth.hdr" "$BASE_URL/collections" | python3 -c '
import json,sys
expected = {"articles", "article_tags", "categories", "sources", "tags"}
data = json.load(sys.stdin)["data"]
by_name = {c["collection"]: c for c in data}
problems = []
for name in sorted(expected):
    c = by_name.get(name)
    if c is None:
        problems.append(f"{name}: brak w API")
    elif not c.get("meta"):
        problems.append(f"{name}: meta:null")
    elif not c.get("schema"):
        problems.append(f"{name}: schema:null (fantom)")
if problems:
    raise SystemExit("FAIL: " + "; ".join(problems))
print("zarejestrowane:", ", ".join(sorted(expected)))
'

echo "OK: kolekcje zarejestrowane (PATCH meta, tabele nietknięte)"
