import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import type { Changes, Metadata } from "../api";
import { errorMessage, fieldLabel, plural, tagQuery } from "../format";
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
import { openTagMenu } from "./ContextMenu";
import { ListLabel } from "./fields";
import type { FieldProps, ListMode } from "./fields";
import Icon from "./Icon";
import Modal from "./Modal";
import { addToQuery } from "./QueryBar";

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
    const carried = carriedTags(props.data, field);
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
    const carried = carriedTags(props.data, field).find(
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
      // With Shift it saves the editor's changes, which is the editor's
      // to do: with nothing typed, that is all it does.
      if (event.shiftKey && text().trim() === "") return;
      if (active() >= 0) {
        pick(options()[active()]);
      } else if (read().naming !== null) {
        // An unfinished `@…` names a type; it is never a tag.
        if (count > 0) pick(options()[0]);
      } else {
        commit(read().field, read().value);
      }
      // What was typed goes in with the changes saved. Nothing is saved
      // while the box still holds something: a type to finish, or a tag
      // that could not be taken off.
      if (event.shiftKey && text() !== "") event.stopPropagation();
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
 * A tag of the selection. In the editor, where changes wait to be saved,
 * `pending` says what is to become of it: put on everything selected, or
 * taken off.
 */
type Tag = Metadata["tags"][string][number] & { pending?: "added" | "removed" };

/** The tags of a type the selection carries, or will once the editor is saved. */
const carriedTags = (data: Metadata, field: string): Tag[] =>
  (data.tags[field] ?? []).filter((tag: Tag) => tag.pending !== "removed");

/** The changes to tags waiting in the editor: tag field to values. */
type Staged = { add: Record<string, string[]>; remove: Record<string, string[]> };

const sameTag = (a: string) => (b: string) => a.toLowerCase() === b.toLowerCase();

/** A list of values by field with one put in, or taken out. */
function withValue(
  lists: Record<string, string[]>,
  field: string,
  value: string,
  keep: boolean,
): Record<string, string[]> {
  const rest = (lists[field] ?? []).filter((had) => !sameTag(value)(had));
  const { [field]: _, ...others } = lists;
  const next = keep ? [...rest, value] : rest;
  return next.length > 0 ? { ...others, [field]: next } : others;
}

/**
 * Takes a change asked for in the editor into those waiting. Asking for
 * the opposite of one that waits calls it off: a tag to be taken off is
 * kept as it was, and one to be put on is not.
 */
function stage(staged: Staged, base: Metadata, changes: Changes): Staged {
  let { add, remove } = staged;
  for (const [field, values] of Object.entries(changes.add ?? {})) {
    for (const value of values) {
      const carried = (base.tags[field] ?? []).find((tag) => sameTag(value)(tag.value));
      if (remove[field]?.some(sameTag(value))) remove = withValue(remove, field, value, false);
      else if (carried?.count !== base.count) add = withValue(add, field, carried?.value ?? value, true);
    }
  }
  for (const [field, values] of Object.entries(changes.remove ?? {})) {
    for (const value of values) {
      const carried = (base.tags[field] ?? []).find((tag) => sameTag(value)(tag.value));
      add = withValue(add, field, value, false);
      if (carried) remove = withValue(remove, field, carried.value, true);
    }
  }
  return { add, remove };
}

/** The selection's metadata as it will be once the changes waiting are saved. */
function staged(base: Metadata, changes: Staged): Metadata {
  const tags: Record<string, Tag[]> = {};
  for (const field of new Set([...Object.keys(base.tags), ...Object.keys(changes.add)])) {
    const adding = changes.add[field] ?? [];
    const removing = changes.remove[field] ?? [];
    const had: Tag[] = (base.tags[field] ?? []).map((tag) =>
      removing.some(sameTag(tag.value))
        ? { ...tag, pending: "removed" }
        : adding.some(sameTag(tag.value))
          ? { ...tag, count: base.count, pending: "added" }
          : tag,
    );
    const fresh: Tag[] = adding
      .filter((value) => !had.some((tag) => sameTag(value)(tag.value)))
      .map((value) => ({ value, count: base.count, description: null, pending: "added" }));
    tags[field] = [...had, ...fresh];
  }
  return { ...base, tags };
}

/**
 * One tag as a pill in its type's colours. In the panel a click adds the
 * tag to the search, and a right click offers more; in the editor it has the buttons that take it off, or put it
 * on the rest of the selection.
 */
function TagChip(
  props: FieldProps & {
    field: string;
    tag: Tag;
    editing?: boolean;
  },
) {
  const removed = () => props.tag.pending === "removed";
  const partial = () => !removed() && props.tag.count < props.data.count;
  /** The tag's namespace, with its colon. */
  const namespace = () => props.tag.value.slice(0, props.tag.value.lastIndexOf(":") + 1);
  const name = () => props.tag.value.slice(namespace().length);
  return (
    <span
      class="chip tinted"
      classList={{ partial: partial(), added: props.tag.pending === "added", removed: removed() }}
      title={
        removed()
          ? "Taken off when the changes are saved"
          : props.tag.pending === "added"
            ? "Put on when the changes are saved"
            : undefined
      }
      style={pillStyle(props.field)}
    >
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
                "Click to add it to the search; right click for more",
              ].join("\n")
        }
        onClick={() => addToQuery(tagQuery(props.field, props.tag.value))}
        onContextMenu={(event) =>
          props.editing || openTagMenu(event, { field: props.field, value: props.tag.value })
        }
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
      <Show when={props.editing && removed()}>
        <span class="chip-actions">
          <button
            class="chip-add"
            aria-label={`Keep ${props.tag.value}`}
            title="Keep it after all"
            onClick={() => props.apply({ add: { [props.field]: [props.tag.value] } })}
          >
            <Icon name="undo" />
          </button>
        </span>
      </Show>
      <Show when={props.editing && !removed()}>
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
 *
 * Nothing is changed as the tags are put on and taken off: the changes
 * wait, shown as they will be, until they are saved, with the button or
 * with Shift and Enter. Closing the modal with changes waiting asks first.
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
  const [saving, setSaving] = createSignal(false);
  const [waiting, setWaiting] = createSignal<Staged>({ add: {}, remove: {} });
  const [metadata] = createResource(
    () => [props.ids, dataVersion()] as const,
    ([ids]) => api.getMetadata(ids),
  );
  /** The tags as they will be once what waits is saved. */
  const shown = createMemo(() => metadata.latest && staged(metadata.latest, waiting()));
  const count = () =>
    [waiting().add, waiting().remove]
      .flatMap((lists) => Object.values(lists))
      .reduce((sum, values) => sum + values.length, 0);
  const apply = (changes: Changes) => {
    const base = metadata.latest;
    if (base) setWaiting((had) => stage(had, base, changes));
  };
  const save = async () => {
    if (saving()) return;
    if (count() === 0) return props.onClose();
    setSaving(true);
    try {
      await api.edit(props.ids, waiting());
      changed();
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };
  return (
    <Modal
      title={`Tags of ${props.target}`}
      medium
      onClose={props.onClose}
      canClose={() =>
        count() === 0 ||
        confirm(`Close without saving? ${plural(count(), "change")} to the tags will be lost.`)
      }
    >
      <div
        class="field-editor"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !event.shiftKey) return;
          event.preventDefault();
          save();
        }}
      >
        {/* `latest` keeps the tags on screen while they are read again. */}
        <Show when={shown()} fallback={<div class="field" />}>
          {(data) => <TagsEditor data={data()} apply={apply} initial={props.initial} />}
        </Show>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <footer class="tags-footer">
        <span class="hint">
          {count() === 0
            ? "Nothing changes until it is saved: "
            : `${plural(count(), "change")} not saved yet: `}
          <kbd>Shift + Enter</kbd> saves.
        </span>
        <button type="button" onClick={props.onClose}>
          {count() === 0 ? "Close" : "Discard"}
        </button>
        <button
          type="button"
          class="primary"
          disabled={count() === 0 || saving()}
          title="Save the changes (Shift + Enter)"
          onClick={save}
        >
          Save
        </button>
      </footer>
    </Modal>
  );
}

/**
 * The tags of one type that is not aggregated, in a section of their own.
 * In the panel the label opens the tag editor.
 */
export function TagField(props: FieldProps & ListMode & { field: string }) {
  const values = () => props.data.tags[props.field] ?? [];

  /** Those without a namespace first, then by namespace. */
  const sorted = createMemo(() => {
    const namespace = (tag: Tag) => tag.value.slice(0, Math.max(0, tag.value.lastIndexOf(":")));
    // The sort is stable: within a namespace the order given is kept.
    return [...values()].sort((a, b) =>
      namespace(a).toLowerCase().localeCompare(namespace(b).toLowerCase()),
    );
  });

  return (
    <div class="field">
      <Show
        when={props.editing}
        fallback={<ListLabel label={fieldLabel(props.field)} onEdit={props.onEdit} />}
      >
        <span class="label">{fieldLabel(props.field)}</span>
      </Show>
      <div class="chips">
        <For each={sorted()}>
          {(tag) => (
            <TagChip
              field={props.field}
              tag={tag}
              data={props.data}
              apply={props.apply}
              editing={props.editing}
            />
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
