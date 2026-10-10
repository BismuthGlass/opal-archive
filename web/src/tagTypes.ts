import { TAG_FIELDS } from "./api";
import { saveSetting, settings } from "./settings";

/** How a tag type is shown: the colour of its tags, and where they go. */
export type TagType = {
  /**
   * The colour its tags are written in, on a light theme and on a dark
   * one. Null is the theme's own text colour.
   */
  light: string | null;
  dark: string | null;
  /**
   * Whether its tags are shown with those of the other aggregated types,
   * in one list told apart by colour, or in a section of their own.
   */
  aggregate: boolean;
};

// The defaults give what describes the work itself a place in the one list,
// each in a colour with some bearing on it, and keep the housekeeping types
// (flaws, language, where it came from, what it is for) apart, as they do
// the bucket a file is kept in.
const DEFAULTS: Record<(typeof TAG_FIELDS)[number], TagType> = {
  tags: { light: null, dark: null, aggregate: true }, // the neutral ones: as the text is
  creator: { light: "#a85400", dark: "#ffd8a8", aggregate: true }, // amber: a signature
  character: { light: "#1a7a35", dark: "#c5efcf", aggregate: true }, // green: the living
  source_work: { light: "#3040b0", dark: "#d5dbff", aggregate: true }, // indigo: a book spine
  person: { light: "#b0204f", dark: "#ffd2df", aggregate: true }, // rose: real people
  genre: { light: "#6a2bc0", dark: "#e5d3ff", aggregate: true }, // violet: mood
  style: { light: "#0a777d", dark: "#c6f0f1", aggregate: true }, // teal: the brush
  medium: { light: "#7d5a0a", dark: "#f2e2c2", aggregate: true }, // canvas
  flaws: { light: "#b3261e", dark: "#ffd0cb", aggregate: false }, // red: a warning
  language: { light: "#1565a8", dark: "#d1ebff", aggregate: false }, // sky
  source: { light: "#556b0f", dark: "#e2e8c6", aggregate: false }, // olive: provenance
  usage_tags: { light: "#8a6500", dark: "#ffe8a3", aggregate: false }, // sticky note
  ai_usage_tags: { light: "#54497f", dark: "#d8d5e8", aggregate: false }, // machine grey
  bucket: { light: "#3b4252", dark: "#f1f3f7", aggregate: false }, // a label on a box
};

/**
 * The short name each type goes by after an @: `@cr:name` is the creator
 * `name`. A tag written without an @ is a plain one, of type `tags`.
 */
export const TAG_PREFIXES: Record<(typeof TAG_FIELDS)[number], string> = {
  tags: "ta",
  creator: "cr",
  character: "ch",
  source_work: "sw",
  person: "pe",
  genre: "ge",
  style: "st",
  medium: "me",
  flaws: "fl",
  language: "la",
  source: "so",
  usage_tags: "us",
  ai_usage_tags: "ai",
  bucket: "bu",
};

export const prefixOf = (field: string) => TAG_PREFIXES[field as keyof typeof TAG_PREFIXES];

/** The type an @ name stands for: its short name or its full one. */
export const typeNamed = (name: string): string | undefined => {
  const wanted = name.trim().toLowerCase();
  return TAG_FIELDS.find((field) => TAG_PREFIXES[field] === wanted || field === wanted);
};

/** The types whose short or full name starts with what has been typed. */
export const typesStarting = (typed: string): string[] => {
  const start = typed.trim().toLowerCase();
  return orderedTypes().filter(
    (field) => prefixOf(field).startsWith(start) || field.startsWith(start),
  );
};

/** What a tag is, read from how it was typed. */
export type TypedTag = {
  /** Its type; null if the name after the @ is not one. */
  field: string | null;
  /** The tag itself, without the type. */
  value: string;
  /** What was typed in front of the value: `@cr:`, or nothing. */
  lead: string;
  /**
   * Set while only `@…` has been typed and no colon yet: the start of a
   * type's name.
   */
  naming: string | null;
};

