-- A set is the ID its files give, as a collection is the name: files that
-- give the same one are a set, in the order they say, and nothing else
-- has to exist for it. What is known of the set itself is kept by that
-- ID once something is, and not before.
CREATE TABLE set_info (
    set_id      TEXT PRIMARY KEY CHECK (set_id <> '' AND set_id = trim(set_id)),
    title       TEXT,
    description TEXT
) STRICT, WITHOUT ROWID;

INSERT INTO set_info (set_id, title, description)
SELECT s.set_id, s.title, s.description
FROM file_set s
WHERE s.title IS NOT NULL OR s.description IS NOT NULL
   OR s.id IN (SELECT set_key FROM set_source_url)
   OR s.id IN (SELECT set_key FROM set_identifier)
   OR s.id IN (SELECT set_key FROM set_reference)
   OR s.id IN (SELECT set_key FROM set_collection);

-- Its lists go by the ID too, and follow it when it is changed.
CREATE TABLE set_source_url_new (
    set_id TEXT NOT NULL REFERENCES set_info (set_id) ON DELETE CASCADE ON UPDATE CASCADE,
    url    TEXT NOT NULL CHECK (url <> '' AND url = trim(url)),
    PRIMARY KEY (set_id, url)
) STRICT, WITHOUT ROWID;
INSERT INTO set_source_url_new (set_id, url)
SELECT s.set_id, l.url FROM set_source_url l JOIN file_set s ON s.id = l.set_key;
DROP TABLE set_source_url;
ALTER TABLE set_source_url_new RENAME TO set_source_url;

CREATE TABLE set_identifier_new (
    set_id TEXT NOT NULL REFERENCES set_info (set_id) ON DELETE CASCADE ON UPDATE CASCADE,
    value  TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (set_id, value)
) STRICT, WITHOUT ROWID;
INSERT INTO set_identifier_new (set_id, value)
SELECT s.set_id, l.value FROM set_identifier l JOIN file_set s ON s.id = l.set_key;
DROP TABLE set_identifier;
ALTER TABLE set_identifier_new RENAME TO set_identifier;

CREATE TABLE set_reference_new (
    set_id TEXT NOT NULL REFERENCES set_info (set_id) ON DELETE CASCADE ON UPDATE CASCADE,
    value  TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (set_id, value)
) STRICT, WITHOUT ROWID;
INSERT INTO set_reference_new (set_id, value)
SELECT s.set_id, l.value FROM set_reference l JOIN file_set s ON s.id = l.set_key;
DROP TABLE set_reference;
ALTER TABLE set_reference_new RENAME TO set_reference;

CREATE TABLE set_collection_new (
    set_id TEXT NOT NULL REFERENCES set_info (set_id) ON DELETE CASCADE ON UPDATE CASCADE,
    value  TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (set_id, value)
) STRICT, WITHOUT ROWID;
INSERT INTO set_collection_new (set_id, value)
SELECT s.set_id, l.value FROM set_collection l JOIN file_set s ON s.id = l.set_key;
DROP TABLE set_collection;
ALTER TABLE set_collection_new RENAME TO set_collection;

-- Which sets a file gives, and where in each it comes.
CREATE TABLE set_file_new (
    set_id    TEXT NOT NULL CHECK (set_id <> '' AND set_id = trim(set_id)),
    file_id   INTEGER NOT NULL REFERENCES file (entity_id) ON DELETE CASCADE,
    -- Those without follow, in the order of their IDs.
    set_index INTEGER,
    PRIMARY KEY (set_id, file_id)
) STRICT, WITHOUT ROWID;
INSERT INTO set_file_new (set_id, file_id, set_index)
SELECT s.set_id, f.file_id, f.set_index FROM set_file f JOIN file_set s ON s.id = f.set_key;
DROP TABLE set_file;
ALTER TABLE set_file_new RENAME TO set_file;
CREATE INDEX set_file_file ON set_file (file_id);

-- A set's tab is of the set by its ID. As before, the tab table is
-- rebuilt, with what hangs off a tab set aside while it is dropped.
CREATE TABLE tab_new (
    id         INTEGER PRIMARY KEY,
    position   INTEGER NOT NULL,
    query      TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'gallery'
               CHECK (kind IN ('gallery', 'upload', 'set', 'download')),
    name       TEXT NOT NULL DEFAULT '',
    -- The set a set tab shows.
    set_id     TEXT,
    -- The downloader a download tab uses: the name of its folder.
    downloader TEXT,
    hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    picked     INTEGER NOT NULL DEFAULT 0 CHECK (picked IN (0, 1)),
    CHECK ((kind = 'set') = (set_id IS NOT NULL)),
    CHECK ((kind = 'download') = (downloader IS NOT NULL))
) STRICT;

INSERT INTO tab_new (id, position, query, kind, name, set_id, downloader, hidden, picked)
SELECT t.id, t.position, t.query, t.kind, t.name, s.set_id, t.downloader, t.hidden, t.picked
FROM tab t LEFT JOIN file_set s ON s.id = t.set_key;

CREATE TEMP TABLE tab_upload_kept AS SELECT tab_id, entity_id FROM tab_upload;
CREATE TEMP TABLE tab_view_kept AS SELECT tab_id, query, ids, custom FROM tab_view;
CREATE TEMP TABLE tab_seen_kept AS SELECT tab_id, key, date_seen FROM tab_download_seen;
CREATE TEMP TABLE tab_tags_kept AS SELECT tab_id, tags FROM tab_tags;

DROP TABLE tab;
ALTER TABLE tab_new RENAME TO tab;

INSERT OR IGNORE INTO tab_upload (tab_id, entity_id) SELECT tab_id, entity_id FROM tab_upload_kept;
INSERT OR IGNORE INTO tab_view (tab_id, query, ids, custom)
SELECT tab_id, query, ids, custom FROM tab_view_kept;
INSERT OR IGNORE INTO tab_download_seen (tab_id, key, date_seen)
SELECT tab_id, key, date_seen FROM tab_seen_kept;
INSERT OR IGNORE INTO tab_tags (tab_id, tags) SELECT tab_id, tags FROM tab_tags_kept;

DROP TABLE tab_upload_kept;
DROP TABLE tab_view_kept;
DROP TABLE tab_seen_kept;
DROP TABLE tab_tags_kept;

CREATE INDEX tab_set ON tab (set_id);

DROP TABLE file_set;
