-- What a file or a set is part of where it came from (a thread, a board)
-- was kept as a reference of it. It is its collection: a plain list of its
-- own, as references are, which groups nothing. References stay, for
-- another use, and what they held until now is moved over.
CREATE TABLE collection (
    entity_id INTEGER NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
    value     TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (entity_id, value)
) STRICT, WITHOUT ROWID;

CREATE TABLE set_collection (
    set_key INTEGER NOT NULL REFERENCES file_set (id) ON DELETE CASCADE,
    value   TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (set_key, value)
) STRICT, WITHOUT ROWID;

INSERT INTO collection (entity_id, value) SELECT entity_id, value FROM reference;
INSERT INTO set_collection (set_key, value) SELECT set_key, value FROM set_reference;
DELETE FROM reference;
DELETE FROM set_reference;
