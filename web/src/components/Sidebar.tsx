import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import * as api from "../api";
import { AI_CONTENT, COLLECTION_TYPES, CONTENT_RATINGS } from "../api";
import type { Changes, Metadata, Scalar } from "../api";
import { dateTime, duration, fieldLabel, fileSize, plural, tagQuery } from "../format";
import { changed, clearSelection, dataVersion, selected } from "../search";
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
import { open as openTab, openCollection } from "../tabs";
import Icon from "./Icon";
import Modal from "./Modal";
import { createStoredFlag } from "./Panel";

const SCORES = [1, 2, 3, 4, 5, 6, 7];
/** Names the tags, of every type together, where a list field is named. */
const TAGS = "tags";
const filled = (data: Metadata, field: string) => (data.tags[field]?.length ?? 0) > 0;

type DetailField = {
  field: string;
  label: string;
  options?: string[];
  /** Multi-line text. */
  long?: boolean;
  placeholder?: string;
  /** Only offered when the selection is a single file. */
  fileOnly?: boolean;
};

/** The single-valued fields, in the order they are listed. */
const DETAIL_FIELDS: DetailField[] = [
  { field: "title", label: "Title" },
  { field: "date", label: "Date", placeholder: "YYYY, YYYY-MM or YYYY-MM-DD" },
  { field: "content_rating", label: "Rating", options: CONTENT_RATINGS },
  { field: "description", label: "Description", long: true },
  { field: "version", label: "Version" },
  { field: "ai_content", label: "AI content", options: AI_CONTENT },
  { field: "ai_description", label: "AI description", long: true },
  // Only used to name the file again on download.
  { field: "original_name", label: "Filename", fileOnly: true },
];

/**
 * Actions on the selection and its metadata, for the side panel. With
 * several entities selected every edit applies to all of them: fields show
 * the value they share or "(mixed)", and tags show how many of the
 * selection carry them.
 */
