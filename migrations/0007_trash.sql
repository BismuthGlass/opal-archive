-- Deleting is two steps: an entity is first trashed, which hides it from
-- searches, and can then be deleted for good or restored.
ALTER TABLE entity ADD COLUMN trashed INTEGER NOT NULL DEFAULT 0 CHECK (trashed IN (0, 1));

CREATE INDEX entity_trashed ON entity (trashed) WHERE trashed = 1;
