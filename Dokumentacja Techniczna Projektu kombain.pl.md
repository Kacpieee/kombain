# Dokumentacja Architektoniczna i Specyfikacja Techniczna: kombain.pl

## 1\. Wizja i Cel Projektu

**kombain.pl** to bezobsługowy, zautomatyzowany portal technologiczny typu *hard AgTech* (Sztuczna Inteligencja w rolnictwie, Rolnictwo Precyzyjne, Robotyka Polowa i Drony, Biotechnologia, Agroenergetyka, Biznes AgTech i Prawo).

### Główne założenia:

* **Wolumen publikacji:** 20+ wysokiej jakości artykułów eksperckich miesięcznie (\~1 dziennie).  
* **Migracja z n8n:** Całkowite odejście od wizualnych workflow n8n (`Master workflow.txt`, `Worker.txt`) na rzecz deterministycznych, typowanych skryptów w TypeScript (Node.js / Bun).  
* **Bezobsługowość \+ Łatwa edycja:** Pipeline działa autonomicznie na VPS (wyzwalany przez cron), ale administrator ma pełny wgląd i możliwość ręcznej korekty treści przez panel **Directus CMS**.  
* **Natychmiastowa publikacja bez przebudowy (Zero-Rebuild):** Nowy artykuł zapisany w bazie PostgreSQL jest od razu widoczny na portalu bez konieczności budowania i wdrażania nowej wersji strony na Cloudflare Pages.

---

## 2\. Architektura i Stack Technologiczny

### 2.1. Infrastruktura (VPS \+ Cloudflare)

1. **VPS (Zarządzany przez Caddy Reverse Proxy):**

   * **PostgreSQL 16+:** Główna baza danych przechowująca źródła, artykuły, kategorie i tagi.  
   * **Directus CMS:** Nakładka headless CMS na bazę PostgreSQL, wystawiona przez Caddy (np. `https://cms.kombain.pl`). Służy jako:  
     * Panel administracyjny do ręcznej edycji artykułów i zarządzania źródłami (`sources`).  
     * Bezpieczna warstwa REST API (po HTTPS z tokenem `read-only`) dla frontendu Astro (dzięki temu port `5432` Postgresa pozostaje zamknięty dla świata).  
   * **Worker (Kontener Docker / Bun / Node.js):** Skrypt automatyzacji uruchamiany cyklicznie (np. co 6 godzin), mający bezpośrednie połączenie z PostgreSQL w wewnętrznej sieci Dockerowej.  
2. **Cloudflare:**

   * **Cloudflare Pages \+ Functions (Astro Hybrid / SSR z Edge Cache):**  
     * Statyczne assety (CSS, JS, layout) serwowane z CDN.  
     * Trasy dynamiczne (`/`, `/artykul/[slug]`, `/kategoria/[slug]`) renderowane na żądanie przez Cloudflare Worker (SSR) z odpytaniem Directus API i agresywnym cache'owaniem na Edge (`Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`).  
     * Pierwsze wejście na nowy artykuł generuje HTML w \~50 ms i zapisuje go na serwerach brzegowych Cloudflare. Kolejne wejścia działają jak czysty statyk.  
   * **Cloudflare R2 (Object Storage):** Przechowywanie pobranych i skonwertowanych do formatu `.webp` miniatur artykułów (podpięte pod subdomenę np. `https://media.kombain.pl`).

---

## 3\. Schemat Bazy Danych PostgreSQL (Od zera pod Directusa)

Baza zostanie postawiona od zera. Poniższy schemat eliminuje wszystkie błędy z oryginalnego workflow n8n (dodaje brakującą kolumnę `slug`, `image_url`, `rejection_reason` oraz klucze obce i indeksy).

### 3.1. Definicja DDL (SQL)

