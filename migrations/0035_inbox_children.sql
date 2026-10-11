-- A request says whether its tags bring their child tags. One made where
-- the children were shown, and those not wanted taken off, says no: its
-- tags are given as they stand.
ALTER TABLE inbox_queue ADD COLUMN children INTEGER NOT NULL DEFAULT 1 CHECK (children IN (0, 1));
