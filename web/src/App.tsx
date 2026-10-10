import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import SetDialog from "./components/SetDialog";
import SetPanel from "./components/SetPanel";
import CollectionPanel from "./components/CollectionPanel";
import ContextMenu, { contextMenuOpen } from "./components/ContextMenu";
import Grid from "./components/Grid";
import InboxPanel from "./components/InboxPanel";
import { modalOpen } from "./components/Modal";
import Icon from "./components/Icon";
import { createStoredFlag, Module } from "./components/Panel";
import QueryBar from "./components/QueryBar";
import SearchHelp from "./components/SearchHelp";
import SettingsModal from "./components/SettingsModal";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import { TagsModal } from "./components/Tags";
import TagEditor from "./components/TagEditor";
import Toolbar from "./components/Toolbar";
import Tooltip from "./components/Tooltip";
import { DropTarget, UploadBox } from "./components/Upload";
import Viewer from "./components/Viewer";
import * as api from "./api";
import { errorMessage, plural } from "./format";
import { actionFor, keyFor, keyLabel } from "./hotkeys";
import {
  MARKS,
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
  toggleMark,
  unmark,
} from "./search";
import { collapsesSets, loadSettings } from "./settings";
import { watchInbox } from "./inbox";
import { closeTagEditor, openTagEditor, tagEditor } from "./tagEditing";
import { refreshStats, stats } from "./stats";
import { hideToast, showToast, toast } from "./toast";
import {
  activeTab,
  error,
  inside,
  load,
  open,
  refresh,
  shownCollection as collectionShown,
  shownSet as setShown,
  showsTrashed,
  stepKey,
  stepWithin,
  trail,
} from "./tabs";
import Trail, { goBack } from "./components/Trail";

