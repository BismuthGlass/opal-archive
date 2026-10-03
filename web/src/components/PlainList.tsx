import { createSignal, For, Show } from "solid-js";
import type { Changes, Metadata } from "../api";
import { ListLabel } from "./fields";
import type { FieldProps, ListMode } from "./fields";
import Icon from "./Icon";

/** Only web addresses are made into links; anything else is shown as text. */
const isWebAddress = (url: string) => /^https?:\/\//i.test(url);

/**
 * The lists a file has that are not tags: plain values with no
 * suggestions, namespaces or aliases. Source URLs are shown as links, one
 * to a line; identifiers as chips.
 */
export const PLAIN_LISTS = [
  {
    field: "identifier",
    label: "Identifiers",
    placeholder: "Add…",
    links: false,
    values: (data: Metadata) => data.identifiers,
    add: (value: string): Changes => ({ add_identifiers: [value] }),
    remove: (value: string): Changes => ({ remove_identifiers: [value] }),
  },
  {
    field: "source_url",
    label: "Source URLs",
    placeholder: "Add a link…",
    links: true,
    values: (data: Metadata) => data.source_urls,
    add: (value: string): Changes => ({ add_urls: [value] }),
    remove: (value: string): Changes => ({ remove_urls: [value] }),
  },
];

export default function PlainList(props: FieldProps & ListMode & { list: (typeof PLAIN_LISTS)[number] }) {
  const [text, setText] = createSignal("");
  const values = () => props.list.values(props.data);

  const add = () => {
    const value = text().trim();
    if (!value) return;
    setText("");
    props.apply(props.list.add(value));
  };

  /** How many of the selection have a value, and the buttons acting on it. */
  const controls = (entry: { value: string; count: number }) => (
    <>
      <Show when={entry.count < props.data.count}>
        <span class="chip-count" title={`On ${entry.count} of ${props.data.count} selected`}>
          ({entry.count})
        </span>
      </Show>
      <Show when={props.editing}>
        <span class="chip-actions">
          <Show when={entry.count < props.data.count}>
            <button
              class="chip-add"
              aria-label={`Add ${entry.value} to all selected`}
              title="Add to all selected"
              onClick={() => props.apply(props.list.add(entry.value))}
            >
              <Icon name="add" />
            </button>
          </Show>
          <button
            class="chip-remove"
            aria-label={`Remove ${entry.value}`}
            title="Remove"
            onClick={() => props.apply(props.list.remove(entry.value))}
          >
            <Icon name="close" />
          </button>
        </span>
      </Show>
    </>
  );

  return (
    <div class="field">
      <Show when={props.editing} fallback={<ListLabel label={props.list.label} {...props} />}>
        <input
          type="text"
          autofocus
          aria-label={`Add to ${props.list.label}`}
          placeholder={props.list.placeholder}
          autocomplete="off"
          spellcheck={false}
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
      </Show>
      <Show when={values().length > 0}>
        <Show
          when={props.list.links}
          fallback={
            <div class="chips plain-chips">
              <For each={values()}>
                {(entry) => (
                  <span class="chip" classList={{ partial: entry.count < props.data.count }}>
                    <span class="chip-label">{entry.value}</span>
                    {controls(entry)}
                  </span>
                )}
              </For>
            </div>
          }
        >
          <ul class="links">
            <For each={values()}>
              {(entry) => (
                <li>
                  <Show
                    when={isWebAddress(entry.value)}
                    fallback={<span class="link-text">{entry.value}</span>}
                  >
                    <a
                      class="link-text"
                      href={entry.value}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={entry.value}
                    >
                      {entry.value}
                    </a>
                  </Show>
                  {controls(entry)}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}
