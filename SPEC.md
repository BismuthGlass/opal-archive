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

An upload tab also takes web addresses, in a field beside its button. An address of a site there is a downloader for (a post, a board, a thread) is given to that downloader, which downloads what is there into the tab: see Downloaders. Any other address has to be of a file itself: the server fetches the file and takes it in as an upload, with the address as its source URL; a page is refused, and nothing is looked for inside it. Several addresses can be pasted at once, of either sort, and are taken one after the other.

Uploading a file that is already in the library changes nothing about the existing file, with one exception: if it is in the trash, it is taken out. Its metadata, name and tags stay as they are. It is still listed in the upload tab it was uploaded through, like any other upload.

## The schema

The metastasis v1.0 format describes a system using sidecar files. This should not be the case in our application. Instead the metadata should be stored in the SQLite database. Fields should be appropriately constrained to possible values, and no custom fields are allowed.

The format's `ai_content` field is left out. Whether a work is AI-made, and how far, is said with a `medium` tag like any other medium (`@me:ai`).

Every file records when it was added to the library, as a date and time to the second in ISO 8601 format, in UTC: `2026-10-03T12:20:37Z`. The application sets it; it is not editable. The interface shows it in local time.

## Sets and variants

There are no collections. A file says itself what it belongs with:

- The sets it is in, each by its `set_id`. A file can be in several.
- Where in each it comes, its `set_index` there. A set is always in an order; files that give no index follow those that do.
- `alt_group_id`: the group of variants it is one of. Files that share one are variants of each other. Nothing else is kept about a group: it is the ID alone.

A set is not an entity. It has no tags, score, date or rating, it is not in the trash or out of it, and a search never finds it: it finds files. Tagging is done on the files, once.

- A set is the ID its files give, as a collection is the name: files that give the same set ID are a set, and nothing else has to exist for it. Something can be said of the set itself: a title and a description, and the plain lists that say where it came from (source URLs, identifiers, references and collections). That is kept by the set ID, apart from the files, from the first thing said of it: a set nothing is said of has no record at all, and one that everything is taken off again has none either.
- The set ID is what says for certain which set is meant, here and in another library: `pinterest:pin:924574998519073090`. A set made without one being said is given one (`set:3f9a1c2e`). It can be changed, to one no other set has: the files, and what is known of the set, follow. The title is for people and need not be unique. A set with no title is called by its set ID.
- A file shows the set it is in, by its title, and the set is opened from there: in the side panel, on the file's tile in the gallery (a mark that it is in a set, which opens the set when it is in one only), and in the viewer. That is the only way to a set.
- What a set says of where it came from, its files are found by: `source_url~pinterest.com/pin/123` finds the files of the set with that address as well as files with it themselves. `set_id=`, `set_title~` and `alt_group_id=` find files by their set or group, and `set_id=pinterest:*` by namespace, as a tag is.
- A view lists every file of a set, each as a file. A setting has it list a set once instead, as one tile that looks like a stack: the first of the set's files that the search finds, in the order of the results. A file in several sets stands for all of them, and is itself passed over if one of them has been listed already. Double-clicking that tile goes into the set. Selecting it selects that one file, and acts on it alone: the rest of the set is reached by going in. A view of a set itself always lists all of it.
- Putting a file in a set leaves it in the sets it was in. Files in the trash still count as in their sets.
- A file taken out of the set on show stays listed there until the view is refreshed, faded and marked as no longer in the set, as a trashed file stays listed: taken out by mistake, it is put back from the same menu, after the files the set holds.
- A set taken apart on purpose is gone, with what was known of it, and its files stay in the library. One left with no file can still have its last file put back; what was known of it is forgotten when the server next clears away what is known of sets no file gives, which it does when it starts and whenever files are deleted or arrive.
- In the side panel a file's sets are a row of its details, listed and edited as its collections are: as text, each opening its set when clicked. A set is called there by its title where it has one, and by its ID otherwise; a collection always by its name, and a label that opens the list to add a set by its ID or take one off. Its variants are the row above, with a link that shows them, and its collections the row below.
- A selection is grouped from one item of its menu, Group, which opens to Set…, Collection… and Variant. The first two ask for a title and an ID, and list under them the sets, or collections, some of the selection is in already, to pick from. An ID that is in use is joined, and one that is not is made by being given: there is no difference to say. A set given no ID is made with one made up; a collection has to be given one. The title is for one that has none.
- Variants are grouped from a selection, which gives them a group ID made for them, or the one some of them already have, and ungrouped the same way. The group ID is not shown: a file says that it has variants, and shows them.
- A file that has variants says so, and they are opened from there as a set is: on its tile (a second mark, in another colour), in the side panel and in the viewer. The tile's marks carry no counts. The tab then shows the variants, and can be gone back out of.
- Broad piles that a file can be in several of are not sets: they are `bucket` tags.

