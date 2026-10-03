import { TAG_FIELDS } from "./api";
import { saveSetting, settings } from "./settings";

/** How a tag type is shown: its pill's colours, and where its tags go. */
export type TagType = {
  /** Background and text colour of the type's pills. */
  bg: string;
  fg: string;
  /**
   * Whether its tags are shown with those of the other aggregated types,
   * in one list told apart by colour, or in a section of their own.
   */
  aggregate: boolean;
};

// The defaults give what describes the work itself a place in the one list,
// each in a colour with some bearing on it, and keep the housekeeping types
// (flaws, language, where it came from, what it is for) apart.
const DEFAULTS: Record<(typeof TAG_FIELDS)[number], TagType> = {
  tags: { bg: "#e3e6ea", fg: "#22262b", aggregate: true }, // slate: the neutral ones
  creator: { bg: "#ffd8a8", fg: "#5c2a00", aggregate: true }, // amber: a signature
  character: { bg: "#c5efcf", fg: "#0b4a1e", aggregate: true }, // green: the living
  source_work: { bg: "#d5dbff", fg: "#1b236e", aggregate: true }, // indigo: a book spine
  person: { bg: "#ffd2df", fg: "#6b0f2c", aggregate: true }, // rose: real people
  genre: { bg: "#e5d3ff", fg: "#3e1378", aggregate: true }, // violet: mood
  style: { bg: "#c6f0f1", fg: "#06484c", aggregate: true }, // teal: the brush
  medium: { bg: "#f2e2c2", fg: "#513a06", aggregate: true }, // canvas
  flaws: { bg: "#ffd0cb", fg: "#7a1410", aggregate: false }, // red: a warning
  language: { bg: "#d1ebff", fg: "#0a3c65", aggregate: false }, // sky
  source: { bg: "#e2e8c6", fg: "#374209", aggregate: false }, // olive: provenance
  usage_tags: { bg: "#ffe8a3", fg: "#594200", aggregate: false }, // sticky note
  ai_usage_tags: { bg: "#d8d5e8", fg: "#2e2949", aggregate: false }, // machine grey
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

export const tagType = (field: string): TagType => ({
  ...defaultTagType(field),
  ...settings.tagTypes?.[field],
});

export const isCustom = (field: string) => settings.tagTypes?.[field] !== undefined;

/** Inline style that gives a pill its type's colours. */
export const pillStyle = (field: string) => {
  const type = tagType(field);
  return { background: type.bg, color: type.fg };
};

/**
 * The order tags are listed in by default: who and what the work is, then
 * how it is made, with plain tags closing the aggregated list, and the
 * housekeeping types after.
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
  else all[field] = { ...all[field], ...changes };
  await saveSetting("tagTypes", Object.keys(all).length > 0 ? all : null);
}
