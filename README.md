# OpalArchive

Media library with metadata, sets and search. See `SPEC.md` for the
idea, `schema.md` for the metadata format it is based on, and `query.md` for
the search language.

## Dependencies

- Rust (stable) and Cargo
- Node.js and npm, to build the frontend
- On `PATH` at runtime, for classifying uploads, reading their attributes and
  making thumbnails:
  - `file`, to tell images, video, audio and books apart
  - ImageMagick (`magick`), for image dimensions and thumbnails
  - ffmpeg (`ffmpeg` and `ffprobe`), for video dimensions, video / audio
    length, video thumbnails and audio cover art
  - poppler (`pdfinfo` and `pdftoppm`), for PDF page counts and thumbnails

- `curl`, to fetch a file from a web address given in an upload tab
- For the downloaders, `uv` (which runs their Python scripts, fetching what
  they need the first time) and `ffmpeg` for some videos

If one of these is missing, uploads still succeed; the attributes or thumbnail
it would have provided are left out and a line is logged.

EPUB books and CBZ comic archives are read by the server itself: the cover
becomes the thumbnail (through ImageMagick) and the page count is recorded. A
CBZ has one page per image. An EPUB's count is the number of print pages it
marks in its navigation; most mark none, and for those it is an estimate of
1800 characters of text per page. Other book formats (mobi, azw3, djvu, cbr,
cb7) are stored without either.

SQLite is compiled into the server, so no system install is needed.

## Layout

- `src/` – the Rust server and API
- `migrations/` – database schema, applied in order on startup
- `web/` – the SolidJS frontend
- `downloaders/` – one folder per downloader: a manifest and a script that
  fetches files from a website. See `downloaders/README.md` for how to add one
- `extension/` – a browser extension that sends posts to be downloaded, from
  a button beside each one. See `extension/README.md` for how to install it.
- `data/` – created at runtime:
  - `opalarchive.db` – the database
  - `storage/` – uploaded files, named `<sha256>.<extension>`
  - `thumbnails/` – one `<sha256>.jpg` per file that has a thumbnail
  - `tmp/` – uploads and downloads in progress
  - `cookies/` – logins saved for downloaders, one cookie file each,
    readable only by the user. They are not encrypted

## Running

```sh
cargo run                      # API on http://127.0.0.1:7878
cd web && npm install && npm run dev   # frontend with live reload, proxies /api
```

For a single-process setup, build the frontend once with `npm run build` and
the server will serve it from `web/dist`.

## Docker

The `Dockerfile` builds one image holding the server, the frontend it
serves and the downloaders with everything they call on:

```sh
docker compose up -d --build
```

`compose.yaml` keeps the library in `./data`, beside it. The image sets
`OPALARCHIVE_HEADLESS`, there being no browser in it to read a login from:
logins are sent by the browser extension, or uploaded in a downloader's
settings. OpalArchive has no login of its own, so the port is published
above to the machine itself only; reach it from another computer through
something that says who may, an SSH tunnel for one
(`ssh -L 7878:localhost:7878 server`).

The downloaders' Python packages are fetched when the image is built. To
update them, yt-dlp say, build it again.

## Testing

```sh
cargo test
```

The tests use a library in memory and a directory of their own under the
system's temporary one; they never touch `data/`. `src/query.rs` tests the
query language, and `src/api_tests.rs` the API, through its router.

## Configuration

| Variable        | Default          | Meaning                          |
| --------------- | ---------------- | -------------------------------- |
| `OPALARCHIVE_ADDR` | `127.0.0.1:7878` | Address the server listens on    |
| `OPALARCHIVE_DATA` | `data`           | Database and internal storage    |
| `OPALARCHIVE_WEB`  | `web/dist`       | Built frontend to serve          |
| `OPALARCHIVE_DOWNLOADERS` | `downloaders` | The folder of downloaders     |
| `OPALARCHIVE_HEADLESS` | unset | Set to `1` where the server has no browser to read a login from, as on a home server or in a container: logins are then sent to it as cookie files, by the browser extension or by uploading one |

There is no authentication, so the server listens on localhost only by
default.

## Icons

