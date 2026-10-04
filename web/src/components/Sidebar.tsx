import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import * as api from "../api";
import { COLLECTION_TYPES, CONTENT_RATINGS } from "../api";
import type { Changes, Metadata, Scalar } from "../api";
import { dateTime, duration, errorMessage, fileSize, plural } from "../format";
import { changed, dataVersion, selected } from "../search";
import { aggregatedTypes, orderedTypes, prefixOf, tagType } from "../tagTypes";
import { openCollection } from "../tabs";
import Detail, { isSet } from "./Detail";
import Icon from "./Icon";
import Modal from "./Modal";
import { createStoredFlag } from "./Panel";
import PlainList, { PLAIN_LISTS } from "./PlainList";
import { AggregatedTags, filled, TagField, TagsModal } from "./Tags";

const SCORES = [1, 2, 3, 4, 5, 6, 7];

/**
 * Whether the panel lists a plain list's values. Links are only listed for
 * a single item: each of several has its own, and together they are a wall
 * of addresses. "Add field" still opens them.
 */
const listed = (list: (typeof PLAIN_LISTS)[number], data: Metadata) =>
  list.values(data).length > 0 && !(list.links && data.count > 1);

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
   * The plain list open in the modal where its values are added and
   * removed. The panel itself only shows the values.
   */
  const [editingList, setEditingList] = createSignal<string | null>(null);
  /**
   * While the tag editor is open, what its box started with: a type,
   * written out, or nothing.
   */
  const [editingTags, setEditingTags] = createSignal<string | null>(null);
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
  /** What is shown, for a modal's title. */
  const target = () => (ids().length === 1 ? "this item" : plural(ids().length, "item"));
  const single = () => (ids().length === 1 ? entity.latest : undefined);

  const apply = async (changes: Changes) => {
    try {
      await api.edit(ids(), changes);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    changed();
  };
  const set = (field: string) => (value: string | number | null) =>
    apply({ set: { [field]: value } });

  const leave = async (collection: number) => {
    try {
      await api.changeMembers(collection, { remove: ids() });
    } catch (err) {
      setError(errorMessage(err));
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
              <AggregatedTags data={data()} apply={apply} onEdit={() => setEditingTags("")} />
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
                      onEdit={() => setEditingTags(`@${prefixOf(field)}:`)}
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
                {/* One collection's alone, so only shown for one. */}
                <Show when={data().count === 1}>
                  <Detail
                    label="Collection ID"
                    scalar={data().collection_id}
                    placeholder="None"
                    onCommit={set("collection_id")}
                  />
                </Show>
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
                <Show when={listed(list, data())}>
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
                PLAIN_LISTS.filter((list) => !listed(list, data())).map(
                  ({ field, label }) => ({ field, label }),
                ),
              ]}
              onPick={pick}
            />

            {/* Values are added and removed in a modal: one for each of the
                plain lists, and below, one for all the tags. */}
            <Show when={PLAIN_LISTS.find((list) => list.field === editingList())} keyed>
              {(list) => (
                <Modal
                  title={`${list.label} of ${target()}`}
                  onClose={() => setEditingList(null)}
                >
                  <div class="field-editor">
                    <PlainList list={list} data={data()} apply={apply} editing />
                  </div>
                  <Show when={error()}>
                    <p class="form-error" role="alert">
                      {error()}
                    </p>
                  </Show>
                </Modal>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={editingTags() !== null}>
        <TagsModal
          ids={ids()}
          target={target()}
          initial={editingTags() ?? ""}
          onClose={() => setEditingTags(null)}
        />
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
