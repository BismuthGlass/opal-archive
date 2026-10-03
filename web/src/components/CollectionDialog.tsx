import { createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { COLLECTION_TYPES } from "../api";
import { plural, quoteValue } from "../format";
import { addedTo, changed } from "../search";
import { tabs } from "../tabs";
import Modal from "./Modal";

/**
 * Puts the given entities into a new or an existing collection. Opened
 * from a collection's tab, a new collection can go inside that one.
 */
export default function CollectionDialog(props: {
  ids: number[];
  /** The collection whose tab this was opened from. */
  parent?: { id: number; title: string | null };
  onClose: () => void;
}) {
  const [mode, setMode] = createSignal<"new" | "existing">("new");
  const [title, setTitle] = createSignal("");
  const [type, setType] = createSignal(COLLECTION_TYPES[0]);
  const [ordered, setOrdered] = createSignal(false);
  const [nested, setNested] = createSignal(true);
  const [filter, setFilter] = createSignal("");
  const [target, setTarget] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // The collections some of the selection is in already: the likeliest
  // ones to want the rest of it.
  const [related] = createResource(
    () => (mode() === "existing" ? props.ids : null),
    async (ids) => (await api.getMetadata(ids)).memberships,
  );
  const relatedIds = () => new Set((related() ?? []).map((collection) => collection.id));

  const [existing] = createResource(
    () => (mode() === "existing" ? filter() : null),
    async (text) => {
      const match = text.trim() ? ` title~${quoteValue(text.trim())}` : "";
      return (await api.search(`kind=collection${match} sort=title`, 0, 200, 0)).items;
    },
  );

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    try {
      if (mode() === "new") {
        await api.createCollection(type(), title(), props.ids, {
          ordered: ordered(),
          parent: nested() ? props.parent?.id : undefined,
        });
      } else if (target() !== null) {
        await api.changeMembers(target()!, { add: props.ids });
      } else {
        return setError("Pick a collection.");
      }
      // A collection that gained something shows it in its own tab.
      const grown = mode() === "new" ? (nested() ? props.parent?.id : undefined) : target();
      const tab = tabs.find((tab) => grown != null && tab.collection?.id === grown);
      if (tab) addedTo(tab.id);
      changed();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal
      title={`Add ${plural(props.ids.length, "item")} to a collection`}
      onClose={props.onClose}
    >
      <form onSubmit={submit}>
        <div class="segmented">
          <label>
            <input type="radio" name="mode" checked={mode() === "new"} onChange={() => setMode("new")} />
            New collection
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode() === "existing"}
              onChange={() => setMode("existing")}
            />
            Existing collection
          </label>
        </div>

        <Show
          when={mode() === "new"}
          fallback={
            <>
              <Show when={(related() ?? []).length > 0}>
                <span class="stacked">
                  {props.ids.length === 1 ? "Already in" : "Already holding some of these"}
                </span>
                <ul class="pick-list" role="listbox" aria-label="Collections of the selection">
                  <For each={related()}>
                    {(collection) => (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={target() === collection.id}
                          // Nothing to add to one that has them all.
                          disabled={collection.count === props.ids.length}
                          onClick={() => setTarget(collection.id)}
                        >
                          <span class="pick-name">
                            {collection.title || `#${collection.id}`}
                          </span>
                          <span class="pick-note">
                            {collection.collection_type},{" "}
                            {collection.count === props.ids.length
                              ? props.ids.length === 1
                                ? "already in it"
                                : "has them all"
                              : `has ${collection.count} of ${props.ids.length}`}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <span class="stacked">Other collections</span>
              </Show>
              <input
                type="text"
                placeholder="Filter by title"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
              <ul class="pick-list tall" role="listbox" aria-label="Other collections">
                <For
                  each={(existing() ?? []).filter((item) => !relatedIds().has(item.id))}
                  fallback={<li class="hint">No other collections{filter().trim() ? " match" : ""}.</li>}
                >
                  {(item) => (
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={target() === item.id}
                        onClick={() => setTarget(item.id)}
                      >
                        <span class="pick-name">{item.title || `#${item.id}`}</span>
                        <span class="pick-note">
                          {item.collection_type}, {plural(item.member_count ?? 0, "item")}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </>
          }
        >
          <label class="stacked">
            Title
            <input
              type="text"
              placeholder="Leave empty to name it after its type"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
          <label class="stacked">
            Type
            <select
              onChange={(e) => {
                setType(e.currentTarget.value);
                // A sequence is ordered by nature; the box can still be unticked.
                setOrdered(e.currentTarget.value === "sequence");
              }}
            >
              <For each={COLLECTION_TYPES}>
                {(option) => (
                  <option value={option} selected={option === type()}>
                    {option}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={ordered()}
              onChange={(e) => setOrdered(e.currentTarget.checked)}
            />
            Ordered: members keep the order they are put in
          </label>
          <Show when={props.parent}>
            {(parent) => (
              <label class="check">
                <input
                  type="checkbox"
                  checked={nested()}
                  onChange={(e) => setNested(e.currentTarget.checked)}
                />
                Add it inside “{parent().title || `Collection #${parent().id}`}”
              </label>
            )}
          </Show>
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