The icons are from [Material Symbols Light](https://icon-sets.iconify.design/material-symbols-light/)
(Google, Apache 2.0). The ones in use are inlined in
`web/src/components/Icon.tsx`; nothing is fetched at runtime.

## API

Everything is under `/api`. Bodies are JSON unless noted, and errors are
`{"error": "..."}` (query errors add a character `position` and the `line` it
is on, for a query of several lines).

| Method and path                  | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `POST /files?name=<filename>`    | Upload; the file is the raw body. 201 if new, 200 if a duplicate, which is only taken out of the trash if it was there. `tab=<id>` lists it under that upload tab either way |
| `POST /files/archive?name=<filename>` | Upload a zip, as the raw body, to be unpacked: its images, video, audio and books are taken in as uploads of their own, each folder becomes a set holding the files directly in it by name, and the archive is not kept. A sidecar in it (`<name>.json` beside a file, `_set.json` in a folder, or a set's anywhere) gives the file or set its metadata, as an export writes them: a file goes in every set its sidecar names, besides those it is in. `tab=<id>` lists its files under that upload tab. Answers `{added, duplicates, sets, failures}`, the last saying of each file passed over what it was and why, and of each sidecar what in it could not be used |
| `GET /tabs/{id}/upload`, `PATCH …` | The tags an upload tab gives to everything uploaded into it; `{tags}`, tag field to values → set them, for what is uploaded from then on |
| `POST /files/fetch`              | `{url, tab}` → have the server fetch the file at that web address, as an upload of it, with the address as its source URL. Answers as an upload does. A page is refused: the address has to be of the file itself |
| `GET /files/{id}/content`        | The file. `?download=1` to save rather than display, and with it `names=` for what it is saved as: `original` (the default), `title`, `hash` or `random` |
| `GET /files/{id}/thumbnail`      | JPEG thumbnail, 404 if the file has none. With `?v=` as a search result gives it (`thumbnail_version`), the answer may be kept for good; without, the browser asks again each time |
| `GET /search?q=&offset=&limit=`  | One page of results and the total. `seed` fixes `sort=random`; `tab=<id>` searches only what that upload or set tab holds, and `set=<id>` only that set's files, in its order unless the query sorts. `variants=<alt_group_id>` searches only the files of that variant group, and `collection=<name>` only what is part of that collection, itself or through a set. Each result lists the sets it is in (`sets`: `id`, `set_id`, `title` and how many `files` each holds), and its `alt_group_id` with how many files share it (`variants`). Trashed entities only match with `@trashed` in the query, or with `trashed=1` |
| `GET /search/ids?q=`             | IDs of every result, in order. Takes `seed`, `tab`, `set`, `variants` and `collection` too. With `collapse=1` a set is listed once, as the first of its files found; a search within a set or a variant group is not affected |
| `GET /entities/{id}`             | Everything about one file, the sets it is in (`sets`: each one's `id`, `set_id`, `title`, and the file's `index` in it) included |
| `POST /entities/metadata`        | `{ids}` → what those files have in common, and the sets any of them are in |
| `POST /entities/edit`            | `{ids, set, add, remove, add_source_url, remove_source_url, add_identifier, remove_identifier, add_reference, remove_reference, add_collection, remove_collection}` → the same edit applied to all. `set` takes `alt_group_id` too, which files that are variants of each other share; the `_source_url`, `_identifier` and `_reference` lists change those plain lists |
| `POST /entities/trash`           | `{ids}` → move to the trash: hidden from searches, nothing removed |
| `POST /entities/restore`         | `{ids}` → take back out of the trash                           |
| `POST /entities/delete`          | `{ids}` → delete for good those that are in the trash; files leave storage |
| `GET /tags?field=&q=`            | Completions for a tag field, one namespace level at a time     |
| `POST /tags`                     | `{field, value, description}` → create a tag nothing carries yet; it is kept until deleted |
| `POST /tags/describe`            | `{field, value, description}` → set a tag's description; empty clears it |
| `POST /tags/delete`              | `{field, value}` → delete a tag nothing carries                |
| `GET /tags/all?field=`           | Every tag of a field with its aliases, and how many alias uses await updating |
| `POST /tags/rename`              | `{field, from, to}` → rename a tag, merging it into `to` if that exists |
| `POST /tags/alias`               | `{field, alias, target}` → make `alias` stand for `target`; an empty `target` removes the alias |
| `POST /tags/aliases/apply`       | Replace aliases still on entities with the tags they stand for |
| `GET /sets?q=`                   | The sets whose title or set ID contains `q`, with how many files each holds, for picking one |
| `POST /sets`                     | `{files, title, set_id}` → a new set of those files, in that order, besides any sets they are in. Without a `set_id` it is given one; one another set has is refused |
| `GET /sets/{id}`                 | Everything about one set: `set_id`, `title`, `description`, how many files it holds, and its `source_url`, `identifier`, `reference` and `collection` lists |
| `PATCH /sets/{id}`               | `{set, add_source_url, remove_source_url, …}` as an edit of entities is written → change it, all or nothing. `set` takes `set_id`, `title` and `description`. A set has no tags |
| `DELETE /sets/{id}`              | Take the set apart: its files stay in the library               |
| `POST /sets/{id}/files`          | `{add, remove}` → put files in it, or take them out. A set left with none stays until empty sets are next cleared away, so that a file can be put back |
| `PUT /sets/{id}/order`           | `{ids}` → set the order of its files; those left out follow    |
| `POST /variants`                 | `{ids}` → make those files variants of each other: they get the `alt_group_id` one of them has, or a new one |
| `POST /export`                   | Form field `ids=1,2,3` → zip of those files. With `sidecars=1` it is an export: each file has a sidecar with its metadata beside it (`<name>.json`), and each set that says something of itself one of its own, in the format of `schema.md`. `names=` says what the files are called in the zip, as for one file |
| `GET /tabs`, `POST /tabs`        | List tabs; `{kind, query, set, downloader, ids}` → new tab, `kind` being `gallery`, `upload`, `set`, `download`, `selection` (which holds the entities in `ids`, and nothing else) or `inbox` (of which there is one: asked for again, it is the one there is, and closed it keeps what it lists) |
| `PATCH /tabs/{id}`, `DELETE …`   | `{query, name}`, either or both → change a tab; close a tab     |
| `PUT /tabs/order`                | `{ids}` → put the tabs in that order                           |
| `GET /tabs/{id}/view`, `PUT …`   | The snapshot a tab shows: `{query, ids, custom}`, or `null` if none is saved |
| `GET /downloaders`               | The downloaders, as their manifests describe them, with when each one's login was saved and what its options are set to (`settings`) |
| `PATCH /downloaders/{name}`      | `{options?, tags?}` → set that downloader's options, for every tab and the inbox, or the tags it gives to what it downloads for the inbox |
| `POST /downloaders/{name}/cookies`, `DELETE …` | `{browser}` → read the site's login from that browser and keep it; forget it |
| `POST /downloaders/{name}/cookies/file` | `{cookies}`, the text of a cookie file in the Netscape format → keep the site's login out of it |
| `GET /inbox`, `POST /inbox`      | The inbox: its tab, queue and each downloader's settings; `{url, downloader?, tags?}` → queue the address to be downloaded, by the downloader whose `sites` it is of |
| `GET /inbox/queue/{id}`, `DELETE …` | What became of a request; take it off the queue, or stop it if it is running |
| `POST /inbox/queue/{id}/retry`   | Queue again a request that failed or was stopped |
| `POST /inbox/clear`              | Empty what the inbox lists and its finished requests; nothing leaves the library |
| `GET /inbox/sites`               | The sites there is a downloader for |
| `GET /tabs/{id}/download`        | How a tab's download is going, or how its last went (`job`), and how many things it has seen |
| `POST /tabs/{id}/download/start`, `…/cancel` | `{url}` → start downloading it into the upload tab with the downloader whose site it is of, and answer `{downloader}` with its name, or `null`, with nothing started, if there is none for it; stop the download running |
| `GET /tabs/{id}/download/seen`, `POST …/seen/forget` | What the tab has downloaded before; `{keys}` → forget those, or all with no `keys` |
| `GET /settings`, `PATCH /settings` | Application settings as one JSON object; PATCH sets the keys given, `null` removing one |
| `GET /stats`, `GET /health`      | Library counts, with how many entities are trashed; liveness and schema version |

Uploading from a shell:

```sh
curl --data-binary @photo.jpg 'http://127.0.0.1:7878/api/files?name=photo.jpg'
```
