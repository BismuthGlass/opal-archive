-- A tag can be described, and can be created before anything carries it.
-- `pinned` keeps such a tag when nothing carries it; other tags still go
-- with their last use.
ALTER TABLE tag ADD COLUMN description TEXT;
ALTER TABLE tag ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