```sql
-- Rozszerzenie dla UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabela Kategorii (Sztywny słownik 6 działów)
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed 6 sztywnych kategorii wymaganych przez logikę portalu
INSERT INTO categories (name, slug, description) VALUES
('AI i Automatyzacja', 'ai-i-automatyzacja', 'Algorytmy uczenia maszynowego, Computer Vision i automatyzacja procesów decyzyjnych.'),
('Rolnictwo Precyzyjne', 'rolnictwo-precyzyjne', 'Systemy GIS, teledetekcja satelitarna, mapowanie gleby, VRA oraz IoT.'),
('Inteligentne Maszyny i Drony', 'inteligentne-maszyny-i-drony', 'Mechatronika, nawigacja RTK/GPS, LiDAR, robotyka polowa oraz drony (UAV).'),
('Biotechnologia i Nauka', 'biotechnologia-i-nauka', 'Inżynieria genetyczna, CRISPR-Cas, mikrobiologia gleby i badania naukowe.'),
('Agroenergetyka', 'agroenergetyka', 'OZE w rolnictwie, agrofotowoltaika, biogazownie nowej generacji i mikrosieci.'),
('Biznes AgTech i Prawo', 'biznes-agtech-i-prawo', 'Finansowanie VC, fuzje i przejęcia w AgTech, modele SaaS oraz regulacje prawne (drony, AI).');

-- 2. Tabela Źródeł (Zastępuje tabelę używaną w Master workflow.txt)
CREATE TABLE sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    url TEXT NOT NULL UNIQUE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('rss', 'scraper')),
    link_selector VARCHAR(255), -- Selektor CSS dla trybu 'scraper' (np. 'article a.post-link')
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Tabela Artykułów (Zastępuje tabelę z Worker.txt)
CREATE TABLE articles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
    category_id UUID REFERENCES categories(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL CHECK (status IN ('published', 'rejected', 'draft')),
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE, -- NULL dozwolony dla statusu 'rejected'
    source_url TEXT NOT NULL UNIQUE,
    image_url TEXT,           -- URL do obrazka .webp w Cloudflare R2
    text_content TEXT,        -- Docelowy kod HTML artykułu (dla 'published')
    tldr JSONB,               -- Tablica stringów (3-5 wniosków technicznych)
    tech_summary JSONB,       -- Obiekt: {"podmiot": "...", "technologia": "...", "cel_wdrozenia": "..."}
    rejection_reason TEXT,    -- Powód odrzucenia (dla statusu 'rejected')
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

CREATE INDEX idx_articles_status_created ON articles(status, created_at DESC);
CREATE INDEX idx_articles_slug ON articles(slug);
CREATE INDEX idx_articles_category ON articles(category_id);

-- 4. Tabela Tagów
CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE
);

-- 5. Tabela Łącząca Artykuły i Tagi (Relacja M:N)
CREATE TABLE article_tags (
    article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
);
```

&nbsp;

---

## 4\. Specyfikacja Pipeline'u Automatyzacji (Migracja z n8n)

Nowy Worker w TypeScript zastępuje dwa pliki z n8n: `Master workflow.txt` oraz `Worker.txt`. Poniżej opisano dokładny przebieg wykonywania kodu wraz z poprawkami błędów znalezionych w n8n.

### KROK 1: Orkiestracja i Pobieranie Linków (`ingestion.ts`)

*Oryginał w n8n: `Master workflow.txt`*

1. Pobierz aktywne źródła: `SELECT id, name, url, type, link_selector FROM sources WHERE is_active = true`.  
2. Ustaw globalny licznik dla pojedynczego uruchomienia: `publishedCount = 0`, `MAX_PUBLISHED_PER_RUN = 2` (bezpiecznik kosztowy i anty-spamowy).  
3. Dla każdego źródła:  
   * **Jeśli `type === 'rss'`:**  
     * Pobierz i sparsuj kanał XML za pomocą `rss-parser`.  
     * *Poprawka błędu z n8n:* Jeśli kanał RSS zwróci błąd sieciowy, zaloguj ostrzeżenie i przejdź do kolejnego źródła (w n8n błąd RSS błędnie przekierowywał URL pliku XML do scrapera HTML).  
   * **Jeśli `type === 'scraper'`:**  
     * Pobierz HTML strony zbiorczej przez `ScrapingAnt API`.  
     * Załaduj HTML do `cheerio`.  
     * *Poprawka błędu z n8n:* Użyj kolumny `link_selector` z bazy danych (a jeśli jest pusta, domyślnego selektora `a[href]`). Nie stosuj sztywnego filtra `includes('/articles/')`, chyba że `link_selector` tego wymaga.  
4. **Normalizacja URL:**  
   * Przekształć linki względne (`/news/123`) na bezwzględne (`https://domena.pl/news/123`).  
   * Usuń parametry śledzące (`utm_*`, `fbclid`, `&amp;`).  
   * Obetnij tablicę do maksymalnie 15 najnowszych pozycji na źródło.  
   * Zwróć ujednolicony interfejs: `RawArticleCandidate { sourceId: string, originalTitle: string, sourceUrl: string }`.

