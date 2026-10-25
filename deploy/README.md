# deploy — VPS kombain.pl

Runbook F1-T2: nowa baza `kombain` na istniejącym PostgreSQL + repoint Directusa + rola read-only + seed źródeł.

> W repo nie ma adresów IP, nazw hostów ani sekretów. Podmień placeholdery:
> `<VPS_IP>`, `<USER>`, `<repo>` (katalog repo lokalnie), `<COMPOSE_DIR>` (katalog z `docker-compose.yml`, np. `~/n8n-docker`).

## Zasady bezpieczeństwa (twarde)

- **Zero `DROP`** — ani bazy, ani schematu, ani tabel.
- **Zero operacji klasterowych** (`pg_dumpall`, `DROP ROLE`, restart kontenera PG, zmiany `postgresql.conf`).
- Skrypt działa **wyłącznie na bazie `kombain`** (allowlist, nie denylist); testy lokalne tylko z `KOMBAIN_ALLOW_TEST_DB=1` i prefiksem `kombain_test`.
- Bazy `n8n`, `postgres`, `template*` oraz stack kcal (kontener `kcal-*`, port 5433) są nietykalne.
- Stara `kombain_db` zostaje jako archiwum do cutoveru — najpierw dump, zero zmian w środku.

## Stan wyjściowy (potwierdzony 2026-10-21)

| Element | Wartość |
|---|---|
| PostgreSQL | 16.14 Debian, `uuid-ossp 1.1` dostępny |
| Bazy | `kombain_db` (owner `kombain_user`, stary Directus + stare tabele), `n8n`, `postgres` |
| n8n | baza `n8n` — nie dzieli bazy z kombain |
| Directus | 10.13, `127.0.0.1:8055`, `cms.kombain.pl` → kontener Directusa |
| Kontener PG | `n8n-docker-postgres-1`, superuser `n8n` |

## 1. Przenieś kit na VPS (uruchom **lokalnie**)

```bash
cd <repo>
tar czf - deploy packages/db/schema.sql | ssh <USER>@<VPS_IP> 'mkdir -p ~/kombain-deploy && tar xzf - -C ~/kombain-deploy'
```

## 2. Backup starej bazy (VPS, **przed** czymkolwiek)

```bash
mkdir -p ~/backups
docker exec n8n-docker-postgres-1 pg_dump -U n8n -Fc -d kombain_db > ~/backups/kombain_db_$(date +%F_%H%M).dump
ls -lh ~/backups
docker exec -i n8n-docker-postgres-1 pg_restore -l < ~/backups/kombain_db_*.dump | head -20
```

Ostatnia linia tylko czyta nagłówek dumpa — jeśli wypisze obiekty, backup jest poprawny.

## 3. Baza `kombain` (VPS)

```bash
cd ~/kombain-deploy
bash deploy/scripts/init-db.sh
```

Skrypt: tworzy bazę tylko jeśli nie istnieje → `uuid-ossp` jako superuser → `schema.sql` jako `kombain_user` → seed 3 źródeł → weryfikacja. Re-run jest bezpieczny; przy częściowym schemacie (1–4 tabele) zatrzymuje się bez zmian. `--seed` służy **tylko** do ponownego seeda (wymaga istniejącej bazy i schematu).

## 4. Preflight przed rotacją hasła `kombain_user` (VPS)

```bash
docker exec n8n-docker-n8n-1 env | grep DB_POSTGRESDB_USER
docker exec n8n-docker-postgres-1 psql -U n8n -d postgres -tAc "SELECT usename, datname, count(*) FROM pg_stat_activity GROUP BY 1,2 ORDER BY 1"
```

**STOP**, jeśli n8n używa `kombain_user` — wtedy nie rotuj hasła (wybierz inną rolę dla Directusa). Jeśli n8n używa `n8n`, przechodź dalej.

## 5. Directus: repoint na nową bazę (VPS)

Backup compose i nowe hasło (bez historii powłoki):

```bash
cd <COMPOSE_DIR>
cp docker-compose.yml docker-compose.yml.bak-$(date +%F_%H%M)
docker exec -it n8n-docker-postgres-1 psql -U n8n -d postgres
```

W otwartym psql wpisz:

```sql
\password kombain_user
```