Sidecar files are how metadata leaves the library and comes back into it: see Export and import.

## Export and import

A selection can be downloaded or exported. A download is the files alone. An export is a zip of the files with their metadata, as sidecars in the format of `schema.md`, for keeping outside the library or for taking to another one.

- Beside each file is its sidecar, `<name>.json`. Two files of one name are told apart in the zip, as in a download (`a.png`, `a (2).png`); the sidecar of each still has the name it had.
- A file's sidecar says which sets it is in, where in each, and which variant group it is of. That is enough to put it back in its sets.
- A collection that something is known of has a sidecar as well, named for it (`4chan_g_123.json` for `4chan:g:123`), which an import reads back.
- A set that says something of itself (a title, a description, where it came from) has a sidecar of its own as well, named for its set ID: `pinterest_pin_123.json` for `pinterest:pin:123`. A set that is its ID and nothing more has none.
- What the files are called, downloaded or exported, one or many, is a setting: the name each was uploaded under (the default), its title (its name, where it has no title), its hash, or random letters and digits that say nothing of it. Whichever it is, an export's sidecars have the name each file had, and an import gives it back.
- The zip is flat: there are no folders in it. What is in which set is said by the sidecars.

Uploading a zip reads the sidecars in it: this is the import. It works for any zip with sidecars in the format, not only an export.

- A file with a sidecar beside it is given what the sidecar says. A file the library did not have gets all of it, the name it had and when it was added included.
- A file the library already had keeps what it has. Tags, source URLs, identifiers, references and collections are added to; a field that holds one value (title, date, score, description…) is only filled in where the file has none. What the user wrote is never replaced.
- What the file itself says (its hash, size, dimensions, length) is always worked out from the file, never read from a sidecar.
- A set is the files that give its ID, whichever library they were in first: an import adds to it, and there is no second. A set's own sidecar fills in its title and description where it has none, and adds to its lists.
- Files are put in a set in the order their sidecars give. In a set the library already had, they follow what was there.
- A file is put in every set its sidecar names, besides those the library has it in.
- A folder still becomes a set named for it, of the files directly in it. A `_set.json` in the folder says which set that is and what is known of it. A file whose own sidecar names sets goes in those, whatever folder it is in. A folder that does not say which set it is takes only files that are in no set yet, so that sending the same zip twice makes no second set of the same files.
- Every file of the zip is listed in the upload tab.
- A sidecar is used as far as it can be. A value that is not allowed is left out, and said with the uploads that failed, by the sidecar's name; a field the library has no place for is ignored. A `.json` that is the sidecar of nothing in the zip is said too.

## Gallery views

What a view lists is decided when its search is calculated, and stays put after that: it is a snapshot, saved with its tab, so it is the same after switching tabs or reloading the page. Where a view was is kept as well: its page, how far it was scrolled, and what was selected in it, across switching tabs and reloading the page. Unlike what the view lists, this is remembered by the browser, not saved with the tab: another browser opens the same view at its top. The order results were dragged into and any that were taken out of the view are part of it. Editing, tagging, rating or trashing a file changes how it is shown, but it does not drop out of the view, and files that start matching do not appear. A Refresh button calculates the search again. A gallery tab opened with an empty query does not list the whole library by itself: it waits, listing nothing, until Search is pressed. The Search button is disabled while the query in the box is the one whose results are on show.

The exceptions are things that cannot or should not wait: a file deleted for good leaves, and what is put into a tab's own container from that tab is added (files uploaded into an upload tab or downloaded into a download tab, files put into the set a tab shows).

