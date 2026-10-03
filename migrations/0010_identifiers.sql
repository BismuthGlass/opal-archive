-- Identifiers (a website's ID for the file, and the like) are not tags
-- either: a plain list per entity, with no namespaces, aliases or
-- suggestions.
CREATE TABLE identifier (
    entity_id INTEGER NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
    value     TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (entity_id, value)
) STRICT, WITHOUT ROWID;

INSERT OR IGNORE INTO identifier (entity_id, value)
SELECT et.entity_id, t.value
FROM entity_tag et JOIN tag t ON t.id = et.tag_id
WHERE t.field = 'identifier';

DELETE FROM tag WHERE field = 'identifier';
DELETE FROM tag_alias WHERE field = 'identifier';