/**
 * Reads a tag as typed: `name` is a plain tag, `@cr:name` a creator. The
 * first colon ends the type; any after it belong to the tag's namespaces.
 */
export function readTag(text: string): TypedTag {
  const typed = text.trimStart();
  if (!typed.startsWith("@")) return { field: "tags", value: typed.trim(), lead: "", naming: null };
  const colon = typed.indexOf(":");
  if (colon < 0) return { field: null, value: "", lead: "", naming: typed.slice(1) };
  return {
    field: typeNamed(typed.slice(1, colon)) ?? null,
    value: typed.slice(colon + 1).trim(),
    lead: typed.slice(0, colon + 1),
    naming: null,
  };
}

/** A tag as it is typed and searched: `name`, or `@cr:name`. */
export const tagText = (field: string, value: string) =>
  field === "tags" ? value : `@${prefixOf(field)}:${value}`;

export const defaultTagType = (field: string): TagType =>
  DEFAULTS[field as keyof typeof DEFAULTS] ?? DEFAULTS.tags;

/** How light a `#rrggbb` colour is, from 0 to 1. */
const lightness = (colour: string) => {
  const part = (at: number) => parseInt(colour.slice(at, at + 2), 16) / 255;
  return 0.2126 * part(1) + 0.7152 * part(3) + 0.0722 * part(5);
};

/**
 * What is stored for a type, as it is read now. A type stored when tags
 * were pills has a background and a text colour instead: of the two, the
 * darker is what shows on a light theme and the lighter on a dark one.
 */
function stored(field: string): Partial<TagType> {
  const { bg, fg, ...rest } = settings.tagTypes?.[field] ?? {};
  const old: Partial<TagType> = {};
  if (bg && fg) [old.light, old.dark] = lightness(bg) < lightness(fg) ? [bg, fg] : [fg, bg];
  else if (bg) old.dark = bg;
  else if (fg) old.light = fg;
  return { ...old, ...rest };
}

export const tagType = (field: string): TagType => ({
  ...defaultTagType(field),
  ...stored(field),
});

export const isCustom = (field: string) => settings.tagTypes?.[field] !== undefined;

/**
 * Inline style for a tag's name, which is written in its type's colour:
 * the type's two colours, for the stylesheet to take the one for the
 * theme. A type with no colour of its own leaves the text as it is.
 */
export const tagTextStyle = (field: string) => {
  const { light, dark } = tagType(field);
  return { "--tag-on-light": light ?? "initial", "--tag-on-dark": dark ?? "initial" };
};

/**
 * The order tags are listed in by default: who and what the work is, then
 * how it is made, with plain tags closing the aggregated list, then the
 * bucket it is kept in, and the housekeeping types after.
 */
const DEFAULT_ORDER: string[] = [
  "creator",
  "character",
  "source_work",
  "person",
  "genre",
  "style",
  "medium",
  "tags",
  "bucket",
  "flaws",
  "language",
  "source",
  "usage_tags",
  "ai_usage_tags",
];

/** Every tag type, in the order chosen in the settings. */
export const orderedTypes = (): string[] => {
  const known = new Set<string>(TAG_FIELDS);
  const chosen = (settings.tagTypeOrder ?? []).filter((field) => known.delete(field));
  // Types the saved order does not mention keep their default place at the end.
  return [...chosen, ...DEFAULT_ORDER.filter((field) => known.has(field))];
};

export const isCustomOrder = () => settings.tagTypeOrder !== undefined;

/** Sets the order of the types; null puts the default one back. */
export const setTagTypeOrder = (order: string[] | null) => saveSetting("tagTypeOrder", order);

/** The types shown together in one list, in order. */
export const aggregatedTypes = (): string[] =>
  orderedTypes().filter((field) => tagType(field).aggregate);

/** Changes how a type is shown; null puts it back to its defaults. */
export async function setTagType(field: string, changes: Partial<TagType> | null) {
  const all = { ...settings.tagTypes };
  if (changes === null) delete all[field];
  else all[field] = { ...stored(field), ...changes };
  await saveSetting("tagTypes", Object.keys(all).length > 0 ? all : null);
}
