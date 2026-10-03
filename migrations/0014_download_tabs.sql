-- A fourth kind of tab downloads files from a website through one of the
-- downloaders, and holds what it downloaded the way an upload tab holds
-- its uploads (in `tab_upload`). As before, the kind's CHECK means
-- rebuilding the table, with what hangs off a tab set aside while it is
-- dropped.
CREATE TABLE tab_new (
    id            INTEGER PRIMARY KEY,
    position      INTEGER NOT NULL,
    query         TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'gallery'
                  CHECK (kind IN ('gallery', 'upload', 'collection', 'download')),
    name          TEXT NOT NULL DEFAULT '',
    collection_id INTEGER REFERENCES entity (id) ON DELETE CASCADE,
    -- The downloader a download tab uses: the name of its folder.
    downloader    TEXT,
    CHECK ((kind = 'collection') = (collection_id IS NOT NULL)),
    CHECK ((kind = 'download') = (downloader IS NOT NULL))
) STRICT;

INSERT INTO tab_new (id, position, query, kind, name, collection_id)
SELECT id, position, query, kind, name, collection_id FROM tab;

CREATE TEMP TABLE tab_upload_kept AS SELECT tab_id, entity_id FROM tab_upload;
CREATE TEMP TABLE tab_view_kept AS SELECT tab_id, query, ids, custom FROM tab_view;

DROP TABLE tab;
ALTER TABLE tab_new RENAME TO tab;

INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
SELECT tab_id, entity_id FROM tab_upload_kept;
INSERT OR IGNORE INTO tab_view (tab_id, query, ids, custom)
SELECT tab_id, query, ids, custom FROM tab_view_kept;

DROP TABLE tab_upload_kept;
DROP TABLE tab_view_kept;

CREATE INDEX tab_collection ON tab (collection_id);

-- What a download tab is set to: the downloader's options, and the tags
-- given to everything it downloads (tag field to values).
CREATE TABLE tab_download (
    tab_id  INTEGER PRIMARY KEY REFERENCES tab (id) ON DELETE CASCADE,
    options TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options)),
    tags    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tags))
) STRICT;

-- What a download tab has already downloaded, by the key its downloader
-- gives each thing (for Pinterest, the pin's URL). These are skipped when
-- met again. The list belongs to the tab: another tab starts afresh.
CREATE TABLE tab_download_seen (
    tab_id    INTEGER NOT NULL REFERENCES tab (id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    date_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (tab_id, key)
) STRICT, WITHOUT ROWID;
