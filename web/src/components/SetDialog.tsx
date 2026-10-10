import { createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { errorMessage, plural, setName } from "../format";
import { addedTo, changed } from "../search";
import { tabs } from "../tabs";
import { showToast } from "../toast";
import Modal from "./Modal";

/**
 * Puts the given files into a new or an existing set. A file is in one
 * set: those in another leave it.
 */
export default function SetDialog(props: { ids: number[]; onClose: () => void }) {
  const [mode, setMode] = createSignal<"new" | "existing">("new");
  const [title, setTitle] = createSignal("");
  const [setId, setSetId] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [target, setTarget] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // The sets some of the files are in already: the likeliest ones to want
  // the rest of them, and the ones the others would leave.
  const [related] = createResource(async () => (await api.getMetadata(props.ids)).sets);
  const relatedIds = () => new Set((related() ?? []).map((set) => set.id));
  /** How many of the files are in a set other than the one they are going to. */
  const leaving = () =>
    (related() ?? [])
      .filter((set) => mode() === "new" || set.id !== target())
      .reduce((sum, set) => sum + set.count, 0);

  const [existing] = createResource(
    () => (mode() === "existing" ? filter() : null),
    (text) => api.listSets(text.trim()),
  );

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    try {
      if (mode() === "new") {
        await api.createSet(props.ids, title(), setId());
      } else if (target() !== null) {
        await api.changeSetFiles(target()!, { add: props.ids });
        // A set that gained something shows it in its own tab.
        const tab = tabs.find((tab) => tab.set?.id === target());
        if (tab) addedTo(tab.id);
      } else {
        return setError("Pick a set.");
      }
      showToast(`Put ${plural(props.ids.length, "file")} in ${mode() === "new" ? "a new set" : "the set"}`);
      changed();
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={`Put ${plural(props.ids.length, "file")} in a set`} onClose={props.onClose}>
      <form onSubmit={submit}>
        <div class="segmented">
          <label>
            <input type="radio" name="mode" checked={mode() === "new"} onChange={() => setMode("new")} />
            New set
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode() === "existing"}
              onChange={() => setMode("existing")}
            />
            Existing set
          </label>
        </div>

        <Show
          when={mode() === "new"}
          fallback={
            <>
              <Show when={(related() ?? []).length > 0}>
                <span class="stacked">
                  {props.ids.length === 1 ? "In now" : "Holding some of these now"}
                </span>
                <ul class="pick-list" role="listbox" aria-label="Sets of the selection">
                  <For each={related()}>
                    {(set) => (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={target() === set.id}
                          // Nothing to add to one that has them all.
                          disabled={set.count === props.ids.length}
                          onClick={() => setTarget(set.id)}
                        >
                          <span class="pick-name">{setName(set)}</span>
                          <span class="pick-note">
                            {set.count === props.ids.length
                              ? props.ids.length === 1
                                ? "already in it"
                                : "has them all"
                              : `has ${set.count} of ${props.ids.length}`}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <span class="stacked">Other sets</span>
              </Show>
              <input
                type="text"
                placeholder="Filter by title or set ID"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
              <ul class="pick-list tall" role="listbox" aria-label="Other sets">
                <For
                  each={(existing() ?? []).filter((set) => !relatedIds().has(set.id))}
                  fallback={<li class="hint">No other sets{filter().trim() ? " match" : ""}.</li>}
                >
                  {(set) => (
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={target() === set.id}
                        onClick={() => setTarget(set.id)}
                      >
                        <span class="pick-name">{setName(set)}</span>
                        <span class="pick-note">{plural(set.files, "file")}</span>
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
              placeholder="None"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
          <label class="stacked">
            Set ID
            <input
              type="text"
              placeholder="Leave empty to have one made up"
              autocomplete="off"
              spellcheck={false}
              value={setId()}
              onInput={(e) => setSetId(e.currentTarget.value)}
            />
          </label>
        </Show>

        <Show when={leaving() > 0}>
          <p class="hint">
            {plural(leaving(), "file")} of these {leaving() === 1 ? "is" : "are"} in another set, and
            will leave it: a file is in one set.
          </p>
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
