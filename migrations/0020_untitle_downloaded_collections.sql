-- A downloaded collection that was given no title was called by its
-- collection ID. It now has no title until it is given one; those called
-- by their ID until now lose that title.
UPDATE entity
SET title = NULL
WHERE id IN (SELECT entity_id FROM collection WHERE collection_id = entity.title);
