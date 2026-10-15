import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import * as api from "./api";
import type { Item } from "./api";
import { plural } from "./format";
import { settings } from "./settings";
import { refreshStats } from "./stats";
import { record } from "./undo";

/** How many results a page holds unless the settings say otherwise, and the bounds they keep to. */
export const DEFAULT_PAGE = 200;
export const LEAST_PAGE = 10;
export const MOST_PAGE = 1000;
/** Results are shown, and fetched, in pages of this many. */
export const pageSize = () =>
  Math.max(LEAST_PAGE, Math.min(MOST_PAGE, Math.round(settings.pageSize ?? DEFAULT_PAGE)));

/**
 * What a view is kept to: a set, a group of variants or a collection, which
 * the server knows; or a mark, which only the page does, with the files
 * that had it in the view it was gone into from, in that view's order.
 */
export type Within = api.Within | { mark: number; ids: number[] } | { selection: number[] };

type SearchError = { message: string; position?: number; line?: number };

const [search, setSearch] = createStore({
  query: "",
  /** Upload tab the results are limited to, if any. */
  scope: null as number | null,
  /** The set or group of variants the results are limited to instead, if any. */
  within: null as Within | null,
  /**
   * Whether what is in the trash is listed along with the rest, without
   * the query having to say `@trashed`.
   */
  trashed: false,
  /** Whether a set is listed once, as one result, rather than file by file. */
  collapsed: false,
  /** The page of results on show, counted from 0. */
  page: 0,
  /** Whether the results have been dragged into an order of their own. */
  custom: false,
  total: 0,
  /** False until the first page of the current query has arrived. */
  ready: false,
  /**
   * Whether the search is waiting to be asked for: a gallery tab opened on
   * the whole library lists nothing until Search is pressed.
   */
  idle: false,
  error: null as SearchError | null,
});
const [pages, setPages] = createStore<Record<number, Item[]>>({});
const [selected, setSelected] = createSignal<ReadonlySet<number>>(new Set());
/** The result selected last, by a click, while it is still selected. */
const [lastSelected, setLastSelected] = createSignal<number | null>(null);
/**
 * The result the side panel's preview shows: of those selected, the one
 * selected last, or failing that the last of them.
 */
export function previewed(): number | null {
  const chosen = selected();
  const last = lastSelected();
  if (last !== null && chosen.has(last)) return last;
  return chosen.size > 0 ? [...chosen].at(-1)! : null;
}
/** How many marks there are, numbered from 1. */
export const MARKS = 9;
/** The marks a file has, lowest first: it can have several. */
type Marks = readonly number[];
/** The marks of a tab: file to its marks, for the files that have any. */
type TabMarks = ReadonlyMap<number, Marks>;
/**
 * What is marked in the tab on show, and with which marks. Marks are the
 * tab's own, and the same in every view of it: what is marked in a search
 * is marked in the set it is in, gone into from there, and the other way
 * round. Nothing in the library is changed by them.
 */
const [marks, setMarks] = createSignal<TabMarks>(new Map());
/** What the marks of the tab on show have been named, for those that have. */
type MarkNames = Readonly<Record<number, string>>;
const [markNames, setMarkNames] = createSignal<MarkNames>({});
/** Bumped when what the view lists changes: what of the marked is in it does too. */
const [listing, setListing] = createSignal(0);

// Marks are remembered per browser, like where each view was left.
const MARKS_KEY = "opalarchive.marks";
/** The marks of each tab that has any. */
const tabMarks = new Map<number, TabMarks>(readMarks());

/** Marks as they are kept: a file had one mark once, stored as its number. */
type StoredMarks = [number, number | number[]][];
// A function declaration: it is called while the lines above are still run.
function storedMarks(given: StoredMarks): [number, Marks][] {
  return given.map(([id, had]) => [id, typeof had === "number" ? [had] : had]);
}

function readMarks(): [number, TabMarks][] {
  try {
    const stored = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "[]");
    return (stored as [number, StoredMarks][]).map(([tab, given]) => [
      tab,
      new Map(storedMarks(given)),
    ]);
  } catch {
    return [];
  }
}

function writeMarks() {
  try {
    localStorage.setItem(
      MARKS_KEY,
      JSON.stringify([...tabMarks].map(([tab, given]) => [tab, [...given]])),
    );
  } catch {
    // Storage unavailable or full; the marks just won't survive a reload.
  }
}

// The names of marks are kept the same way, tab by tab.
const MARK_NAMES_KEY = "opalarchive.markNames";
const tabMarkNames = new Map<number, MarkNames>(readMarkNames());

