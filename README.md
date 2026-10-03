# tagutils

Media library with metadata, collections and search. See `SPEC.md` for the
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
- `data/` – created at runtime:
  - `tagutils.db` – the database
  - `storage/` – uploaded files, named `<sha256>.<extension>`
  - `thumbnails/` – one `<sha256>.jpg` per file that has a thumbnail
  - `tmp/` – uploads in progress

## Running

```sh
cargo run                      # API on http://127.0.0.1:7878
cd web && npm install && npm run dev   # frontend with live reload, proxies /api
```

For a single-process setup, build the frontend once with `npm run build` and
the server will serve it from `web/dist`.

## Configuration

| Variable        | Default          | Meaning                          |
| --------------- | ---------------- | -------------------------------- |
| `TAGUTILS_ADDR` | `127.0.0.1:7878` | Address the server listens on    |
| `TAGUTILS_DATA` | `data`           | Database and internal storage    |
| `TAGUTILS_WEB`  | `web/dist`       | Built frontend to serve          |

There is no authentication, so the server listens on localhost only by
default.

## Icons

The icons are from [Material Symbols Light](https://icon-sets.iconify.design/material-symbols-light/)
(Google, Apache 2.0). The ones in use are inlined in
`web/src/components/Icon.tsx`; nothing is fetched at runtime.

## API

Everything is under `/api`. Bodies are JSON unless noted, and errors are
`{"error": "..."}` (query errors add a character `position`).

| Method and path                  | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `POST /files?name=<filename>`    | Upload; the file is the raw body. 201 if new, 200 if a duplicate, which is only taken out of the trash if it was there. `tab=<id>` lists it under that upload tab either way |
| `GET /files/{id}/content`        | The file. `?download=1` to save rather than display            |
| `GET /files/{id}/thumbnail`      | JPEG thumbnail, 404 if the file has none                       |
| `GET /search?q=&offset=&limit=`  | One page of results and the total. `seed` fixes `sort=random`; `tab=<id>` searches only what that upload or collection tab holds. Trashed entities only match with `is=trashed` in the query, or with `trashed=1` |
| `GET /search/ids?q=`             | IDs of every result, in order. Takes `seed` and `tab` too      |
| `GET /entities/{id}`             | Everything about one file or collection                        |
| `POST /entities/metadata`        | `{ids}` → what those entities have in common                   |
| `POST /entities/edit`            | `{ids, set, add, remove}` → the same edit applied to all. `set` takes `ordered` (true or false) for collections |
| `POST /entities/trash`           | `{ids}` → move to the trash: hidden from searches, nothing removed |
| `POST /entities/restore`         | `{ids}` → take back out of the trash                           |
| `POST /entities/delete`          | `{ids}` → delete for good those that are in the trash; files leave storage |
| `GET /tags?field=&q=`            | Completions for a tag field, one namespace level at a time     |
| `GET /tags/all?field=`           | Every tag of a field with its aliases, and how many alias uses await updating |
| `POST /tags/rename`              | `{field, from, to}` → rename a tag, merging it into `to` if that exists. With `namespace: true`, rename a namespace on every tag under it; an empty `to` removes it |
| `POST /tags/alias`               | `{field, alias, target}` → make `alias` stand for `target`; an empty `target` removes the alias |
| `POST /tags/aliases/apply`       | Replace aliases still on entities with the tags they stand for |
| `POST /collections`              | `{collection_type, title, members, ordered, parent}` → new collection, put inside `parent` if given |
| `POST /collections/{id}/members` | `{add, remove}` → change membership                            |
| `PUT /collections/{id}/order`    | `{ids}` → set member positions; members left out follow        |
| `POST /export`                   | Form field `ids=1,2,3` → zip of those files                    |
| `GET /tabs`, `POST /tabs`        | List tabs; `{kind, query, collection}` → new tab, `kind` being `gallery`, `upload` or `collection` |
| `PATCH /tabs/{id}`, `DELETE …`   | `{query, name}`, either or both → change a tab; close a tab     |
| `PUT /tabs/order`                | `{ids}` → put the tabs in that order                           |
| `GET /stats`, `GET /health`      | Library counts, with how many entities are trashed; liveness and schema version |

Uploading from a shell:

```sh
curl --data-binary @photo.jpg 'http://127.0.0.1:7878/api/files?name=photo.jpg'
```