(dwa razy to samo hasło, bez echa w terminalu), potem `\q`.

W `docker-compose.yml` (serwis `directus`) zmień **trzy** linie:

```yaml
DB_DATABASE: "kombain"
DB_USER: "kombain_user"
DB_PASSWORD: "<hasło wpisane przed chwilą>"
```

Hasło wpisujesz tylko w edytorze pliku — nie w shellu i nie w czacie.

Restart tylko Directusa:

```bash
docker compose config >/dev/null && docker compose up -d --no-deps directus
docker logs --tail 40 n8n-docker-directus-1
```

Pierwszy start utworzy tabele `directus_*` **w bazie `kombain`**. Stara baza pozostaje nietknięta.
**Uwaga:** od `\password` do restartu Directus jest krótkie okno niedostępności (kilkadziesiąt sekund) — CMS nie połączy się ze starą bazą ze starym hasłem.

## 6. Directus: rejestracja kolekcji i relacje

Tabele utworzone przez `schema.sql` są dla Directusa **unmanaged** (`meta: null`) — introspektuje je, ale nie pokazuje w Data Model. `POST /collections` zwraca wtedy `400 already exists`; działa **`PATCH /collections/:name`** z `meta`.

```bash
cd ~/kombain-deploy
bash deploy/scripts/register-collections.sh
```

Skrypt pyta o hasło admina (`read -s`, bez historii), rejestruje 5 kolekcji i weryfikuje `meta: true` dla każdej. Jest idempotentny — można go uruchamiać wielokrotnie.

Po rejestracji: **Settings → Data Model** → 5 kolekcji (`articles`, `categories`, `sources`, `tags`, `article_tags`), z display template `{{title}}` / `{{name}}`.

Relacje:
- `articles.category_id` i `articles.source_id` — Directus rozpoznaje Many-to-One **z istniejących FK**; nie tworzymy ich przez API (`POST /relations` zwróci `already has an associated relationship`).
- `article_tags` — dwa Many-to-One (`article_id → articles`, `tag_id → tags`), dostępne przez `article_tags.tag_id.name`.
- **Ograniczenie:** alias Many-to-Many „tags” w widoku artykułu nie jest skonfigurowany (API Directusa nie pozwala dopisać powiązania junction do relacji wyprowadzonej z FK). Tagi edytuje się w kolekcji `article_tags`; front czyta je przez `article_tags.tag_id.name`.

Sprawdź też: `articles.tldr` i `articles.tech_summary` = JSON, `status` ∈ `published/rejected/draft`.

### Migracja bazy utworzonej przed `article_tags.id`

Bazy postawione wcześniejszą wersją `schema.sql` mają złożony PK `(article_id, tag_id)` — Directus 10 takiej kolekcji nie widzi. `init-db.sh` nie rusza istniejącego schematu, więc migrację wykonuje się raz, ręcznie (tabele zwykle puste):

```bash
docker exec n8n-docker-postgres-1 psql -U n8n -d kombain -v ON_ERROR_STOP=1 -c "BEGIN; ALTER TABLE article_tags DROP CONSTRAINT article_tags_pkey, ADD COLUMN id UUID NOT NULL DEFAULT uuid_generate_v4(), ADD CONSTRAINT article_tags_pkey PRIMARY KEY (id), ADD CONSTRAINT article_tags_article_id_tag_id_key UNIQUE (article_id, tag_id); COMMIT;"
```

To jedyne miejsce w runbooku, gdzie świadomie usuwamy **constraint** (nie tabelę, nie dane). Po `ALTER` zrestartuj Directusa i uruchom `register-collections.sh`.

## 7. Rola read-only + token (UI)

Directus 10 **nie ma pola „User Type”** (to było w v9). „API user” = rola bez App Access + statyczny Token.

1. **Settings → Roles & Permissions → Create Role**: `Public API`; **Admin Access: OFF**, **App Access: OFF**.
2. Uprawnienia: `articles` → **Read** z filtrem `{"status":{"_eq":"published"}}`; `categories`, `tags`, `article_tags` → Read; `sources` → brak.
3. **User Directory → Create User**: email `api@kombain.pl`, rola `Public API` (hasło dowolne — nieużywane).
4. Otwórz użytkownika → sekcja **Token** → **Generate** → skopiuj → **Save**.
5. Token wyłącznie w env VPS — bez echa, bez historii powłoki i bez nadpisywania istniejących zmiennych:

