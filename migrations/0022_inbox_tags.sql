-- A request to the inbox can bring tags of its own, given to what it
-- downloads besides the ones its downloader is set to give: tag field to
-- values, as `inbox_settings.tags`.
ALTER TABLE inbox_queue ADD COLUMN tags TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tags));
