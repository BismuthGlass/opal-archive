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
import { AI_CONTENT, COLLECTION_TYPES, CONTENT_RATINGS, FLAT_TAG_FIELDS, TAG_FIELDS } from "../api";
import type { Changes, Metadata, Scalar } from "../api";
import { duration, fieldLabel, fileSize, plural, tagQuery } from "../format";
import { changed, clearSelection, dataVersion, selected } from "../search";
import { open as openTab } from "../tabs";
import Icon from "./Icon";

const SCORES = [1, 2, 3, 4, 5, 6, 7];

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
    ([list]) => api.getMetadata(list),
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

  const remove = async () => {
    const count = ids().length;
    if (!confirm(`Delete ${plural(count, "item")}? Deleted files leave the library for good.`)) {
      return;
    }
    try {
      await api.deleteEntities(ids());
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    changed();
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
        {(data) => <Stars scalar={data().scalars.score} onChange={set("score")} />}
      </Show>
      <div class="actions">
        <button onClick={download}>
          <Icon name="download" />
          Download
        </button>
        <button onClick={props.onGroup}>
          <Icon name="create-new-folder-outline" />
          Collect…
        </button>
        <button class="danger" onClick={remove}>
          <Icon name="delete-outline" />
          Delete
        </button>
      </div>
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
            {/* Details: only the fields that are set, each edited by clicking
                its value. "Add field" brings in one of the others. */}
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
                              onClick={() => openTab("search", `in=${current().id} sort=position`)}
                            >
                              {plural(collection().member_count, "item")}, open
                            </button>
                          </dd>
                        </>
                      )}
                    </Show>
                    <dt>Added</dt>
                    <dd>{current().date_added.slice(0, 10)}</dd>
                    <dt>ID</dt>
                    <dd>{current().id}</dd>
                  </>
                )}
              </Show>
            </dl>
            <AddField
              fields={DETAIL_FIELDS.filter(
                (detail) =>
                  (!detail.fileOnly || (data().count === 1 && data().files === 1)) &&
                  !isSet(data().scalars[detail.field]) &&
                  adding() !== detail.field,
              )}
              onPick={setAdding}
            />

            <For each={TAG_FIELDS}>
              {(field) => <TagField field={field} data={data()} apply={apply} rename={rename} />}
            </For>

            <div class="field">
              <span class="label">Collections</span>
              <div class="chips">
                <For each={data().memberships} fallback={<span class="none">None</span>}>
                  {(membership) => (
                    <span class="chip" classList={{ partial: membership.count < data().count }}>
                      <button
                        class="chip-label"
                        title="Open this collection"
                        onClick={() => openTab("search", `in=${membership.id} sort=position`)}
                      >
                        {membership.title || `#${membership.id}`}
                      </button>
                      <Show when={membership.count < data().count}>
                        <span
                          class="chip-count"
                          title={`${membership.count} of ${data().count} selected are in it`}
                        >
                          ({membership.count})
                        </span>
                      </Show>
                      <span class="chip-actions">
                        <button
                          class="chip-remove"
                          aria-label="Remove from collection"
                          title="Remove from collection"
                          onClick={() => leave(membership.id)}
                        >
                          <Icon name="close" />
                        </button>
                      </span>
                    </span>
                  )}
                </For>
              </div>
            </div>
          </>
        )}
      </Show>
    </>
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
function AddField(props: { fields: DetailField[]; onPick: (field: string) => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={props.fields.length > 0}>
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
            <For each={props.fields}>
              {(detail) => (
                <li role="none">
                  <button
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      props.onPick(detail.field);
                    }}
                  >
                    {detail.label}
                  </button>
                </li>
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
/**
 * The heading of a group of chips: the namespace they share. Clicking it
 * searches the namespace; the pencil renames it everywhere.
 */
function Namespace(props: { field: string; name: string; rename: RenameNamespace }) {
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
    if (confirm(`${question} ${scope}`)) props.rename(props.field, props.name, to);
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
              onClick={() => openTab("search", tagQuery(props.field, props.name, true))}
            >
              {props.name}:
            </button>
            <button
              class="namespace-edit"
              aria-label={`Rename the namespace ${props.name}`}
              title="Rename this namespace everywhere"
              onClick={() => setEditing(true)}
            >
              <Icon name="edit-outline" />
            </button>
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

function TagField(props: FieldProps & { field: string; rename: RenameNamespace }) {
  const [text, setText] = createSignal("");
  const [open, setOpen] = createSignal(false);
  /** Highlighted suggestion; -1 means the typed text itself. */
  const [active, setActive] = createSignal(-1);
  const values = () => props.data.tags[props.field] ?? [];
  const listId = `suggest-${props.field}`;

  // With nothing typed this returns the field's most used values.
  const [fetched] = createResource(
    () => (open() ? { typed: text().trim() } : null),
    ({ typed }) => api.suggestTags(props.field, typed),
  );
  const suggestions = createMemo(() => {
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

  /** The values by namespace: those without one first, then by name. */
  const groups = createMemo(() => {
    const flat = FLAT_TAG_FIELDS.includes(props.field);
    type Group = { namespace: string; tags: Metadata["tags"][string] };
    const byNamespace = new Map<string, Group>();
    for (const tag of values()) {
      const colon = flat ? -1 : tag.value.lastIndexOf(":");
      const namespace = colon < 0 ? "" : tag.value.slice(0, colon);
      const key = namespace.toLowerCase();
      if (!byNamespace.has(key)) byNamespace.set(key, { namespace, tags: [] });
      byNamespace.get(key)!.tags.push(tag);
    }
    return [...byNamespace.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => group);
  });
  /** A tag's own name, without its namespace. */
  const leaf = (value: string, namespace: string) =>
    namespace ? value.slice(namespace.length + 1) : value;

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

  const onKeyDown = (event: KeyboardEvent) => {
    const count = suggestions().length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1 >= count ? -1 : i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i < 0 ? count - 1 : i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active() >= 0) pick(suggestions()[active()]);
      else add(text());
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div class="field">
      <span class="label">{fieldLabel(props.field)}</span>
      <div class="suggest">
        <input
          type="text"
          role="combobox"
          aria-label={`Add to ${fieldLabel(props.field)}`}
          aria-expanded={open() && suggestions().length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autocomplete="off"
          placeholder="Add…"
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
        <Show when={open() && suggestions().length > 0}>
          <ul class="suggestions" id={listId} role="listbox">
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
      <Show when={values().length > 0}>
        <div class="tag-groups">
          <For each={groups()}>
            {(group) => (
            <div class="chips">
              <Show when={group.namespace}>
                <Namespace field={props.field} name={group.namespace} rename={props.rename} />
              </Show>
              <For each={group.tags}>
                {(tag) => {
                  const partial = () => tag.count < props.data.count;
                  return (
                    <span class="chip" classList={{ partial: partial() }}>
                      <button
                        class="chip-label"
                        title={group.namespace ? `Search for ${tag.value}` : "Search for this"}
                        onClick={() => openTab("search", tagQuery(props.field, tag.value))}
                      >
                        {leaf(tag.value, group.namespace)}
                      </button>
                      <Show when={partial()}>
                        <span
                          class="chip-count"
                          title={`On ${tag.count} of ${props.data.count} selected`}
                        >
                          ({tag.count})
                        </span>
                      </Show>
                      <span class="chip-actions">
                        <Show when={partial()}>
                          <button
                            class="chip-add"
                            aria-label={`Add ${tag.value} to all selected`}
                            title="Add to all selected"
                            onClick={() => props.apply({ add: { [props.field]: [tag.value] } })}
                          >
                            <Icon name="add" />
                          </button>
                        </Show>
                        <button
                          class="chip-remove"
                          aria-label={`Remove ${tag.value}`}
                          title="Remove"
                          onClick={() => props.apply({ remove: { [props.field]: [tag.value] } })}
                        >
                          <Icon name="close" />
                        </button>
                      </span>
                    </span>
                  );
                }}
              </For>
            </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
