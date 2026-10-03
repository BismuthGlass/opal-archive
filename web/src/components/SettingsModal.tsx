import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ACTIONS, bind, isDefault, keyFor, keyLabel, keyOf } from "../hotkeys";
import type { Action } from "../hotkeys";
import { errorMessage, fieldLabel } from "../format";
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
  { id: "hotkeys", label: "Hotkeys" },
] as const;

/** Each tag type's pill colours, and whether it joins the one list. */
function TagTypes() {
  let list!: HTMLUListElement;
  const [error, setError] = createSignal<string | null>(null);
  /** The order while a row is being dragged, and the row. */
  const [dragOrder, setDragOrder] = createSignal<string[] | null>(null);
  const [dragging, setDragging] = createSignal<string | null>(null);
  const order = () => dragOrder() ?? orderedTypes();

  const report = (err: unknown) => setError(errorMessage(err));

  // A row is dragged by its handle. It moves in the list as the pointer
  // passes the other rows, and the order is saved on release.
  const startDrag = (field: string, down: PointerEvent) => {
    down.preventDefault();
    setDragging(field);
    setDragOrder(orderedTypes());
    const onMove = (event: PointerEvent) => {
      const others = [...list.querySelectorAll<HTMLElement>("li:not(.dragging)")];
      // Its place is after every other row whose middle the pointer passed.
      const index = others.filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top + box.height / 2 < event.clientY;
      }).length;
      const rest = order().filter((other) => other !== field);
      rest.splice(index, 0, field);
      if (rest.some((other, i) => other !== order()[i])) setDragOrder(rest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const next = order();
      setDragging(null);
      const moved = next.some((other, i) => other !== orderedTypes()[i]);
      if (!moved) return setDragOrder(null);
      setTagTypeOrder(next)
        .then(() => setError(null), report)
        .finally(() => setDragOrder(null));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

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
        <For each={order()}>
          {(field) => (
            <li classList={{ dragging: dragging() === field }}>
              <span
                class="drag-handle"
                title="Drag to reorder"
                onPointerDown={(event) => startDrag(field, event)}
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
            <Match when={section() === "hotkeys"}>
              <Hotkeys />
            </Match>
          </Switch>
        </section>
      </div>
    </Modal>
  );
}
