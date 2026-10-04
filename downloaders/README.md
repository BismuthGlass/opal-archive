# Downloaders

A downloader fetches files from a website into the library. Each is a
folder here, named for the downloader, holding:

- `manifest.json`, which says what it is;
- a script, in any language, that does the fetching.

The script knows its website and nothing about the library. The server
knows the library and nothing about the website. A download tab in the
interface is tied to one downloader; the server runs the script for it,
takes in the files it fetches, and gives them their source URL and tags.

Adding a downloader means adding a folder. The server reads the folders
when asked, so a new one shows up without a restart.

## The manifest

```json
{
  "title": "Pinterest",
  "source": "pinterest",
  "command": ["uv", "run", "--quiet", "--script", "pinterest.py"],
  "url_hint": "A pin, board, board section or profile URL",
  "cookies": { "browsers": ["chrome", "firefox"] },
  "options": [{ "key": "recursive", "label": "Go into sections", "default": true }]
}
```

| Field      | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `title`    | Its name in the interface                                               |
| `source`   | The `source` tag given to every file it downloads                       |
| `command`  | The program and its first arguments, run from the downloader's folder   |
| `url_hint` | What can be pasted into the download box                                |
| `cookies`  | Optional. Present if it can use a login read from one of these browsers |
| `options`  | Optional. Switches the user sets per tab; each is true or false         |

## The script

The command is run with one more argument, a subcommand.

### `download`

The request arrives on standard input as one JSON object:

```json
{
  "url": "https://…",
  "options": { "recursive": true },
  "cookies": "/path/to/cookies.txt",
  "seen": ["https://…/pin/1/", "https://…/pin/2/"],
  "out": "/path/to/a/folder"
}
```

- `cookies` is a Netscape cookie file saved by the `cookies` subcommand, or
  `null` if no login is saved.
- `seen` holds the keys of what this tab has downloaded before. The script
  should skip them without fetching anything.
- `out` is an empty folder to download into. Files must be put there and
  nowhere else; the server removes each once it has taken it in, and the
  folder at the end.

The script answers on standard output, one JSON object per line:

| Event     | Fields                       | Meaning                                                   |
| --------- | ---------------------------- | --------------------------------------------------------- |
| `found`   | `total`                      | How many things there are to download, as far as is known |
| `item`    | `key`, `source_url`, `files`, optionally `title`, `description`, `set_title`, `tags`, `collection` | One thing has been fetched, as these files, in order |
| `skipped` | `key`                        | One thing was passed over because its key is in `seen`    |
| `error`   | `message`, optionally `key`  | Something failed; the download goes on                    |
| `log`     | `message`                    | What the script is doing, shown while it runs             |

A `key` is whatever tells one thing on the site from another, and is what
the tab remembers; for Pinterest it is the pin's URL. For each `item` the
server takes in the files, lists them under the tab, adds `source_url` and
the tags, and remembers the key. An item with several files also gets a
`set` collection holding them in order, titled with `set_title` if the item
gives one and as the item is if not.

The tags are the manifest's `source`, the ones the user gave the tab, and
any the item brings itself in `tags`: an object of tag field to values,
`{"creator": ["Someone"], "tags": ["cat"]}`. A file that already has a tag
is left as it is, and a value that is not a valid tag is passed over.
`title` and `description` are given to the files, and the set, that have
none; one the user wrote is never replaced.

An item can say what it is part of on the site, to be kept together in the
library: `"collection": {"url": "https://…", "title": "…"}`, as a post is
part of its thread. Everything downloaded with the same `url` is put, in the
order it arrives, in one `sourceset` collection, which is made the first
time, with that title, the `url` as its source URL, and the source and the
tab's tags. An item of several files goes in as its set. Like a set, the
collection is listed in the tab, beside the files.

Lines that are not one of these events are ignored. The script ends with
status 0 when it is done. Any other status means the download failed, and
the last line it wrote to standard error is shown as the reason.

A cancelled download is sent `SIGTERM`, then killed if it has not gone
within three seconds.

### `cookies --browser NAME --out FILE`

Only for downloaders with `cookies` in their manifest. The script reads its
site's login from the browser and writes it to `FILE` as a Netscape cookie
file, then prints `{"logged_in": true}`. If the browser has no login for
the site it writes nothing and prints `{"logged_in": false}`.

The server keeps the file under the data directory, readable only by the
user, and passes its path with every later download.

## A custom panel

The interface builds a downloader's panel from its manifest: the address
box, the options, the base tags, the login and the list of what was seen.
A downloader that needs more can be given its own component in
`web/src/downloaders.ts`.
