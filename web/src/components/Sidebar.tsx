import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import * as api from "../api";
import { CONTENT_RATINGS } from "../api";
import type { Changes, Metadata, Scalar } from "../api";
import {
  dateTime,
  duration,
  errorMessage,
  fileSize,
  plural,
  setName,
} from "../format";
import { changed, dataVersion, selected } from "../search";
import { aggregatedTypes, orderedTypes, prefixOf, tagType } from "../tagTypes";
import { enter, shownSet, shownVariants } from "../tabs";
import Detail, { isSet } from "./Detail";
import Icon from "./Icon";
import Modal from "./Modal";
import PlainList, { PLAIN_LISTS, PlainListRow } from "./PlainList";
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
  single?: boolean;
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
  { field: "original_name", label: "Filename", single: true },
  // What the files that are variants of each other share.
  { field: "alt_group_id", label: "Variant group" },
];

/**
 * Actions on the selection and its metadata, for the side panel. With
 * several files selected every edit applies to all of them: fields show
 * the value they share or "(mixed)", and tags show how many of the
 * selection carry them.
 */
export default function Sidebar(props: {
  /** Asks for the given files to be put into a set. */
  onGroup: (ids: number[]) => void;
}) {
  const ids = createMemo(() => [...selected()]);
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

  const leave = async (set: number) => {
    try {
      await api.changeSetFiles(set, { remove: ids() });
    } catch (err) {
      setError(errorMessage(err));
    }
    changed();
  };

  return (
    <>
      {/* From the top: the score, the set, then the tags, the
          aggregated ones first and each other type under them. What is
          about the file itself comes after. */}
      <Show when={meta()}>
        {(data) => (
          <>
            <Stars scalar={data().scalars.score} onChange={set("score")} />
            <Sets data={data()} onAdd={() => props.onGroup(ids())} onLeave={leave} />
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
                      (!detail.single || data().count === 1) &&
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
              <Show when={single()}>
                {(current) => (
                  <>
                    <dt>Type</dt>
                    <dd>
                      {current().file.media_type}
                      {current().file.extension && ` (${current().file.extension})`},{" "}
                      <a href={api.contentUrl(current().id)} target="_blank" rel="noreferrer">
                        open
                      </a>
                    </dd>
                    <Show when={current().file.width && current().file.height}>
                      <dt>Size</dt>
                      <dd>
                        {current().file.width} × {current().file.height}
                      </dd>
                    </Show>
                    <Show when={current().file.length !== null}>
                      <dt>Length</dt>
                      <dd>{duration(current().file.length!)}</dd>
                    </Show>
                    <Show when={current().file.page_count !== null}>
                      <dt>Pages</dt>
                      <dd>{current().file.page_count}</dd>
                    </Show>
                    <dt>On disk</dt>
                    <dd>{fileSize(current().file.size)}</dd>
                    <Show when={current().file.alt_group_id}>
                      {(group) => (
                        <>
                          <dt>Variants</dt>
                          <dd>
                            <Show when={group() !== shownVariants()} fallback="on show">
                              <button
                                class="link"
                                title="Show the files of this variant group, in this tab"
                                onClick={() => enter({ variants: group() })}
                              >
                                show them
                              </button>
                            </Show>
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
              <For each={PLAIN_LISTS}>
                {(list) => (
                  <Show when={listed(list, data())}>
                    <PlainListRow
                      list={list}
                      data={data()}
                      apply={apply}
                      onEdit={() => setEditingList(list.field)}
                    />
                  </Show>
                )}
              </For>
            </dl>

            <AddField
              groups={[
                DETAIL_FIELDS.filter(
                  (detail) =>
                    (!detail.single || data().count === 1) &&
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
                    <PlainList list={list} data={data()} apply={apply} />
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
 * The set the selection is in, or the sets its files are: each opens when
 * pressed, and the selection can be taken out of it. The button puts the
 * selection into a set, new or existing.
 */
function Sets(props: { data: Metadata; onAdd: () => void; onLeave: (set: number) => void }) {
  const count = () => props.data.sets.length;
  return (
    <div class="sets">
      <div class="sets-head">
        <span class="sets-label">{count() === 0 ? "In no set" : count() === 1 ? "Set" : "Sets"}</span>
        <button
          class="sets-add"
          aria-label="Put in a set"
          title="Put in a set, new or existing"
          onClick={props.onAdd}
        >
          <Icon name="add" />
        </button>
      </div>
      <Show when={count() > 0}>
        <div class="chips">
          <For each={props.data.sets}>
            {(set) => (
              <span class="chip" classList={{ partial: set.count < props.data.count }}>
                <button
                  class="chip-label"
                  title={set.id === shownSet()?.id ? "The set on show" : `Open this set (${set.set_id})`}
                  onClick={() => enter(set)}
                >
                  {setName(set)}
                </button>
                <Show when={set.count < props.data.count}>
                  <span
                    class="chip-count"
                    title={`${set.count} of ${props.data.count} selected are in it`}
                  >
                    ({set.count})
                  </span>
                </Show>
                <span class="chip-actions">
                  <button
                    class="chip-remove"
                    aria-label="Take out of the set"
                    title="Take out of the set"
                    onClick={() => props.onLeave(set.id)}
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
