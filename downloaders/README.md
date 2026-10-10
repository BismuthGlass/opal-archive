# Downloaders

A downloader fetches files from a website into the library. Each is a
folder here, named for the downloader, holding:

- `manifest.json`, which says what it is;
- a script, in any language, that does the fetching.

The script knows its website and nothing about the library. The server
knows the library and nothing about the website. An address pasted into an
upload tab, or sent to the inbox, is given to the downloader whose site it
is of, by the `sites` of its manifest; the server runs the script for it,
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
  "sites": ["pinterest.*", "pin.it"],
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
| `sites`    | Optional. The sites it downloads from, by which an address finds it: a domain, which stands for its subdomains too, or a name and `.*` for that name under any ending |
| `cookies`  | Optional. Present if it can use a login read from one of these browsers |
| `options`  | Optional. Switches the user sets, once for every download; each is true or false |

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
  "out": "/path/to/a/folder",
  "delegates": ["redgifs.com", "pinterest.*"]
}
```

- `cookies` is a Netscape cookie file saved by the `cookies` subcommand, or
  `null` if no login is saved.
- `seen` holds the keys of what this tab has downloaded before. The script
  should skip them without fetching anything.
- `delegates` lists the `sites` of every other downloader: what this one
  may hand over, as described under `delegate` below.
- `out` is an empty folder to download into. Files must be put there and
  nowhere else; the server removes each once it has taken it in, and the
  folder at the end.

The script answers on standard output, one JSON object per line:

| Event     | Fields                       | Meaning                                                   |
| --------- | ---------------------------- | --------------------------------------------------------- |
| `found`   | `total`                      | How many things there are to download, as far as is known |
| `item`    | `key`, `source_url`, `files`, optionally `title`, `description`, `tags`, `reference`, `set`, `delegate` | One thing has been fetched, as these files, in order |
| `skipped` | `key`                        | One thing was passed over because its key is in `seen`    |
| `error`   | `message`, optionally `key`  | Something failed; the download goes on                    |
| `log`     | `message`                    | What the script is doing, shown while it runs             |

A `key` is whatever tells one thing on the site from another, and is what
the tab remembers; for Pinterest it is the pin's URL. For each `item` the
server takes in the files, lists them under the tab, adds `source_url` and
the tags, and remembers the key.

`reference` says what the files are part of on the site, where that is not
something to make a set of: 4chan gives each file of a thread
`4chan:<board>:<thread>`, Pinterest each pin of a board
`pinterest:<user>:<board>`, or `pinterest:<user>:<board>:<section>` if it
is in a section, and each pin a user created `pinterest:<user>`. It is kept as a reference of each file, by which the
others are found (`reference=4chan:g:109956993`, or
`reference=pinterest:someone:a-board*` for a board with its sections), and
groups nothing. Start it with the downloader's name and namespace it with
colons, as a set's `id` below.

The tags are the manifest's `source`, the ones the user gave the tab, and
any the item brings itself in `tags`: an object of tag field to values,
`{"creator": ["Someone"], "tags": ["cat"]}`. A file that already has a tag
is left as it is, and a value that is not a valid tag is passed over.
`title` and `description` are given to the files that have none; one the
user wrote is never replaced.

An item may show something that is another site's: a Reddit post that
links to a Redgifs video. If the address is of one of the `delegates` the
request listed, the script need not fetch it. It names the address in
`delegate`, a list, and the server has that site's downloader fetch it into
the same tab. What comes of it is taken in as that downloader gives it,
with its `source`, source URL and tags, and is then this item's as well:
it gets this item's too, after any files of its own. So the file of that
Reddit post has the source of both sites and the address on each. If no
other downloader takes the address, or it brings nothing in, the item
fails. An item with nothing but a `delegate` needs no `files`.

Nothing is put in a set unless the item asks. It asks with `set`, which
describes the set its files go in:

```json
"set": {
  "id": "pinterest:pin:924574998519073090",
  "url": "https://…",
  "title": "…",
  "description": "…",
  "tags": { "creator": ["Someone"] },
  "reference": "pinterest:someone:a-board"
}
```

| Field         | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `id`          | Required. Its set ID, which no two sets in the library share. Start it with the downloader's name, so that it cannot meet another downloader's, and namespace it with colons: `pinterest:pin:…`, `reddit:post:…` |
| `url`         | Its address on the site, kept as its source URL                          |
| `title`       | What it is called. It has no title if this is left out or empty, and is then called by its `id` |
| `description` | Given to it if it has none                                               |
| `tags`        | Tags for its files, as an item's: a set has none of its own              |
| `reference`   | What it is part of on the site, kept as a reference of its own, as an item's is of its files |

The `id` is what the set is found by. The first item to name one makes the
set, with that title; every later one, in any tab and after any restart,
finds the set that has the ID and adds its files to it, in the order they
arrive, so no second set is ever made of the same thing. The user is free
to retitle it or take its source URL off: none of that is looked at again.
Only if it is gone, or its ID was changed, is a new one made.

A file is in one set. One that is in a set already when it arrives, as the
same picture posted twice is, stays in the set it is in.

A set is not an entity: it has no tags and is not listed in the tab. Its
files are, and what the set says of where it came from (its `url`, its
`reference`) they are found by too. Sets do not nest: what a set is part of
is said with its `reference`.

The downloaders here ask for one shape only: an item of several files asks
for a set with an ID of its own, which makes one set per post. Pinterest
does this for a pin of several images, Reddit for a post of several. Items
that all give the same `id` would gather in one set, but a board or a
thread is not grouped so: Pinterest and 4chan give a `reference` instead.
Pinterest gives it to the file of a pin of one image, and to the set of a
pin of several rather than to the files in it.

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

### `cookies --file COOKIES --out FILE`

The same, with the login taken out of a Netscape cookie file instead of a
browser: for a server that runs where there is no browser (see
`OPALARCHIVE_HEADLESS` in the main README), and is sent the login by the
browser extension or as an uploaded file. `COOKIES` may hold the cookies of
any number of sites; the script writes only its own site's to `FILE`, and
again prints whether there was a login among them.

## The inbox

A download can also be asked for from outside the interface, with nothing
but an address: by the browser extension in `extension/`, or by anything
else that can make a request.

```
POST /api/inbox
{ "url": "https://www.reddit.com/r/…/comments/…", "tags": ["cat", "@cr:someone"] }
```

`tags` is optional: tags for what this one request downloads, written as
they are typed in the interface, given besides the ones the downloader is
set to give.

The server finds the downloader from the address, by the `sites` of each
manifest (or takes the one named in `"downloader"`), and puts the request
in a queue. The queue is kept in the database and worked through one
request at a time. The answer is the request as queued, with its `id`;
`GET /api/inbox/queue/<id>` says what has become of it: its `status` is
`queued`, `running`, `done`, `failed` or `cancelled`, and its `message`
says why it failed.

The script is run exactly as for an upload tab, with two differences. The
tags given are the ones the downloader is set to give in the inbox, not a
tab's. And `seen` is always empty: what is asked for one thing at a
time is wanted, and a file the library already has is only listed again.

What is downloaded is listed under one tab, the inbox, which every
downloader shares. It lists it until the user clears it: closing the tab
only puts it out of sight, and opening the inbox again brings it back as
it was, with whatever arrived meanwhile.

## Settings

The interface builds a downloader's settings from its manifest, in the
window that lists every downloader's: its `options`, each a switch, and
its login if it has `cookies`. They are kept by the server, by the
downloader's name, and passed with every download.