## Marks

A file can be given one of five marks, numbered and coloured, to sort through what is on show. Marks change nothing in the library, and are remembered by the browser.

Marks belong to the tab, not to one view of it. A file marked in a search is marked in its set too, once the tab goes into it, and in its variants and its collection; a file marked there is still marked after going back out. Another tab has marks of its own.

The count of each mark above the grid, and selecting by mark, take in only what the view on show lists. Clearing a mark takes it off everything in the tab that has it.

## Preview

The side panel ends in a drawer that shows the selected file: bigger than its tile, without opening the viewer. Of several selected, it shows the one selected last. Closed, the drawer is only its heading at the bottom of the panel; open, it takes the lower part of the panel, half of it at first and then as far as its top edge is dragged, and the rest of the panel scrolls above it, so that all of it can still be reached. Whether it is open and how tall are remembered by the browser. It shows what the viewer can: pictures, video and audio, which wait to be played, and PDFs.

## Stacked and saved queries

A search is a stack of queries, shown as rows in the search box. Each row is a query of its own, and narrows down what the rows before it found. A + under the rows adds one; a row can be taken out again. Rows left empty count for nothing.

A row can be saved under a name, to be used again: the + then offers the saved queries, and choosing one adds it as a row and runs the search. The row is a copy. Changing or deleting a saved query afterwards leaves the tabs that used it as they are.

The saved queries are a setting. The settings list them, to write, rename, delete and drag into the order they are offered in.

## Going into a set, a file's variants, or a collection

Pressing the set mark on a file's tile goes into its set, in the same tab: the view becomes the set's files, and a bar above it shows the way back. So does clicking the set in the side panel or in the viewer. A file's variants are gone into the same way, from the variants mark, and the view becomes the files of its group; and so is a collection, from its name in the side panel, and the view becomes what is part of it.

- The bar has a back arrow, what was gone through to get here, and a button that opens the set in a tab of its own; for variants or a collection, that tab is a search for them. From a file's variants the tab can go on into the set of one of them, and from a set into a file's variants: any earlier point of the way in can be gone back to directly. Backspace goes back one.
- Coming back out, the view outside is as it was left: the same results, order and page, scrolled as far, with the same selection.
- Inside, the search box filters the set, as it does in a set's own tab. The tab's query is untouched and is there again on coming out.
- A set is shown in its order, and a new order dragged into can be saved from here.
- With nothing selected, the side panel is about the set: its title, description, set ID and lists, to read and change, and a button to take it apart.
- What the tab is for (its upload box, its download panel) gives way while it is inside a set.
- The way in is remembered by the browser, like the tab that is active: reloading the page leaves each tab inside the set it was in, with its filter. A set gone meanwhile ends it.

## Playing a view

The viewer, opened on any result of a view, can play through the results by itself. A button starts and stops it; beside it are how many seconds each result stays up, and whether they come in the view's order or at random. Both are settings, kept for next time.

- In order, the last result is followed by the first. At random, no result comes twice before all have been shown.
- The seconds count from when an image has loaded. Video and audio are not cut off: they play to their end, and then the next result comes.
- What cannot be shown (a file with no preview) is passed over after a second.
- Stepping by hand while it plays moves on, and the count starts again.
- In the viewer, scrolling down steps to the next result and scrolling up to the one before, as the right and left arrows do.
- A right click on a result offers to preview it, which opens the viewer on it as a double click on a file does. With several selected it also offers to preview the selected: the viewer then steps and plays through those alone, in the order the view lists them, and counts them as "2 / 5 selected".

## Downloaders

A downloader fetches files from a website straight into the library. Each downloader is for one site: there is one for Pinterest, one for Reddit, one for Redgifs and one for 4chan. They are made to be added to: a downloader is a folder with a manifest and a script, and the server and the interface need no change for a new one. `downloaders/README.md` describes how they are written.

