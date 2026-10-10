-- Collections go. A file is in at most one set, and says so itself: which
-- set, where in it, and which group of variants it is one of. A set is not
-- an entity: it has no tags and is not searched for. It keeps a title, a
-- description, and the lists that say where it came from.
CREATE TABLE file_set (
    id          INTEGER PRIMARY KEY,
    -- What tells it from every other set, here and in another library:
    -- what a sidecar or a downloader calls it.
    set_id      TEXT NOT NULL UNIQUE CHECK (set_id <> '' AND set_id = trim(set_id)),
    title       TEXT,
    description TEXT
) STRICT;

CREATE TABLE set_source_url (
    set_key INTEGER NOT NULL REFERENCES file_set (id) ON DELETE CASCADE,
    url     TEXT NOT NULL CHECK (url <> '' AND url = trim(url)),
    PRIMARY KEY (set_key, url)
) STRICT, WITHOUT ROWID;

CREATE TABLE set_identifier (
    set_key INTEGER NOT NULL REFERENCES file_set (id) ON DELETE CASCADE,
    value   TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (set_key, value)
) STRICT, WITHOUT ROWID;

CREATE TABLE set_reference (
    set_key INTEGER NOT NULL REFERENCES file_set (id) ON DELETE CASCADE,
    value   TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (set_key, value)
) STRICT, WITHOUT ROWID;

ALTER TABLE file ADD COLUMN set_key INTEGER REFERENCES file_set (id) ON DELETE SET NULL;
-- Where in its set it comes; those without follow, in the order of their IDs.
ALTER TABLE file ADD COLUMN set_index INTEGER;
-- Files with the same one are variants of each other.
ALTER TABLE file ADD COLUMN alt_group_id TEXT
    CHECK (alt_group_id <> '' AND alt_group_id = trim(alt_group_id));

CREATE INDEX file_set_key ON file (set_key) WHERE set_key IS NOT NULL;
CREATE INDEX file_alt_group ON file (alt_group_id) WHERE alt_group_id IS NOT NULL;

-- What there was is carried over as far as it fits. Collections in the
-- trash are left behind.
--
-- A file's set is the collection it was directly in: a set before a
-- sequence before a source set, and of two alike the older.
CREATE TEMP TABLE chosen AS
SELECT member_id AS file, collection_id AS collection, position
FROM (
    SELECT m.member_id, m.collection_id, m.position,
           row_number() OVER (
               PARTITION BY m.member_id
               ORDER BY CASE c.collection_type WHEN 'set' THEN 0 WHEN 'sequence' THEN 1 ELSE 2 END,
                        m.collection_id
           ) AS n
    FROM membership m
    JOIN file f ON f.entity_id = m.member_id
    JOIN collection c ON c.entity_id = m.collection_id
    JOIN entity e ON e.id = c.entity_id
    WHERE c.collection_type IN ('set', 'sequence', 'sourceset') AND e.trashed = 0
)
WHERE n = 1;

-- A title that only said what type of collection it was is not kept.
INSERT INTO file_set (id, set_id, title, description)
SELECT c.entity_id, coalesce(c.collection_id, 'set:' || c.entity_id),
       CASE WHEN e.title IN ('Set', 'Sequence', 'Source Set') THEN NULL ELSE e.title END,
       e.description
FROM collection c JOIN entity e ON e.id = c.entity_id
WHERE c.entity_id IN (SELECT collection FROM chosen);

INSERT INTO set_source_url (set_key, url)
SELECT entity_id, url FROM source_url WHERE entity_id IN (SELECT id FROM file_set);
INSERT INTO set_identifier (set_key, value)
SELECT entity_id, value FROM identifier WHERE entity_id IN (SELECT id FROM file_set);
INSERT INTO set_reference (set_key, value)
SELECT entity_id, value FROM reference WHERE entity_id IN (SELECT id FROM file_set);
-- Sets do not nest: one that was inside a collection refers to it instead.
INSERT OR IGNORE INTO set_reference (set_key, value)
SELECT m.member_id, p.collection_id
FROM membership m JOIN collection p ON p.entity_id = m.collection_id
WHERE p.collection_id IS NOT NULL AND m.member_id IN (SELECT id FROM file_set);

UPDATE file
SET set_key = (SELECT collection FROM chosen WHERE file = file.entity_id),
    set_index = (SELECT position FROM chosen WHERE file = file.entity_id)
WHERE entity_id IN (SELECT file FROM chosen);

-- What only the collection said, of what only files say now, its files
-- say where they said nothing.
UPDATE entity
SET date = coalesce(date, (
        SELECT c.date FROM chosen ch JOIN entity c ON c.id = ch.collection
        WHERE ch.file = entity.id)),
    score = coalesce(score, (
        SELECT c.score FROM chosen ch JOIN entity c ON c.id = ch.collection
        WHERE ch.file = entity.id)),
    content_rating = coalesce(content_rating, (
        SELECT c.content_rating FROM chosen ch JOIN entity c ON c.id = ch.collection
        WHERE ch.file = entity.id))
WHERE id IN (SELECT file FROM chosen);

DROP TABLE chosen;

-- The files of a collection of variants are variants of each other.
UPDATE file
SET alt_group_id = (
    SELECT coalesce(c.collection_id, 'alt:' || c.entity_id)
    FROM membership m
    JOIN collection c ON c.entity_id = m.collection_id
    JOIN entity e ON e.id = c.entity_id
    WHERE m.member_id = file.entity_id AND c.collection_type = 'variant' AND e.trashed = 0
    ORDER BY c.entity_id LIMIT 1
)
WHERE entity_id IN (
    SELECT m.member_id FROM membership m
    JOIN collection c ON c.entity_id = m.collection_id
    JOIN entity e ON e.id = c.entity_id
    WHERE c.collection_type = 'variant' AND e.trashed = 0
);

