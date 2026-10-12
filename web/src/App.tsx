import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import GroupDialog from "./components/GroupDialog";
import type { GroupKind } from "./components/GroupDialog";
import SetPanel from "./components/SetPanel";
import CollectionPanel from "./components/CollectionPanel";
import ContextMenu, { contextMenuOpen, removeForGood } from "./components/ContextMenu";
import Grid, { gridColumns } from "./components/Grid";
import InboxPanel from "./components/InboxPanel";
import { modalOpen } from "./components/Modal";
import Icon from "./components/Icon";
import { createStoredFlag, Module } from "./components/Panel";
import Preview from "./components/Preview";
import QueryBar from "./components/QueryBar";
import SearchHelp from "./components/SearchHelp";
import SettingsModal from "./components/SettingsModal";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import { TaggerModal } from "./components/Tags";
import TagManager from "./components/TagManager";
import Toolbar from "./components/Toolbar";
import Tooltip from "./components/Tooltip";
import { DropTarget, UploadBox } from "./components/Upload";
import Viewer from "./components/Viewer";
import * as api from "./api";
import { errorMessage, plural } from "./format";
import { actionFor } from "./hotkeys";
import {
  clearSelection,
  changed,
  dataVersion,
  goToPage,
  itemAt,
  pageSize,
  repage,
  runSearch,
  search,
  deleted,
  invertSelection,
  moveItems,
  removeFromView,
  selectAll,
  moveSelection,
  showFirstSelected,
  showResult,
  selected,
  setMark,
  unmark,
} from "./search";
import { collapsesSets, loadSettings } from "./settings";
import { watchInbox } from "./inbox";
import { closeTagManager, openTagManager, tagManager } from "./tagManaging";
import QuerySelect, { openQuerySelect } from "./components/QuerySelect";
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

// The side panel can be dragged wider or narrower, between these, in pixels.
const PANEL_LEAST = 260;
const PANEL_MOST = 720;
const PANEL_WIDTH_KEY = "opalarchive.panel.width";

function storedPanelWidth(): number | null {
  try {
    const width = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return width >= PANEL_LEAST && width <= PANEL_MOST ? width : null;
  } catch {
    return null;
  }
}

function storePanelWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(PANEL_WIDTH_KEY);
    else localStorage.setItem(PANEL_WIDTH_KEY, String(width));
  } catch {
    // Storage unavailable; the width just won't survive a reload.
  }
}

