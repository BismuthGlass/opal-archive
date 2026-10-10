-- A file can be in more than one set. Which sets, and where in each, is
-- kept apart from the file, in `set_file`, in place of the two columns
-- that named one set.
--
-- The migration before this one makes `set_file` itself now. A library it
-- ran on before it did has the columns alone.
CREATE TABLE IF NOT EXISTS set_file (
    set_key   INTEGER NOT NULL REFERENCES file_set (id) ON DELETE CASCADE,
    file_id   INTEGER NOT NULL REFERENCES file (entity_id) ON DELETE CASCADE,
    -- Where in the set it comes; those without follow, in the order of
    -- their IDs.
    set_index INTEGER,
    PRIMARY KEY (set_key, file_id)
) STRICT, WITHOUT ROWID;

-- Dropping `file` empties what refers to it, so what is known is set aside.
CREATE TEMP TABLE set_file_kept AS
SELECT set_key, file_id, set_index FROM set_file
UNION
SELECT set_key, entity_id, set_index FROM file WHERE set_key IS NOT NULL;

-- A column that refers to another table cannot be dropped: the table is
-- rebuilt without the two.
CREATE TABLE file_new (
    entity_id     INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL DEFAULT 'file' CHECK (kind = 'file'),
    -- Lowercase hex SHA-256 of the file contents.
    hash          TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
    -- Lowercase, without the dot. Empty if the upload had none.
    extension     TEXT NOT NULL CHECK (extension = lower(extension) AND extension NOT LIKE '%.%'),
    -- Classified on upload, from the file contents and extension.
    media_type    TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio', 'book', 'other')),
    size          INTEGER NOT NULL CHECK (size >= 0),
    -- Name the file was uploaded with, used to name it again on export.
    original_name TEXT,
    width         INTEGER CHECK (width > 0),
    height        INTEGER CHECK (height > 0),
    page_count    INTEGER CHECK (page_count > 0),
    -- In seconds.
    length        REAL CHECK (length >= 0),
    looping       INTEGER CHECK (looping IN (0, 1)),
    -- Whether thumbnails/<hash>.jpg exists.
    has_thumbnail INTEGER NOT NULL DEFAULT 0 CHECK (has_thumbnail IN (0, 1)),
    -- Files with the same one are variants of each other.
    alt_group_id  TEXT CHECK (alt_group_id <> '' AND alt_group_id = trim(alt_group_id)),
    FOREIGN KEY (entity_id, kind) REFERENCES entity (id, kind) ON DELETE CASCADE
) STRICT;

INSERT INTO file_new (entity_id, kind, hash, extension, media_type, size, original_name, width,
                      height, page_count, length, looping, has_thumbnail, alt_group_id)
SELECT entity_id, kind, hash, extension, media_type, size, original_name, width,
       height, page_count, length, looping, has_thumbnail, alt_group_id
FROM file;

DROP TABLE file;
ALTER TABLE file_new RENAME TO file;

CREATE INDEX file_alt_group ON file (alt_group_id) WHERE alt_group_id IS NOT NULL;

INSERT OR IGNORE INTO set_file (set_key, file_id, set_index)
SELECT set_key, file_id, set_index FROM set_file_kept;

DROP TABLE set_file_kept;

CREATE INDEX IF NOT EXISTS set_file_file ON set_file (file_id);
