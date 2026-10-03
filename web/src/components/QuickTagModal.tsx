import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { fieldLabel, plural } from "../format";
import { changed } from "../search";
import { pillStyle, prefixOf, readTag, tagText, typesStarting } from "../tagTypes";
import { showToast } from "../toast";
import Icon from "./Icon";
import Modal from "./Modal";

/**
 * Tags typed in quick succession: Enter puts what is typed on the list,
 * Shift+Enter adds the whole list to the given entities. A tag is a plain
 * one unless its type is written in front: `@cr:name` is a creator.
 */
export default function QuickTagModal(props: {
  ids: number[];
  /** What the tags go on, for the title: "3 items", "this file". */
  target: string;
  onClose: () => void;
}) {
  const [text, setText] = createSignal("");
  const [list, setList] = createSignal<{ field: string; value: string }[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const read = createMemo(() => readTag(text()));
  const [found] = createResource(
    () => (read().field ? { field: read().field!, typed: read().value } : null),
    ({ field, typed }) => api.suggestTags(field, typed).catch(() => []),
  );
  /** What the box could become: types while one is named, then tags. */
  const options = () =>
    read().naming !== null
      ? typesStarting(read().naming!).map((field) => ({
          text: `@${prefixOf(field)}:`,
          note: fieldLabel(field),
        }))
      : (found.latest ?? []).map((option) => ({
          text: read().lead + option.value,
          note: option.alias ? `alias: ${option.alias}` : option.namespace ? "namespace" : "",
        }));

  /** Moves what is typed onto the list. False if it cannot be a tag. */
  const take = () => {
    const { field, value, naming } = read();
    if (!text().trim()) return true;
    if (naming !== null || !field) {
      setError(`${text().trim()} is not a tag: after the @ comes a type and a colon, as in @cr:name.`);
      return false;
    }
    if (!value) return false;
    setText("");
    setError(null);
    const same = (other: { field: string; value: string }) =>
      other.field === field && other.value.toLowerCase() === value.toLowerCase();
    if (!list().some(same)) setList([...list(), { field, value }]);
    return true;
  };

  const apply = async () => {
    if (!take()) return;
    const tags = list();
    if (tags.length === 0) return props.onClose();
    const add: Record<string, string[]> = {};
    for (const tag of tags) (add[tag.field] ??= []).push(tag.value);
    try {
      await api.edit(props.ids, { add });
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
          placeholder="Type a tag, or @cr:name for another type"
          autocomplete="off"
          spellcheck={false}
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
          <For each={options()}>{(option) => <option value={option.text}>{option.note}</option>}</For>
        </datalist>
      </div>
      <div class="chips quick-tag-list">
        <For each={list()} fallback={<span class="none">No tags yet.</span>}>
          {(tag) => (
            <span
              class="chip tinted"
              style={pillStyle(tag.field)}
              title={tagText(tag.field, tag.value)}
            >
              <span class="chip-label">{tag.value}</span>
              <span class="chip-actions">
                <button
                  class="chip-remove"
                  aria-label={`Remove ${tag.value}`}
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
