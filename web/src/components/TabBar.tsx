import { createSignal, For, Show } from "solid-js";
import type { TabKind } from "../api";
import { activeId, close, move, open, saveOrder, select, tabs } from "../tabs";
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

/** How far the pointer travels, in pixels, before a press becomes a drag. */
const DRAG_THRESHOLD = 5;

export default function TabBar() {
  let strip!: HTMLElement;
  const [dragging, setDragging] = createSignal<number | null>(null);

  // Tabs are dragged along the strip to reorder them. The tab moves in the
  // list as the pointer passes its neighbours, and the order is saved on
  // release.
  const startDrag = (id: number, down: PointerEvent) => {
    if (down.button !== 0) return;
    const onMove = (event: PointerEvent) => {
      if (dragging() === null) {
        if (Math.abs(event.clientX - down.clientX) < DRAG_THRESHOLD) return;
        setDragging(id);
      }
      // Its place is after every other tab whose middle the pointer passed.
      const others = [...strip.querySelectorAll<HTMLElement>(".tab:not(.dragging)")];
      const index = others.filter((tab) => {
        const box = tab.getBoundingClientRect();
        return box.left + box.width / 2 < event.clientX;
      }).length;
      move(id, index);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (dragging() !== null) {
        setDragging(null);
        saveOrder();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div class="tabstrip">
      <nav class="tabs" role="tablist" aria-label="Tabs" ref={strip}>
        <For each={tabs}>
          {(tab) => (
            <div
              class="tab"
              classList={{ active: tab.id === activeId(), dragging: tab.id === dragging() }}
              onPointerDown={(event) => startDrag(tab.id, event)}
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