---

### KROK 2: Wstępna Deduplikacja URL i Ekstrakcja Treści (`scraper.ts`)

*Oryginał w n8n: Pierwsza część `Worker.txt` (`Check URL Duplicate` \-\> `HTTP Request` \-\> `ScrapingAnt` \-\> `HTML Text Extractor`)*

1. **Deduplikacja po URL w bazie:**  
   * Zapytanie: `SELECT 1 FROM articles WHERE source_url = $1 LIMIT 1`.  
   * Jeśli rekord istnieje (niezależnie czy `published`, czy `rejected`), **pomiń link** (zero zużycia zasobów na ponowne scrapowanie odrzuconych wcześniej artykułów).  
2. **Pobranie HTML artykułu (Smart Fetch):**  
   * Wykonaj standardowy `fetch(sourceUrl)` z nagłówkiem `User-Agent` przeglądarki Chrome i timeoutem `10s`.  
   * Jeśli odpowiedź zwróci status `403`, `429`, `503` lub treść zawiera sygnaturę blokady Cloudflare (`Just a moment...`, `cf-browser-verification`), wykonaj fallback do **ScrapingAnt API**.  
3. **Ekstrakcja czystej treści i zdjęcia:**  
   * *Poprawka błędu z n8n:* Zamiast wycinania tagów regexem (który zostawiał menu boczne, stopki RODO i „Przeczytaj także”), przekaż HTML do `linkedom` oraz `@mozilla/readability`.  
   * Wyciągnij `og:image` (lub pierwszy obraz z artykułu) do późniejszego pobrania.  
   * **Hard Filter długości:** Sprawdź długość czystego wyekstrahowanego tekstu (`textContent.trim().length`).  
   * Jeśli `< 800` znaków: zapisz do bazy rekord ze statusem `rejected` i `rejection_reason = 'Tekst zbyt krótki (<800 znaków)'` i zakończ przetwarzanie tego linku.

---

### KROK 3: Bramkarz LLM – Weryfikacja i Kategoryzacja (`gatekeeper.ts`)

*Oryginał w n8n: `Fetch Historical Context` \-\> `Bramkarz LLM` \-\> `Switch1`*

1. **Pobranie kontekstu historycznego (Baza Wiedzy do deduplikacji semantycznej):**  
   * Zapytanie:

```sql
SELECT title, tech_summary 
FROM articles 
WHERE status = 'published' AND created_at > NOW() - INTERVAL '30 days';
```

     *(Zwiększono okno z 14 do 30 dni – przy \~20 artykułach miesięcznie to zaledwie \~20 małych obiektów JSON, co daje znacznie lepszą ochronę przed tzw. news echo).*

2. **Wywołanie modelu `gemini-3.1-flash-lite` (lub `gemini-2.5-flash`):**  
   * Użyj oficjalnego SDK `@google/genai` z wymuszonym `responseSchema` (Zod):

```ts
const GatekeeperSchema = z.object({
  is_duplicate: z.boolean(),
  is_relevant: z.boolean(),
  reason: z.string(),
  category: z.enum([
    'AI i Automatyzacja',
    'Rolnictwo Precyzyjne',
    'Inteligentne Maszyny i Drony',
    'Biotechnologia i Nauka',
    'Agroenergetyka',
    'Biznes AgTech i Prawo'
  ])
});
```

3. **Reguły decyzyjne Bramkarza (Prompt):**  
   * **Deduplikacja (`is_duplicate`):** `true`, jeśli podmiot i technologia w nowym artykule pokrywają się z jakimkolwiek wpisem z Bazy Wiedzy.  
   * **Adekwatność (`is_relevant`):**  
     * Odrzuć (`false`), jeśli tekst dotyczy: raportów rynkowych, cen płodów rolnych, giełdy, strajków, standardowych dopłat lub zwykłych maszyn rolniczych bez komponentu „Smart” (np. nowy pług, heder, zwykły traktor).  
     * Zaakceptuj (`true`) wyłącznie twardy AgTech: AI, IoT, autonomia, drony, robotyka, biotechnologia, agroenergetyka, oprogramowanie dla rolnictwa, finansowanie VC/M\&A w AgTech lub prawo nowych technologii.  
