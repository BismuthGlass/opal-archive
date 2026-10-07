import { createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import type { Tab, TabKind } from "../api";
import { fieldLabel } from "../format";
import { activeId, close, move, open, rename, saveOrder, select, tabs } from "../tabs";

const ICONS: Record<TabKind, IconName> = {
  gallery: "photo-library-outline",
  upload: "upload",
  collection: "folder-outline",
  download: "download",
  inbox: "inbox-outline",
  selection: "select-all",
};
import type { IconName } from "./Icon";
import Icon from "./Icon";

/** The kinds of tab the + button offers, before one for each downloader.
    A collection tab is opened from its collection instead. */
const KINDS: { kind: TabKind; label: string; title?: string }[] = [
  { kind: "gallery", label: "Gallery" },
  { kind: "upload", label: "Upload" },
  {
    kind: "inbox",
    label: "Inbox",
    title: "What the browser extension sends to be downloaded; there is one",
  },
];

/** What a tab is called when it has not been given a name. */
function described(tab: Tab) {
  // A stacked query is one line each; here they go side by side.
  const query = tab.query.replaceAll("\n", " + ");
  if (tab.kind === "gallery") return query || "Gallery";
  const what =
    tab.kind === "upload"
      ? "Upload"
      : tab.kind === "inbox"
        ? "Inbox"
        : tab.kind === "selection"
          ? "Selection"
        : tab.kind === "download"
        ? fieldLabel(tab.downloader ?? "download")
        : tab.collection?.title ||
          tab.collection?.collection_id ||
          `Collection #${tab.collection?.id}`;
  return query ? `${what}: ${query}` : what;
}

/** The + button, and the menu of tab kinds it opens. */
function NewTab() {
  const [menu, setMenu] = createSignal(false);
  // Read each time the menu opens: a downloader is a folder on the server,
  // and one may have been added.
  const [downloaders] = createResource(menu, (open) => (open ? api.listDownloaders() : []));
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
                  title={entry.title}
                  onClick={() => {
                    setMenu(false);
                    open(entry.kind);
                  }}
                >
                  <Icon name={ICONS[entry.kind]} />
                  {entry.label}
                </button>
              </li>
            )}
          </For>
          <Show when={(downloaders.latest ?? []).length > 0}>
            <li class="menu-divider" role="separator" />
          </Show>
          <For each={downloaders.latest ?? []}>
            {(downloader) => (
              <li role="none">
                <button
                  role="menuitem"
                  title={`Download from ${downloader.title} into a tab`}
                  onClick={() => {
                    setMenu(false);
                    open("download", "", downloader.name);
                  }}
                >
                  <Icon name={ICONS.download} />
                  {downloader.title}
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
  /** The tab whose name is being typed. */
  const [renaming, setRenaming] = createSignal<number | null>(null);

  // Tabs are dragged along the strip to reorder them. The tab moves in the
  // list as the pointer passes its neighbours, and the order is saved on
  // release.
  const startDrag = (id: number, down: PointerEvent) => {
    if (down.button !== 0 || renaming() !== null) return;
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
              <Show
                when={renaming() === tab.id}
                fallback={
                  <button
                    class="tab-label"
                    role="tab"
                    aria-selected={tab.id === activeId()}
                    title={`${described(tab)}\nDouble-click to rename`}
                    onClick={() => select(tab.id)}
                    onDblClick={() => setRenaming(tab.id)}
                  >
                    <Icon name={ICONS[tab.kind]} />
                    {tab.name || described(tab)}
                  </button>
                }
              >
                <input
                  class="tab-rename"
                  type="text"
                  aria-label="Tab name"
                  placeholder={described(tab)}
                  value={tab.name}
                  ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
                  // Saves on leaving the box as well as on Enter.
                  onBlur={(event) => {
                    if (renaming() !== tab.id) return;
                    setRenaming(null);
                    const name = event.currentTarget.value.trim();
                    if (name !== tab.name) rename(tab.id, name);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      setRenaming(null);
                    }
                  }}
                />
              </Show>
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
