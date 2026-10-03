import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { TAG_FIELDS } from "../api";
import type { TagEntry } from "../api";
import { fieldLabel, plural } from "../format";
import { changed } from "../search";
import Icon from "./Icon";
import Modal from "./Modal";

/** More matching tags than this are not listed; the filter narrows them. */
const MAX_ROWS = 300;

/** A text box that saves on Enter and gives up on Escape or losing focus. */
function InlineInput(props: {
  label: string;
  initial?: string;
  placeholder?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      type="text"
      aria-label={props.label}
      placeholder={props.placeholder}
      value={props.initial ?? ""}
      autocomplete="off"
      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
      onBlur={props.onCancel}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          props.onSave(event.currentTarget.value);
        } else if (event.key === "Escape") {
          // Only leaves the box; without this Escape would close the modal.
          event.preventDefault();
          event.stopPropagation();
          props.onCancel();
        }
      }}
    />
  );
}

/**
 * Every tag of one type, to rename, merge and give aliases. An alias is
 * listed under the tag it defers to.
 */
export default function TagEditor(props: { onClose: () => void }) {
  const [field, setField] = createSignal<string>(TAG_FIELDS[0]);
  const [filter, setFilter] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  /** The tag whose name is being edited, or that is being given an alias. */
  const [editing, setEditing] = createSignal<{ tag: string; mode: "rename" | "alias" } | null>(
    null,
  );
  const [data, { refetch }] = createResource(field, api.listTags);

  const tags = () => data.latest?.tags ?? [];
  const pending = () => data.latest?.pending ?? 0;

  const matching = createMemo(() => {
    const text = filter().trim().toLowerCase();
    const has = (value: string) => value.toLowerCase().includes(text);
    return tags()
      .map((tag) => ({ tag, viaAlias: text !== "" && tag.aliases.some((a) => has(a.value)) }))
      .filter(({ tag, viaAlias }) => viaAlias || has(tag.value));
  });

  const isOpen = (tag: TagEntry) => expanded().has(tag.value.toLowerCase());
  const toggle = (tag: TagEntry, open = !isOpen(tag)) => {
    const next = new Set(expanded());
    if (open) next.add(tag.value.toLowerCase());
    else next.delete(tag.value.toLowerCase());
    setExpanded(next);
  };
  const isEditing = (tag: TagEntry, mode: "rename" | "alias") =>
    editing()?.tag === tag.value && editing()?.mode === mode;

  /** Runs a change, then reloads the list and everything showing tags. */
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await refetch();
    changed();
  };

  const rename = (tag: TagEntry, typed: string) => {
    const to = typed.trim();
    setEditing(null);
    if (!to || to === tag.value) return;
    // Taking the name of another tag merges the two.
    const other = tags().find((t) => t !== tag && t.value.toLowerCase() === to.toLowerCase());
    if (
      other &&
      !confirm(
        `Merge "${tag.value}" into "${other.value}"? Everything tagged "${tag.value}" becomes "${other.value}". This cannot be undone.`,
      )
    ) {
      return;
    }
    run(() => api.renameTag(field(), tag.value, to));
  };

  const addAlias = (tag: TagEntry, typed: string) => {
    const alias = typed.trim();
    setEditing(null);
    if (!alias) return;
    toggle(tag, true);
    run(() => api.setAlias(field(), alias, tag.value));
  };

  return (
    <Modal title="Tags" wide onClose={props.onClose}>
      <div class="tag-editor-bar">
        <select
          aria-label="Tag type"
          onChange={(event) => {
            setField(event.currentTarget.value);
            setEditing(null);
          }}
        >
          <For each={TAG_FIELDS}>
            {(option) => (
              <option value={option} selected={option === field()}>
                {fieldLabel(option)}
              </option>
            )}
          </For>
        </select>
        <input
          type="text"
          aria-label="Filter tags"
          placeholder="Filter"
          value={filter()}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
        <button
          class="primary"
          disabled={pending() === 0}
          title={
            pending() === 0
              ? "No item carries an alias: there is nothing to update"
              : "Replace aliases still on items with the tags they stand for, in every tag type"
          }
          onClick={() => run(api.applyAliases)}
        >
          Update aliases
          <Show when={pending() > 0}> ({pending()})</Show>
        </button>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <ul class="tag-list">
        <For
          each={matching().slice(0, MAX_ROWS)}
          fallback={
            <li class="hint">
              {data.loading
                ? "Loading…"
                : filter().trim()
                  ? "No tags match the filter."
                  : "No tags of this type."}
            </li>
          }
        >
          {({ tag, viaAlias }) => (
            <li>
              <div class="tag-line">
                <Show when={tag.aliases.length > 0} fallback={<span class="tag-toggle" />}>
                  <button
                    class="plain tag-toggle"
                    classList={{ open: isOpen(tag) || viaAlias }}
                    aria-expanded={isOpen(tag) || viaAlias}
                    aria-label={`Aliases of ${tag.value}`}
                    title="Show or hide aliases"
                    onClick={() => toggle(tag)}
                  >
                    <Icon name="chevron-right" />
                  </button>
                </Show>
                <Show
                  when={isEditing(tag, "rename")}
                  fallback={
                    <span class="tag-name">
                      {tag.value}
                      <span class="tag-uses">{tag.count}</span>
                      <Show when={tag.aliases.length > 0}>
                        <span class="tag-note">
                          {tag.aliases.length} {tag.aliases.length === 1 ? "alias" : "aliases"}
                        </span>
                      </Show>
                    </span>
                  }
                >
                  <InlineInput
                    label={`New name for ${tag.value}`}
                    initial={tag.value}
                    onSave={(text) => rename(tag, text)}
                    onCancel={() => setEditing(null)}
                  />
                </Show>
                <span class="tag-actions">
                  <button
                    title="Rename this tag; giving it the name of another tag merges them"
                    onClick={() => setEditing({ tag: tag.value, mode: "rename" })}
                  >
                    Rename
                  </button>
                  <button
                    title="Name another tag that should stand for this one"
                    onClick={() => setEditing({ tag: tag.value, mode: "alias" })}
                  >
                    Add alias
                  </button>
                </span>
              </div>
              <Show when={isEditing(tag, "alias")}>
                <div class="tag-alias">
                  <Icon name="subdirectory-arrow-right" />
                  <InlineInput
                    label={`New alias of ${tag.value}`}
                    placeholder={`Alias of ${tag.value}`}
                    onSave={(text) => addAlias(tag, text)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              </Show>
              <Show when={isOpen(tag) || viaAlias}>
                <For each={tag.aliases}>
                  {(alias) => (
                    <div class="tag-alias">
                      <Icon name="subdirectory-arrow-right" />
                      <span class="tag-name">
                        {alias.value}
                        <Show when={alias.count > 0}>
                          <span class="tag-note">
                            still on {plural(alias.count, "item")}, not updated yet
                          </span>
                        </Show>
                      </span>
                      <span class="tag-actions">
                        <button
                          title="Stop this being an alias"
                          onClick={() => run(() => api.setAlias(field(), alias.value, ""))}
                        >
                          Remove alias
                        </button>
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={matching().length > MAX_ROWS}>
        <p class="hint">
          Showing {MAX_ROWS} of {matching().length} tags. Filter to see the rest.
        </p>
      </Show>
    </Modal>
  );
}