4. **Ewaluacja wyniku:**  
   * Jeśli `is_duplicate === true` LUB `is_relevant === false`:  
     * Zapisz artykuł w tabeli `articles` ze statusem `rejected` oraz polem `rejection_reason = result.reason`.  
     * Przejdź do kolejnego linku.

---

### KROK 4: Redaktor LLM – Generowanie Artykułu Eksperckiego (`editor.ts`)

*Oryginał w n8n: 6 osobnych węzłów kategorii \+ `Parse Synthesis JSON`*

*Poprawki błędów z n8n:*

* W n8n w każdym z 6 węzłów były zepsute zmienne wejściowe: `Tytuł: $('Fetch Historical Context')...` oraz `URL źródła: $('HTML Text Extractor').item.json.article_text`. W kodzie przekazujemy faktyczny `originalTitle`, `cleanText` i `sourceUrl`.  
* W n8n w 2 kategoriach został placeholder `[WPISZ DOKŁADNĄ NAZWĘ KATEGORII]`, a w 2 kolejnych zepsuty opis kompetencji. Poniżej znajduje się **oczyszczona mapa person i kompetencji**.  
* Zamiast 6 osobnych węzłów używamy **jednego szablonu promptu**, do którego wstrzykujemy profil wybranej kategorii.  
* Link `Źródło:` nie jest już generowany przez LLM (ryzyko halucynacji URL), lecz doklejany deterministycznie w kodzie lub komponencie Astro na podstawie `source_url`.

#### 4.1. Mapa Person Redaktorów (Słownik `CATEGORY_PERSONAS`)

| Kategoria | Rola i Kompetencje Eksperckie (`persona_expertise`) | Tło technologiczne w rozwinięciu (`tech_context`) |
| :---- | :---- | :---- |
| **AI i Automatyzacja** | Ekspert od algorytmów uczenia maszynowego (Machine Learning), głębokich sieci neuronowych, widzenia komputerowego (Computer Vision) oraz zaawansowanej automatyzacji procesów decyzyjnych w rolnictwie. | Architektura sztucznej inteligencji, analiza predykcyjna i automatyzacja systemowa. |
| **Rolnictwo Precyzyjne** | Ekspert od systemów informacji geograficznej (GIS), teledetekcji satelitarnej, mapowania zmienności glebowej, technologii zmiennego dawkowania (VRA) oraz analityki danych z czujników IoT. | Agronomia cyfrowa, analiza danych przestrzennych (Big Data) i telemetria IoT. |
| **Inteligentne Maszyny i Drony** | Ekspert od mechatroniki rolniczej, systemów nawigacji satelitarnej RTK/GNSS, sensoryki LiDAR, robotyki polowej (Field Robotics) oraz bezzałogowych statków powietrznych (UAV). | Mechatronika, systemy nawigacji RTK/GPS, sensoryka LiDAR, robotyka polowa oraz drony w zaawansowanych zastosowaniach rolniczych. |
| **Biotechnologia i Nauka** | Ekspert od inżynierii genetycznej, biologii molekularnej, metod edycji genomu (CRISPR-Cas), mikrobiologii gleby oraz zaawansowanych technik hodowli komórkowych in-vitro. | Najnowsze badania naukowe, genetyka syntetyczna i procesy biochemiczne w produkcji rolnej. |
| **Agroenergetyka** | Ekspert od rozproszonych źródeł energii (OZE), inżynierii agrofotowoltaicznej (Agri-PV), technologii biogazowych i biometanowych nowej generacji, magazynów energii oraz optymalizacji mikrosieci (Microgrids). | Inżynieria energetyczna, technologie wodorowe, biogazowe i efektywność OZE w gospodarstwie. |
| **Biznes AgTech i Prawo** | Ekspert od modelowania finansowego SaaS/AgTech, fuzji i przejęć (M\&A) w sektorze technologicznym, analizy trendów Venture Capital oraz regulacji prawnych (compliance) dla autonomii, dronów i AI. | Strategie rynkowe, skalowanie biznesu technologicznego oraz analiza ram prawnych dla nowych technologii. |

&nbsp;

#### 4.2. Szablon Promptu Redaktora (`models/gemini-3-flash-preview`)

