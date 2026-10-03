import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import type { Changes, Metadata } from "../api";
import { errorMessage, fieldLabel, tagQuery } from "../format";
import { changed, dataVersion } from "../search";
import {
  aggregatedTypes,
  orderedTypes,
  pillStyle,
  prefixOf,
  readTag,
  tagText,
  tagType,
  typesStarting,
} from "../tagTypes";
import { open as openTab } from "../tabs";
import { ListLabel } from "./fields";
import type { FieldProps, ListMode } from "./fields";
import Icon from "./Icon";
import Modal from "./Modal";

/** How many suggestions are listed at once. */
const MAX_SUGGESTIONS = 8;
/** How much of a tag has to be typed before tags are suggested for it. */
const MIN_TYPED = 2;

export const filled = (data: Metadata, field: string) => (data.tags[field]?.length ?? 0) > 0;

/** One row of the tag editor's suggestions: a type, or a tag. */
type Option =
  | { kind: "type"; field: string }
  | {
      kind: "tag";
      field: string;
      value: string;
      note: string;
      namespace: boolean;
      alias?: string;
      /** Already on everything selected: shown, but there is nothing to add. */
      has?: boolean;
    };

/**
 * The tag editor's text box and its list of suggestions, as two pieces to
 * be placed apart: the list has a section of its own rather than dropping
 * down from the box.
 *
 * What is typed is a plain tag unless it says otherwise: `@cr:name` is a
 * creator, and so on for each type, by its short name or its full one. A
 * `-` in front takes the tag off instead of putting it on. The suggestions
 * follow: the types while only `@…` is typed, a type's tags after its
 * colon, and after a `-` the tags the selection has.
 */
