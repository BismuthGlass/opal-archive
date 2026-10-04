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

Uploading a file that is already in the library changes nothing about the existing file, with one exception: if it is in the trash, it is taken out. Its metadata, name and tags stay as they are. It is still listed in the upload tab it was uploaded through, like any other upload.

## The schema

The metastasis v1.0 format describes a system using sidecar files. This should not be the case in our application. Instead the metadata should be stored in the SQLite database. Fields should be appropriately constrained to possible values, and no custom fields are allowed.

The format's `ai_content` field is left out. Whether a work is AI-made, and how far, is said with a `medium` tag like any other medium (`@me:ai`).

Every file and collection records when it was added to the library, as a date and time to the second in ISO 8601 format, in UTC: `2026-10-03T12:20:37Z`. The application sets it; it is not editable. The interface shows it in local time.

Collections should behave as their own entities that may also be categorized and searched in the same way as files. The hierarchical directory concept of categories does not apply, as the system isn't directory based. Groups can still belong to other groups, however.

There is no need to support injesting existing sidecar files on file upload for now. We will also support exporting sidecar files, but that's in the future.

## Gallery views

What a view lists is decided when its search is calculated, and stays put after that: it is a snapshot, saved with its tab, so it is the same after switching tabs or reloading the page. The order results were dragged into and any that were taken out of the view are part of it. Editing, tagging, rating or trashing a file changes how it is shown, but it does not drop out of the view, and files that start matching do not appear. A Refresh button calculates the search again.

The exceptions are things that cannot or should not wait: a file deleted for good leaves, and what is put into a tab's own container from that tab is added (files uploaded into an upload tab or downloaded into a download tab, a collection created inside the collection a tab shows).

## Stacked and saved queries

A search is a stack of queries, shown as rows in the search box. Each row is a query of its own, and narrows down what the rows before it found. A + under the rows adds one; a row can be taken out again. Rows left empty count for nothing.

A row can be saved under a name, to be used again: the + then offers the saved queries, and choosing one adds it as a row and runs the search. The row is a copy. Changing or deleting a saved query afterwards leaves the tabs that used it as they are.

The saved queries are a setting. The settings list them, to write, rename, delete and drag into the order they are offered in.

## Playing a view

The viewer, opened on any result of a view, can play through the results by itself. A button starts and stops it; beside it are how many seconds each result stays up, and whether they come in the view's order or at random. Both are settings, kept for next time.

- In order, the last result is followed by the first. At random, no result comes twice before all have been shown.
- The seconds count from when an image has loaded. Video and audio are not cut off: they play to their end, and then the next result comes.
- What cannot be shown (a collection, a file with no preview) is passed over after a second.
- Stepping by hand while it plays moves on, and the count starts again.

## Downloaders

A downloader fetches files from a website straight into the library, in a tab of its own kind. Each downloader is for one site; the first is for Pinterest. They are made to be added to: a downloader is a folder with a manifest and a script, and the server and the interface need no change for a new one unless it wants a panel of its own. `downloaders/README.md` describes how they are written.

