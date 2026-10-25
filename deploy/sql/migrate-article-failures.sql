-- Migracja dla baz utworzonych przed F2-T7b (bezpieczna do wielokrotnego uruchomienia).
CREATE TABLE IF NOT EXISTS article_failures (
    source_url TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 1,
    last_stage VARCHAR(50),
    last_error TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_failures_last_seen ON article_failures(last_seen_at DESC);

-- Worker łączy się jako kombain_user; jeśli migrację uruchomiono inną rolą, oddaj własność.
ALTER TABLE IF EXISTS article_failures OWNER TO kombain_user;
