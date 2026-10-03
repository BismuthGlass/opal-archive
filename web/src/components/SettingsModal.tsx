import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ACTIONS, bind, isDefault, keyFor, keyLabel, keyOf } from "../hotkeys";
import type { Action } from "../hotkeys";
import Modal from "./Modal";

/** The sections of the settings pane; add new ones here. */
const SECTIONS = [{ id: "hotkeys", label: "Hotkeys" }] as const;

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
            <Match when={section() === "hotkeys"}>
              <Hotkeys />
            </Match>
          </Switch>
        </section>
      </div>
    </Modal>
  );
}
