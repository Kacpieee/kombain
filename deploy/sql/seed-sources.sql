-- Seed 3 źródeł RSS (działające kanały, sprawdzone 2026-10-21: HTTP 200 + itemy).
-- Idempotentny: ON CONFLICT DO NOTHING nie nadpisuje ręcznych zmian (np. is_active=false).
INSERT INTO sources (name, url, type, link_selector, is_active) VALUES
  ('AgFunderNews', 'https://agfundernews.com/feed', 'rss', NULL, true),
  ('Future Farming', 'https://www.futurefarming.com/feed/', 'rss', NULL, true),
  ('PrecisionAg', 'https://www.precisionag.com/feed/', 'rss', NULL, true)
ON CONFLICT (url) DO NOTHING;
