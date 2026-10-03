import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import * as api from "../api";
import type { TagEntry } from "../api";
import { fieldLabel, plural } from "../format";
import { changed } from "../search";
import { orderedTypes, pillStyle, prefixOf, splitPrefix } from "../tagTypes";
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

/** As the server stores a tag name: no space around its colons. */
const normalized = (name: string) =>
  name
    .split(":")
    .map((part) => part.trim())
    .join(":")
    .toLowerCase();

/**
 * Every tag of one type, as a list beside the details of the one selected:
 * its description, its aliases, and the buttons to rename, merge and
 * delete it. The type is chosen from the row of pills or, in the box, with
 * its prefix (`@cr `); a name typed there that does not exist yet can be
 * created.
 */
export default function TagEditor(props: { onClose: () => void }) {
  const [field, setField] = createSignal<string>("tags");
  const [filter, setFilter] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  /** The tag whose details are on show, by its lowercased name. */
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  /** The description as typed, until it is saved. */
  const [draft, setDraft] = createSignal("");
  const [data, { refetch }] = createResource(field, api.listTags);

  const tags = () => data.latest?.tags ?? [];
  const pending = () => data.latest?.pending ?? 0;
  const typed = () => filter().trim();
  const selected = createMemo(() => tags().find((tag) => tag.value.toLowerCase() === chosen()));
  const unsaved = () => selected() !== undefined && draft() !== (selected()!.description ?? "");

  // The box shows the selected tag's description, afresh for each tag and
  // whenever the saved text changes.
  createEffect(
    on(
      () => [selected()?.value, selected()?.description] as const,
      ([, description]) => setDraft(description ?? ""),
    ),
  );

  const matching = createMemo(() => {
    const text = typed().toLowerCase();
    const has = (value: string | null) => value !== null && value.toLowerCase().includes(text);
    return tags().filter(
      (tag) => has(tag.value) || has(tag.description) || tag.aliases.some((a) => has(a.value)),
    );
  });
  /** Whether what is typed names no tag or alias yet, and so could be one. */
  const creatable = () => {
    const name = normalized(typed());
    if (!name || name.startsWith("@")) return false;
    return !tags().some(
      (tag) =>
        tag.value.toLowerCase() === name ||
        tag.aliases.some((alias) => alias.value.toLowerCase() === name),
    );
  };

  const select = (tag: TagEntry | null) => {
    setChosen(tag?.value.toLowerCase() ?? null);
    setRenaming(false);
  };

  const choose = (next: string) => {
    setField(next);
    select(null);
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

  const create = async () => {
    if (!creatable()) return;
    const name = typed();
    await run(() => api.createTag(field(), name));
    setChosen(normalized(name));
  };

  const rename = async (tag: TagEntry, text: string) => {
    const to = text.trim();
    setRenaming(false);
    if (!to || to === tag.value) return;
    // Taking the name of another tag merges the two.
    const other = tags().find((t) => t !== tag && t.value.toLowerCase() === normalized(to));
    if (
      other &&
      !confirm(
        `Merge "${tag.value}" into "${other.value}"? Everything tagged "${tag.value}" becomes "${other.value}". This cannot be undone.`,
      )
    ) {
      return;
    }
    await run(() => api.renameTag(field(), tag.value, to));
    // The details follow the tag to its new name, or to the one it joined.
    setChosen(normalized(to));
  };

  const saveDescription = () => {
    const tag = selected();
    if (tag && unsaved()) run(() => api.describeTag(field(), tag.value, draft().trim()));
  };

  const addAlias = (tag: TagEntry, box: HTMLInputElement) => {
    const alias = box.value.trim();
    box.value = "";
    if (alias) run(() => api.setAlias(field(), alias, tag.value));
  };

  const remove = async (tag: TagEntry) => {
    await run(() => api.deleteTag(field(), tag.value));
    select(null);
  };

  return (
    <Modal title="Tags" wide tall onClose={props.onClose}>
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
      <div class="tag-editor">
        <ul class="tag-list" role="listbox" aria-label="Tags">
          <Show when={creatable()}>
            <li>
              <button class="plain tag-row" onClick={create}>
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
                  {data.loading
                    ? "Loading…"
                    : "No tags of this type yet. Type a name to create one."}
                </li>
              </Show>
            }
          >
            {(tag) => (
              <li>
                <button
                  class="plain tag-row"
                  role="option"
                  aria-selected={selected() === tag}
                  onClick={() => select(tag)}
                >
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
                  <Show when={tag.description}>
                    <span class="tag-preview">{tag.description}</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
          <Show when={matching().length > MAX_ROWS}>
            <li class="hint">
              Showing {MAX_ROWS} of {matching().length} tags. Filter to see the rest.
            </li>
          </Show>
        </ul>
        <section class="tag-details" aria-label="Details of the selected tag">
          <Show
            when={selected()}
            fallback={<p class="hint">Select a tag to see and edit its details.</p>}
          >
            {(tag) => (
              <>
                <header>
                  <Show
                    when={renaming()}
                    fallback={
                      <span class="chip tinted type-sample" style={pillStyle(field())}>
                        {tag().value}
                      </span>
                    }
                  >
                    <InlineInput
                      label={`New name for ${tag().value}`}
                      initial={tag().value}
                      onSave={(text) => rename(tag(), text)}
                      onCancel={() => setRenaming(false)}
                    />
                  </Show>
                  <span class="tag-note">on {plural(tag().count, "item")}</span>
                </header>
                <div class="tag-actions">
                  <button
                    title="Rename this tag; giving it the name of another tag merges them"
                    onClick={() => setRenaming(true)}
                  >
                    Rename or merge
                  </button>
                  <Show when={tag().count === 0 && tag().aliases.length === 0}>
                    <button
                      class="danger"
                      title="Delete this tag, which nothing carries"
                      onClick={() => remove(tag())}
                    >
                      Delete
                    </button>
                  </Show>
                </div>

                <label class="stacked">
                  Description
                  <textarea
                    rows={9}
                    aria-label={`Description of ${tag().value}`}
                    placeholder="Who or what this is, how the tag should be used…"
                    value={draft()}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    // Saved on leaving the box, and by Ctrl or Cmd with Enter.
                    onBlur={saveDescription}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        saveDescription();
                      }
                    }}
                  />
                </label>
                <p class="hint tag-saved">
                  {unsaved() ? "Not saved yet: click outside the box to save" : "\u00a0"}
                </p>

                <span class="stacked">Aliases</span>
                <ul class="tag-aliases">
                  <For each={tag().aliases}>
                    {(alias) => (
                      <li>
                        <Icon name="subdirectory-arrow-right" />
                        <span class="tag-alias-name">
                          {alias.value}
                          <Show when={alias.count > 0}>
                            <span class="tag-note">
                              still on {plural(alias.count, "item")}, not updated yet
                            </span>
                          </Show>
                        </span>
                        <button
                          class="plain"
                          aria-label={`Remove the alias ${alias.value}`}
                          title="Stop this being an alias"
                          onClick={() => run(() => api.setAlias(field(), alias.value, ""))}
                        >
                          <Icon name="close" />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <input
                  type="text"
                  aria-label={`New alias of ${tag().value}`}
                  placeholder="Add an alias: another name that stands for this tag"
                  autocomplete="off"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addAlias(tag(), event.currentTarget);
                  }}
                />
              </>
            )}
          </Show>
        </section>
      </div>
    </Modal>
  );
}
