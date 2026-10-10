-- A collection is a name that files and sets give for what they are part
-- of, and needs nothing more to be one. What is known of the collection
-- itself is kept here, by that name, once something is: its title and
-- description, and the lists that say where it is, as a set has them.
CREATE TABLE collection_info (
    name        TEXT PRIMARY KEY CHECK (name <> '' AND name = trim(name)),
    title       TEXT,
    description TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE collection_source_url (
    name TEXT NOT NULL REFERENCES collection_info (name) ON DELETE CASCADE,
    url  TEXT NOT NULL CHECK (url <> '' AND url = trim(url)),
    PRIMARY KEY (name, url)
) STRICT, WITHOUT ROWID;

CREATE TABLE collection_identifier (
    name  TEXT NOT NULL REFERENCES collection_info (name) ON DELETE CASCADE,
    value TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (name, value)
) STRICT, WITHOUT ROWID;

CREATE TABLE collection_reference (
    name  TEXT NOT NULL REFERENCES collection_info (name) ON DELETE CASCADE,
    value TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (name, value)
) STRICT, WITHOUT ROWID;
