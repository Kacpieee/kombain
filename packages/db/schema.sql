-- kombain.pl DDL (Dokumentacja §3.1) — PostgreSQL 16+
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO categories (name, slug, description) VALUES
('AI i Automatyzacja', 'ai-i-automatyzacja', 'ML, Computer Vision, automatyzacja decyzji.'),
('Rolnictwo Precyzyjne', 'rolnictwo-precyzyjne', 'GIS, teledetekcja, VRA, IoT.'),
('Inteligentne Maszyny i Drony', 'inteligentne-maszyny-i-drony', 'Mechatronika, RTK/GNSS, LiDAR, robotyka polowa, UAV.'),
('Biotechnologia i Nauka', 'biotechnologia-i-nauka', 'Inżynieria genetyczna, CRISPR-Cas, mikrobiologia gleby.'),
('Agroenergetyka', 'agroenergetyka', 'Agri-PV, biogazownie, mikrosieci.'),
('Biznes AgTech i Prawo', 'biznes-agtech-i-prawo', 'VC, M&A, SaaS, regulacje dronów/AI.');

CREATE TABLE sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    url TEXT NOT NULL UNIQUE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('rss', 'scraper')),
    link_selector TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_checked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
    published_at TIMESTAMPTZ
);

CREATE INDEX idx_articles_status_created ON articles(status, created_at DESC);
CREATE INDEX idx_articles_slug ON articles(slug);
CREATE INDEX idx_articles_category ON articles(category_id);

CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE article_tags (
    article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
);
