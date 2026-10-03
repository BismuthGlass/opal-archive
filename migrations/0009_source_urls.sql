-- Source URLs are addresses, not tags: they get a table of their own, with
-- no namespaces, aliases or suggestions.
CREATE TABLE source_url (
    entity_id INTEGER NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
    url       TEXT NOT NULL CHECK (url <> '' AND url = trim(url)),
    PRIMARY KEY (entity_id, url)
) STRICT, WITHOUT ROWID;

INSERT OR IGNORE INTO source_url (entity_id, url)
SELECT et.entity_id, t.value
FROM entity_tag et JOIN tag t ON t.id = et.tag_id
WHERE t.field = 'source_url';

-- Their rows in entity_tag go with them.
DELETE FROM tag WHERE field = 'source_url';
DELETE FROM tag_alias WHERE field = 'source_url';
