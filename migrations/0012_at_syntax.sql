-- Tags of a type are now searched as `@cr:name` and the trash as
-- `@trashed`; the `creator=name` and `is=trashed` forms are gone. Saved tab
-- queries are rewritten to match.
UPDATE tab SET query = replace(query, 'is!=trashed', '-@trashed');
UPDATE tab SET query = replace(query, 'is=trashed', '@trashed');
UPDATE tab SET query = replace(query, 'ai_usage_tags=', '@ai:');
UPDATE tab SET query = replace(query, 'usage_tags=', '@us:');
UPDATE tab SET query = replace(query, 'source_work=', '@sw:');
UPDATE tab SET query = replace(query, 'creator=', '@cr:');
UPDATE tab SET query = replace(query, 'character=', '@ch:');
UPDATE tab SET query = replace(query, 'person=', '@pe:');
UPDATE tab SET query = replace(query, 'genre=', '@ge:');
UPDATE tab SET query = replace(query, 'style=', '@st:');
UPDATE tab SET query = replace(query, 'medium=', '@me:');
UPDATE tab SET query = replace(query, 'flaws=', '@fl:');
UPDATE tab SET query = replace(query, 'language=', '@la:');
UPDATE tab SET query = replace(query, 'source=', '@so:');
UPDATE tab SET query = replace(query, 'tags=', '');
