-- A tab can be opened on a chosen set of entities: the ones selected when
-- it was asked for. It holds them as an upload tab holds its uploads, in
-- `tab_upload`, and is kept as one, marked as picked: nothing is uploaded
-- into it, and what it holds is what it was given.
ALTER TABLE tab ADD COLUMN picked INTEGER NOT NULL DEFAULT 0 CHECK (picked IN (0, 1));
