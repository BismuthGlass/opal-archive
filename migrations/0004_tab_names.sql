-- A tab can be given a name, shown instead of its query.
ALTER TABLE tab ADD COLUMN name TEXT NOT NULL DEFAULT '';
