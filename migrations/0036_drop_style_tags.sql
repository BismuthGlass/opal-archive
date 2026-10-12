-- The `style` tag type is gone: how a work is drawn is said by its medium.
-- Its tags go with it, and what was kept of them by value: their aliases
-- and their child tags. The field's CHECK cannot be altered, so the table
-- is rebuilt, as it was for `bucket`: dropping it would take every
-- entity's tags along (they cascade), so they are set aside and put back.
DELETE FROM tag WHERE field = 'style';
DELETE FROM tag_alias WHERE field = 'style';
DELETE FROM tag_child WHERE field = 'style' OR child_field = 'style';

CREATE TABLE tag_new (
    id          INTEGER PRIMARY KEY,
    field       TEXT NOT NULL CHECK (field IN (
        'creator', 'medium', 'genre', 'flaws', 'person', 'source_work',
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
