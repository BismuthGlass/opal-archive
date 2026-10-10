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
| `sites`    | Optional. The sites it downloads from, by which an address sent to the inbox finds it: a domain, which stands for its subdomains too, or a name and `.*` for that name under any ending |
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
| `item`    | `key`, `source_url`, `files`, optionally `title`, `description`, `tags`, `reference`, `collection` | One thing has been fetched, as these files, in order |
| `skipped` | `key`                        | One thing was passed over because its key is in `seen`    |
| `error`   | `message`, optionally `key`  | Something failed; the download goes on                    |
| `log`     | `message`                    | What the script is doing, shown while it runs             |

A `key` is whatever tells one thing on the site from another, and is what
the tab remembers; for Pinterest it is the pin's URL. For each `item` the
server takes in the files, lists them under the tab, adds `source_url` and
the tags, and remembers the key.

`reference` says what the files are part of on the site, where that is not
something to make a collection of: 4chan gives each file of a thread
`4chan:<board>:<thread>`, Pinterest each pin of a board
`pinterest:<user>:<board>`, or `pinterest:<user>:<board>:<section>` if it
is in a section. It is kept as a reference of each file, by which the
others are found (`reference=4chan:g:109956993`, or
`reference=pinterest:someone:a-board*` for a board with its sections), and
groups nothing. Start it with the downloader's name and namespace it with
colons, as a collection's `id` below.

The tags are the manifest's `source`, the ones the user gave the tab, and
any the item brings itself in `tags`: an object of tag field to values,
`{"creator": ["Someone"], "tags": ["cat"]}`. A file that already has a tag
is left as it is, and a value that is not a valid tag is passed over.
`title` and `description` are given to the files, and the set, that have
none; one the user wrote is never replaced.

Nothing is put in a collection unless the item asks. It asks with
`collection`, which describes the collection its files go in:

```json
"collection": {
  "id": "pinterest:pin:924574998519073090",
  "type": "set",
  "url": "https://…",
  "title": "…",
  "description": "…",
  "tags": { "creator": ["Someone"] },
  "reference": "pinterest:someone:a-board",
  "ordered": true,
  "collection": { "id": "pinterest:someone:a-board", "type": "sourceset" }
}
```

| Field         | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `id`          | Required. Its collection ID, which no two collections in the library share. Start it with the downloader's name, so that it cannot meet another downloader's, and namespace it with colons: `pinterest:pin:…`, `4chan:<board>:…` |
| `type`        | `set`, `sourceset`, `sequence`, `variant` or `usercollection`. A `set` if left out |
| `url`         | Its address on the site, kept as its source URL                          |
| `title`       | What it is called. It has no title if this is left out or empty: the `id` is not shown in its place |
| `description` | Given to it if it has none                                               |
| `tags`        | Tags of its own, as an item's                                            |
| `reference`   | What it is part of on the site, kept as a reference of its own, as an item's is of its files |
| `ordered`     | Whether it keeps its members in the order they arrive. It does if left out |
| `collection`  | The collection this one is itself to be put in, described the same way, and so on to any depth |

The `id` is what the collection is found by. The first item to name one
makes the collection, with that type, title and `ordered`; every later one,
in any tab and after any restart, finds the collection that has the ID and
adds its files to it, so no second collection is ever made of the same
thing. The user is free to retitle it, change its type or take its source
URL off: none of that is looked at again. If it is in the trash it comes
back out. Only if it was deleted for good, or its ID was changed, is a new
one made.

The collection always gets the manifest's `source` and the tab's tags; it
does not get the item's own tags, title, description or reference, only
what `collection` says. It is listed in the tab in place of its files: they
are one thing, and the tab shows it as one.

A collection that names a `collection` of its own is put in that one, as a
member like any other, and the files are not. Every collection named is
made, found, tagged and listed as described above.

IDs can be namespaced with colons, as tags are, to say what a collection is
part of: `somesite:<user>:<album>:<part>`.

The downloaders here ask for one shape only: an item of several files asks
for a `set` with an ID of its own, which makes one collection per post.
Pinterest does this for a pin of several images, Reddit for a post of
several. Items that all give the same `id` would gather in one collection,
but a board or a thread is not grouped so: Pinterest and 4chan give a
`reference` instead. Pinterest gives it to the file of a pin of one image,
and to the set of a pin of several rather than to the files in it.

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

The script is run exactly as for a download tab, with two differences. Its
options and base tags are the ones the downloader is set to in the inbox,
not a tab's. And `seen` is always empty: what is asked for one thing at a
time is wanted, and a file the library already has is only listed again.

What is downloaded is listed under one tab, the inbox, which every
downloader shares. It lists it until the user clears it: closing the tab
only puts it out of sight, and opening the inbox again brings it back as
it was, with whatever arrived meanwhile.

## A custom panel

The interface builds a downloader's panel from its manifest: the address
box, the options, the base tags, the login and the list of what was seen.
A downloader that needs more can be given its own component in
`web/src/downloaders.ts`.
