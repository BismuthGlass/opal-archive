import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import * as api from "./api";
import type { Item } from "./api";
import { refreshStats } from "./stats";

/** Results are shown, and fetched, in pages of this many. */
export const PAGE = 200;

type SearchError = { message: string; position?: number };

const [search, setSearch] = createStore({
  query: "",
  /** Upload tab the results are limited to, if any. */
  scope: null as number | null,
  /** The page of results on show, counted from 0. */
  page: 0,
  /** Whether the results have been dragged into an order of their own. */
  custom: false,
  total: 0,
  /** False until the first page of the current query has arrived. */
  ready: false,
  error: null as SearchError | null,
});
const [pages, setPages] = createStore<Record<number, Item[]>>({});
const [selected, setSelected] = createSignal<ReadonlySet<number>>(new Set());
// Bumped when a new query starts (the grid scrolls back to the top) and
// when library data changes (dependent views reload).
const [searchCount, setSearchCount] = createSignal(0);
const [dataVersion, setDataVersion] = createSignal(0);

export { search, selected, searchCount, dataVersion };

// Responses from an older generation are dropped.
let generation = 0;
let seed = 0;
let requested = new Set<number>();
let allIds: Promise<number[]> | null = null;
/**
 * Every result ID in the order the user dragged them into, if they have.
 * It is kept per view while the page is open, so switching tabs and coming
 * back does not lose it; reloading the page does.
 */
let order: number[] | null = null;
let viewKey = "";
const customOrders = new Map<string, number[]>();
/** Items seen in this view, so a reorder can redraw without asking again. */
const known = new Map<number, Item>();
/** Index the next shift-click extends from. */
let anchor: number | null = null;

export const itemAt = (index: number): Item | undefined =>
  pages[Math.floor(index / PAGE)]?.[index % PAGE];

/** A page of the custom order, which the server is asked for by ID. */
async function loadCustomPage(page: number, ids: number[]): Promise<api.SearchPage> {
  const slice = ids.slice(page * PAGE, (page + 1) * PAGE);
  if (slice.some((id) => !known.has(id))) {
    const result = await api.search(`id=${slice.join(",")}`, 0, PAGE, 0, null, true);
    for (const item of result.items) known.set(item.id, item);
  }
  const items = slice.flatMap((id) => known.get(id) ?? []);
  return { total: ids.length, offset: page * PAGE, items };
}

function loadPage(page: number) {
  if (requested.has(page)) return;
  requested.add(page);
  const current = generation;
  const loading = order
    ? loadCustomPage(page, order)
    : api.search(search.query, page * PAGE, PAGE, seed, search.scope);
  loading
    .then((result) => {
      if (current !== generation) return;
      for (const item of result.items) known.set(item.id, item);
      setPages(page, result.items);
      setSearch({ total: result.total, ready: true, error: null });
      // Results may have gone away under the page on show.
      if (search.page > lastPage()) setSearch("page", lastPage());
    })
    .catch((err) => {
      if (current !== generation) return;
      setPages(reconcile({}));
      setSearch({ total: 0, ready: true, error: { message: err.message, position: err.position } });
    });
}

export const pageCount = () => Math.max(1, Math.ceil(search.total / PAGE));
const lastPage = () => pageCount() - 1;

export function goToPage(page: number) {
  setSearch("page", Math.max(0, Math.min(lastPage(), page)));
}

/** Makes sure the pages covering these result indices are loaded. */
export function ensureRange(first: number, last: number) {
  for (let page = Math.floor(first / PAGE); page <= Math.floor(last / PAGE); page++) {
    loadPage(page);
  }
}

/**
 * Brings a custom order in line with what the query finds now: results
 * that are gone drop out, new ones go at the end.
 */
async function reconcileOrder() {
  const current = generation;
  const ids = await api.searchIds(search.query, seed, search.scope);
  if (current !== generation || !order) return;
  const found = new Set(ids);
  const kept = order.filter((id) => found.delete(id));
  order = [...kept, ...ids.filter((id) => found.has(id))];
  customOrders.set(viewKey, order);
}

/** Loads the first page, of the custom order if the view has one. */
function start() {
  if (!order) return loadPage(0);
  const current = generation;
  reconcileOrder()
    .catch(() => {
      // The query no longer runs; let the plain search report why.
      if (current === generation) dropOrder();
    })
    .then(() => {
      if (current !== generation) return;
      loadPage(0);
      setDataVersion((n) => n + 1);
    });
}

function dropOrder() {
  order = null;
  customOrders.delete(viewKey);
  setSearch("custom", false);
}

/**
 * Starts a new search, discarding results and selection. `key` names the
 * view, which gets back the order its results were last dragged into.
 */
export function runSearch(query: string, scope: number | null = null, key = "") {
  generation += 1;
  seed = Math.floor(Math.random() * 2 ** 31);
  requested = new Set();
  allIds = null;
  anchor = null;
  viewKey = key;
  order = customOrders.get(key) ?? null;
  known.clear();
  setPages(reconcile({}));
  setSearch({
    query,
    scope,
    page: 0,
    custom: order !== null,
    total: 0,
    ready: false,
    error: null,
  });
  setSelected(new Set<number>());
  setSearchCount((n) => n + 1);
  start();
}

/**
 * Call after anything changes library data. Reloads the current results in
 * place: what is on screen stays until its replacement arrives.
 */
export function changed() {
  generation += 1;
  requested = new Set();
  allIds = null;
  known.clear();
  setDataVersion((n) => n + 1);
  start();
  refreshStats();
}

/** Every result ID, in the order on show. */
export const resultIds = (): Promise<number[]> =>
  order
    ? Promise.resolve(order)
    : (allIds ??= api.searchIds(search.query, seed, search.scope));

/**
 * Moves results to sit before the result at `before` (an index into all
 * results, or their number to move to the end). From then on the view
 * keeps this order instead of the query's, until `resetOrder`.
 */
export async function moveItems(ids: number[], before: number) {
  const current = await resultIds();
  const moving = new Set(ids);
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

  order = next;
  customOrders.set(viewKey, next);
  generation += 1;
  requested = new Set();
  anchor = null;
  setSearch({ custom: true, total: next.length });
  setDataVersion((n) => n + 1);
  loadPage(search.page);
}

/** Goes back to the order the query gives. */
export function resetOrder() {
  if (!order) return;
  dropOrder();
  changed();
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
    setSelected(new Set(modifiers.toggle ? [...selected(), ...range] : range));
    return;
  }
  anchor = index;
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

export function clearSelection() {
  anchor = null;
  setSelected(new Set<number>());
}
