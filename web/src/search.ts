import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import * as api from "./api";
import type { Item } from "./api";
import { refreshStats } from "./stats";

/** Results are fetched in pages of this many, as the grid scrolls to them. */
export const PAGE = 200;

type SearchError = { message: string; position?: number };

const [search, setSearch] = createStore({
  query: "",
  /** Upload tab the results are limited to, if any. */
  scope: null as number | null,
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
/** Index the next shift-click extends from. */
let anchor: number | null = null;

export const itemAt = (index: number): Item | undefined =>
  pages[Math.floor(index / PAGE)]?.[index % PAGE];

function loadPage(page: number) {
  if (requested.has(page)) return;
  requested.add(page);
  const current = generation;
  api
    .search(search.query, page * PAGE, PAGE, seed, search.scope)
    .then((result) => {
      if (current !== generation) return;
      setPages(page, result.items);
      setSearch({ total: result.total, ready: true, error: null });
    })
    .catch((err) => {
      if (current !== generation) return;
      setPages(reconcile({}));
      setSearch({ total: 0, ready: true, error: { message: err.message, position: err.position } });
    });
}

/** Makes sure the pages covering these result indices are loaded. */
export function ensureRange(first: number, last: number) {
  for (let page = Math.floor(first / PAGE); page <= Math.floor(last / PAGE); page++) {
    loadPage(page);
  }
}

/** Starts a new search, discarding results and selection. */
export function runSearch(query: string, scope: number | null = null) {
  generation += 1;
  seed = Math.floor(Math.random() * 2 ** 31);
  requested = new Set();
  allIds = null;
  anchor = null;
  setPages(reconcile({}));
  setSearch({ query, scope, total: 0, ready: false, error: null });
  setSelected(new Set<number>());
  setSearchCount((n) => n + 1);
  loadPage(0);
}

/**
 * Call after anything changes library data. Reloads the current results in
 * place: what is on screen stays until its replacement arrives.
 */
export function changed() {
  generation += 1;
  requested = new Set();
  allIds = null;
  setDataVersion((n) => n + 1);
  loadPage(0);
  refreshStats();
}

const resultIds = () => (allIds ??= api.searchIds(search.query, seed, search.scope));

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

export async function selectAll() {
  setSelected(new Set(await resultIds()));
}

export function clearSelection() {
  anchor = null;
  setSelected(new Set<number>());
}
