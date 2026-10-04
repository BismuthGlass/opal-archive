-- A new tag type, `bucket`: the broad pile a file is kept in, for telling
-- apart things that have little to do with each other. The field's CHECK
-- cannot be altered, so the table is rebuilt. Dropping it would take every
-- entity's tags along (they cascade), so they are set aside and put back.
CREATE TABLE tag_new (
    id          INTEGER PRIMARY KEY,
    field       TEXT NOT NULL CHECK (field IN (
        'creator', 'medium', 'genre', 'style', 'flaws', 'person', 'source_work',
        'character', 'language', 'tags', 'usage_tags', 'ai_usage_tags', 'source',
        'bucket'
    )),
    value       TEXT NOT NULL COLLATE NOCASE CHECK (value <> '' AND value = trim(value)),
    description TEXT,
    pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    UNIQUE (field, value)
) STRICT;

INSERT INTO tag_new (id, field, value, description, pinned)
SELECT id, field, value, description, pinned FROM tag;

CREATE TEMP TABLE entity_tag_kept AS SELECT entity_id, tag_id FROM entity_tag;

DROP TABLE tag;
ALTER TABLE tag_new RENAME TO tag;

INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
SELECT entity_id, tag_id FROM entity_tag_kept;

DROP TABLE entity_tag_kept;
