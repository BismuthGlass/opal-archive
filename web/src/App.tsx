import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import CollectionDialog from "./components/CollectionDialog";
import ContextMenu, { contextMenuOpen } from "./components/ContextMenu";
import Grid from "./components/Grid";
import { modalOpen } from "./components/Modal";
import QuickTagModal from "./components/QuickTagModal";
import Icon from "./components/Icon";
import { createStoredFlag, Module } from "./components/Panel";
import QueryBar from "./components/QueryBar";
import SettingsModal from "./components/SettingsModal";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import TagEditor from "./components/TagEditor";
import Toolbar from "./components/Toolbar";
import { DropTarget, UploadBox, UploadPanel } from "./components/Upload";
import Viewer from "./components/Viewer";
import * as api from "./api";
import { plural } from "./format";
import { actionFor } from "./hotkeys";
import {
  PAGE,
  clearSelection,
  changed,
  dataVersion,
  goToPage,
  itemAt,
  runSearch,
  search,
  selectAll,
  selected,
} from "./search";
import { loadSettings } from "./settings";
import { refreshStats, stats } from "./stats";
import { hideToast, showToast, toast } from "./toast";
import { activeTab, error, load, open, refresh } from "./tabs";

export default function App() {
  /** Result index shown in the viewer, if it is open. */
  const [viewing, setViewing] = createSignal<number | null>(null);
  /** The entities being put into a collection, while that dialog is open. */
  const [grouping, setGrouping] = createSignal<number[] | null>(null);
  /** The collection the tab is tied to, shown when nothing is selected. */
  const shownCollection = () => (selected().size === 0 ? activeTab()?.collection : undefined);
  const [editingTags, setEditingTags] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /** What quick tagging applies to, while its modal is open. */
  const [tagging, setTagging] = createSignal<{ ids: number[]; name: string } | null>(null);
  /** What the next digit rates, after the quick-rate key. */
  const [rating, setRating] = createSignal<{ ids: number[]; name: string } | null>(null);
  const [panelOpen, setPanelOpen] = createStoredFlag("tagutils.panel", true);

  onMount(() => {
    load();
    loadSettings();
    refreshStats();
  });

  // Each tab shows a search, over the library or over what the tab holds
  // (its uploads, or a collection's members): run it when the tab or its
  // query changes.
  createEffect(
    on(
      () => {
        const tab = activeTab();
        return tab && `${tab.id}:${tab.query}`;
      },
      (key) => {
        if (key === undefined) return;
        setViewing(null);
        const tab = activeTab()!;
        runSearch(tab.query, tab.kind === "gallery" ? null : tab.id, key);
      },
    ),
  );

  // Collection tabs follow their collection: its title, whether it is
  // ordered, and its deletion.
  createEffect(on(dataVersion, refresh, { defer: true }));

  /**
   * What a hotkey acts on: in the viewer just the open file, otherwise
   * everything selected.
   */
  const hotkeyTarget = () => {
    const index = viewing();
    if (index !== null) {
      const item = itemAt(index);
      return item ? { ids: [item.id], name: "this file" } : null;
    }
    const ids = [...selected()];
    return ids.length > 0 ? { ids, name: plural(ids.length, "item") } : null;
  };

  const rate = async (target: { ids: number[]; name: string }, score: number | null) => {
    try {
      await api.edit(target.ids, { set: { score } });
      showToast(
        score === null ? `Cleared the score of ${target.name}` : `Rated ${target.name} ${score}`,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
    changed();
  };

  // On the window and capturing, so that it hears keys before the viewer
  // does and can keep the ones it uses from it.
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, select, [contenteditable]") || modalOpen()) return;
    // The menu from a right click has the keyboard while it is open.
    if (contextMenuOpen()) return;

    // After the quick-rate key, the next key is the score, or calls it off.
    const rated = rating();
    if (rated) {
      setRating(null);
      hideToast();
      const score = /^[0-7]$/.test(event.key) ? Number(event.key) : null;
      if (score !== null || event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (score !== null) rate(rated, score || null);
        return;
      }
      // Any other key calls the rating off and does what it usually does.
    }

    const action = actionFor(event);
    if (action) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const on = hotkeyTarget();
      if (!on) return showToast("Select something first");
      if (action === "quickTag") {
        setTagging(on);
      } else {
        setRating(on);
        showToast(`Rate ${on.name}: press 1 to 7, or 0 to clear`, true);
      }
      return;
    }

    if (viewing() !== null) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
    } else if (event.key === "Escape") {
      clearSelection();
    }
  };
  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return (
    <>
      <header class="topbar">
        <button
          class="icon-button"
          aria-pressed={panelOpen()}
          aria-label="Side panel"
          title={panelOpen() ? "Hide the side panel" : "Show the side panel"}
          onClick={() => setPanelOpen(!panelOpen())}
        >
          <Icon name={panelOpen() ? "left-panel-close-outline" : "left-panel-open-outline"} />
        </button>
        <TabBar />
        <button
          class="icon-button"
          aria-label="Tags"
          title="Tags: rename, merge and alias"
          onClick={() => setEditingTags(true)}
        >
          <Icon name="label-outline" />
        </button>
        <button
          class="icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings-outline" />
        </button>
      </header>
      <Show when={error()}>
        {(message) => (
          <p class="banner" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <div class="workspace">
        {/* The panel is a stack of modules; add new ones here. */}
        <Show when={panelOpen()}>
          <aside class="panel" aria-label="Side panel">
            <Module id="search" title="Search">
              <QueryBar />
            </Module>
            <Module
              id="selection"
              title={
                selected().size > 0
                  ? `${plural(selected().size, "item")} selected`
                  : shownCollection()
                    ? "This collection"
                    : "Selection"
              }
              action={
                <Show when={selected().size > 0}>
                  <button class="link" onClick={clearSelection}>
                    Clear
                  </button>
                </Show>
              }
            >
              <Show
                when={selected().size > 0}
                fallback={
                  // In a collection's tab, with nothing selected, the panel
                  // is about the collection itself.
                  <Show
                    when={shownCollection()}
                    fallback={<p class="hint">Select items to see and edit their metadata.</p>}
                  >
                    {(collection) => <Sidebar ids={[collection().id]} onGroup={setGrouping} />}
                  </Show>
                }
              >
                <Sidebar onGroup={setGrouping} />
              </Show>
            </Module>
          </aside>
        </Show>
        <main class="content">
          <Show when={activeTab()?.kind === "upload"}>
            <UploadBox />
          </Show>
          <Toolbar />
          <Grid onOpen={setViewing} />
        </main>
      </div>
      <footer class="statusbar">
        <span>{plural(search.total, "result")}</span>
        <Show when={selected().size > 0}>
          <span>{selected().size} selected</span>
        </Show>
        <Show when={stats()}>
          {(counts) => (
            <span class="library">
              {plural(counts().files, "file")}, {plural(counts().collections, "collection")} in the
              library
              <Show when={counts().trashed > 0}>
                {", "}
                <button
                  class="link"
                  title="Show what is in the trash"
                  onClick={() => open("gallery", "@trashed")}
                >
                  {counts().trashed} in the trash
                </button>
              </Show>
            </span>
          )}
        </Show>
      </footer>
      <UploadPanel />
      <DropTarget />
      <Show when={viewing() !== null}>
        <Viewer
          index={viewing()!}
          onMove={(index) => {
            // The grid follows the viewer across pages.
            if (index !== null) goToPage(Math.floor(index / PAGE));
            setViewing(index);
          }}
        />
      </Show>
      <Show when={tagging()}>
        {(target) => (
          <QuickTagModal
            ids={target().ids}
            target={target().name}
            onClose={() => setTagging(null)}
          />
        )}
      </Show>
      <ContextMenu />
      <Show when={toast()}>
        <div class="toast" role="status">
          {toast()}
        </div>
      </Show>
      <Show when={editingTags()}>
        <TagEditor onClose={() => setEditingTags(false)} />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      </Show>
      <Show when={grouping()}>
        {(ids) => (
          <CollectionDialog
            ids={ids()}
            // A collection is not offered a place inside itself.
            parent={
              ids().includes(activeTab()?.collection?.id ?? -1)
                ? undefined
                : (activeTab()?.collection ?? undefined)
            }
            onClose={() => setGrouping(null)}
          />
        )}
      </Show>
    </>
  );
}
