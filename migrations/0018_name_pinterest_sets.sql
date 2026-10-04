-- A set made of a Pinterest pin of several files is now named for the pin,
-- `pinterest#<number>`. Those made before, and still called what a set
-- with no title was called, are named the same way.
UPDATE entity
SET title = 'pinterest#' || (
    SELECT rtrim(substr(s.url, instr(s.url, '/pin/') + 5), '/')
    FROM source_url s
    WHERE s.entity_id = entity.id AND s.url LIKE 'https://www.pinterest.com/pin/%'
    ORDER BY s.url LIMIT 1
)
WHERE title = 'Set'
  AND id IN (SELECT entity_id FROM collection WHERE collection_type = 'set')
  AND id IN (SELECT entity_id FROM source_url WHERE url LIKE 'https://www.pinterest.com/pin/%');