```
Działasz jako Redaktor Działu "{category}" na portalu AgTech kombain.pl. Jesteś ekspertem od: {persona_expertise}

Twoim zadaniem jest napisanie pełnowymiarowego, autorskiego i wysokiej jakości artykułu eksperckiego w języku polskim, bazującego na poniższych materiałach źródłowych. Kategorycznie zabraniam streszczania tekstu i tłumaczenia go słowo w słowo. Masz stworzyć niezależną, wyczerpującą publikację opartą na faktach ze źródła, dostosowaną do świadomego technologicznie rolnika i przedsiębiorcy.

DANE ŹRÓDŁOWE:
Tytuł oryginału: {original_title}
Treść źródłowa: {article_text}

WYTYCZNE TREŚCIOWE I SEO (Dla klucza 'content_html'):
1. Wstęp z hookiem: 3–5 zdań otwierających, zawierających mocny haczyk (statystyka, problem biznesowy, zaskoczenie). Od razu pokaż wartość wdrożeniową.
2. Struktura HTML: Używaj wyłącznie tagów <p>, <h2>, <h3>, <strong>, <ul>, <li>. Samodzielnie stwórz logiczną architekturę nagłówków.
3. Rozwinięcie: Pełny, merytoryczny artykuł. Każdy nagłówek H2/H3 zaczyna się angażującym zdaniem. Uzupełniaj treść o tło technologiczne z zakresu: {tech_context}, analizując surowe fakty z tekstu.
4. Styl: Ekspercki, technologiczny, analityczny. Brak języka sprzedażowego i lania wody.
5. Zakończenie: Mocne zamknięcie. Podaj konkretne wnioski dotyczące wdrożenia tej technologii lub jej wpływu na rynek.

WYTYCZNE DLA METADANYCH:
1. Klucz 'title': Max 60 znaków, chwytliwy tytuł po polsku zoptymalizowany pod SEO.
2. Klucz 'slug': Przyjazny dla URL, małe litery, myślniki, bez polskich znaków.
3. Klucz 'tldr': Dokładnie 3-5 krótkich, konkretnych wniosków technicznych w formie tablicy stringów.
4. Klucz 'tags': Tablica max 4 dynamicznych tagów związanych z tekstem (np. ["machine learning", "drony"]), pisane małymi literami.
5. Klucz 'tech_summary': Obiekt JSON zawierający klucze: "podmiot" (główna firma/twórca), "technologia" (rodzaj rozwiązania) oraz "cel_wdrozenia" (mierzalny wynik).
```

&nbsp;

---

### KROK 5: Przetwarzanie Mediów, Sanityzacja i Zapis Transakcyjny (`db/queries.ts`)

*Oryginał w n8n: `Get Category ID` \-\> `Insert Article` \-\> `Hurtowe Mapowanie Tagów` \-\> `Execute Tag Sync` \-\> `Link Article Tags`*

1. **Sanityzacja HTML:** Przepuść wygenerowany `content_html` przez `sanitize-html` (dozwolone tagi: `p, h2, h3, strong, em, ul, ol, li`).  
2. **Przetworzenie obrazka (`media.ts`):**  
   * Jeśli w Kroku 2 znaleziono `og:image`, pobierz obraz, przeskaluj przez bibliotekę `sharp` do `1200x675` (format `webp`, jakość `80`) i wyślij przez S3 SDK na **Cloudflare R2** pod ścieżką `articles/{slug}.webp`.  
   * Jeśli pobranie obrazka się nie powiedzie, przypisz domyślną grafikę danej kategorii.  
3. **Unikalność Sluga:** Wygeneruj czysty slug w kodzie (funkcja `slugify(title)`). Jeśli w bazie istnieje już taki `slug`, doklej krótki 4-znakowy losowy sufiks.  
4. **Atomowa transakcja SQL (`BEGIN ... COMMIT`):**  
   * Pobierz `category_id` dla kategorii zwróconej przez Bramkarza.  
   * Wykonaj `INSERT INTO articles (...) VALUES (...) RETURNING id`.  
   * Dla każdego tagu z tablicy `tags` wykonaj parametryzowany Upsert:

```sql
INSERT INTO tags (name, slug) VALUES ($1, $2)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
RETURNING id;
```

   * Powiąż tagi z artykułem:

```sql
INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;
```

5. Zwiększ licznik `publishedCount++`. Jeśli osiągnięto `MAX_PUBLISHED_PER_RUN`, zakończ pracę skryptu.

---

## 5\. Struktura Projektu (Monorepo)

