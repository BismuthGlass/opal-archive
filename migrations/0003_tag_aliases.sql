-- A tag alias defers to another tag of the same field: wherever the alias
-- is added or searched for, the target is used instead. Both are held by
-- value, since a tag row only exists while some entity carries it.
CREATE TABLE tag_alias (
    field  TEXT NOT NULL,
    alias  TEXT NOT NULL COLLATE NOCASE,
    target TEXT NOT NULL COLLATE NOCASE CHECK (target <> ''),
    PRIMARY KEY (field, alias),
    CHECK (alias <> target)
) STRICT, WITHOUT ROWID;

CREATE INDEX tag_alias_target ON tag_alias (field, target);
