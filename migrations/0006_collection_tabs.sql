-- Whether a collection keeps its members in a chosen order. Until now that
-- was implied by the `sequence` type.
ALTER TABLE collection ADD COLUMN ordered INTEGER NOT NULL DEFAULT 0 CHECK (ordered IN (0, 1));

UPDATE collection SET ordered = 1 WHERE collection_type = 'sequence';

-- A third kind of tab shows the members of one collection, and goes when
-- the collection does. As before, the kind's CHECK means rebuilding the
-- table, with the upload lists set aside while it is dropped.
CREATE TABLE tab_new (
    id            INTEGER PRIMARY KEY,
    position      INTEGER NOT NULL,
    query         TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'gallery'
                  CHECK (kind IN ('gallery', 'upload', 'collection')),
    name          TEXT NOT NULL DEFAULT '',
    collection_id INTEGER REFERENCES entity (id) ON DELETE CASCADE,
    CHECK ((kind = 'collection') = (collection_id IS NOT NULL))
) STRICT;

INSERT INTO tab_new (id, position, query, kind, name)
SELECT id, position, query, kind, name FROM tab;

CREATE TEMP TABLE tab_upload_kept AS SELECT tab_id, entity_id FROM tab_upload;

DROP TABLE tab;
ALTER TABLE tab_new RENAME TO tab;

INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
SELECT tab_id, entity_id FROM tab_upload_kept;

DROP TABLE tab_upload_kept;

CREATE INDEX tab_collection ON tab (collection_id);
