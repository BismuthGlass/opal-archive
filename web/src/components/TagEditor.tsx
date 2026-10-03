import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import type { TagEntry } from "../api";
import { fieldLabel, plural } from "../format";
import { changed } from "../search";
import { orderedTypes, pillStyle, prefixOf, splitPrefix } from "../tagTypes";
import Icon from "./Icon";
import Modal from "./Modal";

/** More matching tags than this are not listed; the filter narrows them. */
const MAX_ROWS = 300;

type Mode = "rename" | "alias" | "describe";

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
 * Every tag of one type: to create, describe, rename, merge, give aliases
 * and delete. The type is chosen from the row of pills or, in the box,
 * with its prefix (`@cr `). An alias is listed under the tag it defers to.
 */
export default function TagEditor(props: { onClose: () => void }) {
  const [field, setField] = createSignal<string>("tags");
  const [filter, setFilter] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  /** The tag being renamed, described or given an alias. */
  const [editing, setEditing] = createSignal<{ tag: string; mode: Mode } | null>(null);
  const [data, { refetch }] = createResource(field, api.listTags);

  const tags = () => data.latest?.tags ?? [];
  const pending = () => data.latest?.pending ?? 0;
  const typed = () => filter().trim();

  const matching = createMemo(() => {
    const text = typed().toLowerCase();
    const has = (value: string | null) => value !== null && value.toLowerCase().includes(text);
    return tags()
      .map((tag) => ({ tag, viaAlias: text !== "" && tag.aliases.some((a) => has(a.value)) }))
      .filter(({ tag, viaAlias }) => viaAlias || has(tag.value) || has(tag.description));
  });
  /** Whether what is typed names no tag or alias yet, and so could be one. */
  const creatable = () => {
    const name = typed().toLowerCase();
    if (!name || name.startsWith("@")) return false;
    return !tags().some(
      (tag) =>
        tag.value.toLowerCase() === name ||
        tag.aliases.some((alias) => alias.value.toLowerCase() === name),
    );
  };

  const isOpen = (tag: TagEntry) => expanded().has(tag.value.toLowerCase());
  const toggle = (tag: TagEntry, open = !isOpen(tag)) => {
    const next = new Set(expanded());
    if (open) next.add(tag.value.toLowerCase());
    else next.delete(tag.value.toLowerCase());
    setExpanded(next);
  };
  const isEditing = (tag: TagEntry, mode: Mode) =>
    editing()?.tag === tag.value && editing()?.mode === mode;

  const choose = (next: string) => {
    setField(next);
    setEditing(null);
  };

  const onInput = (box: HTMLInputElement) => {
    // "@cr " at the start switches to that type and leaves the box.
    const prefixed = splitPrefix(box.value);
    if (prefixed) {
      choose(prefixed.field);
      // Written to the box itself: if the filter was already this, setting
      // it again would not redraw the box.
      box.value = prefixed.rest;
    }
    setFilter(box.value);
  };

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

  const create = () => {
    if (creatable()) run(() => api.createTag(field(), typed()));
  };

  const rename = (tag: TagEntry, text: string) => {
    const to = text.trim();
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

  const describe = (tag: TagEntry, text: string) => {
    setEditing(null);
    if (text.trim() !== (tag.description ?? "")) {
      run(() => api.describeTag(field(), tag.value, text.trim()));
    }
  };

  const addAlias = (tag: TagEntry, text: string) => {
    const alias = text.trim();
    setEditing(null);
    if (!alias) return;
    toggle(tag, true);
    run(() => api.setAlias(field(), alias, tag.value));
  };

  return (
    <Modal title="Tags" wide onClose={props.onClose}>
      <div class="type-picker" role="radiogroup" aria-label="Tag type">
        <For each={orderedTypes()}>
          {(type) => (
            <button
              class="chip tinted"
              role="radio"
              aria-checked={type === field()}
              style={pillStyle(type)}
              // Not on mouse down, so the box keeps the cursor.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(type)}
            >
              {fieldLabel(type)}
              <span class="type-prefix">@{prefixOf(type)}</span>
            </button>
          )}
        </For>
      </div>
      <div class="tag-editor-bar">
        <input
          type="text"
          autofocus
          aria-label="Filter or create tags"
          placeholder={`Filter ${fieldLabel(field()).toLowerCase()}, name a new one, or @ for another type`}
          autocomplete="off"
          value={filter()}
          onInput={(event) => onInput(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter") create();
          }}
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
        <Show when={creatable()}>
          <li>
            <button class="plain tag-create" onClick={create}>
              <Icon name="add" />
              Create
              <span class="chip tinted type-sample" style={pillStyle(field())}>
                {typed()}
              </span>
              <span class="tag-note">Enter</span>
            </button>
          </li>
        </Show>
        <For
          each={matching().slice(0, MAX_ROWS)}
          fallback={
            <Show when={!creatable()}>
              <li class="hint">
                {data.loading ? "Loading…" : "No tags of this type yet. Type a name to create one."}
              </li>
            </Show>
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
                      <span class="chip tinted type-sample" style={pillStyle(field())}>
                        {tag.value}
                      </span>
                      <span class="tag-uses" title={`On ${plural(tag.count, "item")}`}>
                        {tag.count}
                      </span>
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
                <Show
                  when={isEditing(tag, "describe")}
                  fallback={
                    <button
                      class="plain tag-description"
                      classList={{ unset: !tag.description }}
                      title="Click to edit the description"
                      onClick={() => setEditing({ tag: tag.value, mode: "describe" })}
                    >
                      {tag.description || "Add a description"}
                    </button>
                  }
                >
                  <InlineInput
                    label={`Description of ${tag.value}`}
                    initial={tag.description ?? ""}
                    placeholder="What this tag is for"
                    onSave={(text) => describe(tag, text)}
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
                  <Show when={tag.count === 0 && tag.aliases.length === 0}>
                    <button
                      class="danger"
                      title="Delete this tag, which nothing carries"
                      onClick={() => run(() => api.deleteTag(field(), tag.value))}
                    >
                      Delete
                    </button>
                  </Show>
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