- A download tab belongs to one downloader. At its top is a box to paste an address into; under it, what was downloaded through the tab, as in an upload tab.
- What an address can be is up to the downloader. For Pinterest: a pin, a board, a section of a board, or a profile.
- A downloader has options, set per tab. Pinterest has two: whether to go into what is inside (a board's sections, a profile's boards) or take only what sits directly in the board, and whether to download videos.
- Everything downloaded gets the address it came from as a source URL (for Pinterest, the pin's), and a `source` tag naming the site. That tag is implied and not shown among the tab's settings. A tab can also be given tags of its own, of any type, which everything it downloads gets as well.
- Something that is several files (a Pinterest pin with several images) also becomes a `set` holding them in order, titled as the thing is. The set is not listed in the tab; its files are.
- Boards and sections do not become collections: what is downloaded is flat.
- A downloader also passes on what the site says of each thing, where it says anything: its title and description, and any tags the downloader makes of it. Title and description only fill in where there is none; what the user wrote is never replaced. Pinterest gives the pin's title and description.
- A file the library already has is not stored twice. It comes out of the trash if it was there, is listed in the tab, and is given the source URL and the tags like the rest.
- A tab remembers what it has downloaded, by address, and skips it when it is met again, without fetching it. Downloading the same board a second time in the same tab therefore fetches only what is new, and something deleted from the library does not come back. The list can be read, and entries forgotten, one or all. It belongs to the tab: another tab of the same downloader starts with none.
- Some sites show more to someone logged in. A downloader can read the site's login from a browser when asked to, and the server keeps it for later downloads, for every tab of that downloader, until told to forget it. It is kept in a file under the data directory that only the user can read; it is not encrypted.
- A download runs on the server, one per tab, and goes on while another tab is looked at or the page is reloaded. It can be cancelled. Closing its tab stops it.

## Deleting

Deleting is two steps. The first moves a file or collection to the trash: it keeps its file and all its metadata, but no longer shows up in searches. From the trash it can be restored, or deleted for good, which removes the file from storage. Uploading a trashed file again restores it.

Being trashed is a state, not a tag. States are searched with an `@`: `@trashed` lists the trash. It is the only state for now.

## Authentication

The application doesn't need to support authentication for now.

## Tags

Every multi-value text field of the schema (tags, creator, character, flaws, medium, and so on) is a tag. There is one tag system, and those fields are its **types**.

### Types

- A tag is a value together with its type. `samus` as a `character` and `samus` as a plain `tags` entry are two different tags.
- A search only looks at the type it names. A plain search term looks at `tags` only, so creator or flaw tags never show up among regular tags.
- The set of types is fixed and comes from the schema. No custom types, in line with "no custom fields".
- `bucket` is the type for keeping apart things that have little to do with each other: the broad pile a file belongs in (`@bu:reference`, `@bu:wallpapers`). A file can be in several. It is a tag like the others, so it is not a wall: a search looks everywhere unless it names a bucket.
- Tags are case insensitive.

### Namespaces

- A tag may be placed in a namespace, written `<namespace>:<tag>`, as in `metroid:samus`.
- Namespaces nest without limit: `nintendo:metroid:samus`. Everything before the last colon is the namespace; the last part is the tag's own name.
- A namespace is not a separate thing to create or manage. It exists as long as some tag is written under it.
- The parts between colons can't be empty and have no spaces around them: `metroid: samus` is stored as `metroid:samus`, and `metroid::samus` is not a valid tag.
- Namespaces apply within a type. `metroid:samus` as a `character` says nothing about a `metroid` namespace in `tags`.
- Source URLs and identifiers are not tags. Each is a plain list on a file, with no namespaces, aliases or suggestions: source URLs are web addresses shown as links, identifiers are shown as chips. They can still be searched, with `source_url=`, `identifier=` and the `~` forms.

### Searching

- `metroid:samus` finds exactly that tag.
- `metroid:*` finds everything under the namespace, at any depth: `metroid:samus` and also `metroid:prime:ridley`.
- `*:samus` finds the tag `samus` in any namespace.
- `samus` alone finds only the tag with no namespace. It does not find `metroid:samus`.
- `metroid` alone finds only the tag `metroid`, not the tags under the namespace of that name.
- All of this works the same with a type in front: `@ch:metroid:*`.

### Interface

- When typing a tag, suggestions complete one level at a time: first the namespaces, then what is inside the chosen one. A bare name typed at the top level also suggests tags of that name inside namespaces.
- Tags on a file are shown grouped by namespace, so a long list stays readable.

### Showing tags

- A tag is shown as a pill in the colours of its type. Each type has a background and a text colour, both configurable in the settings.
- The settings also say which types are aggregated. The aggregated types share one list on a file, told apart only by colour; each of the others has a section of its own.
- By default the types that describe the work are aggregated (tags, creator, character, source work, person, genre, style, medium) and the rest are not (bucket, flaws, language, source, usage tags, AI usage tags).
- The order the types are listed in is configurable too, by dragging them in the settings. By default plain tags come last among the aggregated types.

### Writing tags

- Wherever a tag is typed, to add it or to search for it, its type is written in front of it: `@cr:name` is the creator `name`. A tag with nothing in front is a plain tag.
- Each type has a two-letter name: `@cr:` creator, `@ch:` character, `@sw:` source work, `@pe:` person, `@ge:` genre, `@st:` style, `@me:` medium, `@fl:` flaws, `@la:` language, `@so:` source, `@us:` usage tags, `@ai:` AI usage tags, `@bu:` bucket, and `@ta:` for plain tags. The full name works too (`@creator:`). Only the first colon ends the type; any after it belong to the tag's namespaces.
- There is one place to add and remove tags, for every type. Typing `@` suggests the types; after the colon the suggestions are that type's tags.
- The same goes for searching: `@us:wallpaper` finds that usage tag, `@us:*` everything with a usage tag. There is no other way to search tags by type.
- No tag can start with `@`.
- `@` is also how other things are told apart from plain tags. `@trashed` is the first: a state rather than a tag.
- Tags are still shown without the `@`: as pills in their type's colours, in the aggregated list or in their type's section.

### Aliases

- A tag can be an alias of another tag of the same type. The alias defers to that tag: wherever the alias is added to a file or searched for, the tag it defers to is used instead.
- Aliases don't chain. Making a tag an alias of something that is itself an alias points it at the final tag, and a tag that gains an alias target takes its own aliases along.
- Making an existing tag an alias does not rewrite the files that carry it. They keep the old tag until "Update aliases" is pressed, which replaces every alias still on a file with the tag it defers to. Until then those files are not found by searching for either name.
- Removing an alias makes it an ordinary name again; nothing is changed back on files.

### Tag editor

- A modal listing every tag of a type, with how many files carry it. Its text box filters the plain tags, or with a type in front (`@us:`, `@us:*`, `@us:wall`) the tags of that type.
- A tag can be created here before any file carries it, by typing a name that does not exist yet. It is then offered as a suggestion when tagging.
- Selecting a tag in the list shows its details beside it: its description, its aliases, and the buttons to rename, merge and delete it.
- A tag's description can be long, for instance a few paragraphs about an author. Its start is shown in the list and with the tag's suggestions, and the whole of it in the tooltip of the tag's pill.
- A tag that no file carries can be deleted.
- A tag can be renamed. Giving it the name of another tag merges the two.
- Aliases are listed in the details of the tag they defer to, and can be added and removed there.
- The "Update aliases" button lives here and shows how many uses are waiting.

### Decisions

- A namespace is not itself a tag. Searching `metroid` does not find a file tagged only `metroid:samus`; `metroid:*` does, and `metroid` is its own tag.
- A bare name does not reach into namespaces. Searching `samus` does not find `metroid:samus`; `*:samus` does. This keeps it possible to ask for only the tag without a namespace.
- A tag does not need to exist before it is used. Typing a new one creates it, and a tag no file carries any more disappears, unless it was created or described in the tag editor: those are kept until deleted there.
