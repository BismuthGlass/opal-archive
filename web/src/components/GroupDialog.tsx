import { createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { errorMessage, plural } from "../format";
import { addedTo, changed } from "../search";
import { tabs } from "../tabs";
import { showToast } from "../toast";
import Modal from "./Modal";

/** What the files can be grouped as, by an ID that is typed. */
export type GroupKind = "set" | "collection";

/**
 * Puts the given files in a set, or makes them part of a collection, by
 * its ID. One that is there already is joined; one that is not is made by
 * being named. Under the boxes are those some of the files are in
 * already, to pick from for the rest of them.
 */
export default function GroupDialog(props: {
  kind: GroupKind;
  ids: number[];
  onClose: () => void;
}) {
  const [title, setTitle] = createSignal("");
  const [id, setId] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const set = props.kind === "set";
  const what = set ? "set" : "collection";

  // Those some of the files have already: the likeliest to want the rest.
  const [present] = createResource(async () => {
    const data = await api.getMetadata(props.ids);
    return set
      ? data.sets.map((held) => ({ id: held.set_id, title: held.title, count: held.count }))
      : data.collection.map((held) => ({ id: held.value, title: null, count: held.count }));
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const given = id().trim();
    try {
      if (set) {
        // With no ID, a set is made with one made up for it.
        const joined = await api.joinSet(props.ids, title(), given);
        // A set that gained something shows it in its own tab.
        const tab = tabs.find((tab) => tab.set?.set_id === joined.set_id);
        if (tab) addedTo(tab.id);
      } else {
        if (!given) return setError("Give the collection an ID.");
        await api.edit(props.ids, { add_collection: [given] });
        // A title is for a collection that has none, as it is for a set.
        const wanted = title().trim();
        if (wanted && !(await api.getCollection(given)).title) {
          await api.changeCollection(given, { set: { title: wanted } });
        }
      }
      showToast(
        set
          ? `Put ${plural(props.ids.length, "file")} in the set`
          : `Made ${plural(props.ids.length, "file")} part of the collection`,
      );
      changed();
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal
      title={
        set
          ? `Put ${plural(props.ids.length, "file")} in a set`
          : `Make ${plural(props.ids.length, "file")} part of a collection`
      }
      onClose={props.onClose}
    >
      <form onSubmit={submit}>
        <label class="stacked">
          Title
          <input
            type="text"
            placeholder={`Given to the ${what} if it has none`}
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
        </label>
        <label class="stacked">
          ID
          <input
            type="text"
            placeholder={
              set
                ? "One there is already is joined. Leave empty to have one made up."
                : "One there is already is joined"
            }
            autocomplete="off"
            spellcheck={false}
            value={id()}
            onInput={(e) => setId(e.currentTarget.value)}
          />
        </label>

        <Show when={(present() ?? []).length > 0}>
          <span class="stacked">
            {props.ids.length === 1 ? `Already in` : `Already holding some of these`}
          </span>
          <ul class="pick-list" role="listbox" aria-label={`The ${what}s of the selection`}>
            <For each={present()}>
              {(held) => (
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={id().trim() === held.id}
                    // Nothing to add to one that has them all.
                    disabled={held.count === props.ids.length}
                    onClick={() => setId(held.id)}
                  >
                    <span class="pick-name" data-tip={held.id}>
                      {held.id}
                    </span>
                    <span class="pick-note">
                      {held.title ? `${held.title}, ` : ""}
                      {held.count === props.ids.length
                        ? props.ids.length === 1
                          ? "already in it"
                          : "has them all"
                        : `has ${held.count} of ${props.ids.length}`}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <footer>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="primary">
            Add
          </button>
        </footer>
      </form>
    </Modal>
  );
}
