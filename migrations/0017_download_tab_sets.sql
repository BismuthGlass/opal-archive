-- A download tab now lists the sets made of what it downloaded, beside
-- their files. Those made before are listed too: the sets holding a file
-- of the tab whose source URL is something the tab remembers downloading.
CREATE TEMP TABLE tab_set AS
SELECT DISTINCT u.tab_id, c.entity_id
FROM tab_upload u
JOIN tab t ON t.id = u.tab_id AND t.kind = 'download'
JOIN membership m ON m.member_id = u.entity_id
JOIN collection c ON c.entity_id = m.collection_id AND c.collection_type = 'set'
JOIN source_url s ON s.entity_id = c.entity_id
JOIN tab_download_seen d ON d.tab_id = u.tab_id AND d.key = s.url;

INSERT OR IGNORE INTO tab_upload (tab_id, entity_id) SELECT tab_id, entity_id FROM tab_set;

-- The views saved for those tabs are of what they listed before.
DELETE FROM tab_view WHERE tab_id IN (SELECT tab_id FROM tab_set);

DROP TABLE tab_set;