export default function App() {
  /** Result index shown in the viewer, if it is open. */
  const [viewing, setViewing] = createSignal<number | null>(null);
  /** The result indexes the viewer keeps to, when it shows only some. */
  const [viewingOnly, setViewingOnly] = createSignal<number[] | null>(null);
  /** Opens the viewer on a result, or moves it, or with `null` closes it. */
  const view = (index: number | null, only: number[] | null = viewingOnly()) => {
    // The grid follows the viewer across pages.
    if (index !== null) goToPage(Math.floor(index / PAGE));
    setViewingOnly(index === null ? null : only);
    setViewing(index);
  };
  /** The files being put into a set, while that dialog is open. */
  const [grouping, setGrouping] = createSignal<number[] | null>(null);
  /** The set on show, described when nothing is selected. */
  const shownSet = () => (selected().size === 0 ? setShown() : undefined);
  /** The collection on show, likewise. */
  const shownCollection = () => (selected().size === 0 ? collectionShown() : undefined);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  /** What the tagging hotkey applies to, while the tag editor it opens is up. */
  const [tagging, setTagging] = createSignal<{ ids: number[]; name: string } | null>(null);
  /** What the next digit rates, after the quick-rate key. */
  const [rating, setRating] = createSignal<{ ids: number[]; name: string } | null>(null);
  /** What the next digit marks, after the mark-as key. */
  const [marking, setMarking] = createSignal<{ ids: number[]; name: string } | null>(null);
  /** The mark the mark key gives: the one last picked with the mark-as key. */
  let usualMark = 1;
  const [panelOpen, setPanelOpen] = createStoredFlag("opalarchive.panel", true);

  onMount(() => {
    load();
    loadSettings();
    refreshStats();
    watchInbox();
  });

  // Each tab shows a search, over the library or over what the tab holds
  // (its uploads, or a set's files): run it when the tab or its query
  // changes.
  /**
   * The tab the last search was shown in, how far inside sets, and whether
   * sets were listed once.
   */
  let shown: { tab: number; inside: boolean; depth: number; stacked: boolean } | null = null;
  createEffect(
    on(
      () => {
        const tab = activeTab();
        if (!tab) return undefined;
        // Inside a set, the view is of its files: one view for each way
        // in, kept apart from the tab's own by a character that cannot be
        // typed.
        const way = trail().map(stepKey).join("/");
        // With the trash on show it is another view of the same query.
        const trashed = showsTrashed() ? "\u0002" : "";
        // So it is with sets listed once, which a set itself never is.
        const stacked = collapsesSets() ? "\u0003" : "";
        return inside()
          ? `${tab.id}:\u0001${way}:${trashed}${stacked}${inside()!.query}`
          : `${tab.id}:${trashed}${stacked}${tab.query}`;
      },
      (key) => {
        if (key === undefined) return;
        view(null);
        const tab = activeTab()!;
        const step = inside();
        const stacked = collapsesSets();
        // The query of the tab on show changed: the search was asked for.
        // The settings arriving, or changing, is not asking.
        const asked =
          shown?.tab === tab.id && !shown.inside && !step && shown.stacked === stacked;
        // A set just gone into is listed afresh, though it was seen
        // before: what is in it may have changed since.
        const entered = shown?.tab === tab.id && trail().length > shown.depth;
        shown = { tab: tab.id, inside: !!step, depth: trail().length, stacked };
        if (step) {
          // Not saved with the tab: the trail is the page's alone.
          // A set is listed once in a collection, as anywhere but in a set.
          const once = stacked && "collection" in step;
          runSearch(
            step.query,
            null,
            key,
            null,
            stepWithin(step),
            false,
            entered,
            showsTrashed(),
            once,
          );
        } else {
          // Listing the whole library is not done just for opening a tab.
          const wait = tab.kind === "gallery" && tab.query === "" && !asked;
          const scope = tab.kind === "gallery" ? null : tab.id;
          runSearch(
            tab.query,
            scope,
            key,
            tab.id,
            null,
            wait,
            false,
            showsTrashed(),
            stacked && tab.kind !== "set",
          );
        }
      },
    ),
  );

  // Set tabs follow their set: what it is called, and its going.
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
      showToast(errorMessage(err));
    }
    changed();
  };

  const mark = (target: { ids: number[]; name: string }, number: number | null) => {
    if (number === null) {
      unmark(target.ids);
      showToast(`Took the mark off ${target.name}`);
    } else if (toggleMark(target.ids, number)) {
      showToast(`Gave ${target.name} mark ${number}`);
    } else {
      showToast(`Took mark ${number} off ${target.name}`);
    }
  };

  /** Moves to the trash, or with `restore` out of it. */
  const trash = async (target: { ids: number[]; name: string }, restore: boolean) => {
    try {
      const { changed } = await (restore ? api.restoreEntities : api.trashEntities)(target.ids);
      showToast(
        changed === 0
          ? `${restore ? "Nothing was" : "Already"} in the trash`
          : restore
            ? `Took ${target.name} out of the trash`
            : `Moved ${target.name} to the trash`,
      );
    } catch (err) {
      showToast(errorMessage(err));
    }
    changed();
  };

  /** The digit a key stands for, with Shift still down or not. */
  const digitOf = (event: KeyboardEvent) => {
    const digit = /^\d$/.test(event.key) ? event.key : /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
    return digit === undefined ? null : Number(digit);
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

    // After the mark-as key, likewise, the next key is the mark.
    const marked = marking();
    if (marked) {
      // Letting go of Shift, or holding it, is not an answer.
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      setMarking(null);
      hideToast();
      const digit = digitOf(event);
      const number = digit !== null && digit <= MARKS ? digit : null;
      if (number !== null || event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (number) {
          // Picked once, it is what the mark key gives from then on. Given
          // to what already has it, it would be taken off: it is kept on.
          usualMark = number;
          if (!toggleMark(marked.ids, number)) toggleMark(marked.ids, number);
          showToast(
            `Gave ${marked.name} mark ${number}. ${keyLabel(keyFor("mark"))} now gives mark ${number}`,
          );
        } else if (number === 0) {
          mark(marked, null);
        }
        return;
      }
    }

    const action = actionFor(event);
    if (action) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const on = hotkeyTarget();
      if (!on) return showToast("Select something first");
      if (action === "quickTag") {
        setTagging(on);
      } else if (action === "mark") {
        mark(on, usualMark);
      } else if (action === "markAs") {
        setMarking(on);
        showToast(
          `Mark ${on.name}: press 1 to ${MARKS}, which the mark key then gives too, or 0 to take the mark off`,
          true,
        );
      } else if (action === "trash" || action === "restore") {
        trash(on, action === "restore");
      } else {
        setRating(on);
        showToast(`Rate ${on.name}: press 1 to 7, or 0 to clear`, true);
      }
      return;
    }

    if (viewing() !== null) return;
    if (event.key === "Backspace" && inside()) {
      // Back out of the set, as the arrow above the grid does.
      event.preventDefault();
      goBack();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
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
          onClick={openTagEditor}
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
            <Module
              id="search"
              title="Search"
              beside={
                <button
                  class="help-button"
                  aria-label="How to search"
                  title="How to search"
                  onClick={() => setHelpOpen(true)}
                >
                  <Icon name="help-outline" />
                </button>
              }
            >
              <QueryBar />
            </Module>
            <Module
              id="selection"
              title={
                selected().size > 0
                  ? `${plural(selected().size, "item")} selected`
                  : shownSet()
                    ? "This set"
                    : shownCollection() !== undefined
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
                  // Showing a set, with nothing selected, the panel is about
                  // the set itself.
                  <Show
                    when={shownSet()}
                    fallback={
                      // As it is about a collection, showing one.
                      <Show
                        when={shownCollection()}
                        fallback={<p class="hint">Select items to see and edit their metadata.</p>}
                      >
                        {(name) => <CollectionPanel name={name()} />}
                      </Show>
                    }
                  >
                    {(set) => <SetPanel set={set().id} />}
                  </Show>
                }
              >
                <Sidebar onGroup={setGrouping} />
              </Show>
            </Module>
          </aside>
        </Show>
        <main class="content">
          {/* What a tab is for gives way while it is inside a set. */}
          <Show when={activeTab()?.kind === "upload" && !inside()}>
            <UploadBox />
          </Show>
          <Show when={activeTab()?.kind === "inbox" && !inside()}>
            <InboxPanel />
          </Show>
          <Trail />
          <Toolbar />
          <Grid onOpen={(index) => view(index, null)} />
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
              {plural(counts().files, "file")} in the library
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
      <DropTarget />
      <Show when={viewing() !== null}>
        <Viewer index={viewing()!} only={viewingOnly() ?? undefined} onMove={(index) => view(index)} />
      </Show>
      <Show when={tagging()} keyed>
        {(target) => (
          <TagsModal ids={target.ids} target={target.name} onClose={() => setTagging(null)} />
        )}
      </Show>
      <ContextMenu onPreview={view} onGroup={setGrouping} />
      <Tooltip />
      <Show when={toast()}>
        <div class="toast" role="status">
          {toast()}
        </div>
      </Show>
      <Show when={tagEditor()} keyed>
        {(opened) => <TagEditor initial={opened.tag} onClose={closeTagEditor} />}
      </Show>
      <Show when={helpOpen()}>
        <SearchHelp onClose={() => setHelpOpen(false)} />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      </Show>
      {/* Keyed: the dialog is given the value itself. Handed a way to read
          it instead, it would still be reading as the dialog closes, when
          there is nothing left to read. The same goes for the other
          dialogs opened with a value. */}
      <Show when={grouping()} keyed>
        {(ids) => <SetDialog ids={ids} onClose={() => setGrouping(null)} />}
      </Show>
    </>
  );
}
