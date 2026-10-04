-- A collection can have an identifier of its own, apart from its title: no
-- two collections share one, so it says for certain which collection is
-- meant. A downloader names the collections it makes by it, and finds
-- them again by it however they have been retitled since.
ALTER TABLE collection ADD COLUMN collection_id TEXT
    CHECK (collection_id <> '' AND collection_id = trim(collection_id));

CREATE UNIQUE INDEX collection_collection_id ON collection (collection_id)
    WHERE collection_id IS NOT NULL;

-- The collections downloaded before get theirs from the source URL they
-- were found by until now: the first collection of each pin or thread.
UPDATE collection
SET collection_id = (
    SELECT 'pinterest#' || rtrim(substr(s.url, instr(s.url, '/pin/') + 5), '/')
    FROM source_url s
    WHERE s.entity_id = collection.entity_id AND s.url LIKE 'https://www.pinterest.com/pin/%'
    ORDER BY s.url LIMIT 1
)
WHERE collection_type = 'set'
  AND entity_id IN (
    SELECT min(c.entity_id) FROM collection c
    JOIN source_url s ON s.entity_id = c.entity_id
    WHERE c.collection_type = 'set' AND s.url LIKE 'https://www.pinterest.com/pin/%'
    GROUP BY s.url
  );

UPDATE collection
SET collection_id = (
    SELECT '4chan#' || substr(s.url, instr(s.url, '/thread/') + 8)
    FROM source_url s
    WHERE s.entity_id = collection.entity_id
      AND s.url LIKE 'https://boards.4chan.org/%/thread/%' AND s.url NOT LIKE '%#%'
    ORDER BY s.url LIMIT 1
)
WHERE collection_type = 'sourceset'
  AND entity_id IN (
    SELECT min(c.entity_id) FROM collection c
    JOIN source_url s ON s.entity_id = c.entity_id
    WHERE c.collection_type = 'sourceset'
      AND s.url LIKE 'https://boards.4chan.org/%/thread/%' AND s.url NOT LIKE '%#%'
    GROUP BY substr(s.url, instr(s.url, '/thread/') + 8)
  );
