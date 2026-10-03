import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ACTIONS, bind, isDefault, keyFor, keyLabel, keyOf } from "../hotkeys";
import type { Action } from "../hotkeys";
import { TAG_FIELDS } from "../api";
import { fieldLabel } from "../format";
import { isCustom, pillStyle, setTagType, tagType } from "../tagTypes";
import type { TagType } from "../tagTypes";
import Modal from "./Modal";

/** The sections of the settings pane; add new ones here. */
const SECTIONS = [
  { id: "tagTypes", label: "Tag types" },
  { id: "hotkeys", label: "Hotkeys" },
] as const;

/** Each tag type's pill colours, and whether it joins the one list. */
function TagTypes() {
  const [error, setError] = createSignal<string | null>(null);
  const change = (field: string, changes: Partial<TagType> | null) =>
    setTagType(field, changes).then(
      () => setError(null),
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );

  return (
    <>
      <h3>Tag types</h3>
      <p class="hint">
        Tags are shown as pills in the colours of their type. The types ticked as aggregated share
        one list in the side panel; the others each get a section of their own.
      </p>
      <ul class="setting-rows">
        <For each={TAG_FIELDS}>
          {(field) => (
            <li>
              <div class="setting-text">
                <span>
                  <span class="chip tinted type-sample" style={pillStyle(field)}>
                    {fieldLabel(field)}
                  </span>
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
      setError(err instanceof Error ? err.message : String(err));
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
    <Modal title="Settings" wide onClose={props.onClose}>
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