export default function App() {
  /** Result index shown in the viewer, if it is open. */
  const [viewing, setViewing] = createSignal<number | null>(null);
  /** The result indexes the viewer keeps to, when it shows only some. */
  const [viewingOnly, setViewingOnly] = createSignal<number[] | null>(null);
  /** Opens the viewer on a result, or moves it, or with `null` closes it. */
  const view = (index: number | null, only: number[] | null = viewingOnly()) => {
    // The grid follows the viewer across pages.
    if (index !== null) goToPage(Math.floor(index / pageSize()));
    setViewingOnly(index === null ? null : only);
    setViewing(index);
  };
  // A page of another size: the results are dealt into pages again.
  createEffect(on(pageSize, (_now, before) => before !== undefined && repage(before), { defer: true }));
  /** The files being put in a set or a collection, while that dialog is open. */
  const [grouping, setGrouping] = createSignal<{ kind: GroupKind; ids: number[] } | null>(null);
  /** The set on show, described when nothing is selected. */
  const shownSet = () => (selected().size === 0 ? setShown() : undefined);
  /** The collection on show, likewise. */
  const shownCollection = () => (selected().size === 0 ? collectionShown() : undefined);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  /** What the tagging hotkey applies to, while the tagger it opens is up. */
  const [tagging, setTagging] = createSignal<{ ids: number[]; name: string } | null>(null);
  /** What the next digit scores, after the score key. */
  const [scoring, setScoring] = createSignal<{ ids: number[]; name: string } | null>(null);
  /** What the next digit rates, after the rating key. */
  const [rating, setRating] = createSignal<{ ids: number[]; name: string } | null>(null);
  /** The mark the mark key gives: the one last given with a key of its own. */
  let usualMark = 1;
  const [panelOpen, setPanelOpen] = createStoredFlag("opalarchive.panel", true);
  /** How wide the side panel was dragged to be; until then, as the stylesheet has it. */
  const [panelWidth, setPanelWidth] = createSignal(storedPanelWidth());
  /** Dragging the panel's edge sets its width; it is kept when the drag ends. */
  const resizePanel = (event: PointerEvent) => {
    const grip = event.currentTarget as HTMLElement;
    const left = grip.parentElement!.getBoundingClientRect().left;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => {
      // Never so wide that the files are left less than half the window.
      const most = Math.max(PANEL_LEAST, Math.min(PANEL_MOST, window.innerWidth / 2));
      setPanelWidth(Math.round(Math.max(PANEL_LEAST, Math.min(most, moved.clientX - left))));
    };
    const done = () => {
      grip.removeEventListener("pointermove", move);
      storePanelWidth(panelWidth());
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done, { once: true });
    grip.addEventListener("pointercancel", done, { once: true });
  };
  /** A double click on the edge puts the width back as it was made. */
  const resetPanelWidth = () => {
    setPanelWidth(null);
    storePanelWidth(null);
  };

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

  const score = async (target: { ids: number[]; name: string }, score: number | null) => {
    try {
      await api.edit(target.ids, { set: { score } });
      showToast(
        score === null ? `Cleared the score of ${target.name}` : `Scored ${target.name} ${score}`,
      );
    } catch (err) {
      showToast(errorMessage(err));
    }
    changed();
  };

  /** Sets the content rating, or with `null` clears it. */
  const rate = async (target: { ids: number[]; name: string }, rating: string | null) => {
    try {
      await api.edit(target.ids, { set: { content_rating: rating } });
      showToast(
        rating === null ? `Cleared the rating of ${target.name}` : `Rated ${target.name} ${rating}`,
      );
    } catch (err) {
      showToast(errorMessage(err));
    }
    changed();
  };

  /** Gives a mark, or with `given` false takes it off; with no number, takes every mark off. */
  const mark = (target: { ids: number[]; name: string }, number: number | null, given = true) => {
    if (number === null) {
      unmark(target.ids);
      showToast(`Took every mark off ${target.name}`);
      return;
    }
    setMark(target.ids, number, given);
    showToast(given ? `Gave ${target.name} mark ${number}` : `Took mark ${number} off ${target.name}`);
  };

  /** Deletes what is in the trash for good, once it has been agreed to. */
  const remove = async (target: { ids: number[]; name: string }) => {
    if (!(await removeForGood(target.ids))) return;
    const index = viewing();
    deleted(target.ids);
    showToast(`Deleted ${target.name} for good`);
    stepOn(index);
  };

  /** Takes out of the view on show, and of nothing else. */
  const hide = async (target: { ids: number[]; name: string }) => {
    const index = viewing();
    try {
      await removeFromView(target.ids);
      showToast(`Removed ${target.name} from this view`);
      stepOn(index);
    } catch (err) {
      showToast(errorMessage(err));
    }
  };

  /**
   * After the file open in the viewer, at `index`, has left the view: the
   * viewer goes on to what took its place, the next one, or the one before
   * if it was the last. With nothing left it closes.
   */
  const stepOn = (index: number | null) => {
    if (index === null) return;
    const only = viewingOnly();
    const left = only
      ? only.filter((at) => at !== index).map((at) => (at > index ? at - 1 : at))
      : null;
    const count = left ? left.length : search.total;
    if (count === 0) return view(null);
    const place = Math.min(only ? only.indexOf(index) : index, count - 1);
    view(left ? left[place] : place, left);
  };

  /**
   * Moves to the trash, or with `restore` out of it. What is all in the
   * trash already is deleted for good instead, once agreed to: the second
   * of the two steps deleting takes.
   */
  const trash = async (target: { ids: number[]; name: string }, restore: boolean) => {
    try {
      const state = restore ? null : await api.getMetadata(target.ids);
      if (state && state.count > 0 && state.trashed === state.count) {
        return await remove(target);
      }
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

  /** Takes out of the inbox, or with `back` puts in it again. */
  const archive = async (target: { ids: number[]; name: string }, back: boolean) => {
    try {
      const { changed } = await (back ? api.unarchiveEntities : api.archiveEntities)(target.ids);
      showToast(
        changed === 0
          ? `${back ? "Already" : "Nothing was"} in the inbox`
          : back
            ? `Moved ${target.name} to the inbox`
            : `Archived ${target.name}`,
      );
    } catch (err) {
      showToast(errorMessage(err));
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

    // After the score key, the next key is the score, or calls it off.
    const scored = scoring();
    if (scored) {
      setScoring(null);
      hideToast();
      const given = /^[0-7]$/.test(event.key) ? Number(event.key) : null;
      if (given !== null || event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (given !== null) score(scored, given || null);
        return;
      }
      // Any other key calls the scoring off and does what it usually does.
    }

    // After the rating key, likewise, the next key is the rating: 1 to 3,
    // in the order the ratings go.
    const rated = rating();
    if (rated) {
      setRating(null);
      hideToast();
      const given = /^[0-3]$/.test(event.key) ? Number(event.key) : null;
      if (given !== null || event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (given !== null) rate(rated, given ? api.CONTENT_RATINGS[given - 1] : null);
        return;
      }
    }

    const action = actionFor(event);
    // Where a file stands in the view is the gallery's to change: in the
    // viewer those keys are left to it.
    const moves = action === "moveToStart" || action === "moveToEnd";
    if (action && !(moves && viewing() !== null)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "selectByQuery") {
        // Of the gallery only, and of the view: nothing need be selected yet.
        if (viewing() === null) openQuerySelect();
        return;
      }
      const on = hotkeyTarget();
      if (!on) return showToast("Select something first");
      if (action === "quickTag") {
        setTagging(on);
      } else if (action === "mark") {
        mark(on, usualMark);
      } else if (action === "unmark") {
        mark(on, null);
      } else if (/^mark\d$/.test(action)) {
        // Each mark has a key of its own, which the mark key then repeats.
        usualMark = Number(action.slice(4));
        mark(on, usualMark);
      } else if (/^unmark\d$/.test(action)) {
        // And another that takes it off.
        mark(on, Number(action.slice(6)), false);
      } else if (action === "moveToStart" || action === "moveToEnd") {
        const end = action === "moveToEnd";
        moveItems(on.ids, end ? search.total : 0)
          .then(() => showToast(`Moved ${on.name} to the ${end ? "end" : "start"}`))
          .catch((err) => showToast(errorMessage(err)));
      } else if (action === "showSelected") {
        // Of the gallery only: in the viewer there is one file, and it is on show.
        if (viewing() === null) showFirstSelected();
      } else if (action === "hide") {
        hide(on);
      } else if (action === "trash" || action === "restore") {
        trash(on, action === "restore");
      } else if (action === "archive" || action === "unarchive") {
        archive(on, action === "unarchive");
      } else if (action === "quickRating") {
        setRating(on);
        showToast(`Rate ${on.name}: press 1 for safe, 2 for risky, 3 for nsfw, or 0 to clear`, true);
      } else {
        setScoring(on);
        showToast(`Score ${on.name}: press 1 to 7, or 0 to clear`, true);
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
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      invertSelection();
    } else if (event.key === "Escape") {
      clearSelection();
    } else if (
      /^Arrow/.test(event.key) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      // What has arrows of its own keeps them: a player, a menu, a list.
      !target.closest("video, audio, [role=menu], [role=listbox]")
    ) {
      // The arrows move the selection from tile to tile; with Shift, they
      // take what is between along.
      event.preventDefault();
      const direction = event.key.slice(5).toLowerCase() as "left" | "right" | "up" | "down";
      moveSelection(direction, gridColumns(), event.shiftKey);
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
          aria-label="Tag manager"
          title="Tag manager: describe, rename, merge and alias tags"
          onClick={openTagManager}
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
          <aside
            class="panel"
            aria-label="Side panel"
            style={{ "--panel-width": panelWidth() === null ? undefined : `${panelWidth()}px` }}
          >
            <div
              class="panel-grip"
              title="Drag to resize; double-click to put it back"
              onPointerDown={resizePanel}
              onDblClick={resetPanelWidth}
            />
            <div class="panel-modules">
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
                    {(set) => <SetPanel set={set().set_id} />}
                  </Show>
                }
              >
                <Sidebar />
              </Show>
            </Module>
            </div>
            <Preview />
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
              <Show when={counts().inbox > 0}>
                {", "}
                <button
                  class="link"
                  title="Show what is in the inbox: new to the library, and not yet archived"
                  onClick={() => open("gallery", "@inbox")}
                >
                  {counts().inbox} in the inbox
                </button>
              </Show>
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
        <Viewer
          index={viewing()!}
          only={viewingOnly() ?? undefined}
          onMove={(index) => view(index)}
          onGoTo={(index) => {
            view(null);
            showResult(index);
          }}
        />
      </Show>
      <Show when={tagging()} keyed>
        {(target) => (
          <TaggerModal ids={target.ids} target={target.name} onClose={() => setTagging(null)} />
        )}
      </Show>
      <ContextMenu onPreview={view} onGroup={(kind, ids) => setGrouping({ kind, ids })} />
      <Tooltip />
      <Show when={toast()}>
        <div class="toast" role="status">
          {toast()}
        </div>
      </Show>
      <Show when={tagManager()} keyed>
        {(opened) => <TagManager initial={opened.tag} onClose={closeTagManager} />}
      </Show>
      <QuerySelect />
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
        {(group) => (
          <GroupDialog kind={group.kind} ids={group.ids} onClose={() => setGrouping(null)} />
        )}
      </Show>
    </>
  );
}