```
kombain.pl/
├── PROJECT_SPEC.md                  # Niniejsza dokumentacja projektu
├── package.json                     # Konfiguracja workspace (pnpm / bun)
├── .env.example                     # Szablon zmiennych środowiskowych
│
├── packages/
│   └── db/                          # Współdzielony pakiet bazy danych (PostgreSQL)
│       ├── package.json
│       ├── schema.sql               # Plik inicjalizacyjny DDL dla bazy na VPS
│       ├── index.ts                 # Klient pg (Pool) + eksport typów i zapytań
│       └── queries.ts               # Transakcje: savePublishedArticle, saveRejectedArticle, getActiveSources
│
├── apps/
│   ├── worker/                      # Skrypt automatyzacji (uruchamiany na VPS)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts             # Punkt wejścia (uruchomienie jednorazowe CLI lub cron)
│   │       ├── config.ts            # Walidacja ENV (Zod)
│   │       ├── orchestrator.ts      # Pętla po źródłach (dawny Master Workflow)
│   │       ├── pipeline.ts          # Przetwarzanie pojedynczego linku (dawny Worker)
│   │       ├── prompts.ts           # Prompty Bramkarza i słownik 6 Person Redaktorów
│   │       └── services/
│   │           ├── ingestion.ts     # RSS Parser + Cheerio Scraper dla stron zbiorczych
│   │           ├── scraper.ts       # Fetch + ScrapingAnt Fallback + Readability
│   │           ├── llm.ts           # Integracja z @google/genai (Structured Outputs)
│   │           └── media.ts         # Sharp (konwersja do WebP) + Upload do Cloudflare R2
│   │
│   └── web/                         # Frontend Astro (wdrażany na Cloudflare Pages)
│       ├── astro.config.mjs         # Adapter: @astrojs/cloudflare (output: 'server')
│       ├── package.json
│       └── src/
│           ├── lib/
│           │   └── directus.ts      # Klient pobierający artykuły z Directus REST API + Cache Headers
│           ├── layouts/
│           │   └── MainLayout.astro
│           ├── components/
│           │   ├── ArticleCard.astro
│           │   ├── TechSummaryBox.astro  # Komponent renderujący JSONB 'tech_summary'
│           │   └── TldrBox.astro         # Komponent renderujący JSONB 'tldr'
│           └── pages/
│               ├── index.astro
│               ├── kategoria/[slug].astro
│               └── artykul/[slug].astro
```

&nbsp;

---

## 6\. Plan Realizacji Krok po Kroku (Roadmap)

### Faza 1: Baza Danych i Directus na VPS

1. Wykonanie skryptu `schema.sql` na czystej bazie PostgreSQL na VPS.  
2. Odświeżenie schematu w panelu **Directus** (Directus automatycznie wykryje tabele `articles`, `sources`, `categories`, `tags`, `article_tags`).  
3. Skonfigurowanie w Directusie relacji wizualnych oraz wygenerowanie statycznego tokenu API (`DIRECTUS_PUBLIC_READ_TOKEN`) dla roli z uprawnieniami `SELECT` do tabeli `articles` (tylko ze statusem `published`), `categories` i `tags`.  
4. Dodanie w Directusie 2–3 testowych źródeł w tabeli `sources`.

### Faza 2: Budowa i Testy Workera (`apps/worker`)

1. Implementacja warstwy bazodanowej (`packages/db`).  
2. Implementacja modułu `ingestion.ts` oraz `scraper.ts` z Readability i ScrapingAnt.  
3. Implementacja modułu `llm.ts` (Bramkarz \+ Redaktor) z walidacją Zod.  
4. Przeprowadzenie testowego uruchomienia na VPS na żywych źródłach i weryfikacja wygenerowanych artykułów bezpośrednio w GUI Directusa.

### Faza 3: Budowa Frontendu Astro i Wdrożenie na Cloudflare Pages (`apps/web`)

1. Inicjalizacja projektu Astro z adapterem `@astrojs/cloudflare`.  
2. Podpięcie pod endpoint Directusa (`https://cms.kombain.pl/items/articles`) i ostylowanie widoków (strona główna, strona kategorii, widok artykułu z ramkami `TL;DR`, `Tech Summary` oraz linkiem do źródła na dole).  
3. Konfiguracja nagłówków `Cache-Control` na trasach SSR oraz opcjonalnego webhooka w Directusie czyszczącego cache Cloudflare przy ręcznej edycji artykułu.