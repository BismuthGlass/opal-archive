import { createSignal, For, Show } from "solid-js";
import type { TabKind } from "../api";
import { activeId, close, open, select, tabs } from "../tabs";
import type { IconName } from "./Icon";
import Icon from "./Icon";

/** The kinds of tab on offer; add new ones here. */
const KINDS: { kind: TabKind; label: string; icon: IconName }[] = [
  { kind: "search", label: "Search", icon: "search" },
  { kind: "upload", label: "Upload", icon: "upload" },
];

function label(kind: TabKind, query: string) {
  if (kind === "upload") return query ? `Upload: ${query}` : "Upload";
  return query || "New search";
}

/** The + button, and the menu of tab kinds it opens. */
function NewTab() {
  const [menu, setMenu] = createSignal(false);
  return (
    <div
      class="tab-new"
      // Closes when focus leaves the button and its menu.
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(false);
      }}
      // A native listener, so stopping the event keeps Escape from also
      // clearing the selection.
      on:keydown={(event) => {
        if (event.key === "Escape" && menu()) {
          event.stopPropagation();
          setMenu(false);
        }
      }}
    >
      <button
        aria-label="New tab"
        title="New tab"
        aria-haspopup="menu"
        aria-expanded={menu()}
        onClick={() => setMenu(!menu())}
      >
        <Icon name="add" />
      </button>
      <Show when={menu()}>
        <ul class="suggestions" role="menu">
          <For each={KINDS}>
            {(entry) => (
              <li role="none">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    open(entry.kind);
                  }}
                >
                  <Icon name={entry.icon} />
                  {entry.label}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export default function TabBar() {
  return (
    <div class="tabstrip">
      <nav class="tabs" role="tablist" aria-label="Tabs">
        <For each={tabs}>
          {(tab) => (
            <div
              class="tab"
              classList={{ active: tab.id === activeId() }}
              // Middle click closes, as in a browser.
              onAuxClick={(event) => event.button === 1 && close(tab.id)}
            >
              <button
                class="tab-label"
                role="tab"
                aria-selected={tab.id === activeId()}
                title={label(tab.kind, tab.query)}
                onClick={() => select(tab.id)}
              >
                <Show when={tab.kind === "upload"}>
                  <Icon name="upload" />
                </Show>
                {label(tab.kind, tab.query)}
              </button>
              <button class="tab-close" aria-label="Close tab" onClick={() => close(tab.id)}>
                <Icon name="close" />
              </button>
            </div>
          )}
        </For>
      </nav>
      <NewTab />
    </div>
  );
}
