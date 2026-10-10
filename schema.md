# Metadata schema

This file describes the metastasis v2.0 format for media file metadata.  It is the format OpalArchive writes when it exports, and reads from the sidecars of a zip that is uploaded; what the library stores is what decides it.

Metadata is stored as a JSON object in a sidecar file with the same path as the media file, but with a `.json` extension appended.  The sidecar file for `file.png` is `file.png.json`.

Files that belong together are a set.  A file lists the sets it is in under `sets`, each by its `set_id`, with where in it the file comes as `set_index`; it can be in several.  That is all a set needs: files that give the same `set_id` are in the same set, and no other file has to exist for it.

A set may say something of itself as well: a title, a description, where it came from.  That goes in a sidecar of its own, which says so with `metadata_type: "set"` and may be anywhere.  It is conventionally named for the set ID (`pinterest_pin_123.json` for `pinterest:pin:123`), but it is its `set_id` field that says which set it is of; one with no `set_id` is of the set named as the sidecar is, minus the `.json` extension.  A set has no tags and none of the fields that describe a work: those are its files'.

A directory can be a set.  Its files, those directly in it, are in the set of the directory unless their own sidecars name sets.  A `_set.json` file in the directory is that set's sidecar: it gives the set its `set_id` and whatever else is known of it.

Files that are variants of each other (another crop, another resolution, an edit) share an `alt_group_id`.  A group is the ID alone: nothing else is said of it.

Field names are lowercase snake_case.  The TypeScript interfaces below describe the JSON representation.

```ts
type ContentRating = "safe" | "risky" | "nsfw";
type MetadataType = "file" | "set";

// The sidecar of a set.
interface SetMetadata {
  metadata_type: "set";

  // Which set: what its files give as their `set_id`.  No two sets
  // share one.  Unlike the title, which is for people and need not be
  // unique, it says for certain which set is meant:
  // `pinterest:pin:924574998519073090`, or a UUID.
  set_id?: string;

  title?: string;

  // Human-readable description.
  description?: string;

  // Where the set came from, as a file's fields of the same names.
  source_url?: string[];
  identifier?: string[];
  reference?: string[];
}

// A set a file is in.
interface FileSet {
  // Which set.  A sidecar for the set is optional, and it's valid to
  // simply use `set_id` to tie files together.
  set_id: string;

  // Position within the set: files come lowest first, and those
  // without one after them.
  set_index?: number;
}

interface FileMetadata {
  // Defines what this metadata file describes.
  // If omited, the type is "file".
  metadata_type?: MetadataType;

  // Date and time added to the library, to the second, in UTC:
  // `2026-10-03T12:20:37Z`.
  date_added?: string;

  // Artists or other creators.
  creator?: string[];

  // Title of the work.
  title?: string;

  // The sets the file is in.
  sets?: FileSet[];

  // A file in one set may name it here instead, as one of `sets`
  // is written.  Both are read; `sets` is what is written.
  set_id?: string;
  set_index?: number;

  // What the file shares with the files it is a variant of.
  alt_group_id?: string;

  // Work's date, e.g. YYYY or YYYY-MM-DD.
  date?: string;

  // E.g. digital_art, photography, oil_painting.
  medium?: string[];

  // E.g. cyberpunk, historic, horror, cosplay.
  genre?: string[];

  // E.g. anime, hyperrealistic, sketch, monochrome.
  style?: string[];

  // E.g. cropped, censored, jpeg_artifacting.
  flaws?: string[];

  // Real people depicted.
  person?: string[];

  // Source IP, series, or other originating work.
  source_work?: string[];

  // Fictional characters depicted.
  character?: string[];

  // Rating from 1 to 7.
  score?: number;

  // Version or state, e.g. WIP.
  version?: string;

  // Suitability of the content.
  content_rating?: ContentRating;

  // Languages associated with the file.
  language?: string[];

  // General descriptive tags.
  tags?: string[];

  // The broad piles the file is kept in, for keeping apart
  // things that have little to do with each other.
  bucket?: string[];

  // Human-readable description.
  description?: string;

  // Other IDs, e.g. a website ID.
  identifier?: string[];

  // References for the file, as a plain list of strings.
  reference?: string[];

  // Description provided to an AI to identify the file.
  ai_description?: string;

  // Tags for the file's intended use.
  usage_tags?: string[];

  // Tags to be referenced by AI.
  ai_usage_tags?: string[];

  // Platform or website from where file was retrieved.
  source?: string[];

  // The actual URL containing the file.
  // May also include things like the URLs for pages where the file appears.
  source_url?: string[];

  // The following are various file attributes for ease of access. it
  // prevents having to process the file each time we want to do a
  // search based on these parameters.  A reader that has the file works
  // them out from it, and does not take them from here.
  hash?: string; // SHA-256, in lowercase hex.
  extension?: string; // Lowercase, without the dot.
  media_type?: "image" | "video" | "audio" | "book" | "other";
  size?: number; // In bytes.
  // The name the file had before it was stored.  The file may be under
  // another name beside its sidecar, where two had the same.
  original_name?: string;
  width?: number;
  height?: number;
  page_count?: number;
  length?: number; // In seconds.
  looping?: boolean
}
```

All fields are optional.  Fields without values may simply be omited.  A field that holds a list may hold one value by itself instead.

The library has no custom fields: a field not listed here is ignored when a sidecar is read, and is not kept.  A value the library does not allow (a `score` of 9, a `content_rating` that is none of those listed, a `date` in another form, a `set_index` that is not a whole number, a tag starting with `@`) is left out and reported, and the rest of the sidecar is still used.

## Changes

v2.0: collections are gone.  A file lists the sets it is in under `sets`, each with its `set_id` and `set_index`, in place of the `collection` list, and variants share an `alt_group_id` in place of a collection of that type.  A set's own sidecar has `metadata_type: "set"` and only a title, a description and the lists that say where it came from; it has no type, no tags, and cannot be in another set.  A directory's is `_set.json`, formerly `_collection.json`.  `collection_id`, `collection_type` and `ordered` are gone: a set is always in the order its files give.

v1.1: a collection says what it is itself, with `collection_type` and `ordered`, and need not have a `collection_id`; `date_added` is a date and time; `media_type`, `size` and `original_name` are added to the file attributes; `ai_content` is gone, a `medium` tag saying it instead; unknown fields are ignored rather than preserved, and unknown values are refused rather than only warned about.
