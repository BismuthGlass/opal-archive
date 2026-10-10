# Metadata schema

This file describes the metastasis v1.1 format for media file metadata.  It is the format OpalArchive writes when it exports, and reads from the sidecars of a zip that is uploaded; what the library stores is what decides it.

Metadata is stored as a JSON object in a sidecar file with the same path as the media file, but with a `.json` extension appended.  The sidecar file for `file.png` is `file.png.json`.  We can also have metadata not attached to any files, such as metadata for collections.  Such a sidecar says so with `metadata_type: "collection"`, and may be anywhere.

A collection is referred to by an ID.  That is its `collection_id` where it has one.  A collection need not have one: its ID is then the name of its sidecar minus the `.json` extension, so `collection.json` can be referred to by the ID `collection`, and that ID means something only beside that sidecar.  An ID that no sidecar answers to is a `collection_id`: every file that refers to it is in the one collection that has it.

A special type of collection is a collection tying all the files inside a directory together.  This can be done by adding a `_collection.json` file to the directory.  Files within the directory may still have their own metadata, but they implicitly belong to the directory's collection.  Directories with a `_collection.json` file are also implicitly included as a single unit to collections defined in their parent directories (but their contents aren't, so this is not recursive.)

Both files and collections share the same metadata format. Field names are lowercase snake_case.  The TypeScript interfaces below describe the JSON representation.

```ts
type ContentRating = "safe" | "risky" | "nsfw";
type CollectionType = "variant" | "set" | "sourceset" | "sequence" | "usercollection";
type MetadataType = "file" | "collection";

interface FileCollection {
  // Which collection: its `collection_id`, or for a collection that
  // has none the name of its sidecar, without `.json`.
  // A sidecar for the collection is optional, and it's valid to simply
  // use `id` to tie files together.
  id: string;

  // How the files are related.  The collection's own sidecar, if it has
  // one, is what decides this; it is repeated here for when it has none.
  collection_type: CollectionType;

  // Position within the collection, if it keeps its members in order:
  // members come lowest first.
  index?: number;
}

interface FileMetadata {
  // Defines what type of entity this metadata file describes.
  // If omited, the type is "file".
  metadata_type?: MetadataType;

  // Date and time added to the library, to the second, in UTC:
  // `2026-10-03T12:20:37Z`.
  date_added?: string;

  // Artists or other creators.
  creator?: string[];

  // Title of the work.
  title?: string;

  // For a collection: its identifier, the `id` its members refer to it
  // by. No two collections share one. Unlike the title, which is for
  // people and need not be unique, it says for certain which collection
  // is meant: `pinterest:pin:924574998519073090`, or a UUID.
  // A collection may have none.
  collection_id?: string;

  // For a collection: how its members are related.
  collection_type?: CollectionType;

  // For a collection: whether its members are kept in an order, the one
  // their `index` gives.
  ordered?: boolean;

  // Collections this file belongs to.
  // Since collections may have their own metadata, they can
  // also belong to other collections.
  collection?: FileCollection[];

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

The library has no custom fields: a field not listed here is ignored when a sidecar is read, and is not kept.  A value the library does not allow (a `score` of 9, a `content_rating` or `collection_type` that is none of those listed, a `date` in another form, a tag starting with `@`) is left out and reported, and the rest of the sidecar is still used.

## Changes

v1.1: a collection says what it is itself, with `collection_type` and `ordered`, and need not have a `collection_id`; `date_added` is a date and time; `media_type`, `size` and `original_name` are added to the file attributes; `ai_content` is gone, a `medium` tag saying it instead; unknown fields are ignored rather than preserved, and unknown values are refused rather than only warned about.