- A downloader has no tab of its own. An address pasted into an upload tab is given to the downloader whose site it is of, and what it downloads is listed in that tab with what was uploaded there. An address of no downloader's site is fetched as a file.
- What an address can be is up to the downloader. For Pinterest: a pin, a board, a section of a board, or a profile; or the address of a picture itself, on `pinimg.com`, which is downloaded at its full size whatever size the address is of, and gets the `source` tag as any pin's file does. For 4chan: a thread, whose posts' files are downloaded and with them the files the posts link to on catbox and the like; such a file gets both its own address and its post's as source URLs. For Redgifs: a video's page, the address of the video file itself, or a user's page, which stands for everything the user has posted.
- A downloader has options, set once for every tab and for Opal Drop, in a window of the settings of all the downloaders: each under its name, with its options and its login, one downloader after the other. An upload tab and Opal Drop each have a button that opens it. Pinterest has one: whether to go into what is inside (a board's sections, a profile's boards) or take only what sits directly in the board. 4chan has one: whether each file is described with the text of its post. Videos are always downloaded: there is no option to leave them out.
- Everything downloaded gets the address it came from as a source URL (for Pinterest, the pin's; for 4chan, the post's), and a `source` tag naming the site. That tag is implied. What is downloaded also gets the tags the upload tab gives to everything that arrives in it.
- What becomes a set is up to the downloader: nothing is grouped unless it asks. It gives the set a set ID, and may give it a title, an address, a description, a collection, and tags, which go to the set's files. The set gets the address as its source URL.
- The set ID is what a downloaded set is found by: downloading more of the same thing, in any tab, adds to the set that has the ID, and never makes a second. Its title is the user's to change, as is everything else about it. A file that is in another set already, as the same picture posted twice is, is then in both.
- A Pinterest pin of several images becomes a set holding them in order, with the set ID `pinterest:pin:<number>`, the pin as its source URL and the pin's description.
- A Pinterest pin that Pinterest labels "AI modified" gets the medium tag `ai_generated`.
- A Pinterest profile stands for the pins its owner created and, with going into what is inside turned on, for all its boards too. Its two tabs have addresses of their own, ending in `_created` and `_saved`, which stand for the one or the other alone. A created pin is given the collection `pinterest:<user>`.
- What is downloaded from a Pinterest board or section is not put in a set for it: that groups the pins more than is wanted. It is given a collection instead, `pinterest:<user>:<board>`, or `pinterest:<user>:<board>:<section>` for what is in a section: a pin of one image has it on its file, a pin of several on its set. A single pin downloaded by its own address has none.
- A set ID may be namespaced with colons in this way, as a tag is.
- A 4chan thread does not become a set. Each of its files is given the collection `4chan:<board>:<number>` instead, by which the files of a thread are found: a downloader may say what the things it fetches are part of, where a set would group them too much.
- A downloaded set is titled only where the site has a title for it: the set of a pin by the pin's title. Without one it has no title, as a file has none, and is called by its set ID.
- What one site shows from another is fetched by that other site's downloader, where there is one: a Reddit post that links to a Redgifs video is given to the Redgifs downloader, and the file then has what both give. It has the `source` tags of both sites and of both posters, the address of the Reddit post and of the Redgifs video as source URLs, and the post's title.
- A Redgifs video is tagged with its poster, as the source `redgifs:<username>`, as a Reddit post's files are with theirs. A post of several pictures becomes a set, with the set ID `redgifs:gallery:<id>`.
- A downloader also passes on what the site says of each thing, where it says anything: its title and description, and any tags the downloader makes of it. Title and description only fill in where there is none; what the user wrote is never replaced. Pinterest gives the pin's title and description.
- A file the library already has is not stored twice. It comes out of the trash if it was there, is listed in the tab, and is given the source URL and the tags like the rest.
- A tab remembers what it has downloaded, by address, and skips it when it is met again, without fetching it. Downloading the same board a second time in the same tab therefore fetches only what is new, and something deleted from the library does not come back. The list can be read, and entries forgotten, one or all. It belongs to the tab: another tab starts with none.
- Some sites show more to someone logged in. A downloader can read the site's login from a browser when asked to, and the server keeps it for later downloads, whichever tab asks for them, until told to forget it. It is kept in a file under the data directory that only the user can read; it is not encrypted.
- A download runs on the server, one per tab, and goes on while another tab is looked at or the page is reloaded. It can be cancelled. Closing its tab stops it.