function createTagBox(props: FieldProps & { initial?: string }) {
  const [text, setText] = createSignal(props.initial ?? "");
  /** Highlighted suggestion; -1 means the typed text itself. */
  const [active, setActive] = createSignal(-1);
  const [problem, setProblem] = createSignal<string | null>(null);
  const removing = () => text().trimStart().startsWith("-");
  const read = createMemo(() => readTag(removing() ? text().trimStart().slice(1) : text()));
  /** What goes in front of a tag in the box: `-`, `@cr:`, both or neither. */
  const lead = () => (removing() ? "-" : "") + read().lead;

  /** Tags are only suggested once this much of one has been typed. */
  const enough = () => read().value.length >= MIN_TYPED;
  const [fetched] = createResource(
    () => {
      const { field, value } = read();
      return field && !removing() && enough() ? { field, typed: value } : null;
    },
    ({ field, typed }) => api.suggestTags(field, typed),
  );

  const options = createMemo<Option[]>(() => {
    const { field, value, naming } = read();
    if (naming !== null) return typesStarting(naming).map((field) => ({ kind: "type", field }));
    if (!field) return [];
    const carried = props.data.tags[field] ?? [];
    if (removing()) {
      // To take off: the tags of that type the selection carries.
      const typed = value.toLowerCase();
      return carried
        .filter((tag) => tag.value.toLowerCase().includes(typed))
        .map((tag) => ({
          kind: "tag",
          field,
          value: tag.value,
          namespace: false,
          note: tag.count < props.data.count ? `on ${tag.count} of ${props.data.count}` : "",
        }));
    }
    if (!enough()) return [];
    // Tags the whole selection already has are still listed, so that it is
    // plain they exist, but marked: there is nothing to add.
    const complete = new Set(
      carried.filter((tag) => tag.count === props.data.count).map((tag) => tag.value.toLowerCase()),
    );
    return (fetched.latest ?? []).slice(0, MAX_SUGGESTIONS).map((option) => {
      const has = !option.namespace && complete.has(option.value.toLowerCase());
      return {
        kind: "tag",
        field,
        value: option.value,
        namespace: option.namespace,
        alias: option.alias,
        has,
        note: has
          ? "already on it"
          : [String(option.count), option.description].filter(Boolean).join(" · "),
      };
    });
  });

  const reset = (next = "") => {
    setText(next);
    setActive(-1);
    setProblem(null);
  };

  /** Puts the tag on the selection, or with a `-` typed, takes it off. */
  const commit = (field: string | null, value: string) => {
    const name = value.trim();
    if (!field || !name) return;
    if (!removing()) {
      reset();
      return props.apply({ add: { [field]: [name] } });
    }
    const carried = (props.data.tags[field] ?? []).find(
      (tag) => tag.value.toLowerCase() === name.toLowerCase(),
    );
    if (!carried) return setProblem(`${tagText(field, name)} is not on the selection.`);
    reset();
    props.apply({ remove: { [field]: [carried.value] } });
  };

  const pick = (option: Option) => {
    // A type writes its prefix, ready for the tag; a namespace steps into
    // it; a tag is put on, or taken off.
    if (option.kind === "type") reset(`${removing() ? "-" : ""}@${prefixOf(option.field)}:`);
    else if (option.namespace) reset(lead() + option.value);
    else if (option.has) reset();
    else commit(option.field, option.value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const count = options().length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1 >= count ? -1 : i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i < 0 ? count - 1 : i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active() >= 0) {
        pick(options()[active()]);
      } else if (read().naming !== null) {
        // An unfinished `@…` names a type; it is never a tag.
        if (count > 0) pick(options()[0]);
      } else {
        commit(read().field, read().value);
      }
    }
  };

  const heading = () =>
    read().naming !== null
      ? "Types"
      : removing()
        ? "Take off"
        : read().field
          ? `Suggested ${fieldLabel(read().field!).toLowerCase()}`
          : "Suggestions";

  const input = () => (
    <div class="tag-box">
      <input
        type="text"
        role="combobox"
        autofocus
        aria-label="Add or remove a tag"
        aria-expanded="true"
        aria-controls="tag-suggestions"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck={false}
        placeholder="Add a tag. @cr:name for another type, -name to take one off"
        value={text()}
        // The box takes the cursor when it appears, which may be after its
        // modal opened; with a type written in ahead, the cursor goes after it.
        ref={(el) =>
          queueMicrotask(() => {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          })
        }
        onInput={(e) => {
          setText(e.currentTarget.value);
          setActive(-1);
          setProblem(null);
        }}
        onKeyDown={onKeyDown}
      />
      <Show when={problem() ?? (read().field === null && read().naming === null)}>
        <p class="form-error">
          {problem() ?? `${read().lead.slice(0, -1)} is not a tag type. Type @ to see them.`}
        </p>
      </Show>
    </div>
  );

  const suggestions = () => (
    <section class="tag-suggestions" aria-label="Suggestions">
      <span class="label">{heading()}</span>
      <ul id="tag-suggestions" role="listbox">
        <For
          each={options()}
          fallback={
            <li class="hint">
              {removing()
                ? "Nothing like that to take off."
                : !read().field
                  ? "Nothing to suggest."
                  : enough()
                    ? "No tag like that yet. Enter adds it as a new one."
                    : `Type ${MIN_TYPED} letters to see suggestions.`}
            </li>
          }
        >
          {(option, i) => (
            <li
              role="option"
              aria-selected={i() === active()}
              classList={{
                active: i() === active(),
                has: option.kind === "tag" && option.has,
              }}
              // Keeps the cursor in the box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(option)}
            >
              <Show
                when={option.kind === "tag" && option}
                fallback={
                  <>
                    <span class="chip tinted type-sample" style={pillStyle(option.field)}>
                      {fieldLabel(option.field)}
                    </span>
                    <span class="suggestion-count">@{prefixOf(option.field)}:</span>
                  </>
                }
              >
                {(tag) => (
                  <>
                    <span class="suggestion-value">
                      <Show when={tag().alias}>
                        <span class="suggestion-alias">{tag().alias} → </span>
                      </Show>
                      {tag().value}
                    </span>
                    <span class="suggestion-count">
                      {tag().note}
                      <Show when={tag().namespace}>
                        <Icon name="chevron-right" />
                      </Show>
                    </span>
                  </>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );

  return { input, suggestions };
}

/**
 * The heading of a group of chips in the panel: the namespace they share.
 * Clicking it searches the namespace.
 */
function Namespace(props: { field: string; name: string }) {
  return (
    <span class="namespace">
      <button
        class="namespace-label"
        title="Search for everything in this namespace"
        onClick={() => openTab("gallery", tagQuery(props.field, props.name, true))}
      >
        {props.name}:
      </button>
    </span>
  );
}

type Tag = Metadata["tags"][string][number];

/**
 * One tag as a pill in its type's colours. In the panel it searches for
 * the tag; in the editor it has the buttons that take it off, or put it
 * on the rest of the selection.
 */
function TagChip(
  props: FieldProps & {
    field: string;
    tag: Tag;
    editing?: boolean;
    /** The namespace the pill is listed under, and so leaves out. */
    under?: string;
  },
) {
  const partial = () => props.tag.count < props.data.count;
  /** The tag's namespace, with its colon, unless a heading shows it. */
  const namespace = () => {
    if (props.under !== undefined) return "";
    return props.tag.value.slice(0, props.tag.value.lastIndexOf(":") + 1);
  };
  const name = () =>
    props.tag.value.slice(props.under ? props.under.length + 1 : namespace().length);
  return (
    <span class="chip tinted" classList={{ partial: partial() }} style={pillStyle(props.field)}>
      <button
        class="chip-label"
        // In the editor a pill is just a value; in the panel it searches.
        disabled={props.editing}
        title={
          props.editing
            ? undefined
            : [
                `${fieldLabel(props.field)}: ${props.tag.value}`,
                ...(props.tag.description ? [props.tag.description] : []),
                "Click to search for it",
              ].join("\n")
        }
        onClick={() => openTab("gallery", tagQuery(props.field, props.tag.value))}
      >
        <Show when={namespace()}>
          <span class="chip-namespace">{namespace()}</span>
        </Show>
        {name()}
      </button>
      <Show when={partial()}>
        <span class="chip-count" title={`On ${props.tag.count} of ${props.data.count} selected`}>
          ({props.tag.count})
        </span>
      </Show>
      <Show when={props.editing}>
        <span class="chip-actions">
          <Show when={partial()}>
            <button
              class="chip-add"
              aria-label={`Add ${props.tag.value} to all selected`}
              title="Add to all selected"
              onClick={() => props.apply({ add: { [props.field]: [props.tag.value] } })}
            >
              <Icon name="add" />
            </button>
          </Show>
          <button
            class="chip-remove"
            aria-label={`Remove ${props.tag.value}`}
            title="Remove"
            onClick={() => props.apply({ remove: { [props.field]: [props.tag.value] } })}
          >
            <Icon name="close" />
          </button>
        </span>
      </Show>
    </span>
  );
}

/**
 * Where every tag of the selection is added and removed, whatever its
 * type: the box on top, then the tags as the panel shows them (the
 * aggregated ones together, the other types in their sections) beside the
 * suggestions for what is being typed. `initial` starts the box with a
 * type already written.
 */
export function TagsEditor(props: FieldProps & { initial?: string }) {
  const box = createTagBox(props);
  const untagged = () => orderedTypes().every((field) => !filled(props.data, field));
  return (
    <div class="tags-editor">
      {box.input()}
      <div class="tags-editor-body">
        <div class="tags-editor-tags">
          <Show when={untagged()}>
            <p class="hint">No tags yet.</p>
          </Show>
          <AggregatedTags data={props.data} apply={props.apply} editing />
          <For each={orderedTypes().filter((field) => !tagType(field).aggregate)}>
            {(field) => (
              <Show when={filled(props.data, field)}>
                <TagField field={field} data={props.data} apply={props.apply} editing />
              </Show>
            )}
          </For>
        </div>
        {box.suggestions()}
      </div>
    </div>
  );
}

/**
 * The tag editor in a modal of its own, for the given entities: what the
 * tagging hotkey opens, on the selection or on the file in the viewer.
 */
export function TagsModal(props: {
  ids: number[];
  /** What the tags are of, for the title: "3 items", "this file". */
  target: string;
  /** What the box starts with: a type, written out. */
  initial?: string;
  onClose: () => void;
}) {
  const [error, setError] = createSignal<string | null>(null);
  const [metadata] = createResource(
    () => [props.ids, dataVersion()] as const,
    ([ids]) => api.getMetadata(ids),
  );
  const apply = async (changes: Changes) => {
    try {
      await api.edit(props.ids, changes);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    changed();
  };
  return (
    <Modal title={`Tags of ${props.target}`} medium onClose={props.onClose}>
      <div class="field-editor">
        {/* `latest` keeps the tags on screen while a change reloads them. */}
        <Show when={metadata.latest} fallback={<div class="field" />}>
          {(data) => <TagsEditor data={data()} apply={apply} initial={props.initial} />}
        </Show>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </Modal>
  );
}

/**
 * The tags of one type that is not aggregated, in a section of their own,
 * grouped by namespace. In the panel the label opens the tag editor.
 */
export function TagField(props: FieldProps & ListMode & { field: string }) {
  const values = () => props.data.tags[props.field] ?? [];

  /** The values by namespace: those without one first, then by name. */
  const groups = createMemo(() => {
    type Group = { namespace: string; tags: Tag[] };
    const byNamespace = new Map<string, Group>();
    for (const tag of values()) {
      const colon = tag.value.lastIndexOf(":");
      const namespace = colon < 0 ? "" : tag.value.slice(0, colon);
      const key = namespace.toLowerCase();
      if (!byNamespace.has(key)) byNamespace.set(key, { namespace, tags: [] });
      byNamespace.get(key)!.tags.push(tag);
    }
    return [...byNamespace.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => group);
  });

  return (
    <div class="field">
      <Show
        when={props.editing}
        fallback={<ListLabel label={fieldLabel(props.field)} onEdit={props.onEdit} />}
      >
        <span class="label">{fieldLabel(props.field)}</span>
      </Show>
      <div class="tag-groups">
        <For each={groups()}>
          {(group) => (
            <div class="chips">
              <Show when={group.namespace}>
                {/* In the editor the heading is only a heading; in the panel
                    it searches the namespace. */}
                <Show
                  when={props.editing}
                  fallback={<Namespace field={props.field} name={group.namespace} />}
                >
                  <span class="namespace">{group.namespace}:</span>
                </Show>
              </Show>
              <For each={group.tags}>
                {(tag) => (
                  <TagChip
                    field={props.field}
                    tag={tag}
                    under={group.namespace}
                    data={props.data}
                    apply={props.apply}
                    editing={props.editing}
                  />
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * The tags of every aggregated type in one list with no heading, told
 * apart by the colour of their pills. In the panel it ends in the button
 * that opens the tag editor; in the editor each pill can be taken off.
 */
export function AggregatedTags(props: FieldProps & ListMode) {
  const entries = () =>
    aggregatedTypes().flatMap((field) =>
      (props.data.tags[field] ?? []).map((tag) => ({ field, tag })),
    );
  return (
    <div class="aggregate">
      <div class="chips aggregate-chips">
        <For each={entries()}>
          {(entry) => (
            <TagChip
              field={entry.field}
              tag={entry.tag}
              data={props.data}
              apply={props.apply}
              editing={props.editing}
            />
          )}
        </For>
        <Show when={!props.editing}>
          <button
            class="chip chip-edit"
            aria-label="Edit tags"
            title="Add or remove tags"
            onClick={props.onEdit}
          >
            <Icon name="add" />
            <Show when={entries().length === 0}>Tags</Show>
          </button>
        </Show>
      </div>
    </div>
  );
}
