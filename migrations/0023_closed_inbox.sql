-- The inbox can be closed like any tab, and keeps what it lists all the
-- same: closed, its tab is only put out of sight, and opening the inbox
-- again brings it back as it was. No other tab is ever hidden; they are
-- deleted when closed.
ALTER TABLE tab ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
