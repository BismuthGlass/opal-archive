import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import * as api from "../api";
import type { TagEntry } from "../api";
import { errorMessage, fieldLabel, plural } from "../format";
import { changed } from "../search";
import { prefixOf, readTag, tagText, tagTextStyle, typesStarting } from "../tagTypes";
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
 * delete it. The box filters the plain tags, or those of the type written
 * in front (`@cr:`), as it would a namespace; a name typed there that does
 * not exist yet can be created. While only `@…` is typed the list is of the
 * types.
 */
export default function TagManager(props: {
  /** A tag to open on: the list is narrowed to it, and it is selected. */
  initial?: { field: string; value: string };
  onClose: () => void;
}) {
  const [filter, setFilter] = createSignal(
    props.initial ? tagText(props.initial.field, props.initial.value) : "",
  );
  const read = createMemo(() => readTag(filter()));
  /** The type on show: the one last written, while another is being typed. */
  const field = createMemo<string>((shown) => read().field ?? shown, "tags");
  const [error, setError] = createSignal<string | null>(null);
  /** The tag whose details are on show, by its lowercased name. */
  const [chosen, setChosen] = createSignal<string | null>(
    props.initial?.value.toLowerCase() ?? null,
  );
  const [renaming, setRenaming] = createSignal(false);
  /** The description as typed, until it is saved. */
  const [draft, setDraft] = createSignal("");
  const [data, { refetch }] = createResource(field, api.listTags);

  const tags = () => data.latest?.tags ?? [];
  const pending = () => data.latest?.pending ?? 0;
  // `@us:*` is every usage tag, as it would be in a search.
  const typed = () => read().value.replace(/\*+$/, "");
  /** The types on offer, while one is being named. */
  const types = () => (read().naming === null ? [] : typesStarting(read().naming!));
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
    if (!name || read().field === null) return false;
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

  // The details belong to a tag of the type on show.
  createEffect(on(field, () => select(null), { defer: true }));

  let box!: HTMLInputElement;
  /** Writes a type into the box, ready for a name. */
  const chooseType = (type: string) => {
    setFilter(type === "tags" ? "" : `@${prefixOf(type)}:`);
    box.focus();
  };

  /** Runs a change, then reloads the list and everything showing tags. */
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
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
    <Modal title="Tag Manager" wide tall onClose={props.onClose}>
      <div class="tag-manager-bar">
        <input
          type="text"
          autofocus
          ref={box}
          aria-label="Filter or create tags"
          placeholder="Filter tags or name a new one. @cr: for creators, @ for all the types"
          autocomplete="off"
          spellcheck={false}
          value={filter()}
          onInput={(event) => setFilter(event.currentTarget.value)}
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
      <div class="tag-manager">
        <ul class="tag-list" role="listbox" aria-label="Tags">
          <For each={types()}>
            {(type) => (
              <li>
                <button class="plain tag-row" onClick={() => chooseType(type)}>
                  <span class="tag-name" style={tagTextStyle(type)}>
                    {fieldLabel(type)}
                  </span>
                  <span class="tag-note">
                    {type === "tags" ? "no @ needed" : `@${prefixOf(type)}:`}
                  </span>
                </button>
              </li>
            )}
          </For>
          <Show when={read().field === null && read().naming === null}>
            <li class="hint">{read().lead.slice(0, -1)} is not a tag type. Type @ to see them.</li>
          </Show>
          <Show when={read().field !== null}>
          <Show when={creatable()}>
            <li>
              <button class="plain tag-row" onClick={create}>
                <Icon name="add" />
                Create
                <span class="tag-name" style={tagTextStyle(field())}>
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
                    : `No ${fieldLabel(field()).toLowerCase()} yet. Type a name to create one.`}
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
                  <span class="tag-name" style={tagTextStyle(field())}>
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
                      <span class="tag-name" style={tagTextStyle(field())}>
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
