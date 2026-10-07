import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import * as api from "./api";
import { errorMessage } from "./format";
import type { Tab, TabKind } from "./api";
import { forgetDownload } from "./downloads";
import { forgetViews } from "./search";

/** Drops what the page keeps for a closed tab: its number is given out again. */
function forget(id: number) {
  forgetViews(id);
  forgetDownload(id);
  setTrails(produce((all) => void delete all[id]));
  saveTrails();
  setShowsTrashed(id, false);
}

// Tabs live on the server; which one is active is remembered per browser.
const ACTIVE_KEY = "opalarchive.activeTab";

const [tabs, setTabs] = createStore<Tab[]>([]);
const [activeId, setActiveId] = createSignal<number | null>(null);
const [error, setError] = createSignal<string | null>(null);

export { tabs, activeId, error };

export const activeTab = () => tabs.find((tab) => tab.id === activeId());

// The tabs whose searches list what is in the trash along with the rest.
// It is part of what a tab searches for, as its query is, but is
// remembered per browser.
const TRASHED_KEY = "opalarchive.showTrashed";
const [trashedTabs, setTrashedTabs] = createSignal<ReadonlySet<number>>(readTrashedTabs());

function readTrashedTabs(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(TRASHED_KEY) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}

/** Whether the active tab's searches, and filters, list the trash too. */
export const showsTrashed = () => trashedTabs().has(activeId() ?? -1);

export function setShowsTrashed(tab: number, show: boolean) {
  if (trashedTabs().has(tab) === show) return;
  const next = new Set(trashedTabs());
  if (show) next.add(tab);
  else next.delete(tab);
  setTrashedTabs(next);
  try {
    localStorage.setItem(TRASHED_KEY, JSON.stringify([...next]));
  } catch {
    // Storage unavailable; the choice just won't survive a reload.
  }
}

/** A collection a tab has gone into, and the filter typed while in it. */
export type Step = {
  id: number;
  title: string | null;
  /** Its identifier, which it is called by when it has no title. */
  collection_id: string | null;
  ordered: boolean;
  query: string;
};

// A tab can go into a collection among its results, and into one inside
// that, and back out: the way in is its trail. It is kept while the page
// is open, and not with the tab.
const [trails, setTrails] = createStore<Record<number, Step[]>>({});

// Remembered per browser, like the active tab, so a reload keeps them.
const TRAILS_KEY = "opalarchive.trails";

function saveTrails() {
  try {
    localStorage.setItem(TRAILS_KEY, JSON.stringify(trails));
  } catch {
    // Storage unavailable; the trails just won't survive a reload.
  }
}

/**
 * Takes up the trails remembered for the tabs there still are, as far as
 * their collections still exist.
 */
async function loadTrails(list: Tab[]) {
  let stored: Record<string, Step[]> = {};
  try {
    stored = JSON.parse(localStorage.getItem(TRAILS_KEY) ?? "{}");
  } catch {
    // Nothing remembered.
  }
  for (const tab of list) {
    const kept: Step[] = [];
    for (const step of stored[tab.id] ?? []) {
      const entity = await api.getEntity(step.id).catch(() => null);
      if (!entity?.collection) break;
      kept.push({
        id: step.id,
        title: entity.title,
        collection_id: entity.collection.collection_id,
        ordered: entity.collection.ordered,
        query: String(step.query ?? ""),
      });
    }
    if (kept.length > 0) setTrails(tab.id, kept);
  }
  saveTrails();
}

/** The collections the active tab has gone into, outermost first. */
export const trail = (): Step[] => trails[activeId() ?? -1] ?? [];

/** The collection the active tab is inside, if it has gone into one. */
export const inside = (): Step | undefined => trail().at(-1);

/**
 * The collection the active tab shows the members of: the one it has gone
 * into, or failing that the one a collection tab is tied to.
 */
export const shownCollection = () => inside() ?? activeTab()?.collection ?? undefined;

/** Goes into a collection, in the active tab. */
export async function enter(collection: { id: number; title: string | null }) {
  const tab = activeId();
  // The collection on show is already gone into.
  if (tab === null || shownCollection()?.id === collection.id) return;
  await guard(async () => {
    const entity = await api.getEntity(collection.id);
    if (activeId() !== tab) return;
    const step = {
      id: entity.id,
      title: entity.title,
      collection_id: entity.collection?.collection_id ?? null,
      ordered: entity.collection?.ordered ?? false,
      query: "",
    };
    setTrails(tab, [...(trails[tab] ?? []), step]);
    saveTrails();
  });
}

/**
 * Goes back out: one collection, or to where the trail was `depth` long.
 * Resolves to the collection that was left for the one outside it.
 */
