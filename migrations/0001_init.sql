-- Every file and every collection is an entity. The metadata they share
-- lives here, so both are tagged and searched the same way.
CREATE TABLE entity (
    id             INTEGER PRIMARY KEY,
    kind           TEXT NOT NULL CHECK (kind IN ('file', 'collection')),
    date_added     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    title          TEXT,
    -- YYYY, YYYY-MM or YYYY-MM-DD.
    date           TEXT CHECK (
        date GLOB '[0-9][0-9][0-9][0-9]'
        OR date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
        OR date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    score          INTEGER CHECK (score BETWEEN 1 AND 7),
    version        TEXT,
    content_rating TEXT CHECK (content_rating IN ('safe', 'risky', 'nsfw')),
    description    TEXT,
    ai_content     TEXT CHECK (ai_content IN ('none', 'partial', 'full', 'unknown')),
    ai_description TEXT,
    -- Target for the composite foreign keys that pin a subtype row to its kind.
    UNIQUE (id, kind)
) STRICT;

-- Attributes of the stored file. The file itself lives in internal storage
-- as <hash>.<extension>.
CREATE TABLE file (
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
    FOREIGN KEY (entity_id, kind) REFERENCES entity (id, kind) ON DELETE CASCADE
) STRICT;

CREATE TABLE collection (
    entity_id       INTEGER PRIMARY KEY,
    kind            TEXT NOT NULL DEFAULT 'collection' CHECK (kind = 'collection'),
    collection_type TEXT NOT NULL CHECK (
        collection_type IN ('variant', 'set', 'sourceset', 'sequence', 'usercollection')
    ),
    FOREIGN KEY (entity_id, kind) REFERENCES entity (id, kind) ON DELETE CASCADE
) STRICT;

-- A member is any entity, so collections can belong to other collections.
-- Cycles are rejected by the application: SQLite triggers cannot use
-- recursive queries.
CREATE TABLE membership (
    collection_id INTEGER NOT NULL REFERENCES collection (entity_id) ON DELETE CASCADE,
    member_id     INTEGER NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
    -- Position within the collection, if applicable.
    position      INTEGER,
    PRIMARY KEY (collection_id, member_id),
    CHECK (collection_id <> member_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX membership_member ON membership (member_id);

-- All multi-valued metadata fields. A value exists once per field and is
-- shared by every entity that carries it, which makes renames and mass
-- edits single-row operations. Values are case-insensitive (ASCII): the
-- first spelling entered is the one kept.
CREATE TABLE tag (
    id    INTEGER PRIMARY KEY,
    field TEXT NOT NULL CHECK (field IN (
        'creator', 'medium', 'genre', 'style', 'flaws', 'person', 'source_work',
        'character', 'language', 'tags', 'identifier', 'usage_tags',
        'ai_usage_tags', 'source', 'source_url'
    )),
    value TEXT NOT NULL COLLATE NOCASE CHECK (value <> '' AND value = trim(value)),
    UNIQUE (field, value)
) STRICT;

CREATE TABLE entity_tag (
    entity_id INTEGER NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tag (id) ON DELETE CASCADE,
    PRIMARY KEY (entity_id, tag_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX entity_tag_tag ON entity_tag (tag_id);

-- Persistent search tabs.
CREATE TABLE search_tab (
    id       INTEGER PRIMARY KEY,
    position INTEGER NOT NULL,
    query    TEXT NOT NULL DEFAULT ''
) STRICT;
