-- A downloader no longer has tabs of its own. An upload tab takes any
-- address and gives it to the downloader whose site it is of; what each
-- downloader is set to is set once, for every tab and for the inbox.

-- So the settings the inbox kept for each downloader are every tab's: its
-- options. Its tags are still the inbox's alone: an upload tab gives its
-- own, from `tab_tags`.
ALTER TABLE inbox_settings RENAME TO downloader_settings;

-- The download tabs there are become upload tabs. They keep what they
-- list (it is in `tab_upload` already), what they have seen, and the tags
-- they gave; the options each was set to are dropped. One with no name is
-- named for its downloader, as it was shown. The inbox (`*`) stays.
INSERT OR IGNORE INTO tab_tags (tab_id, tags)
SELECT d.tab_id, d.tags
FROM tab_download d JOIN tab t ON t.id = d.tab_id
WHERE t.kind = 'download' AND t.downloader <> '*' AND d.tags <> '{}';

UPDATE tab SET name = upper(substr(downloader, 1, 1)) || substr(downloader, 2)
WHERE kind = 'download' AND downloader <> '*' AND name = '';

UPDATE tab SET kind = 'upload', downloader = NULL
WHERE kind = 'download' AND downloader <> '*';

DROP TABLE tab_download;