export function leave(depth = trail().length - 1): Step | undefined {
  const tab = activeId();
  const steps = trail();
  if (tab === null || depth < 0 || depth >= steps.length) return undefined;
  setTrails(tab, steps.slice(0, depth));
  saveTrails();
  return steps[depth];
}

/** Filters the collection the active tab is inside. */
export function filterInside(query: string) {
  const tab = activeId();
  const depth = trail().length - 1;
  if (tab !== null && depth >= 0) setTrails(tab, depth, "query", query);
  saveTrails();
}

function savedActiveId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function select(id: number) {
  setActiveId(id);
  try {
    localStorage.setItem(ACTIVE_KEY, String(id));
  } catch {
    // Storage unavailable; the choice just won't survive a reload.
  }
}

async function guard(action: () => Promise<void>) {
  try {
    await action();
    setError(null);
  } catch (err) {
    setError(errorMessage(err));
  }
}

export const load = () =>
  guard(async () => {
    let list = await api.listTabs();
    if (list.length === 0) list = [await api.createTab("gallery", "")];
    // Before the tabs are shown, so that each opens where it was.
    await loadTrails(list);
    setTabs(list);
    const saved = savedActiveId();
    select(list.some((tab) => tab.id === saved) ? saved! : list[0].id);
  });

/** Opens a tab and switches to it. Resolves to the tab, if it was created. */
export async function open(
  kind: TabKind,
  query = "",
  downloader?: string,
): Promise<Tab | undefined> {
  let tab: Tab | undefined;
  await guard(async () => {
    tab = await api.createTab(kind, query, undefined, downloader);
    setTabs(tabs.length, tab);
    select(tab.id);
  });
  return tab;
}

export const close = (id: number) =>
  guard(async () => {
    await api.deleteTab(id);
    forget(id);
    const index = tabs.findIndex((tab) => tab.id === id);
    const rest = tabs.filter((tab) => tab.id !== id);
    // There is always at least one tab.
    if (rest.length === 0) rest.push(await api.createTab("gallery", ""));
    setTabs(rest);
    if (activeId() === id) select(rest[Math.min(index, rest.length - 1)].id);
  });

export const setQuery = (id: number, query: string) =>
  guard(async () => {
    const tab = await api.updateTab(id, { query });
    setTabs((t) => t.id === id, "query", tab.query);
  });

/** Shows a collection in its own tab, going to the one it has if any. */
export async function openCollection(id: number) {
  const existing = tabs.find((tab) => tab.collection?.id === id);
  if (existing) return select(existing.id);
  await guard(async () => {
    const tab = await api.createTab("collection", "", id);
    setTabs(tabs.length, tab);
    select(tab.id);
  });
}

/**
 * Re-reads the tabs, after library changes: a collection tab follows its
 * collection's title, and goes when the collection is deleted.
 */
export const refresh = () =>
  guard(async () => {
    let list = await api.listTabs();
    if (list.length === 0) list = [await api.createTab("gallery", "")];
    const index = tabs.findIndex((tab) => tab.id === activeId());
    // A collection tab goes with its collection.
    for (const tab of tabs) {
      if (!list.some((kept) => kept.id === tab.id)) forget(tab.id);
    }
    setTabs(reconcile(list, { key: "id" }));
    await followTrail();
    if (!list.some((tab) => tab.id === activeId())) {
      select(list[Math.max(0, Math.min(index, list.length - 1))].id);
    }
  });

/**
 * Brings the active tab's trail up to date with its collections: their
 * titles and whether they are ordered. It ends where one has been deleted.
 */
async function followTrail() {
  const tab = activeId();
  const steps = trail();
  if (tab === null || steps.length === 0) return;
  const kept: Step[] = [];
  for (const step of steps) {
    const entity = await api.getEntity(step.id).catch(() => null);
    if (!entity?.collection) break;
    kept.push({ ...step, title: entity.title, ordered: entity.collection.ordered });
  }
  if (activeId() === tab && trails[tab]?.length === steps.length) {
    setTrails(tab, reconcile(kept, { key: "id" }));
    saveTrails();
  }
}

/** Names a tab; an empty name puts it back to showing its query. */
export const rename = (id: number, name: string) =>
  guard(async () => {
    const tab = await api.updateTab(id, { name });
    setTabs((t) => t.id === id, "name", tab.name);
  });

/** Moves a tab to another place in the strip. Not saved until `saveOrder`. */
export function move(id: number, index: number) {
  const from = tabs.findIndex((tab) => tab.id === id);
  if (from < 0 || from === index) return;
  const list = tabs.map((tab) => ({ ...tab }));
  list.splice(index, 0, ...list.splice(from, 1));
  // Keyed, so each tab keeps its place in the page and just moves.
  setTabs(reconcile(list, { key: "id" }));
}

export const saveOrder = () =>
  guard(async () => {
    await api.orderTabs(tabs.map((tab) => tab.id));
  });
