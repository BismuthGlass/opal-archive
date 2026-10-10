import { createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import type { Changes, FileSet, Metadata } from "../api";
import { errorMessage, plural } from "../format";
import { changed, dataVersion } from "../search";
import { activeTab, inside, leave, openSet, shownSet } from "../tabs";
import { showToast } from "../toast";
import Detail from "./Detail";
import Modal from "./Modal";
import PlainList, { PLAIN_LISTS, PlainListRow } from "./PlainList";

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
 * what it is called and says of itself, to read and to change. A set has
 * no tags: those are its files'.
 */
export default function SetPanel(props: { set: number }) {
  const [error, setError] = createSignal<string | null>(null);
  /** The list open in the modal where its values are added and removed. */
  const [editingList, setEditingList] = createSignal<string | null>(null);
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
            <Detail
              label="Title"
              scalar={scalar(current().title)}
              onCommit={(title) => apply({ set: { title } })}
            />
            <Detail
              label="Description"
              scalar={scalar(current().description)}
              long
              onCommit={(description) => apply({ set: { description } })}
            />
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
                <PlainListRow
                  list={list}
                  data={asSelection(current())}
                  apply={apply}
                  onEdit={() => setEditingList(list.field)}
                />
              )}
            </For>
          </dl>
          <Show when={error()}>
            <p class="form-error" role="alert">
              {error()}
            </p>
          </Show>
          <p class="hint">A set has no tags of its own. Select its files to tag them.</p>
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