```bash
read -rsp "Directus token: " DTOKEN; echo
DTOKEN="$DTOKEN" python3 - <<'PY'
import os, pathlib
p = pathlib.Path.home() / "kombain-deploy" / ".env"
p.parent.mkdir(parents=True, exist_ok=True)
lines = [l for l in (p.read_text().splitlines() if p.exists() else []) if not l.startswith("DIRECTUS_PUBLIC_READ_TOKEN=")]
lines.append("DIRECTUS_PUBLIC_READ_TOKEN=" + os.environ["DTOKEN"])
p.write_text("\n".join(lines) + "\n")
p.chmod(0o600)
print("zapisano", p)
PY
unset DTOKEN
```

Alternatywa bez UI: `PATCH /users/:id` z polem `token` (patrz historia tasku F1-T2).

## 8. Weryfikacja

```bash
set -a; . ~/kombain-deploy/.env; set +a

docker exec n8n-docker-postgres-1 psql -U kombain_user -d kombain -c "\dt"
docker exec n8n-docker-postgres-1 psql -U kombain_user -d kombain -c "SELECT count(*) AS kategorie FROM categories;"
docker exec n8n-docker-postgres-1 psql -U kombain_user -d kombain -c "SELECT name, url, is_active FROM sources ORDER BY name;"

curl -s -o /dev/null -w '%{http_code}\n' https://cms.kombain.pl/items/articles
curl -s -H "Authorization: Bearer $DIRECTUS_PUBLIC_READ_TOKEN" "https://cms.kombain.pl/items/articles?limit=5&fields=title,status"
```

`set -a; . .env` jest konieczne — bez tego `$DIRECTUS_PUBLIC_READ_TOKEN` jest pusty, a wklejanie tokena inline trafia do historii/`ps`.

Oczekiwane: 5 tabel + `directus_*`; 6 kategorii; 3 źródła. Bez tokena: `403` **albo** `200` z pustą listą (zależy od uprawnień roli `public`) — oba wyniki są poprawne, jeśli z tokenem widać wyłącznie `status=published`.

## 9. Rollback

Rotacja hasła w sekcji 5 zmienia hasło **roli w PostgreSQL**, więc rollback musi je najpierw przywrócić — sam plik compose tego nie zrobi.

```bash
cd <COMPOSE_DIR>
COMPOSE_BAK="$(ls -t docker-compose.yml.bak-* | head -1)"
echo "$COMPOSE_BAK"
grep DB_PASSWORD "$COMPOSE_BAK"
```

Hasło pojawi się na ekranie — to świadome, jednorazowe odczytanie backupu na VPS (nie wklejaj go do czatu ani do repo).

Odczytane stare hasło ustaw z powrotem w roli:

```bash
docker exec -it n8n-docker-postgres-1 psql -U n8n -d postgres
```

```sql
\password kombain_user
```

(dwa razy stare hasło), `\q`. Następnie przywróć compose i zrestartuj Directusa:

```bash
cp "$COMPOSE_BAK" docker-compose.yml
docker compose config >/dev/null && docker compose up -d --no-deps directus
docker logs --tail 20 n8n-docker-directus-1
```

Nowa baza `kombain` zostaje (nie zawiera nic, co blokowałoby powrót), stara `kombain_db` jest nietknięta. Okno niedostępności CMS: od `\password` do zakończenia restartu (kilkadziesiąt sekund).

## 10. Troubleshooting

