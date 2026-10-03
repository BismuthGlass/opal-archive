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
import { AI_CONTENT, COLLECTION_TYPES, CONTENT_RATINGS, TAG_FIELDS } from "../api";
import type { Changes, Metadata, Scalar } from "../api";
import { dateTime, duration, fieldLabel, fileSize, plural, tagQuery } from "../format";
import { changed, clearSelection, dataVersion, selected } from "../search";
import { aggregatedTypes, pillStyle, prefixOf, tagType, typeOfPrefix } from "../tagTypes";
import { open as openTab, openCollection } from "../tabs";
import Icon from "./Icon";
import Modal from "./Modal";
import { createStoredFlag } from "./Panel";

const SCORES = [1, 2, 3, 4, 5, 6, 7];
/** Names the list of every aggregated tag type, where a field is named. */
const AGGREGATE = "aggregate";
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
export default function Sidebar(props: { onGroup: () => void }) {
  const ids = createMemo(() => [...selected()]);
  const [error, setError] = createSignal<string | null>(null);
  /** An unset field picked from "Add field", shown while it is filled in. */
  const [adding, setAdding] = createSignal<string | null>(null);
  /**
   * The list field (a tag field, or one of the plain lists) open in the
   * modal where its values are added and removed. The panel itself only
   * shows the values.
   */
  const [editingList, setEditingList] = createSignal<string | null>(null);
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
    const list =
      field === AGGREGATE ||
      PLAIN_LISTS.some((list) => list.field === field) ||
      (TAG_FIELDS as readonly string[]).includes(field);
    if (!list) return setAdding(field);
    setEditingList(field);
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
  const rename = async (field: string, from: string, to: string) => {
    try {
      await api.renameNamespace(field, from, to);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    changed();
  };
  const set = (field: string) => (value: string | number | null) =>
    apply({ set: { [field]: value } });

  /** Whether everything selected is already in the trash. */
  const allTrashed = () => meta() !== undefined && meta()!.trashed === meta()!.count;

  /** Trashes, restores or deletes the selection. */
  const dispose = async (action: (ids: number[]) => Promise<unknown>, gone = false) => {
    try {
      await action(ids());
      // Trashed and restored items stay listed, and selected; deleted ones
      // are gone.
      if (gone) clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    changed();
  };
  // Deleting is two steps: to the trash, and from there for good.
  const trash = () => dispose(api.trashEntities);
  const restore = () => dispose(api.restoreEntities);
  const remove = () => {
    const count = ids().length;
    if (confirm(`Delete ${plural(count, "item")} for good? This cannot be undone.`)) {
      dispose(api.deleteEntities, true);
    }
  };

  const download = () => {
    const file = single()?.file;
    // One file downloads as itself; anything else as a zip.
    if (file) location.href = api.contentUrl(ids()[0], true);
    else api.exportZip(ids());
  };

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
      <Show when={meta()}>
        {(data) => (
          <>
            <Stars scalar={data().scalars.score} onChange={set("score")} />
            {/* The aggregated tags, straight under the score. */}
            <Show when={aggregatedTypes().length > 0}>
              <AggregatedTags
                data={data()}
                apply={apply}
                onEdit={() => setEditingList(AGGREGATE)}
              />
            </Show>
          </>
        )}
      </Show>
      <div class="actions">
        <button onClick={download}>
          <Icon name="download" />
          Download
        </button>
        <Show
          when={allTrashed()}
          fallback={
            <button class="danger" title="Move to the trash" onClick={trash}>
              <Icon name="delete-outline" />
              Trash
            </button>
          }
        >
          <button title="Take out of the trash" onClick={restore}>
            <Icon name="restore-from-trash-outline" />
            Restore
          </button>
          <button class="danger" title="Delete for good" onClick={remove}>
            <Icon name="delete-forever-outline" />
            Delete
          </button>
        </Show>
      </div>
      <Show when={meta()}>
        {(data) => <Collections data={data()} onAdd={props.onGroup} onLeave={leave} />}
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
            <For each={TAG_FIELDS.filter((field) => !tagType(field).aggregate)}>
              {(field) => (
                <Show when={filled(data(), field)}>
                  <TagField
                    field={field}
                    data={data()}
                    apply={apply}
                    rename={rename}
                    onEdit={() => setEditingList(field)}
                  />
                </Show>
              )}
            </For>
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
                [
                  ...TAG_FIELDS.filter(
                    (field) => !tagType(field).aggregate && !filled(data(), field),
                  ).map((field) => ({ field, label: fieldLabel(field) })),
                  ...PLAIN_LISTS.filter((list) => list.values(data()).length === 0).map(
                    ({ field, label }) => ({ field, label }),
                  ),
                ],
              ]}
              onPick={pick}
            />

            {/* Values are added and removed in a modal, one field at a time. */}
            <Show when={editingList()}>
              {(field) => {
                const plain = () => PLAIN_LISTS.find((list) => list.field === field());
                return (
                  <Modal
                    title={`${
                      plain()?.label ?? (field() === AGGREGATE ? "Tags" : fieldLabel(field()))
                    } of ${
                      data().count === 1 ? "this item" : plural(data().count, "item")
                    }`}
                    onClose={() => setEditingList(null)}
                  >
                    <div class="field-editor">
                      <Show
                        when={plain()}
                        fallback={
                          <Show
                            when={field() !== AGGREGATE}
                            fallback={<AggregatedTags data={data()} apply={apply} editing />}
                          >
                            <TagField
                              field={field()}
                              data={data()}
                              apply={apply}
                              rename={rename}
                              editing
                            />
                          </Show>
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

/**
 * The box that adds tags to one field, with suggestions while typing.
 *
 * With `onType`, the field can be changed from the box itself: `@cr ` at
 * the start switches to creators, and so on for each type's prefix. The
 * prefix leaves the box once it has been understood, and what follows is a
 * tag of that type. While only `@…` is typed the suggestions are the types.
 */
function TagInput(props: FieldProps & { field: string; onType?: (field: string) => void }) {
  const [text, setText] = createSignal("");
  const [open, setOpen] = createSignal(false);
  /** Highlighted suggestion; -1 means the typed text itself. */
  const [active, setActive] = createSignal(-1);
  const values = () => props.data.tags[props.field] ?? [];
  const listId = `suggest-${props.field}`;

  /** The letters typed after an @, while a type is still being named. */
  const naming = () => (props.onType && text().startsWith("@") ? text().slice(1).toLowerCase() : null);
  const types = createMemo(() => {
    const typed = naming();
    if (typed === null) return [];
    return TAG_FIELDS.filter(
      (field) => prefixOf(field).startsWith(typed) || field.replaceAll("_", " ").startsWith(typed),
    );
  });

  // With nothing typed this returns the field's most used values.
  const [fetched] = createResource(
    () => (open() && naming() === null ? { field: props.field, typed: text().trim() } : null),
    ({ field, typed }) => api.suggestTags(field, typed),
  );
  const suggestions = createMemo(() => {
    if (naming() !== null) return [];
    // Values the whole selection already has are not worth offering.
    const complete = new Set(
      values()
        .filter((tag) => tag.count === props.data.count)
        .map((tag) => tag.value.toLowerCase()),
    );
    return (fetched.latest ?? [])
      .filter((option) => option.namespace || !complete.has(option.value.toLowerCase()))
      .slice(0, MAX_SUGGESTIONS);
  });
  /** How many rows the list has, of whichever kind it is showing. */
  const rows = () => (naming() !== null ? types().length : suggestions().length);

  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setText("");
    setActive(-1);
    props.apply({ add: { [props.field]: [trimmed] } });
  };

  /** Choosing a namespace steps into it; choosing a tag adds it. */
  const pick = (option: api.Suggestion) => {
    if (option.namespace) {
      setText(option.value);
      setActive(-1);
    } else {
      add(option.value);
    }
  };

  /** Goes over to another type, keeping what was typed after its prefix. */
  const switchTo = (field: string, rest = "") => {
    props.onType?.(field);
    setText(rest);
    setActive(-1);
  };

  const onInput = (typed: string) => {
    setOpen(true);
    setActive(-1);
    // "@cr " at the start: a prefix, finished by the space.
    const prefixed = props.onType ? /^@(\S+)\s(.*)$/.exec(typed) : null;
    const field = prefixed && typeOfPrefix(prefixed[1]);
    if (field) switchTo(field, prefixed![2]);
    else setText(typed);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const count = rows();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1 >= count ? -1 : i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i < 0 ? count - 1 : i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (naming() !== null) {
        // An unfinished prefix names a type; it is never a tag.
        const field = types()[Math.max(0, active())];
        if (field) switchTo(field);
      } else if (active() >= 0) {
        pick(suggestions()[active()]);
      } else {
        add(text());
      }
    } else if (event.key === "Backspace" && text() === "" && props.field !== "tags") {
      // Deleting past the start goes back to plain tags.
      props.onType?.("tags");
    } else if (event.key === "Escape") {
      // With suggestions showing, Escape puts them away and no more.
      if (open() && count > 0) event.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div class="suggest">
      <input
        type="text"
        role="combobox"
        autofocus
        aria-label={`Add to ${fieldLabel(props.field)}`}
        aria-expanded={open() && rows() > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autocomplete="off"
        placeholder={props.onType ? `Add to ${fieldLabel(props.field)}, or @ for another type` : "Add…"}
        value={text()}
        onInput={(e) => onInput(e.currentTarget.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      <Show when={open() && rows() > 0}>
        <ul class="suggestions" id={listId} role="listbox">
          <For each={types()}>
            {(field, i) => (
              <li
                role="option"
                aria-selected={i() === active()}
                classList={{ active: i() === active() }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => switchTo(field)}
              >
                <span class="chip tinted type-sample" style={pillStyle(field)}>
                  {fieldLabel(field)}
                </span>
                <span class="suggestion-count">@{prefixOf(field)}</span>
              </li>
            )}
          </For>
          <For each={suggestions()}>
            {(option, i) => (
              <li
                role="option"
                aria-selected={i() === active()}
                classList={{ active: i() === active() }}
                // Keeps focus in the input, so the list stays open to click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(option)}
              >
                <span class="suggestion-value">
                  <Show when={option.alias}>
                    <span class="suggestion-alias">{option.alias} → </span>
                  </Show>
                  {option.value}
                </span>
                <span class="suggestion-count">
                  {option.count}
                  <Show when={option.namespace}>
                    <Icon name="chevron-right" />
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
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
            : `${fieldLabel(props.field)}: ${props.tag.value}\nClick to search for it`
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

/** The tags of one type, in a section of their own, grouped by namespace. */
function TagField(props: FieldProps & ListMode & { field: string; rename: RenameNamespace }) {
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
        fallback={<ListLabel label={fieldLabel(props.field)} {...props} />}
      >
        <TagInput field={props.field} data={props.data} apply={props.apply} />
      </Show>
      <Show when={values().length > 0}>
        <div class="tag-groups">
          <For each={groups()}>
            {(group) => (
              <div class="chips">
                <Show when={group.namespace}>
                  <Namespace
                    field={props.field}
                    name={group.namespace}
                    rename={props.editing ? props.rename : undefined}
                  />
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
      </Show>
    </div>
  );
}

/**
 * The tags of every aggregated type in one list, told apart by the colour
 * of their pills. In the panel the list has no heading, and ends in the
 * button that opens its editor. In the editor what is typed is a plain tag
 * unless a type is chosen, with its prefix (`@cr `) or from the row of
 * types above the box, which also shows the one in force.
 */
function AggregatedTags(props: FieldProps & ListMode) {
  /** The type what is typed goes to: plain tags, until a prefix says otherwise. */
  const [target, setTarget] = createSignal<string>("tags");
  // In the editor a type reached by its prefix is listed too, even if it
  // is not one of the aggregated ones, so that what is added can be seen.
  const types = createMemo(() =>
    TAG_FIELDS.filter(
      (field) => tagType(field).aggregate || (props.editing && field === target()),
    ),
  );
  const entries = () =>
    types().flatMap((field) => (props.data.tags[field] ?? []).map((tag) => ({ field, tag })));

  return (
    <div class={props.editing ? "field" : "aggregate"}>
      <Show when={props.editing}>
        <div class="type-picker" role="radiogroup" aria-label="Type of the tag to add">
          <For each={types()}>
            {(field) => (
              <button
                class="chip tinted"
                role="radio"
                aria-checked={field === target()}
                style={pillStyle(field)}
                // Not on mouse down, so the box keeps the cursor.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setTarget(field)}
              >
                {fieldLabel(field)}
                <span class="type-prefix">@{prefixOf(field)}</span>
              </button>
            )}
          </For>
        </div>
        <TagInput field={target()} data={props.data} apply={props.apply} onType={setTarget} />
      </Show>
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
