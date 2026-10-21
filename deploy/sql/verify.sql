-- Weryfikacja F1-T2: liczby wierszy + constrainty na articles.
-- Zakłada komplet 5 tabel — pilnuje tego guard w deploy/scripts/init-db.sh.
SELECT 'categories' AS tabela, count(*) AS wiersze FROM categories
UNION ALL SELECT 'sources', count(*) FROM sources
UNION ALL SELECT 'articles', count(*) FROM articles
UNION ALL SELECT 'tags', count(*) FROM tags
UNION ALL SELECT 'article_tags', count(*) FROM article_tags
ORDER BY 1;

-- to_regclass: brak tabeli nie wywala całego pliku
SELECT conname AS constraint_name
FROM pg_constraint
WHERE conrelid = to_regclass('public.articles') AND contype = 'c'
ORDER BY 1;
