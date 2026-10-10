-- References are a plain list per entity, as identifiers are: no
-- namespaces, aliases or suggestions.
CREATE TABLE reference (
    entity_id INTEGER NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
    value     TEXT NOT NULL CHECK (value <> '' AND value = trim(value)),
    PRIMARY KEY (entity_id, value)
) STRICT, WITHOUT ROWID;
