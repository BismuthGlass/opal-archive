-- Search tabs are called gallery tabs. The kind's CHECK cannot be altered,
-- so the table is rebuilt. Dropping it would take the upload lists along
-- (they cascade), so they are set aside and put back.
CREATE TABLE tab_new (
    id       INTEGER PRIMARY KEY,
    position INTEGER NOT NULL,
    query    TEXT NOT NULL DEFAULT '',
    kind     TEXT NOT NULL DEFAULT 'gallery' CHECK (kind IN ('gallery', 'upload')),
    name     TEXT NOT NULL DEFAULT ''
) STRICT;

INSERT INTO tab_new (id, position, query, kind, name)
SELECT id, position, query, CASE kind WHEN 'search' THEN 'gallery' ELSE kind END, name
FROM tab;

CREATE TEMP TABLE tab_upload_kept AS SELECT tab_id, entity_id FROM tab_upload;

DROP TABLE tab;
ALTER TABLE tab_new RENAME TO tab;

INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
SELECT tab_id, entity_id FROM tab_upload_kept;

DROP TABLE tab_upload_kept;
