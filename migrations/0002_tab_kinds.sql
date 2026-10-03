-- Tabs get a kind: a search, or an upload session showing what was
-- uploaded through it.
ALTER TABLE search_tab RENAME TO tab;

ALTER TABLE tab ADD COLUMN kind TEXT NOT NULL DEFAULT 'search'
    CHECK (kind IN ('search', 'upload'));

-- Files uploaded through an upload tab, including ones that turned out to
-- be in the library already.
CREATE TABLE tab_upload (
    tab_id    INTEGER NOT NULL REFERENCES tab (id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entity (id) ON DELETE CASCADE,
    PRIMARY KEY (tab_id, entity_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX tab_upload_entity ON tab_upload (entity_id);