function readMarkNames(): [number, MarkNames][] {
  try {
    return JSON.parse(localStorage.getItem(MARK_NAMES_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeMarkNames() {
  try {
    localStorage.setItem(MARK_NAMES_KEY, JSON.stringify([...tabMarkNames]));
  } catch {
    // Storage unavailable or full; the names just won't survive a reload.
  }
}

/**
 * Names a mark of the tab on show, or with nothing takes its name away.
 * The name only says what the mark is being used for.
 */
export function nameMark(mark: number, name: string | null) {
  const next = { ...markNames() };
  if (name?.trim()) next[mark] = name.trim();
  else delete next[mark];
  setMarkNames(next);
  const tab = tabOf(viewKey);
  if (tab === null) return;
  if (Object.keys(next).length > 0) tabMarkNames.set(tab, next);
  else tabMarkNames.delete(tab);
  writeMarkNames();
}

/** The tab a view is of: its key starts with the tab's number. */
const tabOf = (key: string) => (key === "" ? null : Number.parseInt(key, 10));

/** Sets the marks of the tab on show. */
function putMarks(next: TabMarks) {
  setMarks(next);
  const tab = tabOf(viewKey);
  if (tab === null) return;
  if (next.size > 0) tabMarks.set(tab, next);
  else tabMarks.delete(tab);
  writeMarks();
}

/** The marks of a tab, which need not be the one on show. */
const marksOf = (tab: number): TabMarks =>
  tab === tabOf(viewKey) ? marks() : (tabMarks.get(tab) ?? new Map<number, Marks>());

/** Gives files of a tab the marks given for them, in place of those they have. */
function remark(tab: number, given: [number, Marks][]) {
  const next = new Map(marksOf(tab));
  for (const [id, now] of given) {
    if (now.length > 0) next.set(id, now);
    else next.delete(id);
  }
  if (tab === tabOf(viewKey)) return putMarks(next);
  if (next.size > 0) tabMarks.set(tab, next);
  else tabMarks.delete(tab);
  writeMarks();
}

/**
 * Sets the marks of the tab on show, as something that can be undone:
 * each file whose marks change gets back those it had. `name` says what
 * was done, given how many files it changed.
 */
function changeMarks(next: TabMarks, name: (count: number) => string) {
  const was = marks();
  const before: [number, Marks][] = [];
  const after: [number, Marks][] = [];
  for (const id of new Set([...was.keys(), ...next.keys()])) {
    const had = was.get(id) ?? [];
    const now = next.get(id) ?? [];
    if (had.join() === now.join()) continue;
    before.push([id, had]);
    after.push([id, now]);
  }
  if (after.length === 0) return;
  putMarks(next);
  const tab = tabOf(viewKey);
  record(tab, {
    name: name(after.length),
    undo: () => remark(tab!, before),
    redo: () => remark(tab!, after),
  });
}
/**
 * A query as it is saved with a tab's view: marked, by characters that
 * cannot be typed, when the view was calculated with the trash on show or
 * with sets listed once, so that a view calculated another way is not
 * taken for this one.
 */
const savedAs = (query: string, trashed = search.trashed, collapsed = search.collapsed) =>
  `${query}${trashed ? "\u0002" : ""}${collapsed ? "\u0003" : ""}`;

// Bumped when a new search is shown (the grid scrolls back to the top) and
// when library data changes (dependent views reload).
const [searchCount, setSearchCount] = createSignal(0);
const [dataVersion, setDataVersion] = createSignal(0);

/** How far down the grid is to be scrolled, once it is laid out, until it has. */
const [scrollTo, setScrollTo] = createSignal<number | null>(null);
/** How far down the grid is scrolled now, as it last said. */
let scrolled = 0;

/** The grid says how far down it is scrolled, to be put back there later. */
export function noteScroll(top: number) {
  scrolled = top;
}

/** The result the grid is to bring into view and point out, until it has. */
const [sought, setSought] = createSignal<number | null>(null);

/**
 * The result the grid is to scroll just far enough to show, until it has:
 * the one the arrow keys have moved the selection to.
 */
const [revealed, setRevealed] = createSignal<number | null>(null);

export { search, selected, marks, markNames, searchCount, dataVersion, scrollTo, setScrollTo, sought, setSought, revealed, setRevealed };

// Responses from an older generation are dropped.
let generation = 0;
/** Counts calculations of the view; a reload in between does not void one. */
let calculation = 0;
let seed = 0;
let requested = new Set<number>();
/**
 * The view: every result ID, in order, as found when the search was last
 * calculated. It only changes when the user asks: by refreshing, by
 * dragging results into another order, or by taking some out. Edits,
 * trashing included, change how a result looks but not whether it is
 * listed. It is saved with its tab, so reloading the page keeps it too.
 */
let ids: number[] = [];
/** Settles when the view has been calculated. */
let calculated: Promise<void> = Promise.resolve();
let viewKey = "";
/** The tab the view belongs to, and is saved with. */
let viewTab: number | null = null;
/**
 * The views seen while the page is open, so that coming back to a tab, or
 * out of a set, shows what it showed before without asking the
 * server again: on the page it was on, scrolled as far, with the same
 * selection.
 */
const views = new Map<string, { ids: number[]; custom: boolean }>();
/**
 * The query each tab's saved view is of, as it is saved, as far as it is
 * known: a tab saves one view, and one not on show is saved over it only
 * if it is that one.
 */
const savedQueries = new Map<number, string>();

/**
 * A result taken out of a view: where in the view it was, and when it was
 * taken out, which is the same for all that went together.
 */
type Removed = { id: number; index: number; at: number };
/**
 * What has been taken out of the view on show since it was last
 * calculated, in the order it went: it can be put back from there.
 */
const [removed, setRemoved] = createSignal<readonly Removed[]>([]);
export { removed };

// Remembered per browser, as the views are, so that what was taken out
// can still be put back after a reload.
const REMOVED_KEY = "opalarchive.removed";
/** Views it is remembered for at most; the ones taken from longest ago go first. */
const REMOVED_MOST = 200;
/** What has been taken out of each view that has had anything taken out. */
const removedFrom = new Map<string, readonly Removed[]>(readRemoved());

function readRemoved(): [string, Removed[]][] {
  try {
    return JSON.parse(localStorage.getItem(REMOVED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeRemoved() {
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify([...removedFrom].slice(-REMOVED_MOST)));
  } catch {
    // Storage unavailable or full; it just won't survive a reload.
  }
}

/** Sets what has been taken out of the view on show. */
function putRemoved(next: readonly Removed[]) {
  if (next.length === 0 && removed().length === 0) return;
  setRemoved(next);
  if (viewKey === "") return;
  // Put last: it is the one taken from most recently.
  removedFrom.delete(viewKey);
  if (next.length > 0) removedFrom.set(viewKey, next);
  writeRemoved();
}

/** How a view was left: where it was, and what was selected in it. */
type Left = {
  page: number;
  scroll: number;
  selected: ReadonlySet<number>;
  anchor: number | null;
};
/** A view as it is stored. */
type StoredLeft = {
  page: number;
  scroll: number;
  selected: number[];
  /** Marks were once kept with each view; they are taken up as their tab's. */
  marks?: StoredMarks;
  anchor: number | null;
};

// How each view was left is remembered per browser, like the active tab,
// so that reloading the page brings every view back to where it was.
const LEFT_KEY = "opalarchive.views";
/** Views remembered at most; the ones left longest ago go first. */
const LEFT_MOST = 200;
/** A selection bigger than this is not worth keeping across a reload. */
const SELECTED_MOST = 20000;

const lefts = new Map<string, Left>(readLefts());

function readLefts(): [string, Left][] {
  try {
    const stored = JSON.parse(localStorage.getItem(LEFT_KEY) ?? "[]") as [string, StoredLeft][];
    let moved = false;
    const read = stored.map(([key, { marks: given, ...left }]): [string, Left] => {
      const tab = tabOf(key);
      if (given?.length && tab !== null) {
        tabMarks.set(tab, new Map([...(tabMarks.get(tab) ?? []), ...storedMarks(given)]));
        moved = true;
      }
      return [key, { ...left, selected: new Set(left.selected) }];
    });
    if (moved) writeMarks();
    return read;
  } catch {
    return [];
  }
}

function writeLefts() {
  const stored = [...lefts].map(([key, left]) => [
    key,
    {
      ...left,
      selected: left.selected.size > SELECTED_MOST ? [] : [...left.selected],
    },
  ]);
  try {
    localStorage.setItem(LEFT_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable or full; the views just won't survive a reload.
  }
}

/** Notes how the view on show is being left. */
function noteLeft() {
  if (viewKey === "") return;
  // Put last: it is the one left most recently.
  lefts.delete(viewKey);
  lefts.set(viewKey, {
    page: search.page,
    scroll: scrolled,
    selected: selected(),
    anchor,
  });
  for (const key of lefts.keys()) {
    if (lefts.size <= LEFT_MOST) break;
    lefts.delete(key);
  }
  writeLefts();
}
let saving = 0;
/** Items already fetched, so a reorder can redraw without asking again. */
const known = new Map<number, Item>();
/** Index the next shift-click extends from. */
let anchor: number | null = null;

export const itemAt = (index: number): Item | undefined =>
  pages[Math.floor(index / pageSize())]?.[index % pageSize()];

/** Keeps the view as it now is, here and, shortly, with its tab. */
function remember() {
  views.set(viewKey, { ids, custom: search.custom });
  const tab = viewTab;
  if (tab === null) return;
  const view = { query: savedAs(search.query), ids, custom: search.custom };
  savedQueries.set(tab, view.query);
  // A drag or a run of removals saves once, when it settles.
  clearTimeout(saving);
  saving = window.setTimeout(() => {
    saving = 0;
    api.saveTabView(tab, view).catch(() => {});
  }, 300);
}

/** A page of the view. Its items are asked for by ID, trashed or not. */
async function fetchPage(page: number): Promise<Item[]> {
  for (;;) {
    const slice = ids.slice(page * pageSize(), (page + 1) * pageSize());
    if (slice.some((id) => !known.has(id))) {
      const result = await api.search(`id=${slice.join(",")}`, 0, pageSize(), 0, null, true);
      for (const item of result.items) known.set(item.id, item);
    }
    // What was deleted for good is the one thing that has to leave.
    const gone = new Set(slice.filter((id) => !known.has(id)));
    if (gone.size === 0) return slice.map((id) => known.get(id)!);
    ids = ids.filter((id) => !gone.has(id));
    keepListed();
    remember();
  }
}

function loadPage(page: number) {
  if (requested.has(page)) return;
  requested.add(page);
  const current = generation;
  calculated
    .then(() => (current === generation ? fetchPage(page) : []))
    .then((items) => {
      if (current !== generation) return;
      setPages(page, items);
      setSearch({ total: ids.length, ready: true, error: null });
      // Results may have gone away under the page on show.
      if (search.page > lastPage()) setSearch("page", lastPage());
    })
    .catch((err) => {
      if (current !== generation) return;
      setPages(reconcile({}));
      setSearch({ total: 0, ready: true, error: { message: err.message, position: err.position, line: err.line } });
    });
}

export const pageCount = () => Math.max(1, Math.ceil(search.total / pageSize()));
const lastPage = () => pageCount() - 1;

export function goToPage(page: number) {
  setSearch("page", Math.max(0, Math.min(lastPage(), page)));
}

/**
 * What the view no longer lists is no longer selected. It keeps its mark:
 * another view of the tab may list it.
 */
function keepListed() {
  const listed = new Set(ids);
  if ([...selected()].some((id) => !listed.has(id))) {
    setSelected(new Set([...selected()].filter((id) => listed.has(id))));
  }
  setListing((n) => n + 1);
}

/** Makes sure the pages covering these result indices are loaded. */
export function ensureRange(first: number, last: number) {
  for (let page = Math.floor(first / pageSize()); page <= Math.floor(last / pageSize()); page++) {
    loadPage(page);
  }
}

/**
 * Deals the results into pages again, after the size of a page changed
 * from `before`: what headed the page on show is still on the one shown.
 */
export function repage(before: number) {
  const first = search.page * before;
  generation += 1;
  requested = new Set();
  setPages(reconcile({}));
  setSearch("page", Math.floor(first / pageSize()));
  if (!search.idle) loadPage(search.page);
}

/** Drops what is loaded and loads the page on show again. */
function reload() {
  generation += 1;
  requested = new Set();
  setDataVersion((n) => n + 1);
  loadPage(search.page);
}

/**
 * Runs the query and makes its results the view. A view dragged into an
 * order of its own keeps that order: results that are gone drop out and
 * new ones go at the end.
 */
function calculate() {
  const current = (calculation += 1);
  // What the tab was left with is asked for only when the view is opened;
  // a refresh always runs the search.
  const within = search.within;
  const found =
    within && "mark" in within
      ? foundMarked(within)
      : within && "selection" in within
        ? foundAmong(within.selection)
        : api.searchIds(search.query, seed, search.scope, within, search.trashed, search.collapsed);
  calculated = found.then((found) => {
    if (current !== calculation) return;
    if (search.custom) {
      const fresh = new Set(found);
      const kept = ids.filter((id) => fresh.delete(id));
      ids = [...kept, ...found.filter((id) => fresh.has(id))];
    } else {
      ids = found;
    }
    // Whatever was taken out is back, if the search still finds it.
    putRemoved([]);
    remember();
    keepListed();
  });
  // Failures are reported by the page load that waits on this.
  calculated.catch(() => {});
}

/**
 * Shows a search, discarding results and selection. `key` names the view:
 * one already seen comes back as it was left, a new one is calculated.
 */
export function runSearch(
  query: string,
  scope: number | null = null,
  key = "",
  tab: number | null = null,
  /** A set or group of variants to show, in place of what `scope` holds. */
  within: Within | null = null,
  /** Whether to wait to be asked, if the tab has no view of this query yet. */
  wait = false,
  /**
   * Whether to calculate a view already seen again. It comes back where it
   * was left, and in the order it was dragged into, but with what it holds
   * now.
   */
  fresh = false,
  /** Whether to list what is in the trash along with the rest. */
  trashed = false,
  /** Whether to list a set once, as one result. */
  collapsed = false,
) {
  // The view being left is saved now, not after its delay.
  flushSave();
  // Coming back to it, it is as it was left.
  noteLeft();
  generation += 1;
  seed = Math.floor(Math.random() * 2 ** 31);
  requested = new Set();
  /** Whether the tab on show goes back to a query it has shown before. */
  const back = tab !== null && viewTab === tab;
  viewKey = key;
  setRemoved(removedFrom.get(key) ?? []);
  viewTab = tab;
  known.clear();
  const seen = views.get(key);
  const left = lefts.get(key);
  anchor = left?.anchor ?? null;
  scrolled = 0;
  ids = seen?.ids ?? [];
  setPages(reconcile({}));
  setSearch({
    query,
    scope,
    within,
    trashed,
    collapsed,
    page: left?.page ?? 0,
    custom: seen?.custom ?? false,
    total: 0,
    ready: false,
    idle: false,
    error: null,
  });
  setSelected(left?.selected ?? new Set<number>());
  setLastSelected(null);
  setMarks(tabMarks.get(tabOf(key) ?? -1) ?? new Map<number, Marks>());
  setMarkNames(tabMarkNames.get(tabOf(key) ?? -1) ?? {});
  setListing((n) => n + 1);
  setSearchCount((n) => n + 1);
  // After the count: the grid goes to the top first, then to where it was.
  setScrollTo(left?.scroll || null);
  if (seen && !fresh) {
    // Voids a calculation still running for the view just left.
    calculation += 1;
    calculated = Promise.resolve();
    // It is the tab's view again, in place of the one saved with it.
    if (back) remember();
  } else if (tab === null) {
    calculate();
  } else {
    // A view saved with the tab, of this same query, is taken up as it
    // was left; otherwise the search is run.
    const current = (calculation += 1);
    calculated = api
      .getTabView(tab)
      .catch(() => null)
      .then((saved) => {
        if (current !== calculation) return;
        if (saved) savedQueries.set(tab, saved.query);
        if (saved && saved.query === savedAs(query, trashed, collapsed)) {
          ids = saved.ids;
          setSearch("custom", saved.custom);
          views.set(viewKey, { ids, custom: saved.custom });
        } else if (wait) {
          // Nothing is listed, and nothing saved, until it is asked for.
          setSearch("idle", true);
        } else {
          calculate();
          return calculated;
        }
      });
    calculated.catch(() => {});
  }
  {
    // The view may have changed since it was left.
    const current = generation;
    calculated
      .then(() => {
        if (current === generation) keepListed();
      })
      .catch(() => {});
  }
  loadPage(search.page);
}

/**
 * Drops the views kept for a tab that has been closed. The server gives a
 * later tab the same number, and it must not be shown the closed one's.
 */
export function forgetViews(tab: number) {
  savedQueries.delete(tab);
  for (const key of [...views.keys(), ...lefts.keys(), ...removedFrom.keys()]) {
    if (key.startsWith(`${tab}:`)) {
      views.delete(key);
      lefts.delete(key);
      removedFrom.delete(key);
    }
  }
  writeRemoved();
  // The tab closed may be the one on show: nothing is noted of it later.
  if (viewKey.startsWith(`${tab}:`)) viewKey = "";
  writeLefts();
  if (tabMarks.delete(tab)) writeMarks();
  if (tabMarkNames.delete(tab)) writeMarkNames();
  if (viewTab === tab) {
    // Nothing more is saved for it either.
    clearTimeout(saving);
    saving = 0;
    viewTab = null;
  }
}

/** Saves a view that is waiting to be saved, at once. */
function flushSave() {
  if (!saving) return;
  clearTimeout(saving);
  saving = 0;
  if (viewTab !== null) {
    const view = { query: savedAs(search.query), ids, custom: search.custom };
    api.saveTabView(viewTab, view).catch(() => {});
  }
}
// Leaving the page should not lose the last change either, nor where the
// view on show was.
window.addEventListener("pagehide", () => {
  flushSave();
  noteLeft();
});

/** Calculates the current search again. */
export function refresh() {
  generation += 1;
  seed = Math.floor(Math.random() * 2 ** 31);
  requested = new Set();
  anchor = null;
  known.clear();
  setSearch("idle", false);
  calculate();
  setDataVersion((n) => n + 1);
  loadPage(search.page);
}

/**
 * Call after anything changes library data. What is listed stays as it
 * is; the results are fetched again so that they show the change.
 */
export function changed() {
  known.clear();
  reload();
  refreshStats();
}

/**
 * Call after files are deleted for good. They leave the view at once,
 * ahead of the results being fetched again, so that nothing on show asks
 * after a file that is no longer there.
 */
export function deleted(gone: number[]) {
  drop(gone);
  // Nor can they be put back in a view they were taken out of.
  const lost = new Set(gone);
  for (const [key, list] of removedFrom) {
    const kept = list.filter((was) => !lost.has(was.id));
    if (kept.length === list.length) continue;
    if (kept.length > 0) removedFrom.set(key, kept);
    else removedFrom.delete(key);
  }
  setRemoved(removedFrom.get(viewKey) ?? []);
  writeRemoved();
  // No view of any tab lists them any more: their marks go with them.
  const going = new Set(gone);
  for (const [tab, given] of tabMarks) {
    const kept = new Map([...given].filter(([id]) => !going.has(id)));
    if (kept.size === given.size) continue;
    if (kept.size > 0) tabMarks.set(tab, kept);
    else tabMarks.delete(tab);
    if (tab === tabOf(viewKey)) setMarks(kept);
  }
  writeMarks();
  changed();
}

/** Takes results out of the view, and out of what of it is on show. */
function drop(gone: number[]) {
  const going = new Set(gone);
  ids = ids.filter((id) => !going.has(id));
  for (const page of Object.keys(pages)) {
    setPages(Number(page), (items) => items.filter((item) => !going.has(item.id)));
  }
  setSearch("total", ids.length);
  anchor = null;
  keepListed();
  remember();
}

/**
 * Call after files are uploaded into an upload tab, or anything else is
 * put into what a tab holds from that tab: unlike other changes, these
 * are added to its view.
 */
export function addedTo(tab: number) {
  for (const key of [...views.keys()]) {
    if (key.startsWith(`${tab}:`) && key !== viewKey) views.delete(key);
  }
  if (viewKey.startsWith(`${tab}:`)) {
    refresh();
  } else {
    // The view saved with that tab lacks what was just added: it is
    // replaced by one of no query, so opening the tab runs its search.
    savedQueries.set(tab, "\u0000");
    api.saveTabView(tab, { query: "\u0000", ids: [], custom: false }).catch(() => {});
  }
  refreshStats();
}

/** Every result ID, in the order on show. */
export const resultIds = (): Promise<number[]> => calculated.then(() => ids);

/**
 * Goes to the first of the results that is selected: turns to its page,
 * and has the grid scroll to it and point it out. Says whether there was
 * one.
 */
export async function showFirstSelected(): Promise<boolean> {
  const chosen = selected();
  const index = (await resultIds()).findIndex((id) => chosen.has(id));
  if (index < 0) return false;
  showResult(index);
  return true;
}

/** Goes to a result: turns to its page, scrolls to it and points it out. */
export function showResult(index: number) {
  goToPage(Math.floor(index / pageSize()));
  setSought(index);
}

/**
 * Moves results to sit before the result at `before` (an index into all
 * results, or their number to move to the end). From then on the view
 * keeps this order instead of the query's, until `resetOrder`.
 */
export async function moveItems(moved: number[], before: number) {
  const current = await resultIds();
  const moving = new Set(moved);
  // The moved items land before the first unmoved one at or after the drop.
  let target = before;
  while (target < current.length && moving.has(current[target])) target += 1;
  const rest = current.filter((id) => !moving.has(id));
  const at = target >= current.length ? rest.length : rest.indexOf(current[target]);
  const next = [
    ...rest.slice(0, at),
    ...current.filter((id) => moving.has(id)),
    ...rest.slice(at),
  ];
  if (next.every((id, index) => id === current[index])) return;

  ids = next;
  anchor = null;
  setSearch("custom", true);
  remember();
  reload();
}

/**
 * A view, as what it is to be found and saved by when it may no longer be
 * the one on show: undoing can put back what was taken out of a view of
 * the tab other than the one it is in now.
 */
type ViewRef = { key: string; tab: number | null; query: string };

const viewOnShow = (): ViewRef => ({ key: viewKey, tab: viewTab, query: savedAs(search.query) });

/**
 * The view on show, or one seen before as it was kept: what it lists, and
 * what has been taken out of it. Nothing, for one no longer kept, which
 * is calculated afresh when it is shown again.
 */
async function viewOf(view: ViewRef) {
  if (view.key === viewKey) await resultIds();
  // It may have stopped being on show meanwhile.
  if (view.key === viewKey) return { ids, custom: search.custom, removed: removed(), shown: true };
  const seen = views.get(view.key);
  return seen && { ...seen, removed: removedFrom.get(view.key) ?? [], shown: false };
}

/** Keeps a view that is not on show as it now is, here and with its tab. */
function keepAside(view: ViewRef, listed: number[], custom: boolean, taken: readonly Removed[]) {
  views.set(view.key, { ids: listed, custom });
  removedFrom.delete(view.key);
  if (taken.length > 0) removedFrom.set(view.key, taken);
  writeRemoved();
  // Otherwise it is saved when it is on show again.
  if (view.tab !== null && savedQueries.get(view.tab) === view.query) {
    api.saveTabView(view.tab, { query: view.query, ids: listed, custom }).catch(() => {});
  }
}

/** Takes results out of a view. Resolves to the IDs of those it listed. */
async function hideIn(view: ViewRef, taken: number[]): Promise<number[]> {
  const was = await viewOf(view);
  if (!was) return [];
  const going = new Set(taken);
  const at = Date.now();
  const gone = was.ids.flatMap((id, index) => (going.has(id) ? [{ id, index, at }] : []));
  if (gone.length === 0) return [];
  if (was.shown) {
    drop(taken);
    putRemoved([...removed(), ...gone]);
    reload();
  } else {
    keepAside(view, was.ids.filter((id) => !going.has(id)), was.custom, [...was.removed, ...gone]);
  }
  return gone.map((was) => was.id);
}

/**
 * Puts back in a view what was taken out of it, where it was: as near to
 * there as can be, when the view has changed since. Resolves to the IDs of
 * those put back.
 */
async function unhideIn(view: ViewRef, back: number[]): Promise<number[]> {
  const was = await viewOf(view);
  if (!was) return [];
  const wanted = new Set(back);
  const listed = new Set(was.ids);
  // Those that were first in the view go in first, so that what went
  // together comes back as it was.
  const returning = was.removed
    .filter((had) => wanted.has(had.id) && !listed.has(had.id))
    .sort((a, b) => a.index - b.index);
  const rest = was.removed.filter((had) => !wanted.has(had.id));
  if (returning.length === 0 && rest.length === was.removed.length) return [];
  const next = [...was.ids];
  for (const had of returning) next.splice(Math.min(had.index, next.length), 0, had.id);
  if (was.shown) {
    ids = next;
    anchor = null;
    putRemoved(rest);
    remember();
    keepListed();
    reload();
  } else {
    keepAside(view, next, was.custom, rest);
  }
  return returning.map((had) => had.id);
}

/**
 * Takes results out of the view, and out of the selection. Nothing happens
 * to the entities themselves: calculating the search again brings them
 * back. It can be undone.
 */
export async function removeFromView(taken: number[]) {
  const view = viewOnShow();
  const gone = await hideIn(view, taken);
  if (gone.length === 0) return;
  record(tabOf(view.key), {
    name: `removing ${plural(gone.length, "item")} from the view`,
    undo: () => unhideIn(view, gone),
    redo: () => hideIn(view, gone),
  });
}

/**
 * Puts back in the view what was taken out of it, where it was: as near
 * to there as can be, when the view has changed since. It can be undone.
 */
export async function restoreToView(back: number[]) {
  const view = viewOnShow();
  const returned = await unhideIn(view, back);
  if (returned.length === 0) return;
  record(tabOf(view.key), {
    name: `putting ${plural(returned.length, "item")} back in the view`,
    undo: () => hideIn(view, returned),
    redo: () => unhideIn(view, returned),
  });
}

/**
 * What has been taken out of the view on show, to be shown: what went
 * last first, and what went together in the order it was listed. What
 * has been deleted for good since is left out.
 */
export async function removedItems(): Promise<Item[]> {
  const list = [...removed()].sort((a, b) => b.at - a.at || a.index - b.index);
  const unknown = list.map((was) => was.id).filter((id) => !known.has(id));
  for (let from = 0; from < unknown.length; from += 500) {
    const some = unknown.slice(from, from + 500);
    const result = await api.search(`id=${some.join(",")}`, 0, some.length, 0, null, true);
    for (const item of result.items) known.set(item.id, item);
  }
  return list.flatMap((was) => known.get(was.id) ?? []);
}

/** Goes back to the order the query gives. */
/** Puts every result of the view in an order drawn by lot, as one dragged into. */
export async function shuffleOrder() {
  const next = [...(await resultIds())];
  if (next.length < 2) return;
  for (let last = next.length - 1; last > 0; last -= 1) {
    const other = Math.floor(Math.random() * (last + 1));
    [next[last], next[other]] = [next[other], next[last]];
  }
  ids = next;
  anchor = null;
  setSearch("custom", true);
  remember();
  reload();
}

export function resetOrder() {
  if (!search.custom) return;
  setSearch("custom", false);
  refresh();
}

export async function clickSelect(
  index: number,
  id: number,
  modifiers: { shift: boolean; toggle: boolean },
) {
  if (modifiers.shift && anchor !== null) {
    // The range may span pages that were never loaded.
    const ids = await resultIds();
    const range = ids.slice(Math.min(anchor, index), Math.max(anchor, index) + 1);
    setLastSelected(id);
    setSelected(new Set(modifiers.toggle ? [...selected(), ...range] : range));
    return;
  }
  anchor = index;
  setLastSelected(id);
  if (modifiers.toggle) {
    const next = new Set(selected());
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  } else {
    setSelected(new Set([id]));
  }
}

/**
 * Moves the selection one tile over, as an arrow key does, in a grid of
 * `columns` to the row: from the result selected last to the one beside
 * it, above it or below it, which is then the one selected; or with
 * `extend`, selected along with everything between it and where the run
 * began. Past the edge of a page it goes on to the next one, or back to
 * the one before. With nothing selected, it starts at the first result of
 * the page on show.
 */
export async function moveSelection(
  direction: "left" | "right" | "up" | "down",
  columns: number,
  extend = false,
) {
  const all = await resultIds();
  if (all.length === 0) return;
  const size = pageSize();
  const last = previewed();
  const from = last === null ? -1 : all.indexOf(last);
  let target: number;
  if (from < 0) {
    target = Math.min(search.page * size, all.length - 1);
  } else if (direction === "left" || direction === "right") {
    target = Math.max(0, Math.min(all.length - 1, from + (direction === "left" ? -1 : 1)));
  } else {
    // Rows start again on each page, whose last one need not be full.
    const page = Math.floor(from / size);
    const start = page * size;
    const place = from - start;
    const column = place % columns;
    /** How many results a page has. */
    const held = (page: number) => Math.min(size, all.length - page * size);
    if (direction === "down") {
      const lastPlace = held(page) - 1;
      if (place + columns <= lastPlace) target = from + columns;
      else if (Math.floor(lastPlace / columns) > Math.floor(place / columns)) target = start + lastPlace;
      else if (start + size < all.length) target = start + size + Math.min(column, held(page + 1) - 1);
      else target = from;
    } else if (place - columns >= 0) {
      target = from - columns;
    } else if (page > 0) {
      // The same column of the row that ends the page before, or of the
      // one over it if that row stops short.
      const lastPlace = held(page - 1) - 1;
      const under = Math.floor(lastPlace / columns) * columns + column;
      const there = under <= lastPlace ? under : under - columns;
      target = start - size + (there >= 0 ? there : lastPlace);
    } else {
      target = from;
    }
  }
  if (target === from) return;
  // A run with no start yet, as after selecting all, starts where it was.
  if (extend && anchor === null && from >= 0) anchor = from;
  await clickSelect(target, all[target], { shift: extend, toggle: false });
  goToPage(Math.floor(target / size));
  setRevealed(target);
}

/** Selects every result, on every page. */
export async function selectAll() {
  setSelected(new Set(await resultIds()));
}

/**
 * Selects what the view lists that a query finds, or with `add` has it
 * join what is selected. The view is not searched again: the query is run
 * on the whole library, trash and all, and what it finds that is listed
 * here is what is selected. Says how many that is; with none, the
 * selection is left as it was.
 */
export async function selectByQuery(query: string, add = false): Promise<number> {
  const [found, listed] = await Promise.all([
    api.searchIds(query, 0, null, null, true),
    resultIds(),
  ]);
  const matching = new Set(found);
  const chosen = listed.filter((id) => matching.has(id));
  if (chosen.length === 0) return 0;
  anchor = null;
  setSelected(new Set(add ? [...selected(), ...chosen] : chosen));
  return chosen.length;
}

/** Selects every result that is not selected, in place of those that are. */
export async function invertSelection() {
  const all = await resultIds();
  const had = selected();
  anchor = null;
  setSelected(new Set(all.filter((id) => !had.has(id))));
}

export function clearSelection() {
  anchor = null;
  setSelected(new Set<number>());
}

/**
 * The marks of what the view on show lists. What is marked elsewhere in
 * the tab, and not listed here, is neither counted nor selected from here.
 */
function listedMarks(): [number, Marks][] {
  listing();
  const given = marks();
  if (given.size === 0) return [];
  const listed = new Set(ids);
  return [...given].filter(([id]) => listed.has(id));
}

/** How many results carry each mark; index 0 is not used. */
export function markCounts(): number[] {
  const counts = Array<number>(MARKS + 1).fill(0);
  for (const [, given] of listedMarks()) for (const mark of given) counts[mark] += 1;
  return counts;
}

/**
 * What the view on show lists that has a mark, in the order it lists it.
 * What has the mark elsewhere in the tab is no part of it.
 */
export async function listedMarked(mark: number): Promise<number[]> {
  const given = marks();
  return (await resultIds()).filter((id) => given.get(id)?.includes(mark));
}

/**
 * What a view gone into a mark lists: the files that had the mark in the
 * view it was gone into from, and have it still, in that view's order; or
 * with a query, those of them it finds, in its order.
 */
async function foundMarked(within: { mark: number; ids: number[] }): Promise<number[]> {
  const given = marks();
  return foundAmong(within.ids.filter((id) => given.get(id)?.includes(within.mark)));
}

/**
 * What a view kept to these files lists: all of them, as they are given;
 * or with a query, those of them it finds, in its order. A view gone into
 * what was selected is one.
 */
async function foundAmong(held: number[]): Promise<number[]> {
  if (search.query.trim() === "") return held;
  const kept = new Set(held);
  const all = await api.searchIds(search.query, seed, null, null, search.trashed, false);
  return all.filter((id) => kept.has(id));
}

/** What is selected, in the order the view lists it: what going into it shows. */
export async function listedSelected(): Promise<number[]> {
  const chosen = selected();
  return (await resultIds()).filter((id) => chosen.has(id));
}

/**
 * Gives a mark to these, beside any others they have, or with `given`
 * false takes it off them.
 */
export function setMark(marked: number[], mark: number, given: boolean) {
  const next = new Map(marks());
  for (const id of marked) {
    const rest = (next.get(id) ?? []).filter((had) => had !== mark);
    const now = given ? [...rest, mark].sort((a, b) => a - b) : rest;
    if (now.length > 0) next.set(id, now);
    else next.delete(id);
  }
  changeMarks(next, (count) =>
    given ? `giving ${plural(count, "item")} mark ${mark}` : `taking mark ${mark} off ${plural(count, "item")}`,
  );
}

/** Takes every mark off these. */
export function unmark(marked: number[]) {
  const next = new Map(marks());
  for (const id of marked) next.delete(id);
  changeMarks(next, (count) => `taking every mark off ${plural(count, "item")}`);
}

/** Takes one mark off everything in the tab that has it. */
export function clearMark(mark: number) {
  const next = new Map<number, Marks>();
  for (const [id, given] of marks()) {
    const rest = given.filter((had) => had !== mark);
    if (rest.length > 0) next.set(id, rest);
  }
  changeMarks(next, (count) => `taking mark ${mark} off ${plural(count, "item")}`);
}

/**
 * Selects every result with a mark, on every page. With `toggle`, as with
 * Ctrl on a tile, they are added to what is selected, or taken out of it
 * if every one of them is selected already.
 */
export function selectMarked(mark: number, toggle = false) {
  anchor = null;
  const marked = listedMarks()
    .filter(([, given]) => given.includes(mark))
    .map(([id]) => id);
  if (!toggle) return setSelected(new Set(marked));
  const next = new Set(selected());
  const all = marked.every((id) => next.has(id));
  for (const id of marked) {
    if (all) next.delete(id);
    else next.add(id);
  }
  setSelected(next);
}
