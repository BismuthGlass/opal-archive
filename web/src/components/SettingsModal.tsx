import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ACTIONS, bind, isDefault, keyFor, keyLabel, keyOf } from "../hotkeys";
import type { Action } from "../hotkeys";
import { errorMessage, fieldLabel } from "../format";
import { savedQueries, setSavedQueries } from "../savedQueries";
import { collapsesSets, downloadNames, saveSetting } from "../settings";
import type { SavedQuery } from "../settings";
import type { Naming } from "../api";
import {
  isCustom,
  isCustomOrder,
  orderedTypes,
  pillStyle,
  prefixOf,
  setTagType,
  setTagTypeOrder,
  tagType,
} from "../tagTypes";
import Icon from "./Icon";
import type { TagType } from "../tagTypes";
import Modal from "./Modal";

/** The sections of the settings pane; add new ones here. */
const SECTIONS = [
  { id: "tagTypes", label: "Tag types" },
  { id: "savedQueries", label: "Saved queries" },
  { id: "hotkeys", label: "Hotkeys" },
  { id: "gallery", label: "Gallery" },
  { id: "downloads", label: "Downloads" },
] as const;

/** What a downloaded file can be called, as the setting offers them. */
const NAMINGS: { id: Naming; label: string; description: string }[] = [
  {
    id: "original",
    label: "Original name",
    description: "The name the file was uploaded under.",
  },
  {
    id: "title",
    label: "Title",
    description: "The file's title, or its original name where it has no title.",
  },
  { id: "hash", label: "Hash", description: "The file's SHA-256, as the library stores it." },
  {
    id: "random",
    label: "Random",
    description: "Letters and digits that say nothing of the file, new for every download.",
  },
];