-- A collection's tags go to the files that were directly in it.
INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
SELECT m.member_id, et.tag_id
FROM membership m
JOIN collection c ON c.entity_id = m.collection_id AND c.collection_type <> 'usercollection'
JOIN entity e ON e.id = c.entity_id AND e.trashed = 0
JOIN file f ON f.entity_id = m.member_id
JOIN entity_tag et ON et.entity_id = m.collection_id;

-- A user collection becomes a bucket of its title, for every file in it,
-- at any depth. A colon would make a namespace of the title, and an @ a
-- tag type.
CREATE TEMP TABLE bucketed AS
WITH RECURSIVE inside (collection, id) AS (
    SELECT c.entity_id, m.member_id
    FROM collection c
    JOIN entity e ON e.id = c.entity_id
    JOIN membership m ON m.collection_id = c.entity_id
    WHERE c.collection_type = 'usercollection' AND e.trashed = 0
      AND e.title IS NOT NULL AND e.title <> 'User Collection'
    UNION
    SELECT i.collection, m.member_id FROM membership m JOIN inside i ON m.collection_id = i.id
)
SELECT DISTINCT trim(ltrim(replace(trim(e.title), ':', ' -'), '@ ')) AS value, i.id AS file
FROM inside i
JOIN entity e ON e.id = i.collection
JOIN file f ON f.entity_id = i.id;

INSERT INTO tag (field, value)
SELECT DISTINCT 'bucket', value FROM bucketed WHERE value <> ''
ON CONFLICT (field, value) DO NOTHING;

INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
SELECT b.file, t.id FROM bucketed b JOIN tag t ON t.field = 'bucket' AND t.value = b.value;

DROP TABLE bucketed;

-- A tab that listed a collection lists the files that were in it.
INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
WITH RECURSIVE inside (tab_id, id) AS (
    SELECT u.tab_id, u.entity_id
    FROM tab_upload u JOIN collection c ON c.entity_id = u.entity_id
    UNION
    SELECT i.tab_id, m.member_id FROM membership m JOIN inside i ON m.collection_id = i.id
)
SELECT i.tab_id, i.id FROM inside i JOIN file f ON f.entity_id = i.id;

-- A view that lists a collection is of what is no longer there.
DELETE FROM tab_view
WHERE EXISTS (
    SELECT 1 FROM json_each(tab_view.ids) j JOIN collection c ON c.entity_id = j.value
);

-- A collection's tab is its set's, if it became one. As before, the
-- kind's CHECK means rebuilding the table, with what hangs off a tab set
-- aside while it is dropped.
CREATE TABLE tab_new (
    id         INTEGER PRIMARY KEY,
    position   INTEGER NOT NULL,
    query      TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'gallery'
               CHECK (kind IN ('gallery', 'upload', 'set', 'download')),
    name       TEXT NOT NULL DEFAULT '',
    -- The set a set tab shows.
    set_key    INTEGER REFERENCES file_set (id) ON DELETE CASCADE,
    -- The downloader a download tab uses: the name of its folder.
    downloader TEXT,
    hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    picked     INTEGER NOT NULL DEFAULT 0 CHECK (picked IN (0, 1)),
    CHECK ((kind = 'set') = (set_key IS NOT NULL)),
    CHECK ((kind = 'download') = (downloader IS NOT NULL))
) STRICT;

INSERT INTO tab_new (id, position, query, kind, name, set_key, downloader, hidden, picked)
SELECT id, position, query, CASE kind WHEN 'collection' THEN 'set' ELSE kind END, name,
       collection_id, downloader, hidden, picked
FROM tab
WHERE kind <> 'collection' OR collection_id IN (SELECT id FROM file_set);

CREATE TEMP TABLE tab_upload_kept AS SELECT tab_id, entity_id FROM tab_upload;
CREATE TEMP TABLE tab_view_kept AS SELECT tab_id, query, ids, custom FROM tab_view;
CREATE TEMP TABLE tab_seen_kept AS SELECT tab_id, key, date_seen FROM tab_download_seen;
CREATE TEMP TABLE tab_tags_kept AS SELECT tab_id, tags FROM tab_tags;

DROP TABLE tab;
ALTER TABLE tab_new RENAME TO tab;

INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
SELECT tab_id, entity_id FROM tab_upload_kept WHERE tab_id IN (SELECT id FROM tab);
INSERT OR IGNORE INTO tab_view (tab_id, query, ids, custom)
SELECT tab_id, query, ids, custom FROM tab_view_kept WHERE tab_id IN (SELECT id FROM tab);
INSERT OR IGNORE INTO tab_download_seen (tab_id, key, date_seen)
SELECT tab_id, key, date_seen FROM tab_seen_kept WHERE tab_id IN (SELECT id FROM tab);
INSERT OR IGNORE INTO tab_tags (tab_id, tags)
SELECT tab_id, tags FROM tab_tags_kept WHERE tab_id IN (SELECT id FROM tab);

DROP TABLE tab_upload_kept;
DROP TABLE tab_view_kept;
DROP TABLE tab_seen_kept;
DROP TABLE tab_tags_kept;

CREATE INDEX tab_set ON tab (set_key);

-- The collections themselves, and with them what they carried and where
-- they were listed.
DELETE FROM entity WHERE kind = 'collection';
DROP TABLE membership;
DROP TABLE collection;

DELETE FROM tag WHERE pinned = 0 AND id NOT IN (SELECT tag_id FROM entity_tag);
