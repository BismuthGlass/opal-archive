-- A tag can have child tags: tags put on an entity along with it, when it
-- is added. They may be of any field. It happens once, as the parent goes
-- on: taking the parent off later leaves the children where they are.
-- Both are held by value, as aliases are.
CREATE TABLE tag_child (
    field       TEXT NOT NULL,
    parent      TEXT NOT NULL COLLATE NOCASE,
    child_field TEXT NOT NULL,
    child       TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (field, parent, child_field, child)
) STRICT, WITHOUT ROWID;

CREATE INDEX tag_child_child ON tag_child (child_field, child);