function Downloads() {
  const [error, setError] = createSignal("");
  const choose = (naming: Naming) => {
    setError("");
    saveSetting("downloadNames", naming === "original" ? null : naming).catch((err) =>
      setError(errorMessage(err)),
    );
  };
  return (
    <>
      <h3>Downloads</h3>
      <p class="hint">
        What files are called when they are downloaded or exported. Two that come out alike in one
        zip are told apart with a number. An export's sidecars keep the original name whichever is
        chosen, and uploading it gives the files that name back.
      </p>
      <ul class="setting-rows" role="radiogroup" aria-label="File names">
        <For each={NAMINGS}>
          {(naming) => (
            <li>
              <label class="setting-choice">
                <input
                  type="radio"
                  name="download-names"
                  checked={downloadNames() === naming.id}
                  onChange={() => choose(naming.id)}
                />
                <div class="setting-text">
                  <span class="setting-label">{naming.label}</span>
                  <span class="hint">{naming.description}</span>
                </div>
              </label>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </>
  );
}

function Gallery() {
  const [error, setError] = createSignal("");
  const choose = (collapse: boolean) => {
    setError("");
    saveSetting("collapseSets", collapse || null).catch((err) => setError(errorMessage(err)));
  };
  return (
    <>
      <h3>Gallery</h3>
      <ul class="setting-rows">
        <li>
          <label class="setting-choice">
            <input
              type="checkbox"
              checked={collapsesSets()}
              onChange={(event) => choose(event.currentTarget.checked)}
            />
            <div class="setting-text">
              <span class="setting-label">Show a set as one tile</span>
              <span class="hint">
                A search lists a set once, as the first of its files that it finds, with how many
                the set holds. Double-clicking it opens the set. Selecting it selects that one file:
                to tag or rate the others, open the set. Without this, every file of a set is
                listed.
              </span>
            </div>
          </label>
        </li>
      </ul>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </>
  );
}

/**
 * Rows of a list dragged by their handles into another order. A row moves
 * in the list as the pointer passes the others, and the order is saved on
 * release. `keys` names the rows in their saved order.
 */
function createRowDrag<K>(
  list: () => HTMLUListElement,
  keys: () => K[],
  save: (next: K[]) => Promise<unknown>,
  report: (err: unknown) => void,
) {
  /** The order while a row is being dragged, and the row. */
  const [dragOrder, setDragOrder] = createSignal<K[] | null>(null);
  const [dragging, setDragging] = createSignal<K | null>(null);
  const order = () => dragOrder() ?? keys();

  const start = (key: K, down: PointerEvent) => {
    down.preventDefault();
    setDragging(() => key);
    setDragOrder(keys());
    const onMove = (event: PointerEvent) => {
      const others = [...list().querySelectorAll<HTMLElement>("li:not(.dragging)")];
      // Its place is after every other row whose middle the pointer passed.
      const index = others.filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top + box.height / 2 < event.clientY;
      }).length;
      const rest = order().filter((other) => other !== key);
      rest.splice(index, 0, key);
      if (rest.some((other, i) => other !== order()[i])) setDragOrder(rest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const next = order();
      setDragging(null);
      const moved = next.some((other, i) => other !== keys()[i]);
      if (!moved) return setDragOrder(null);
      save(next)
        .catch(report)
        .finally(() => setDragOrder(null));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return { order, dragging, start };
}

/** Each tag type's pill colours, and whether it joins the one list. */
function TagTypes() {
  let list!: HTMLUListElement;
  const [error, setError] = createSignal<string | null>(null);

  const report = (err: unknown) => setError(errorMessage(err));

  const drag = createRowDrag(
    () => list,
    orderedTypes,
    (next) => setTagTypeOrder(next).then(() => setError(null)),
    report,
  );

  const change = (field: string, changes: Partial<TagType> | null) =>
    setTagType(field, changes).then(
      () => setError(null),
      report,
    );

  return (
    <>
      <h3>Tag types</h3>
      <p class="hint">
        A tag is of a type, written in front of it wherever tags are typed: <code>@cr:name</code>{" "}
        is a creator, and a tag with no @ is a plain one. Tags are shown as pills in the colours of
        their type. The types ticked as aggregated share one list in the side panel; the others
        each get a section of their own. Drag a row by its
        handle to change the order the types are listed in.
        <Show when={isCustomOrder()}>
          {" "}
          <button
            class="link"
            onClick={() => setTagTypeOrder(null).then(() => setError(null), report)}
          >
            Reset the order
          </button>
        </Show>
      </p>
      <ul class="setting-rows" ref={list}>
        <For each={drag.order()}>
          {(field) => (
            <li classList={{ dragging: drag.dragging() === field }}>
              <span
                class="drag-handle"
                title="Drag to reorder"
                onPointerDown={(event) => drag.start(field, event)}
              >
                <Icon name="drag-indicator" />
              </span>
              <div class="setting-text">
                <span>
                  <span class="chip tinted type-sample" style={pillStyle(field)}>
                    {fieldLabel(field)}
                  </span>{" "}
                  <code class="hint">@{prefixOf(field)}:</code>
                </span>
              </div>
              <Show when={isCustom(field)}>
                <button class="link" title="Back to the defaults" onClick={() => change(field, null)}>
                  Reset
                </button>
              </Show>
              <label class="swatch" title="Background colour">
                <span class="hint">Background</span>
                <input
                  type="color"
                  aria-label={`Background colour of ${fieldLabel(field)}`}
                  value={tagType(field).bg}
                  onChange={(event) => change(field, { bg: event.currentTarget.value })}
                />
              </label>
              <label class="swatch" title="Text colour">
                <span class="hint">Text</span>
                <input
                  type="color"
                  aria-label={`Text colour of ${fieldLabel(field)}`}
                  value={tagType(field).fg}
                  onChange={(event) => change(field, { fg: event.currentTarget.value })}
                />
              </label>
              <label class="check" title="Show with the other aggregated types in one list">
                <input
                  type="checkbox"
                  aria-label={`Aggregate ${fieldLabel(field)}`}
                  checked={tagType(field).aggregate}
                  onChange={(event) => change(field, { aggregate: event.currentTarget.checked })}
                />
                Aggregate
              </label>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </>
  );
}

/** The queries kept to be used again: their names, text and order. */
function SavedQueries() {
  let list!: HTMLUListElement;
  const [error, setError] = createSignal<string | null>(null);

  const report = (err: unknown) => setError(errorMessage(err));
  const save = (next: SavedQuery[]) => setSavedQueries(next).then(() => setError(null), report);

  // A saved query has nothing to tell it apart but its place in the list.
  const places = () => savedQueries().map((_, index) => index);
  const drag = createRowDrag(
    () => list,
    places,
    (next) => setSavedQueries(next.map((index) => savedQueries()[index])).then(() => setError(null)),
    report,
  );

  const change = (index: number, changes: Partial<SavedQuery>) =>
    save(savedQueries().map((saved, i) => (i === index ? { ...saved, ...changes } : saved)));

  return (
    <>
      <h3>Saved queries</h3>
      <p class="hint">
        Queries kept to be used again. The + under the search box adds one as a row of the search,
        narrowing the results down to what it matches as well; the row is a copy, so changing a
        saved query here leaves the tabs that used it as they are. The bookmark beside a row of
        the search box saves that row here. Drag a row by its handle to change the order they are
        offered in.
      </p>
      <Show when={savedQueries().length > 0}>
        <ul class="setting-rows" ref={list}>
          <For each={drag.order()}>
            {(index) => (
              <li classList={{ dragging: drag.dragging() === index }}>
                <span
                  class="drag-handle"
                  title="Drag to reorder"
                  onPointerDown={(event) => drag.start(index, event)}
                >
                  <Icon name="drag-indicator" />
                </span>
                <input
                  class="saved-name"
                  type="text"
                  aria-label="Name"
                  placeholder="Name"
                  value={savedQueries()[index]?.name ?? ""}
                  onChange={(event) => change(index, { name: event.currentTarget.value.trim() })}
                />
                <input
                  class="saved-query"
                  type="text"
                  aria-label="Query"
                  placeholder="rating=safe score>=5"
                  spellcheck={false}
                  autocomplete="off"
                  autocapitalize="off"
                  value={savedQueries()[index]?.query ?? ""}
                  onChange={(event) => change(index, { query: event.currentTarget.value.trim() })}
                />
                <button
                  aria-label="Delete this saved query"
                  title="Delete this saved query"
                  onClick={() => save(savedQueries().filter((_, i) => i !== index))}
                >
                  <Icon name="delete-outline" />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p>
        <button onClick={() => save([...savedQueries(), { name: "", query: "" }])}>
          Add a query
        </button>
      </p>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </>
  );
}

/** One key binding per action; click the key, then press the new one. */
function Hotkeys() {
  /** The action waiting for its new key. */
  const [capturing, setCapturing] = createSignal<Action | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const assign = async (action: Action, key: string | null) => {
    try {
      setError(await bind(action, key));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // Listens ahead of everything else while a key is being chosen, so the
  // key is taken as a binding and nothing acts on it.
  const onKeyDown = (event: KeyboardEvent) => {
    const action = capturing();
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") return setCapturing(null);
    const key = keyOf(event);
    if (key === null) return;
    setCapturing(null);
    assign(action, key);
  };
  window.addEventListener("keydown", onKeyDown, true);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return (
    <>
      <h3>Hotkeys</h3>
      <p class="hint">
        Hotkeys work in the gallery, on the selected items, and in the viewer, on the open file.
        Click a key to change it.
      </p>
      <ul class="setting-rows">
        <For each={ACTIONS}>
          {(action) => (
            <li>
              <div class="setting-text">
                <span class="setting-label">{action.label}</span>
                <span class="hint">{action.description}</span>
              </div>
              <Show when={!isDefault(action.id)}>
                <button
                  class="link"
                  title={`Back to ${keyLabel(action.key)}`}
                  onClick={() => assign(action.id, null)}
                >
                  Reset
                </button>
              </Show>
              <button
                class="keycap"
                classList={{ capturing: capturing() === action.id }}
                aria-label={`Key for ${action.label}`}
                title="Click, then press the new key"
                onClick={() => setCapturing(capturing() === action.id ? null : action.id)}
                onBlur={() => capturing() === action.id && setCapturing(null)}
              >
                {capturing() === action.id ? "Press a key…" : keyLabel(keyFor(action.id))}
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </>
  );
}

/** Application settings: sections down the side, the chosen one beside. */
export default function SettingsModal(props: { onClose: () => void }) {
  const [section, setSection] = createSignal<(typeof SECTIONS)[number]["id"]>(SECTIONS[0].id);
  return (
    <Modal title="Settings" wide tall onClose={props.onClose}>
      <div class="settings">
        <nav class="settings-nav" aria-label="Settings sections">
          <For each={SECTIONS}>
            {(entry) => (
              <button
                class="plain"
                aria-current={section() === entry.id ? "page" : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            )}
          </For>
        </nav>
        <section class="settings-pane">
          <Switch>
            <Match when={section() === "tagTypes"}>
              <TagTypes />
            </Match>
            <Match when={section() === "savedQueries"}>
              <SavedQueries />
            </Match>
            <Match when={section() === "hotkeys"}>
              <Hotkeys />
            </Match>
            <Match when={section() === "downloads"}>
              <Downloads />
            </Match>
            <Match when={section() === "gallery"}>
              <Gallery />
            </Match>
          </Switch>
        </section>
      </div>
    </Modal>
  );
}
