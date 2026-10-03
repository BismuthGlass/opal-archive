-- AI content stops being a field of its own: how far a work is AI-made is
-- said with a `medium` tag like any other. What was recorded is carried
-- over: `full` becomes the medium `ai`, `partial` becomes `ai:partial`.
-- `none` and `unknown` said nothing a tag would, and are dropped.
INSERT OR IGNORE INTO tag (field, value) VALUES ('medium', 'ai');
INSERT OR IGNORE INTO tag (field, value) VALUES ('medium', 'ai:partial');

INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
SELECT e.id, t.id FROM entity e JOIN tag t
    ON t.field = 'medium'
   AND t.value = CASE e.ai_content WHEN 'full' THEN 'ai' WHEN 'partial' THEN 'ai:partial' END;

-- The tags were only made in case they were needed.
DELETE FROM tag
WHERE field = 'medium' AND value IN ('ai', 'ai:partial') AND pinned = 0
  AND id NOT IN (SELECT tag_id FROM entity_tag);

ALTER TABLE entity DROP COLUMN ai_content;