export default function Sidebar(props: {
  /**
   * What to show instead of the selection: the collection a tab is tied
   * to, when nothing in it is selected.
   */
  ids?: number[];
  /** Asks for the given entities to be put into a collection. */
  onGroup: (ids: number[]) => void;
}) {
  const ids = createMemo(() => props.ids ?? [...selected()]);
  const [error, setError] = createSignal<string | null>(null);
  /** An unset field picked from "Add field", shown while it is filled in. */
  const [adding, setAdding] = createSignal<string | null>(null);
  /**
   * The list field (a tag field, or one of the plain lists) open in the
   * modal where its values are added and removed. The panel itself only
   * shows the values.
   */
  const [editingList, setEditingList] = createSignal<string | null>(null);
  /** What the tag editor's box starts with: a type, written out, or nothing. */
  const [tagStart, setTagStart] = createSignal("");
  // An error, or a half-added field, belongs to the selection it began on.
  createEffect(
    on(
      ids,
      () => {
        setError(null);
        setAdding(null);
      },
      { defer: true },
    ),
  );

  const [metadata] = createResource(
    () => [ids(), dataVersion()] as const,
    // Remembers which selection the answer is about: the previous one's
    // stays on screen while the next loads.
    async ([list]) => ({ ...(await api.getMetadata(list)), of: list }),
  );
  const [entity] = createResource(
    () => (ids().length === 1 ? ([ids()[0], dataVersion()] as const) : null),
    ([id]) => api.getEntity(id),
  );
  // `latest` keeps the previous answer on screen while a new one loads.
  const meta = () => metadata.latest;
  // Once a newly added field's value has been saved and reloaded, the row
  // shows because it is set, and no longer needs to be held open.
  let addedSaved = false;
  createEffect(
    on(
      () => metadata.latest,
      () => {
        if (addedSaved) setAdding(null);
        addedSaved = false;
      },
      { defer: true },
    ),
  );
  const pick = (field: string) => {
    if (PLAIN_LISTS.some((list) => list.field === field)) setEditingList(field);
    else setAdding(field);
  };
  /** Opens the tag editor, its box starting with `initial`. */
  const editTags = (initial = "") => {
    setTagStart(initial);
    setEditingList(TAGS);
  };
  const single = () => (ids().length === 1 ? entity.latest : undefined);

  const apply = async (changes: Changes) => {
    try {
      await api.edit(ids(), changes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    changed();
  };
  const set = (field: string) => (value: string | number | null) =>
    apply({ set: { [field]: value } });

  const leave = async (collection: number) => {
    try {
      await api.changeMembers(collection, { remove: ids() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    changed();
  };

  return (
    <>
      {/* From the top: the score, the collections, then the tags, the
          aggregated ones first and each other type under them. What is
          about the file itself comes after. */}
      <Show when={meta()}>
        {(data) => (
          <>
            <Stars scalar={data().scalars.score} onChange={set("score")} />
            <Collections data={data()} onAdd={() => props.onGroup(ids())} onLeave={leave} />
            <Show when={aggregatedTypes().length > 0}>
              <AggregatedTags data={data()} apply={apply} onEdit={() => editTags()} />
            </Show>
            <div class="tag-sections">
              <For each={orderedTypes().filter((field) => !tagType(field).aggregate)}>
                {(field) => (
                  <Show when={filled(data(), field)}>
                    <TagField
                      field={field}
                      data={data()}
                      apply={apply}
                      // The editor opens ready for a tag of this type.
                      onEdit={() => editTags(`@${prefixOf(field)}:`)}
                    />
                  </Show>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p class="form-error dismissible" role="alert">
          {error()}
          <button aria-label="Dismiss" title="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" />
          </button>
        </p>
      </Show>

      <Show when={meta()}>
        {(data) => (
          <>
            {/* Details and tags: only the fields that are set. "Add field"
                brings in one of the others. */}
            <dl class="facts">
              <For each={DETAIL_FIELDS}>
                {(detail) => (
                  <Show
                    when={
                      (!detail.fileOnly || (data().count === 1 && data().files === 1)) &&
                      (isSet(data().scalars[detail.field]) || adding() === detail.field)
                    }
                  >
                    <Detail
                      label={detail.label}
                      scalar={data().scalars[detail.field]}
                      options={detail.options}
                      long={detail.long}
                      placeholder={detail.placeholder}
                      startOpen={adding() === detail.field}
                      onCommit={set(detail.field)}
                      onClose={(saved) => {
                        if (adding() !== detail.field) return;
                        if (saved) addedSaved = true;
                        else setAdding(null);
                      }}
                    />
                  </Show>
                )}
              </For>
              <Show when={data().collections === data().count}>
                <Detail
                  label="Collection"
                  scalar={data().collection_type}
                  options={COLLECTION_TYPES}
                  required
                  onCommit={set("collection_type")}
                />
                <Detail
                  label="Ordered"
                  scalar={{
                    value: data().ordered.value === null ? null : data().ordered.value ? "yes" : "no",
                    mixed: data().ordered.mixed,
                  }}
                  options={["yes", "no"]}
                  required
                  onCommit={(value) => apply({ set: { ordered: value === "yes" } })}
                />
              </Show>

              <Show when={single()}>
                {(current) => (
                  <>
                    <Show when={current().file}>
                      {(file) => (
                        <>
                          <dt>Type</dt>
                          <dd>
                            {file().media_type}
                            {file().extension && ` (${file().extension})`},{" "}
                            <a href={api.contentUrl(current().id)} target="_blank" rel="noreferrer">
                              open
                            </a>
                          </dd>
                          <Show when={file().width && file().height}>
                            <dt>Size</dt>
                            <dd>
                              {file().width} × {file().height}
                            </dd>
                          </Show>
                          <Show when={file().length !== null}>
                            <dt>Length</dt>
                            <dd>{duration(file().length!)}</dd>
                          </Show>
                          <Show when={file().page_count !== null}>
                            <dt>Pages</dt>
                            <dd>{file().page_count}</dd>
                          </Show>
                          <dt>On disk</dt>
                          <dd>{fileSize(file().size)}</dd>
                        </>
                      )}
                    </Show>
                    <Show when={current().collection}>
                      {(collection) => (
                        <>
                          <dt>Members</dt>
                          <dd>
                            <button
                              class="link"
                              onClick={() => openCollection(current().id)}
                            >
                              {plural(collection().member_count, "item")}, open
                            </button>
                          </dd>
                        </>
                      )}
                    </Show>
                    <dt>Added</dt>
                    <dd title={current().date_added}>{dateTime(current().date_added)}</dd>
                    <dt>ID</dt>
                    <dd>{current().id}</dd>
                  </>
                )}
              </Show>
            </dl>
            <For each={PLAIN_LISTS}>
              {(list) => (
                <Show when={list.values(data()).length > 0}>
                  <PlainList
                    list={list}
                    data={data()}
                    apply={apply}
                    onEdit={() => setEditingList(list.field)}
                  />
                </Show>
              )}
            </For>

            <AddField
              groups={[
                DETAIL_FIELDS.filter(
                  (detail) =>
                    (!detail.fileOnly || (data().count === 1 && data().files === 1)) &&
                    !isSet(data().scalars[detail.field]) &&
                    adding() !== detail.field,
                ),
                PLAIN_LISTS.filter((list) => list.values(data()).length === 0).map(
                  ({ field, label }) => ({ field, label }),
                ),
              ]}
              onPick={pick}
            />

            {/* Values are added and removed in a modal: one for all the tags,
                one for each of the plain lists. */}
            <Show when={editingList()} keyed>
              {(field) => {
                const plain = () => PLAIN_LISTS.find((list) => list.field === field);
                return (
                  <Modal
                    title={`${plain()?.label ?? "Tags"} of ${
                      data().count === 1 ? "this item" : plural(data().count, "item")
                    }`}
                    medium={!plain()}
                    onClose={() => setEditingList(null)}
                  >
                    <div class="field-editor">
                      <Show
                        when={plain()}
                        fallback={
                          <TagsEditor data={data()} apply={apply} initial={tagStart()} />
                        }
                      >
                        {(list) => <PlainList list={list()} data={data()} apply={apply} editing />}
                      </Show>
                    </div>
                    <Show when={error()}>
                      <p class="form-error" role="alert">
                        {error()}
                      </p>
                    </Show>
                  </Modal>
                );
              }}
            </Show>
          </>
        )}
      </Show>
    </>
  );
}

/**
 * The collections the selection is in: a count that unfolds into the list,
 * and a button to put the selection into another.
 */
function Collections(props: {
  data: Metadata;
  onAdd: () => void;
  onLeave: (collection: number) => void;
}) {
  const [open, setOpen] = createStoredFlag("tagutils.collections", false);
  const count = () => props.data.memberships.length;
  return (
    <div class="collections" classList={{ open: open() && count() > 0 }}>
      <div class="collections-head">
        <button
          class="collections-toggle"
          aria-expanded={open() && count() > 0}
          disabled={count() === 0}
          onClick={() => setOpen(!open())}
        >
          <span class="chevron">
            <Icon name="chevron-right" />
          </span>
          Collections <span class="collections-count">({count()})</span>
        </button>
        <button
          class="collections-add"
          aria-label="Add to a collection"
          title="Add to a collection, new or existing"
          onClick={props.onAdd}
        >
          <Icon name="add" />
        </button>
      </div>
      <Show when={open() && count() > 0}>
        <div class="chips">
          <For each={props.data.memberships}>
            {(membership) => (
              <span class="chip" classList={{ partial: membership.count < props.data.count }}>
                <button
                  class="chip-label"
                  title="Open this collection"
                  onClick={() => openCollection(membership.id)}
                >
                  {membership.title || `#${membership.id}`}
                </button>
                <Show when={membership.count < props.data.count}>
                  <span
                    class="chip-count"
                    title={`${membership.count} of ${props.data.count} selected are in it`}
                  >
                    ({membership.count})
                  </span>
                </Show>
                <span class="chip-actions">
                  <button
                    class="chip-remove"
                    aria-label="Remove from collection"
                    title="Remove from collection"
                    onClick={() => props.onLeave(membership.id)}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

type FieldProps = { data: Metadata; apply: (changes: Changes) => void };

/**
 * The score as seven stars. Clicking a star sets it; clicking the current
 * score clears it.
 */
function Stars(props: { scalar: Scalar; onChange: (score: number | null) => void }) {
  const [hover, setHover] = createSignal<number | null>(null);
  const score = () => (typeof props.scalar.value === "number" ? props.scalar.value : 0);
  const shown = () => hover() ?? score();
  return (
    <div class="stars" role="radiogroup" aria-label="Score" onMouseLeave={() => setHover(null)}>
      <For each={SCORES}>
        {(n) => (
          <button
            role="radio"
            aria-checked={score() === n}
            aria-label={`Score ${n} of 7`}
            title={score() === n ? "Clear the score" : `Score ${n} of 7`}
            classList={{ filled: n <= shown() }}
            onMouseEnter={() => setHover(n)}
            onClick={() => {
              // Otherwise the hover would keep showing the cleared score.
              setHover(null);
              props.onChange(score() === n ? null : n);
            }}
          >
            <Icon name={n <= shown() ? "star" : "star-outline"} />
          </button>
        )}
      </For>
      <Show when={props.scalar.mixed}>
        <span class="stars-note">mixed</span>
      </Show>
    </div>
  );
}

/** Whether a field has something to show: a value, or differing values. */
const isSet = (scalar: Scalar) => scalar.mixed || (scalar.value !== null && scalar.value !== "");

/**
 * One row of the details list. Clicking the value swaps it for an input
 * (or a select, given `options`). Enter or leaving the input saves, Escape
 * cancels.
 */
function Detail(props: {
  label: string;
  scalar: Scalar;
  options?: string[];
  /** Leaves out the empty choice, for fields that must have a value. */
  required?: boolean;
  /** Multi-line text. */
  long?: boolean;
  placeholder?: string;
  /** Begin in editing mode, for a field that was just added. */
  startOpen?: boolean;
  onCommit: (value: string | null) => void;
  /** Editing ended; `saved` tells whether a change was sent. */
  onClose?: (saved: boolean) => void;
}) {
  const [editing, setEditing] = createSignal(props.startOpen ?? false);
  const value = () => String(props.scalar.value ?? "");

  /** Leaves editing mode, saving `text` if it is given and is a change. */
  const close = (text: string | null) => {
    if (!editing()) return;
    setEditing(false);
    const next = text?.trim() ?? null;
    // With mixed values, leaving the input empty means "no change".
    const changed =
      next !== null && (props.scalar.mixed ? next !== "" : next !== value());
    if (changed) props.onCommit(next || null);
    props.onClose?.(changed);
  };
  const focus = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) =>
    queueMicrotask(() => {
      element.focus();
      if (!(element instanceof HTMLSelectElement)) element.select();
    });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close(null);
    } else if (event.key === "Enter" && !(props.long && event.shiftKey)) {
      event.preventDefault();
      close((event.currentTarget as HTMLInputElement).value);
    }
  };

  return (
    <>
      <dt>{props.label}</dt>
      <dd class="detail">
        <Show
          when={editing()}
          fallback={
            <button
              class="detail-value"
              classList={{ unset: !isSet(props.scalar) || props.scalar.mixed }}
              title="Click to edit"
              onClick={() => setEditing(true)}
            >
              {props.scalar.mixed ? "(mixed)" : value() || "Not set"}
            </button>
          }
        >
          <Switch
            fallback={
              <input
                type="text"
                ref={focus}
                value={value()}
                placeholder={props.scalar.mixed ? "(mixed)" : (props.placeholder ?? "")}
                onBlur={(e) => close(e.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
            }
          >
            <Match when={props.options}>
              {(options) => (
                <select
                  ref={focus}
                  onChange={(e) => {
                    const choice = e.currentTarget.value;
                    if (!editing()) return;
                    setEditing(false);
                    if (choice !== "mixed") props.onCommit(choice || null);
                    props.onClose?.(choice !== "mixed");
                  }}
                  onBlur={() => close(null)}
                  onKeyDown={(e) => e.key === "Escape" && close(null)}
                >
                  <Show when={props.scalar.mixed}>
                    <option value="mixed" selected>
                      (mixed)
                    </option>
                  </Show>
                  <Show when={!props.required}>
                    <option value="" selected={!props.scalar.mixed && value() === ""}>
                      Not set
                    </option>
                  </Show>
                  <For each={options()}>
                    {(option) => (
                      <option value={option} selected={!props.scalar.mixed && value() === option}>
                        {option}
                      </option>
                    )}
                  </For>
                </select>
              )}
            </Match>
            <Match when={props.long}>
              <textarea
                ref={focus}
                rows={4}
                value={value()}
                placeholder={props.scalar.mixed ? "(mixed)" : "Shift+Enter for a new line"}
                onBlur={(e) => close(e.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
            </Match>
          </Switch>
        </Show>
      </dd>
    </>
  );
}

/** The "+" under the details: a menu of the fields that are not set yet. */
/**
 * "Add field" and its menu of the fields not on show, in groups with a
 * line between them.
 */
function AddField(props: {
  groups: { field: string; label: string }[][];
  onPick: (field: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const groups = () => props.groups.filter((group) => group.length > 0);
  return (
    <Show when={groups().length > 0}>
      <div
        class="add-field"
        // Closes when focus leaves the button and its menu.
        onFocusOut={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
        // A native listener, so stopping the event keeps Escape from also
        // clearing the selection.
        on:keydown={(event) => {
          if (event.key === "Escape" && open()) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <button
          class="link"
          aria-haspopup="menu"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <Icon name="add" />
          Add field
        </button>
        <Show when={open()}>
          <ul class="suggestions" role="menu">
            <For each={groups()}>
              {(group, index) => (
                <>
                  <Show when={index() > 0}>
                    <li class="menu-divider" role="separator" />
                  </Show>
                  <For each={group}>
                    {(entry) => (
                      <li role="none">
                        <button
                          role="menuitem"
                          onClick={() => {
                            setOpen(false);
                            props.onPick(entry.field);
                          }}
                        >
                          {entry.label}
                        </button>
                      </li>
                    )}
                  </For>
                </>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}

/** How many suggestions the dropdown shows at once. */
const MAX_SUGGESTIONS = 8;

/**
 * Editor for one multi-valued field: an input with suggestions, and below
 * it the values the selection carries. A value only some of the selection
 * has shows how many in brackets, and a "+" to give it to the rest.
 */
/** Only web addresses are made into links; anything else is shown as text. */
const isWebAddress = (url: string) => /^https?:\/\//i.test(url);

/**
 * A list field is drawn two ways: in the panel as just its values, under
 * a label that opens the editor; and with `editing`, in that editor's
 * modal, with the box to add values and the buttons to remove them.
 */
type ListMode = { editing?: boolean; onEdit?: () => void };

/** A list field's label in the panel: click it to edit the list. */
function ListLabel(props: ListMode & { label: string }) {
  return (
    <button class="label list-label" title={`Edit ${props.label}`} onClick={props.onEdit}>
      {props.label}
      <Icon name="edit-outline" />
    </button>
  );
}

/**
 * The lists a file has that are not tags: plain values with no
 * suggestions, namespaces or aliases. Source URLs are shown as links, one
 * to a line; identifiers as chips.
 */
const PLAIN_LISTS = [
  {
    field: "identifier",
    label: "Identifiers",
    placeholder: "Add…",
    links: false,
    values: (data: Metadata) => data.identifiers,
    add: (value: string): Changes => ({ add_identifiers: [value] }),
    remove: (value: string): Changes => ({ remove_identifiers: [value] }),
  },
  {
    field: "source_url",
    label: "Source URLs",
    placeholder: "Add a link…",
    links: true,
    values: (data: Metadata) => data.source_urls,
    add: (value: string): Changes => ({ add_urls: [value] }),
    remove: (value: string): Changes => ({ remove_urls: [value] }),
  },
];

function PlainList(props: FieldProps & ListMode & { list: (typeof PLAIN_LISTS)[number] }) {
  const [text, setText] = createSignal("");
  const values = () => props.list.values(props.data);

  const add = () => {
    const value = text().trim();
    if (!value) return;
    setText("");
    props.apply(props.list.add(value));
  };

  /** How many of the selection have a value, and the buttons acting on it. */
  const controls = (entry: { value: string; count: number }) => (
    <>
      <Show when={entry.count < props.data.count}>
        <span class="chip-count" title={`On ${entry.count} of ${props.data.count} selected`}>
          ({entry.count})
        </span>
      </Show>
      <Show when={props.editing}>
        <span class="chip-actions">
          <Show when={entry.count < props.data.count}>
            <button
              class="chip-add"
              aria-label={`Add ${entry.value} to all selected`}
              title="Add to all selected"
              onClick={() => props.apply(props.list.add(entry.value))}
            >
              <Icon name="add" />
            </button>
          </Show>
          <button
            class="chip-remove"
            aria-label={`Remove ${entry.value}`}
            title="Remove"
            onClick={() => props.apply(props.list.remove(entry.value))}
          >
            <Icon name="close" />
          </button>
        </span>
      </Show>
    </>
  );

  return (
    <div class="field">
      <Show when={props.editing} fallback={<ListLabel label={props.list.label} {...props} />}>
        <input
          type="text"
          autofocus
          aria-label={`Add to ${props.list.label}`}
          placeholder={props.list.placeholder}
          autocomplete="off"
          spellcheck={false}
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
      </Show>
      <Show when={values().length > 0}>
        <Show
          when={props.list.links}
          fallback={
            <div class="chips plain-chips">
              <For each={values()}>
                {(entry) => (
                  <span class="chip" classList={{ partial: entry.count < props.data.count }}>
                    <span class="chip-label">{entry.value}</span>
                    {controls(entry)}
                  </span>
                )}
              </For>
            </div>
          }
        >
          <ul class="links">
            <For each={values()}>
              {(entry) => (
                <li>
                  <Show
                    when={isWebAddress(entry.value)}
                    fallback={<span class="link-text">{entry.value}</span>}
                  >
                    <a
                      class="link-text"
                      href={entry.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={entry.value}
                    >
                      {entry.value}
                    </a>
                  </Show>
                  {controls(entry)}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

/**
 * The heading of a group of chips: the namespace they share. Clicking it
 * searches the namespace; the pencil renames it everywhere.
 */
function Namespace(props: { field: string; name: string; rename?: RenameNamespace }) {
  const [editing, setEditing] = createSignal(false);

  const save = (typed: string) => {
    // As the server will store it: no space around colons, none trailing.
    const to = typed
      .split(":")
      .map((part) => part.trim())
      .join(":")
      .replace(/:+$/, "");
    setEditing(false);
    if (to === props.name) return;
    const question = to
      ? `Rename the namespace "${props.name}" to "${to}"?`
      : `Remove the namespace "${props.name}"? Its tags are kept, without it.`;
    const kind = fieldLabel(props.field).toLowerCase();
    const scope = `This changes every ${kind} tag under it, across the whole library.`;
    if (confirm(`${question} ${scope}`)) props.rename?.(props.field, props.name, to);
  };

  return (
    <span class="namespace">
      <Show
        when={editing()}
        fallback={
          <>
            <button
              class="namespace-label"
              title="Search for everything in this namespace"
              onClick={() => openTab("gallery", tagQuery(props.field, props.name, true))}
            >
              {props.name}:
            </button>
            <Show when={props.rename}>
              <button
                class="namespace-edit"
                aria-label={`Rename the namespace ${props.name}`}
                title="Rename this namespace everywhere"
                onClick={() => setEditing(true)}
              >
                <Icon name="edit-outline" />
              </button>
            </Show>
          </>
        }
      >
        <input
          type="text"
          aria-label={`New name for the namespace ${props.name}`}
          value={props.name}
          ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save(event.currentTarget.value);
            else if (event.key === "Escape") setEditing(false);
          }}
        />
      </Show>
    </span>
  );
}

type RenameNamespace = (field: string, from: string, to: string) => void;

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

  // With nothing typed this returns the type's most used tags.
  const [fetched] = createResource(
    () => {
      const { field, value } = read();
      return field && !removing() ? { field, typed: value } : null;
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
              {read().field && read().value && !removing()
                ? "No tag like that yet. Enter adds it as a new one."
                : removing()
                  ? "Nothing like that to take off."
                  : "Nothing to suggest."}
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
function TagsEditor(props: FieldProps & { initial?: string }) {
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
      setError(err instanceof Error ? err.message : String(err));
    }
    changed();
  };
  return (
    <Modal title={`Tags of ${props.target}`} medium onClose={props.onClose}>
      <div class="field-editor">
        {/* `latest` keeps the tags on screen while a change reloads them. */}
        <Show when={metadata.latest} fallback={<div class="field" />}>
          {(data) => <TagsEditor data={data()} apply={apply} />}
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
function TagField(props: FieldProps & ListMode & { field: string }) {
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
function AggregatedTags(props: FieldProps & ListMode) {
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
