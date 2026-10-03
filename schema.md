# Metadata schema

This file describes the metastasis v1.0 format for media file metadata.

Metadata is stored as a JSON object in a sidecar file with the same path as the media file, but with a `.json` extension appended.  The sidecar file for `file.png` is `file.png.json`.  We can also have metadata not attached to any files, such as metadata for collections, in which case the name of the file minus the `.json` extension is the ID of the collection.  So `collection.json` can be referred to by the ID `collection`.

A special type of collection is a collection tying all the files inside a directory together.  This can be done by adding a `_collection.json` file to the directory.  Files within the directory may still have their own metadata, but they implicitly belong to the directory's collection.  Directories with a `_collection.json` file are also implicitly included as a single unit to collections defined in their parent directories (but their contents aren't, so this is not recursive.)

Both files and collections share the same metadata format. Field names are lowercase snake_case.  The TypeScript interfaces below describe the JSON representation.

```ts
type ContentRating = "safe" | "risky" | "nsfw";
type AiContent = "none" | "partial" | "full" | "unknown";
type CollectionType = "variant" | "set" | "sourceset" | "sequence" | "usercollection";
type MetadataType = "file" | "collection";

interface FileCollection {
  // Collection identifier (typically a UUID).
  // Collection metadata may be stored in `<id>.json`, but this is optional,
  // and it's valid to simply use `id` to tie files together.
  id: string;

  // How the files are related.
  collection_type: CollectionType;

  // Position within the collection, if applicable.
  index?: number;
}

interface FileMetadata {
  // Defines what type of entity this metadata file describes.
  // If omited, the type is "file".
  metadata_type?: MetadataType;

  // Date added to the collection.
  date_added?: string;

  // Artists or other creators.
  creator?: string[];

  // Title of the work.
  title?: string;

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

  // Human-readable description.
  description?: string;

  // Other IDs, e.g. a website ID.
  identifier?: string[];

  // Extent to which the content is AI-generated.
  ai_content?: AiContent;

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
  // search based on these parameters.
  hash?: string;
  extension?: string;
  width?: number;
  height?: number;
  page_count?: number;
  length?: number; // In seconds.
  looping?: boolean
}
```

All fields are optional.  Fields without values may simply be omited.  Arbitrary fields are allowed and should be preserved.  String enum properties may have arbitrary values, although checks on the format should warn about unknown values.
