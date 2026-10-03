import { createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { plural } from "../format";
import { changed } from "../search";
import { showToast } from "../toast";
import Icon from "./Icon";
import Modal from "./Modal";

/**
 * Tags typed in quick succession: Enter puts what is typed on the list,
 * Shift+Enter adds the whole list to the given entities. It adds to one
 * tag field, `tags` unless another is named.
 */
export default function QuickTagModal(props: {
  ids: number[];
  /** What the tags go on, for the title: "3 items", "this file". */
  target: string;
  /** The tag field the tags go into. */
  field?: string;
  onClose: () => void;
}) {
  const field = () => props.field ?? "tags";
  const [text, setText] = createSignal("");
  const [list, setList] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [suggestions] = createResource(
    () => ({ field: field(), typed: text().trim() }),
    ({ field, typed }) => api.suggestTags(field, typed).catch(() => []),
  );

  /** Moves what is typed onto the list. */
  const take = () => {
    const tag = text().trim();
    setText("");
    if (!tag) return list();
    const has = list().some((other) => other.toLowerCase() === tag.toLowerCase());
    if (!has) setList([...list(), tag]);
    return list();
  };

  const apply = async () => {
    const tags = take();
    if (tags.length === 0) return props.onClose();
    try {
      await api.edit(props.ids, { add: { [field()]: tags } });
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err));
    }
    showToast(`Added ${plural(tags.length, "tag")} to ${props.target}`);
    changed();
    props.onClose();
  };

  return (
    <Modal title={`Add tags to ${props.target}`} onClose={props.onClose}>
      <div class="quick-tag">
        <input
          type="text"
          autofocus
          aria-label="Tag"
          placeholder="Type a tag"
          autocomplete="off"
          list="quick-tag-suggestions"
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) apply();
              else take();
            } else if (event.key === "Backspace" && text() === "") {
              setList(list().slice(0, -1));
            }
          }}
        />
        <datalist id="quick-tag-suggestions">
          <For each={suggestions.latest ?? []}>
            {(option) => (
              <option value={option.value}>
                {option.alias ? `alias: ${option.alias}` : option.namespace ? "namespace" : ""}
              </option>
            )}
          </For>
        </datalist>
      </div>
      <div class="chips quick-tag-list">
        <For each={list()} fallback={<span class="none">No tags yet.</span>}>
          {(tag) => (
            <span class="chip">
              <span class="chip-label">{tag}</span>
              <span class="chip-actions">
                <button
                  class="chip-remove"
                  aria-label={`Remove ${tag}`}
                  title="Remove"
                  onClick={() => setList(list().filter((other) => other !== tag))}
                >
                  <Icon name="close" />
                </button>
              </span>
            </span>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <footer class="quick-tag-foot">
        <span class="hint">
          <kbd>Enter</kbd> adds to the list, <kbd>Shift</kbd> + <kbd>Enter</kbd> applies
        </span>
        <button class="primary" onClick={apply}>
          Add to {props.target}
        </button>
      </footer>
    </Modal>
  );
}
