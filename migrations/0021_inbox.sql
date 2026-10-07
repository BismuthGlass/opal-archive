-- The inbox: downloads asked for from outside the interface, by a browser
-- extension for one. They wait in a queue, are run one at a time, each by
-- the downloader its address belongs to, and what they fetch is listed
-- under one tab, the inbox, until the user clears it.
--
-- That tab is a download tab of no one downloader: its `downloader` is
-- `*`, which is no folder's name. It holds its files as any download tab
-- does, in `tab_upload`.

-- What has been asked for, oldest first. A row stays, done or failed, to
-- show what became of it, until the inbox is cleared.
CREATE TABLE inbox_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    url           TEXT NOT NULL,
    -- The downloader it is for: the name of its folder.
    downloader    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    -- Why it failed, or what went wrong on the way though it got there.
    message       TEXT NOT NULL DEFAULT '',
    -- Files that were new to the library, and ones it already had.
    added         INTEGER NOT NULL DEFAULT 0,
    existing      INTEGER NOT NULL DEFAULT 0,
    date_queued   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    date_finished TEXT
) STRICT;

CREATE INDEX inbox_queue_status ON inbox_queue (status);

-- What each downloader is set to when it downloads for the inbox: its
-- options, and the tags given to everything it downloads. A download tab
-- keeps its own, in `tab_download`.
CREATE TABLE inbox_settings (
    downloader TEXT PRIMARY KEY,
    options    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options)),
    tags       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(tags))
) STRICT, WITHOUT ROWID;
