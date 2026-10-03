-- Application settings: one row per setting, its value as JSON.
CREATE TABLE setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value))
) STRICT, WITHOUT ROWID;