## Deleting

Deleting is two steps. The first moves a file to the trash: it keeps its file and all its metadata, but no longer shows up in searches. From the trash it can be restored, or deleted for good, which removes the file from storage. Uploading a trashed file again restores it. The key that trashes does both steps: on files that are all in the trash already it deletes them for good, once that is agreed to. In the viewer, what took the deleted file's place is shown next.

Being trashed is a state, not a tag. States are searched with an `@`: `@trashed` lists the trash.

## The inbox

A file new to the library is in the inbox: it has just arrived, however it did (uploaded, downloaded, fetched, unpacked from a zip), and has yet to be looked over. Archiving it takes it out; it can be put back. Nothing else about the file changes either way, and a plain search finds it in the inbox or out of it.

- Being in the inbox is a state, as being trashed is: `@inbox` lists the inbox, `-@inbox` what was archived.
- It is the application's own, and no part of a file's metadata: it is not in the schema, an export does not write it, and a sidecar cannot set it. A file from a zip is in the inbox like any other new file.
- A file the library already has does not go back in the inbox by arriving again.
- The files the library held before there was an inbox started out of it.
- A key archives the selection, or the file open in the viewer, and another puts it back; the menu of a right click offers the same, by what the selection is in. A file in the inbox shows a dot on its tile, and says so in the viewer. The status bar counts the inbox, leaving out what is in the trash, and opens it in a tab.
- The inbox is not Opal Drop, the tab that lists what was sent to be downloaded from outside the interface.

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
- Source URLs, identifiers, references and collections are not tags. Each is a plain list on a file, with no namespaces, aliases or suggestions: source URLs are web addresses shown as links, the others are shown as text. They can still be searched, with `source_url=`, `identifier=`, `reference=`, `collection=` and the `~` forms.
- A collection says what a file, or a set, is part of where it came from: the board of a pin (`pinterest:<user>:<board>`), the thread of a post (`4chan:<board>:<number>`). It is a name, which is all it needs to be one: it groups nothing, and a file can have several.
- Something can be said of a collection itself, as of a set: a title, a description, and the plain lists of where it is (source URLs, identifiers, references). It is kept by the collection's name, apart from the files, from the first thing said: a collection nothing is said of has no record at all, and one that everything is taken off again has none either. Opened, with nothing selected, the side panel is about the collection and is where this is read and changed. A downloader may give a collection's address and title with its name: a 4chan thread links to the thread, a Pinterest board to the board.
- A file or a set names its collections by their names, whatever titles they have: the title is shown where the collection itself is. `collection=4chan:g:*` finds what is part of any thread of a board. A collection's name, where a file or a set lists it, is clicked to open it as a set is opened: the tab shows what is part of it, files of a set that is part of it included, and can be gone back out of. Downloaders fill it in. References are kept as a list of their own, for whatever else a file is to point at; nothing fills them in.

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
- Clicking a tag's pill in the side panel adds the tag to the query in the search box, without searching. A right click on it offers to search for the tag in a new tab, or to open it in the tag manager. The heading of a namespace does the same for everything in the namespace, without the tag manager.
- The settings also say which types are aggregated. The aggregated types share one list on a file, told apart only by colour; each of the others has a section of its own.
- By default the types that describe the work are aggregated (tags, creator, character, source work, person, genre, style, medium) and the rest are not (bucket, flaws, language, source, usage tags, AI usage tags).
- The order the types are listed in is configurable too, by dragging them in the settings. By default plain tags come last among the aggregated types.

### Writing tags

