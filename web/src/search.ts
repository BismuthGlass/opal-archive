import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import * as api from "./api";
import type { Item } from "./api";
import { refreshStats } from "./stats";

/** Results are shown, and fetched, in pages of this many. */
export const PAGE = 200;

type SearchError = { message: string; position?: number; line?: number };

const [search, setSearch] = createStore({
  query: "",
  /** Upload tab the results are limited to, if any. */
  scope: null as number | null,
  /** The set or group of variants the results are limited to instead, if any. */
  within: null as api.Within | null,
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
export const MARKS = 5;
/**
 * What is marked in the tab on show, and with which mark. Marks are the
 * tab's own, and the same in every view of it: what is marked in a search
 * is marked in the set it is in, gone into from there, and the other way
 * round. Nothing in the library is changed by them.
 */
const [marks, setMarks] = createSignal<ReadonlyMap<number, number>>(new Map());
/** Bumped when what the view lists changes: what of the marked is in it does too. */
const [listing, setListing] = createSignal(0);

// Marks are remembered per browser, like where each view was left.
const MARKS_KEY = "opalarchive.marks";
/** The marks of each tab that has any. */
const tabMarks = new Map<number, ReadonlyMap<number, number>>(readMarks());

function readMarks(): [number, Map<number, number>][] {
  try {
    const stored = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "[]");
    return (stored as [number, [number, number][]][]).map(([tab, given]) => [tab, new Map(given)]);
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

/** The tab a view is of: its key starts with the tab's number. */
const tabOf = (key: string) => (key === "" ? null : Number.parseInt(key, 10));

/** Sets the marks of the tab on show. */
function putMarks(next: ReadonlyMap<number, number>) {
  setMarks(next);
  const tab = tabOf(viewKey);
  if (tab === null) return;
  if (next.size > 0) tabMarks.set(tab, next);
  else tabMarks.delete(tab);
  writeMarks();
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

export { search, selected, marks, searchCount, dataVersion, scrollTo, setScrollTo, sought, setSought };

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
  marks?: [number, number][];
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
        tabMarks.set(tab, new Map([...(tabMarks.get(tab) ?? []), ...given]));
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
  pages[Math.floor(index / PAGE)]?.[index % PAGE];

/** Keeps the view as it now is, here and, shortly, with its tab. */
function remember() {
  views.set(viewKey, { ids, custom: search.custom });
  const tab = viewTab;
  if (tab === null) return;
  const view = { query: savedAs(search.query), ids, custom: search.custom };
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
    const slice = ids.slice(page * PAGE, (page + 1) * PAGE);
    if (slice.some((id) => !known.has(id))) {
      const result = await api.search(`id=${slice.join(",")}`, 0, PAGE, 0, null, true);
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

export const pageCount = () => Math.max(1, Math.ceil(search.total / PAGE));
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
  for (let page = Math.floor(first / PAGE); page <= Math.floor(last / PAGE); page++) {
    loadPage(page);
  }
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
  const found = api.searchIds(
    search.query,
    seed,
    search.scope,
    search.within,
    search.trashed,
    search.collapsed,
  );
  calculated = found.then((found) => {
    if (current !== calculation) return;
    if (search.custom) {
      const fresh = new Set(found);
      const kept = ids.filter((id) => fresh.delete(id));
      ids = [...kept, ...found.filter((id) => fresh.has(id))];
    } else {
      ids = found;
    }
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
  within: api.Within | null = null,
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
  setMarks(tabMarks.get(tabOf(key) ?? -1) ?? new Map<number, number>());
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
  for (const key of [...views.keys(), ...lefts.keys()]) {
    if (key.startsWith(`${tab}:`)) {
      views.delete(key);
      lefts.delete(key);
    }
  }
  // The tab closed may be the one on show: nothing is noted of it later.
  if (viewKey.startsWith(`${tab}:`)) viewKey = "";
  writeLefts();
  if (tabMarks.delete(tab)) writeMarks();
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
  goToPage(Math.floor(index / PAGE));
  setSought(index);
  return true;
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
 * Takes results out of the view, and out of the selection. Nothing happens
 * to the entities themselves: calculating the search again brings them
 * back.
 */
export async function removeFromView(removed: number[]) {
  await resultIds();
  drop(removed);
  reload();
}

/** Goes back to the order the query gives. */
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

/** Selects every result, on every page. */
export async function selectAll() {
  setSelected(new Set(await resultIds()));
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
function listedMarks(): [number, number][] {
  listing();
  const given = marks();
  if (given.size === 0) return [];
  const listed = new Set(ids);
  return [...given].filter(([id]) => listed.has(id));
}

/** How many results carry each mark; index 0 is not used. */
export function markCounts(): number[] {
  const counts = Array<number>(MARKS + 1).fill(0);
  for (const [, mark] of listedMarks()) counts[mark] += 1;
  return counts;
}

/**
 * Gives results a mark, in place of any they had. Given to results that
 * all have it already, it is taken off them instead. Returns whether it
 * was put on.
 */
export function toggleMark(marked: number[], mark: number): boolean {
  if (marked.every((id) => marks().get(id) === mark)) {
    unmark(marked);
    return false;
  }
  const next = new Map(marks());
  for (const id of marked) next.set(id, mark);
  putMarks(next);
  return true;
}

/** Takes whatever mark these results have off them. */
export function unmark(marked: number[]) {
  const next = new Map(marks());
  for (const id of marked) next.delete(id);
  putMarks(next);
}

/** Takes a mark off everything in the tab that has it, listed here or not. */
export function clearMark(mark: number) {
  putMarks(new Map([...marks()].filter(([, given]) => given !== mark)));
}

/** Selects every result with a mark, on every page. */
export function selectMarked(mark: number) {
  anchor = null;
  setSelected(new Set(listedMarks().filter(([, given]) => given === mark).map(([id]) => id)));
}
