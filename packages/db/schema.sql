-- kombain.pl DDL — PostgreSQL 16+ (Dokumentacja §3.1)
-- Świadome rozszerzenia względem spec (zatwierdzone w briefie F1-T1):
--   1. articles.needs_human_check — wymagane przez AGENTS §2.8 (review-faile → draft + needs_human_check)
--   2. chk_articles_category — published/draft muszą mieć kategorię; rejected może być bez kategorii
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabela Kategorii (Sztywny słownik 6 działów)
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed 6 sztywnych kategorii wymaganych przez logikę portalu (nazwy = enum Bramkarza)
INSERT INTO categories (name, slug, description) VALUES
('AI i Automatyzacja', 'ai-i-automatyzacja', 'Algorytmy uczenia maszynowego, Computer Vision i automatyzacja procesów decyzyjnych.'),
('Rolnictwo Precyzyjne', 'rolnictwo-precyzyjne', 'Systemy GIS, teledetekcja satelitarna, mapowanie gleby, VRA oraz IoT.'),
('Inteligentne Maszyny i Drony', 'inteligentne-maszyny-i-drony', 'Mechatronika, nawigacja RTK/GPS, LiDAR, robotyka polowa oraz drony (UAV).'),
('Biotechnologia i Nauka', 'biotechnologia-i-nauka', 'Inżynieria genetyczna, CRISPR-Cas, mikrobiologia gleby i badania naukowe.'),
('Agroenergetyka', 'agroenergetyka', 'OZE w rolnictwie, agrofotowoltaika, biogazownie nowej generacji i mikrosieci.'),
('Biznes AgTech i Prawo', 'biznes-agtech-i-prawo', 'Finansowanie VC, fuzje i przejęcia w AgTech, modele SaaS oraz regulacje prawne (drony, AI).')
ON CONFLICT (slug) DO NOTHING;

-- 2. Tabela Źródeł (zastępuje tabelę z Master workflow.txt)
CREATE TABLE sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    url TEXT NOT NULL UNIQUE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('rss', 'scraper')),
    link_selector VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Tabela Artykułów (zastępuje tabelę z Worker.txt)
CREATE TABLE articles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
    category_id UUID REFERENCES categories(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL CHECK (status IN ('published', 'rejected', 'draft')),
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE,
    source_url TEXT NOT NULL UNIQUE,
    image_url TEXT,
    text_content TEXT,
    tldr JSONB,
    tech_summary JSONB,
    rejection_reason TEXT,
    needs_human_check BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    CONSTRAINT chk_articles_category CHECK (status = 'rejected' OR category_id IS NOT NULL)
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
-- Jednokolumnowy PK jest wymagany przez Directus 10 (inaczej ignoruje kolekcję);
-- para (article_id, tag_id) pozostaje unikalna.
CREATE TABLE article_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE (article_id, tag_id)
);
