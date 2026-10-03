-- What a tab shows is a snapshot of its search, kept until the user asks
-- for it to be calculated again: the results in the order on show, with
-- any the user dragged elsewhere or took out. It is saved with the tab so
-- that reloading the page brings it back as it was.
CREATE TABLE tab_view (
    tab_id INTEGER PRIMARY KEY REFERENCES tab (id) ON DELETE CASCADE,
    -- The query the snapshot is of; a view of another query is stale.
    query  TEXT NOT NULL,
    -- Entity IDs, as a JSON array.
    ids    TEXT NOT NULL CHECK (json_valid(ids)),
    -- Whether the order is one the user made, rather than the query's.
    custom INTEGER NOT NULL DEFAULT 0 CHECK (custom IN (0, 1))
) STRICT;
