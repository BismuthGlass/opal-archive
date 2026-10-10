import { createSignal, For, Show } from "solid-js";
import type { Changes, Metadata } from "../api";
import { ListLabel } from "./fields";
import type { FieldProps, ListMode } from "./fields";
import { enter } from "../tabs";
import Icon from "./Icon";

/** A value of a list, how many of the selection have it, and what it is shown as if not itself. */
type Entry = { value: string; count: number; label?: string | null };

/** Only web addresses are made into links; anything else is shown as text. */
const isWebAddress = (url: string) => /^https?:\/\//i.test(url);

/**
 * The lists a file has that are not tags: plain values with no
 * suggestions, namespaces or aliases. The sets it is in are among them. Each is shown one value to a line,
 * as text rather than as the chips tags are, so that they are not taken
 * for tags; source URLs are links.
 */
export const PLAIN_LISTS = [
  {
    field: "identifier",
    label: "Identifier",
    placeholder: "Add…",
    links: false,
    values: (data: Metadata) => data.identifier,
    add: (value: string): Changes => ({ add_identifier: [value] }),
    remove: (value: string): Changes => ({ remove_identifier: [value] }),
  },
  {
    field: "reference",
    label: "Reference",
    placeholder: "Add…",
    links: false,
    values: (data: Metadata) => data.reference,
    add: (value: string): Changes => ({ add_reference: [value] }),
    remove: (value: string): Changes => ({ remove_reference: [value] }),
  },
  {
    // The sets a file is in: IDs it gives, as it gives its collections.
    field: "set",
    label: "Sets",
    placeholder: "Add by set ID…",
    links: false,
    // Called by its title where it has one, as a set is everywhere: the
    // ID is still what is added and taken off.
    values: (data: Metadata): Entry[] =>
      data.set.map((set) => ({ value: set.set_id, count: set.count, label: set.title })),
    add: (value: string): Changes => ({ add_set: [value] }),
    remove: (value: string): Changes => ({ remove_set: [value] }),
    // A set is opened by its ID: the tab shows its files.
    open: (value: string) => void enter({ set_id: value }),
  },
  {
    field: "collection",
    label: "Collection",
    placeholder: "Add…",
    links: false,
    // A collection is opened as a set is: the tab shows what is part of it.
    open: (value: string) => void enter({ collection: value }),
    values: (data: Metadata) => data.collection,
    add: (value: string): Changes => ({ add_collection: [value] }),
    remove: (value: string): Changes => ({ remove_collection: [value] }),
  },
  {
    field: "source_url",
    label: "Source URL",
    placeholder: "Add a link…",
    links: true,
    values: (data: Metadata) => data.source_url,
    add: (value: string): Changes => ({ add_source_url: [value] }),
    remove: (value: string): Changes => ({ remove_source_url: [value] }),
  },
];

type ListProps = FieldProps & ListMode & { list: (typeof PLAIN_LISTS)[number] };

/** A plain list's values, one to a line, with what can be done to each. */
function Values(props: ListProps) {
  /** How many of the selection have a value, and the buttons acting on it. */
  const controls = (entry: Entry) => (
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
    <ul class="links">
      <For each={props.list.values(props.data) as Entry[]}>
        {(entry) => (
          <li>
            <Show
              when={props.list.links && isWebAddress(entry.value)}
              fallback={
                <Show
                  // Not from the modal where the list is edited: that would
                  // stay in front of what was opened.
                  when={!props.editing && "open" in props.list && props.list.open}
                  fallback={
                    <span class="link-text" data-tip={entry.label || entry.value}>
                      {entry.label || entry.value}
                    </span>
                  }
                >
                  {(open) => (
                    <button
                      class="link link-text"
                      data-tip={entry.label || entry.value}
                      onClick={() => open()(entry.value)}
                    >
                      {entry.label || entry.value}
                    </button>
                  )}
                </Show>
              }
            >
              <a
                class="link-text"
                href={entry.value}
                target="_blank"
                rel="noopener noreferrer"
                data-tip={entry.value}
              >
                {entry.value}
              </a>
            </Show>
            {controls(entry)}
          </li>
        )}
      </For>
    </ul>
  );
}

/**
 * A plain list as a row of the details list: its values beside the label,
 * as any other detail is, one to a line.
 */
export function PlainListRow(props: ListProps) {
  return (
    <>
      <dt>
        <ListLabel label={props.list.label} onEdit={props.onEdit} />
      </dt>
      <dd>
        <Values {...props} />
      </dd>
    </>
  );
}

/** The editor of a plain list, for a modal: the box to add a value, over the values. */
export default function PlainList(props: ListProps) {
  const [text, setText] = createSignal("");

  const add = () => {
    const value = text().trim();
    if (!value) return;
    setText("");
    props.apply(props.list.add(value));
  };

  return (
    <div class="field">
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
      <Show when={props.list.values(props.data).length > 0}>
        <Values {...props} editing />
      </Show>
    </div>
  );
}
