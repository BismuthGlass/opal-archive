import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import CollectionDialog from "./components/CollectionDialog";
import Grid from "./components/Grid";
import Icon from "./components/Icon";
import { createStoredFlag, Module } from "./components/Panel";
import QueryBar from "./components/QueryBar";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import { DropTarget, UploadBox, UploadPanel } from "./components/Upload";
import Viewer from "./components/Viewer";
import { plural } from "./format";
import { clearSelection, runSearch, search, selectAll, selected } from "./search";
import { refreshStats, stats } from "./stats";
import { activeTab, error, load } from "./tabs";

export default function App() {
  /** Result index shown in the viewer, if it is open. */
  const [viewing, setViewing] = createSignal<number | null>(null);
  const [grouping, setGrouping] = createSignal(false);
  const [panelOpen, setPanelOpen] = createStoredFlag("tagutils.panel", true);

  onMount(() => {
    load();
    refreshStats();
  });

  // Each tab shows a search, over the library or over the tab's own
  // uploads: run it when the tab or its query changes.
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
        runSearch(tab.query, tab.kind === "upload" ? tab.id : null);
      },
    ),
  );

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.matches("input, textarea, select, [contenteditable]") || grouping()) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
    } else if (event.key === "Escape") {
      clearSelection();
    }
  };
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  return (
    <>
      <header class="topbar">
        <button
          class="panel-toggle"
          aria-pressed={panelOpen()}
          aria-label="Side panel"
          title={panelOpen() ? "Hide the side panel" : "Show the side panel"}
          onClick={() => setPanelOpen(!panelOpen())}
        >
          <Icon name={panelOpen() ? "left-panel-close-outline" : "left-panel-open-outline"} />
        </button>
        <span class="brand">tagutils</span>
        <TabBar />
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
                selected().size > 0 ? `${plural(selected().size, "item")} selected` : "Selection"
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
                fallback={<p class="hint">Select items to see and edit their metadata.</p>}
              >
                <Sidebar onGroup={() => setGrouping(true)} />
              </Show>
            </Module>
          </aside>
        </Show>
        <main class="content">
          <Show when={activeTab()?.kind === "upload"}>
            <UploadBox />
          </Show>
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
            </span>
          )}
        </Show>
      </footer>
      <UploadPanel />
      <DropTarget />
      <Show when={viewing() !== null}>
        <Viewer index={viewing()!} onMove={setViewing} />
      </Show>
      <Show when={grouping()}>
        <CollectionDialog ids={[...selected()]} onClose={() => setGrouping(false)} />
      </Show>
    </>
  );
}
