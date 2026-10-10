-- A file that has just arrived is in the inbox: it is new to the library
-- and has yet to be looked over. Archiving takes it out. It is a state of
-- the entity, as being trashed is, and no part of its metadata: it is not
-- exported, nor read from a sidecar.
--
-- What the library already holds was there before there was an inbox, and
-- starts out of it.
ALTER TABLE entity ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0 CHECK (inbox IN (0, 1));

CREATE INDEX entity_inbox ON entity (inbox) WHERE inbox = 1;
