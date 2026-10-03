import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { COLLECTION_TYPES } from "../api";
import { plural, quoteValue } from "../format";
import { changed } from "../search";

/** Puts the given entities into a new or an existing collection. */
export default function CollectionDialog(props: { ids: number[]; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  const [mode, setMode] = createSignal<"new" | "existing">("new");
  const [title, setTitle] = createSignal("");
  const [type, setType] = createSignal(COLLECTION_TYPES[0]);
  const [filter, setFilter] = createSignal("");
  const [target, setTarget] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => dialog.showModal());

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
        await api.createCollection(type(), title(), props.ids);
      } else if (target() !== null) {
        await api.changeMembers(target()!, { add: props.ids });
      } else {
        return setError("Pick a collection.");
      }
      changed();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <dialog ref={dialog} class="dialog" onClose={props.onClose}>
      <form onSubmit={submit}>
        <h2>Add {plural(props.ids.length, "item")} to a collection</h2>
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
              <input
                type="text"
                placeholder="Filter by title"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
              <select
                size={8}
                aria-label="Collection"
                onChange={(e) => setTarget(Number(e.currentTarget.value))}
              >
                <For each={existing()}>
                  {(item) => (
                    <option value={item.id}>
                      {item.title || `#${item.id}`} ({item.collection_type},{" "}
                      {plural(item.member_count ?? 0, "item")})
                    </option>
                  )}
                </For>
              </select>
            </>
          }
        >
          <label class="stacked">
            Title
            <input type="text" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
          </label>
          <label class="stacked">
            Type
            <select onChange={(e) => setType(e.currentTarget.value)}>
              <For each={COLLECTION_TYPES}>
                {(option) => (
                  <option value={option} selected={option === type()}>
                    {option}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>

        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <footer>
          <button type="button" onClick={() => dialog.close()}>
            Cancel
          </button>
          <button type="submit" class="primary">
            Add
          </button>
        </footer>
      </form>
    </dialog>
  );
}
