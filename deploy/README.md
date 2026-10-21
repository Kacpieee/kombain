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

## 6. Directus: model i relacje (UI)

1. `https://cms.kombain.pl`, zaloguj się jako admin.
2. **Settings → Data Model**. Jeśli lista jest pusta: **Settings → Data Model → „Refresh schema”** (Directus 10 introspektuje tabele zewnętrzne; brak metadanych kolekcji objawia się pustą listą).
3. Kolekcje: `articles`, `sources`, `categories`, `tags`, `article_tags`.
4. Relacje (display template = „wizualność” w panelu):
   - `articles.category_id` → `categories`, Many-to-One, display `{{name}}`
   - `articles.source_id` → `sources`, Many-to-One, display `{{name}}`
   - `article_tags` → Many-to-Many `articles` ↔ `tags`, display `{{name}}`
5. Sprawdź: `articles.tldr` i `articles.tech_summary` = JSON, `status` ∈ `published/rejected/draft`.

## 7. Rola read-only + token (UI)

1. **Settings → Roles & Permissions → Create Role**: `Public API`, bez dostępu do appki.
2. Uprawnienia: `articles` → **Read** z filtrem `{"status":{"_eq":"published"}}`; `categories`, `tags`, `article_tags` → Read; `sources` → brak.
3. **User Directory → Create User**: typ **API**, rola `Public API` → wygeneruj **static token** (widoczny raz).
4. Token wyłącznie w env VPS jako `DIRECTUS_PUBLIC_READ_TOKEN`.

## 8. Weryfikacja

```bash
docker exec n8n-docker-postgres-1 psql -U kombain_user -d kombain -c "\dt"
docker exec n8n-docker-postgres-1 psql -U kombain_user -d kombain -c "SELECT count(*) AS kategorie FROM categories;"
docker exec n8n-docker-postgres-1 psql -U kombain_user -d kombain -c "SELECT name, url, is_active FROM sources ORDER BY name;"

curl -s -o /dev/null -w '%{http_code}\n' https://cms.kombain.pl/items/articles
curl -s -H "Authorization: Bearer $DIRECTUS_PUBLIC_READ_TOKEN" "https://cms.kombain.pl/items/articles?limit=5&fields=title,status"
```

Oczekiwane: 5 tabel + `directus_*`; 6 kategorii; 3 źródła. Bez tokena: `403` **albo** `200` z pustą listą (zależy od uprawnień roli `public`) — oba wyniki są poprawne, jeśli z tokenem widać wyłącznie `status=published`.

## 9. Rollback

Rotacja hasła w sekcji 5 zmienia hasło **roli w PostgreSQL**, więc rollback musi je najpierw przywrócić — sam plik compose tego nie zrobi.

```bash
cd <COMPOSE_DIR>
COMPOSE_BAK="$(ls -t docker-compose.yml.bak-* | head -1)"
echo "$COMPOSE_BAK"
grep DB_PASSWORD "$COMPOSE_BAK"
```

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
| Seed nie dodał źródeł | źródło już istnieje (`ON CONFLICT (url)`) — poprawne zachowanie |
