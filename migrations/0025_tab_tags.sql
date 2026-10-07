-- The tags an upload tab gives to everything uploaded into it: tag field to
-- values, as a download tab's are in `tab_download.tags`.
CREATE TABLE tab_tags (
    tab_id INTEGER PRIMARY KEY REFERENCES tab (id) ON DELETE CASCADE,
    tags   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tags))
) STRICT;