| Objaw | Przyczyna / fix |
|---|---|
| `FAIL: dozwolona jest wyłącznie baza 'kombain'` | wpisano inną nazwę — celowa blokada (allowlist) |
| `FAIL: rola kombain_user nie istnieje` | rola została zmieniona/usunięta; skrypt nie tworzy ról |
| `FAIL: nie mogę połączyć się jako superuser` | zły `PG_SUPERUSER` (ustaw np. `PG_SUPERUSER=n8n`) |
| `FAIL: rola ... nie łączy się lokalnie` | `pg_hba.conf` bez `local ... trust`; użyj `PG_SUPERUSER` z hasłem lub zmień auth świadomie |
| Directus: `password authentication failed` | hasło w compose nie zgadza się z `\password`; po rollbacku przywróć hasło roli (sekcja 9) |
| Directus: `permission denied for schema public` | schemat założony inną rolą niż `kombain_user`; sprawdź ownera tabel |
| Directus: `relation "directus_..." does not exist` | trwa pierwsza migracja — odczekaj, sprawdź logi |
| Data Model pokazuje 0 kolekcji | tabele są unmanaged — uruchom `deploy/scripts/register-collections.sh` (PATCH meta) |
| `POST /collections` → `400 already exists` | to normalne dla istniejącej tabeli; użyj PATCH (skrypt robi to za Ciebie) |
| Seed nie dodał źródeł | źródło już istnieje (`ON CONFLICT (url)`) — poprawne zachowanie |

## 11. Worker: Docker + cron (VPS)

Pliki: `deploy/worker.compose.yml` + `apps/worker/Dockerfile`. Worker wchodzi do sieci `n8n-docker_default` (bez publikowania portów). **Uruchamiaj z roota repo** (`-f deploy/worker.compose.yml`), bo build context to katalog repo, a `env_file` rozwiązuje się względem katalogu compose (`deploy/`).

### 11.1 Kod na VPS (pełne repo, nie tylko deploy)

```bash
cd <repo>
tar czf - package.json tsconfig.json .dockerignore packages apps/worker deploy | ssh <USER>@<VPS_IP> 'mkdir -p ~/kombain && tar xzf - -C ~/kombain'
```

### 11.2 Env (tylko na VPS, `chmod 600`, nigdy w repo)

```bash
cd ~/kombain
umask 077
cat > deploy/worker.env <<'EOF'
DIRECT_DATABASE_URL=postgresql://kombain_user:<haslo>@n8n-docker-postgres-1:5432/kombain
GEMINI_API_KEY=<klucz>
GEMINI_LITE_MODEL=gemini-3.1-flash-lite
GEMINI_PRO_MODEL=gemini-3.8-flash
SCRAPINGANT_API_KEY=<klucz>
DEEPSEEK_API_KEY=<klucz>
DEEPSEEK_BASE_URL=https://api.deepseek.com
SEARCH_PROVIDER=deepseek
MAX_PUBLISHED_PER_RUN=1
MAX_LINKS_PER_SOURCE=15
MAX_PROCESSED_PER_RUN=10
FETCH_CONCURRENCY=5
RUN_TIMEOUT_MS=1500000
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat_id>
HEALTHCHECKS_PING_URL=<url>
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
R2_BUCKET=articles
R2_ACCESS_KEY_ID=<klucz>
R2_SECRET_ACCESS_KEY=<sekret>
R2_PUBLIC_BASE_URL=https://media.kombain.pl
EOF
chmod 600 deploy/worker.env
```

### 11.3 Pierwszy run (limit 1, ręcznie)

```bash
cd ~/kombain
docker compose -f deploy/worker.compose.yml build
docker compose -f deploy/worker.compose.yml run --rm worker
```

### 11.4 Cron co 6 h (host, z lockiem przeciw nakładaniu)

```bash
crontab -e
```

```cron
0 */6 * * * flock -n /tmp/kombain-worker.lock /home/ubuntu/kombain/deploy/scripts/worker-cron.sh >> /home/ubuntu/kombain-worker.log 2>&1
```

`flock -n` = jeśli poprzedni run trwa, nowy jest pomijany. Wrapper `worker-cron.sh` dokłada `timeout 1800` i przy przekroczeniu wysyła Telegram + ping `/fail` do healthchecks. Podmień `/home/ubuntu` na katalog swojego użytkownika.

### 11.5 Podsumowanie runu

```bash
grep '"event":"run_summary"' /home/ubuntu/kombain-worker.log | tail -1
grep '"event":"dropped"' /home/ubuntu/kombain-worker.log | tail -5
```

Uwagi:
- `MAX_PUBLISHED_PER_RUN` (max 2) pilnuje kosztów; na pierwszy test `1`.
- Po limicie run kończy się, a pozostałe linki wrócą w kolejnym runie.
- Błąd źródła nie wywala runu — trafia do `source_error` w logu.