- Wherever a tag is typed, to add it or to search for it, its type is written in front of it: `@cr:name` is the creator `name`. A tag with nothing in front is a plain tag.
- Each type has a two-letter name: `@cr:` creator, `@ch:` character, `@sw:` source work, `@pe:` person, `@ge:` genre, `@st:` style, `@me:` medium, `@fl:` flaws, `@la:` language, `@so:` source, `@us:` usage tags, `@ai:` AI usage tags, `@bu:` bucket, and `@ta:` for plain tags. The full name works too (`@creator:`). Only the first colon ends the type; any after it belong to the tag's namespaces.
- There is one place to add and remove tags, for every type: the tagger. Typing `@` suggests the types; after the colon the suggestions are that type's tags.
- Tags put on and taken off there change nothing until they are saved: they wait, shown as they will be, a tag to be put on standing out and one to be taken off struck through, and each can be called off. They are saved with the Save button or with Shift and Enter, which also takes in a tag still typed in the box. Closing the window with changes waiting asks first; the Discard button drops them without asking.
- The same goes for searching: `@us:wallpaper` finds that usage tag, `@us:*` everything with a usage tag. There is no other way to search tags by type.
- No tag can start with `@`.
- `@` is also how other things are told apart from plain tags. `@trashed` is the first: a state rather than a tag.
- Tags are still shown without the `@`: as pills in their type's colours, in the aggregated list or in their type's section.

### Aliases

- A tag can be an alias of another tag of the same type. The alias defers to that tag: wherever the alias is added to a file or searched for, the tag it defers to is used instead.
- Aliases don't chain. Making a tag an alias of something that is itself an alias points it at the final tag, and a tag that gains an alias target takes its own aliases along.
- Making an existing tag an alias does not rewrite the files that carry it. They keep the old tag until "Update aliases" is pressed, which replaces every alias still on a file with the tag it defers to. Until then those files are not found by searching for either name.
- Removing an alias makes it an ordinary name again; nothing is changed back on files.
- An alias is still a tag: files may carry it until the aliases are updated, and it can have a description of its own.

### Child tags

- A tag can have child tags: tags that are added to a file along with it. The tag is their parent. Adding `samus aran` can add `@sw:metroid` too.
- A child can be of any type, and a tag can have several. A child's own children are added as well.
- It happens once, when the parent is added to a file that did not carry it. Taking the parent off leaves the children on, and a child taken off does not come back unless the parent is taken off and added again.
- It happens wherever tags are added by hand or by a tab: in the tagger, and for the tags an upload, download or inbox tab gives. Importing a file's metadata from a sidecar adds only the tags written there.
- In the tagger the children show as soon as their parent is put on, waiting with it and marked with the tag that brings them. Each can be called off before saving, and calling the parent off calls them off too. What is saved is what is shown, on every file selected.
- Giving a tag a child changes nothing on the files that already carry the tag.
- Child tags follow a renamed tag, and go when either tag is deleted. An alias has no children: adding it adds the tag it defers to, and that tag's children.

### Tag manager

- A modal listing every tag of a type, with how many files carry it. Its text box filters the plain tags, or with a type in front (`@us:`, `@us:*`, `@us:wall`) the tags of that type.
- A tag can be created here before any file carries it, by typing a name that does not exist yet. It is then offered as a suggestion when tagging.
- Selecting a tag in the list shows its details beside it: its description, its aliases, and the buttons to rename, merge and delete it.
- A tag's description can be long, for instance a few paragraphs about an author. Its start is shown in the list and with the tag's suggestions, and the whole of it in the tooltip of the tag's pill.
- A tag that no file carries can be deleted.
- A tag can be renamed. Giving it the name of another tag merges the two.
- Aliases are listed in the details of the tag they defer to, and can be added and removed there.
- An alias is also in the list of tags, as its name struck out, an arrow, and the tag it defers to. Its details show its own description and how many files still carry it, with a button to go to the tag it defers to and one to stop it being an alias. It cannot be renamed or given aliases while it is one.
- Child tags are listed in the details of their parent, and can be added and removed there. A child is typed as any tag is: a plain name, or `@sw:name` for another type, with the same suggestions as when tagging.
- The "Update aliases" button lives here and shows how many uses are waiting.

### Decisions

- A namespace is not itself a tag. Searching `metroid` does not find a file tagged only `metroid:samus`; `metroid:*` does, and `metroid` is its own tag.
- A bare name does not reach into namespaces. Searching `samus` does not find `metroid:samus`; `*:samus` does. This keeps it possible to ask for only the tag without a namespace.
- A tag does not need to exist before it is used. Typing a new one creates it, and a tag no file carries any more disappears, unless it was created or described in the tag manager: those are kept until deleted there.
