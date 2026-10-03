# Idea

I would like to have a tool to organize and categorize all my media, including images, videos, books and audio. Each file will be assigned metadata as described in `schema.md`. This format is primarily for JSON sidecars, but in this case we will be using it over a dedicated database.

As for bulk, we are talking about managing a couple tens of thousands of files.

## Techstack

This will be a rust application exposing an API. This API will mainly be accessed through an SPA frontend. Uploaded files will be managed by the application itself, and stored in internal storage.

Since the program deals with media, we can use tools such as ffmpeg and imagemagick and others to retrieve and handle data from files, such as their resolution and so on. In other words, it's fine to use external CLI tools, provided that these are documented as dependencies.

The SPA should be light:

- Rust
- SQLite
- SolidJS

Minimize third party libraries beyond this as much as possible, unless they are reliable and would save considerable development effort (it's ok to use a rust crate for handling SQLite, for example.)

There are future plans for a CLI tool, but that is not described yet. It should be kept in mind when designing the API.

## Key features

- Easy to mass edit file metadata
- Easy to export / download files, including bulk downloads
- Robust group system
- Accessible to most platforms, browser based
- Modern UI focused on performance
- Robust query system for finding files, text based
- Persistent search tabs

## Internal storage

Uploaded files should be brought into internal storage, with their hash for a filename (keep extension intact). The user is never expected to see or access this internal storage.

Thumbnails should also be stored for each file (in a separate dir).

## The schema

The metastasis v1.0 format describes a system using sidecar files. This should not be the case in our application. Instead the metadata should be stored in the SQLite database. Fields should be appropriately constrained to possible values, and no custom fields are allowed.

Collections should behave as their own entities that may also be categorized and searched in the same way as files. The hierarchical directory concept of categories does not apply, as the system isn't directory based. Groups can still belong to other groups, however.

There is no need to support injesting existing sidecar files on file upload for now. We will also support exporting sidecar files, but that's in the future.

## Authentication

The application doesn't need to support authentication for now.

## Tags

Every multi-value text field of the schema (tags, creator, character, flaws, medium, and so on) is a tag. There is one tag system, and those fields are its **types**.

### Types

- A tag is a value together with its type. `samus` as a `character` and `samus` as a plain `tags` entry are two different tags.
- A search only looks at the type it names. A plain search term looks at `tags` only, so creator or flaw tags never show up among regular tags.
- The set of types is fixed and comes from the schema. No custom types, in line with "no custom fields".
- Tags are case insensitive.

### Namespaces

- A tag may be placed in a namespace, written `<namespace>:<tag>`, as in `metroid:samus`.
- Namespaces nest without limit: `nintendo:metroid:samus`. Everything before the last colon is the namespace; the last part is the tag's own name.
- A namespace is not a separate thing to create or manage. It exists as long as some tag is written under it.
- The parts between colons can't be empty and have no spaces around them: `metroid: samus` is stored as `metroid:samus`, and `metroid::samus` is not a valid tag.
- Namespaces apply within a type. `metroid:samus` as a `character` says nothing about a `metroid` namespace in `tags`.
- Types whose values are not names don't have namespaces: in `source_url` a colon is just part of the address.

### Searching

- `metroid:samus` finds exactly that tag.
- `metroid:*` finds everything under the namespace, at any depth: `metroid:samus` and also `metroid:prime:ridley`.
- `*:samus` finds the tag `samus` in any namespace.
- `samus` alone finds only the tag with no namespace. It does not find `metroid:samus`.
- All of this works the same with a type in front: `character=metroid:*`.

### Interface

- When typing a tag, suggestions complete one level at a time: first the namespaces, then what is inside the chosen one.
- Tags on a file are shown grouped by namespace, so a long list stays readable.
- A namespace can be renamed or merged as a whole, which renames every tag under it.

### Open questions

- Should a namespace also count as a tag? That is, should searching `metroid` find a file tagged only `metroid:samus`? The text above says no: a file is found by `metroid:*`, and `metroid` is its own tag.
- Should `samus` alone find `metroid:samus`? The text above says no, and `*:samus` is the way to ask for it. Saying yes makes casual searches friendlier but makes it impossible to ask for only the tag without a namespace.
- Does a tag need to exist before it can be used, or is it created by typing it, as now?