## 12. CLI workera (testowanie bez publikacji)

Z roota `~/kombain` (albo przez `scripts/worker-run.sh`):

```bash
# 1. Co mam w env (maskowane, bez wartości sekretów)
docker compose -f deploy/worker.compose.yml run --rm worker bun src/cli.ts check-env

# 2. Jak wygląda prompt Redaktora dla działu (bez wołania API)
docker compose -f deploy/worker.compose.yml run --rm worker bun src/cli.ts preview-prompt --kind editor --category "Agroenergetyka"

# 3. Pełny test jednego linku BEZ zapisu do DB (płaci za Gemini)
docker compose -f deploy/worker.compose.yml run --rm worker bun src/cli.ts run --dry-run --url "https://example.com/artykul"

# 4. Dry-run na źródłach, max 1 artykuł
docker compose -f deploy/worker.compose.yml run --rm worker bun src/cli.ts run --dry-run --limit 1
```

Semantyka:
- `--dry-run` — scrape + Bramkarz + Redaktor + review, **bez** media i bez `saveArticle`/`rejectArticle`; wynik `wouldBe: published|draft|rejected`.
- `--url` — pojedynczy link, pomija ingestion (najtańszy test). Bez `--dry-run` wykona normalny zapis z `source_id = NULL` (CLI ostrzega).
- Dry-run **nie podgląda** URL-i już zapisanych w DB — dedup zwróci `dropped/url_duplicate` przed scrapem.
- `--limit` — 1..2 (limit publikacji; w dry-run limit przetworzonych), `--max-links` 1..15.
- `--json` — JSONL zamiast linii ludzkich.
- `preview-prompt --kind gate|editor|r1|r2|r3` — te same buildery co produkcja; nic nie jest wysyłane do Gemini.
- `check-env` — tylko `set(len=…)`/`not set`, host DB bez hasła.

## 13. Alerty i dead man's switch

Worker wysyła **jedno podsumowanie na run** (Telegram) oraz alert w tej samej wiadomości, gdy: `errors >= 3` albo padły wszystkie źródła. `worker_fatal` i timeout (124) idą osobnym alertem.

### 13.1 Telegram

1. W Telegramie: `@BotFather` → `/newbot` → nazwa → dostajesz token.
2. Napisz coś do bota, potem:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["result"][-1]["message"]["chat"]["id"])'
```

3. Do `deploy/worker.env`: `TELEGRAM_BOT_TOKEN=...` i `TELEGRAM_CHAT_ID=...`.
4. Test: `scripts/worker-run.sh run --dry-run --limit 1` **nie wysyła** alertów (dry-run jest cichy). Test kanału robisz realnym runem albo tymczasowo przez `run --limit 1`.

### 13.2 healthchecks.io (brak runu = alert)

1. `https://healthchecks.io` → **Add Check**: period 1 h, grace 12 h.
2. Skopiuj ping URL do `HEALTHCHECKS_PING_URL`.
3. Worker pinguje `/start` na początku, base URL po sukcesie, `/fail` przy fatal/timeoucie.
4. Brak pingów przez 12 h → healthchecks wyśle mail/Telegram „worker nie działa”.

### 13.3 Pamięć porażek (backoff)

Tabela `article_failures`: link, który rzucił błąd, dostaje `attempts+1`; po **3 próbach** jest pomijany przez **7 dni** (bez scrape i bez LLM), a po wygaśnięciu okna dostaje jedną próbę (kolejny błąd znów uruchamia 7-dniową przerwę). Sukces (published/draft/rejected) czyści wpis. To zatrzymuje cichy retry-loop i koszty.

Migracja istniejącej bazy (jako `kombain_user` — worker ma DML na tej roli):

```bash
docker exec -i n8n-docker-postgres-1 psql -U kombain_user -d kombain -v ON_ERROR_STOP=1 < deploy/sql/migrate-article-failures.sql
```

Podgląd:

```bash
docker exec n8n-docker-postgres-1 psql -U kombain_user -d kombain -c "SELECT source_url, attempts, last_stage, last_seen_at FROM article_failures ORDER BY last_seen_at DESC LIMIT 10;"
```
