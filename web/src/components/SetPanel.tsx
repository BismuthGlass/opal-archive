import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import * as api from "../api";
import type { Changes, FileSet, Metadata } from "../api";
import { errorMessage, plural } from "../format";
import { changed, dataVersion } from "../search";
import { activeTab, inside, leave, openSet, shownSet } from "../tabs";
import { showToast } from "../toast";
import Detail, { isSet } from "./Detail";
import Modal from "./Modal";
import PlainList, { PLAIN_LISTS, PlainListRow } from "./PlainList";
import { AddField } from "./Sidebar";

/** The single-valued fields a set may have or not, in the order they are listed. */
const SET_FIELDS = [
  { field: "title", label: "Title", long: false },
  { field: "description", label: "Description", long: true },
] as const;

/** A set's lists as the list editors read a selection's: one item with them all. */
const asSelection = (set: FileSet): Metadata => {
  const counted = (values: string[]) => values.map((value) => ({ value, count: 1 }));
  return {
    count: 1,
    trashed: 0,
    scalars: {},
    tags: {},
    source_url: counted(set.source_url),
    identifier: counted(set.identifier),
    reference: counted(set.reference),
    sets: [],
  };
};

/**
 * The set on show, for the side panel while nothing in it is selected:
 * what it is called and says of itself, to read and to change. Only what
 * is set is listed, as for a file: "Add field" brings in one of the rest.
 */
export default function SetPanel(props: { set: number }) {
  const [error, setError] = createSignal<string | null>(null);
  /** The list open in the modal where its values are added and removed. */
  const [editingList, setEditingList] = createSignal<string | null>(null);
  /** An unset field picked from "Add field", shown while it is filled in. */
  const [adding, setAdding] = createSignal<string | null>(null);
  // A half-added field belongs to the set it began on.
  createEffect(on(() => props.set, () => setAdding(null), { defer: true }));
  const pick = (field: string) => {
    if (PLAIN_LISTS.some((list) => list.field === field)) setEditingList(field);
    else setAdding(field);
  };
  const [loaded] = createResource(
    () => [props.set, dataVersion()] as const,
    ([id]) => api.getSet(id).catch(() => undefined),
  );
  // `latest` keeps the previous answer on screen while a new one loads.
  const set = () => loaded.latest;

  const apply = async (changes: Changes) => {
    try {
      await api.changeSet(props.set, changes);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    changed();
  };
  const scalar = (value: string | null) => ({ value, mixed: false });
  // Once a newly added field's value has been saved and reloaded, the row
  // shows because it is set, and no longer needs to be held open.
  let addedSaved = false;
  createEffect(
    on(
      () => loaded.latest,
      () => {
        if (addedSaved) setAdding(null);
        addedSaved = false;
      },
      { defer: true },
    ),
  );

  /** Takes the set apart, once it has been agreed to. Its files stay. */
  const dissolve = async (set: FileSet) => {
    const files = plural(set.files, "file");
    if (!confirm(`Take this set apart? Its ${files} stay in the library, in no set.`)) return;
    try {
      await api.deleteSet(set.id);
      showToast("Took the set apart");
      // Out of it, if the tab had gone into it; its own tab goes with it.
      if (inside() && shownSet()?.id === set.id) leave();
    } catch (err) {
      setError(errorMessage(err));
    }
    changed();
  };

  return (
    <Show when={set()}>
      {(current) => (
        <>
          <dl class="facts">
            <For each={SET_FIELDS}>
              {(detail) => (
                <Show when={isSet(scalar(current()[detail.field])) || adding() === detail.field}>
                  <Detail
                    label={detail.label}
                    scalar={scalar(current()[detail.field])}
                    long={detail.long}
                    startOpen={adding() === detail.field}
                    onCommit={(value) => apply({ set: { [detail.field]: value } })}
                    onClose={(saved) => {
                      if (adding() !== detail.field) return;
                      if (saved) addedSaved = true;
                      else setAdding(null);
                    }}
                  />
                </Show>
              )}
            </For>
            <Detail
              label="Set ID"
              scalar={scalar(current().set_id)}
              // A set always has one: emptied, it stays as it was.
              onCommit={(set_id) => set_id && apply({ set: { set_id } })}
            />
            <dt>Files</dt>
            <dd>{current().files}</dd>
            <For each={PLAIN_LISTS}>
              {(list) => (
                <Show when={list.values(asSelection(current())).length > 0}>
                  <PlainListRow
                    list={list}
                    data={asSelection(current())}
                    apply={apply}
                    onEdit={() => setEditingList(list.field)}
                  />
                </Show>
              )}
            </For>
          </dl>
          <AddField
            groups={[
              SET_FIELDS.filter(
                (detail) => !isSet(scalar(current()[detail.field])) && adding() !== detail.field,
              ).map(({ field, label }) => ({ field, label })),
              PLAIN_LISTS.filter((list) => list.values(asSelection(current())).length === 0).map(
                ({ field, label }) => ({ field, label }),
              ),
            ]}
            onPick={pick}
          />
          <Show when={error()}>
            <p class="form-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="panel-actions">
            <Show when={activeTab()?.set?.id !== current().id}>
              <button title="Open this set in a tab of its own" onClick={() => openSet(current().id)}>
                Open in a tab
              </button>
            </Show>
            <button
              class="danger"
              title="Take the set apart. Its files stay in the library, in no set."
              onClick={() => dissolve(current())}
            >
              Take apart
            </button>
          </div>
          <Show when={PLAIN_LISTS.find((list) => list.field === editingList())} keyed>
            {(list) => (
              <Modal title={`${list.label} of this set`} onClose={() => setEditingList(null)}>
                <div class="field-editor">
                  <PlainList list={list} data={asSelection(current())} apply={apply} />
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
  );
}
