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

/**
 * A set a tab has gone into, or a group of variants, or a collection, and
 * the filter typed while in it.
 */
export type Step = (api.SetName | { variants: string } | { collection: string }) & {
  query: string;
};

/** What a step is called. */
export const stepName = (step: Step) =>
  "variants" in step
    ? "Variants"
    : "collection" in step
      ? step.collection
      : step.title || step.set_id;

/** What tells a step from any other. */
export const stepKey = (step: Step) =>
  "variants" in step
    ? `v${step.variants}`
    : "collection" in step
      ? `c${step.collection}`
      : `s${step.set_id}`;

/** What a step keeps a search to. */
export const stepWithin = (step: Step): api.Within =>
  "variants" in step
    ? { variants: step.variants }
    : "collection" in step
      ? { collection: step.collection }
      : { set: step.set_id };

// A tab can go into the set of one of its results, or its variants, or a
// collection it is part of, and on from there, and back out: the way in
// is its trail. It is kept while the page is open, and not with the tab.
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

/** A step as it is now, if what it goes into is still there. */
async function current(
  step: { set_id: string } | { variants: string } | { collection: string },
  query: string,
): Promise<Step | null> {
  // A group is its ID and nothing more, and a collection its name: there
  // is nothing of either to read.
  if ("variants" in step) return { variants: String(step.variants), query };
  if ("collection" in step) return { collection: String(step.collection), query };
  // A set no file gives any more is gone.
  const set = await api.getSet(step.set_id).catch(() => null);
  return set && set.files > 0 ? { set_id: set.set_id, title: set.title, query } : null;
}

/**
 * Takes up the trails remembered for the tabs there still are, as far as
 * their sets still exist.
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
      const now = await current(step, String(step.query ?? ""));
      if (!now) break;
      kept.push(now);
    }
    if (kept.length > 0) setTrails(tab.id, kept);
  }
  saveTrails();
}

/** What the active tab has gone into, outermost first. */
export const trail = (): Step[] => trails[activeId() ?? -1] ?? [];

/** The set or group the active tab is inside, if it has gone into one. */
export const inside = (): Step | undefined => trail().at(-1);

/**
 * The set the active tab shows the files of: the one it has gone into, or
 * failing that the one a set tab is tied to.
 */
export const shownSet = (): api.SetName | undefined => {
  const step = inside();
  if (!step) return activeTab()?.set ?? undefined;
  return "variants" in step || "collection" in step ? undefined : step;
};

/** The collection the active tab shows, if it has gone into one. */
export const shownCollection = (): string | undefined => {
  const step = inside();
  return step && "collection" in step ? step.collection : undefined;
};

/** The group of variants the active tab shows, if it has gone into one. */
export const shownVariants = (): string | undefined => {
  const step = inside();
  return step && "variants" in step ? step.variants : undefined;
};

/** Goes into a set, a group of variants or a collection, in the active tab. */
export async function enter(
  into: { set_id: string } | { variants: string } | { collection: string },
) {
  const tab = activeId();
  // What is on show is already gone into.
  const here =
    "variants" in into
      ? shownVariants() === into.variants
      : "collection" in into
        ? shownCollection() === into.collection
        : shownSet()?.set_id === into.set_id;
  if (tab === null || here) return;
  await guard(async () => {
    const step = await current(into, "");
    if (!step) throw new Error("That set is gone.");
    if (activeId() !== tab) return;
    setTrails(tab, [...(trails[tab] ?? []), step]);
    saveTrails();
  });
}

/**
 * Goes back out: one step, or to where the trail was `depth` long.
 * Resolves to what was left for what is outside it.
 */
export function leave(depth = trail().length - 1): Step | undefined {
  const tab = activeId();
  const steps = trail();
  if (tab === null || depth < 0 || depth >= steps.length) return undefined;
  setTrails(tab, steps.slice(0, depth));
  saveTrails();
  return steps[depth];
}

/** Filters the set or group the active tab is inside. */
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
export async function open(kind: TabKind, query = ""): Promise<Tab | undefined> {
  let tab: Tab | undefined;
  await guard(async () => {
    tab = await api.createTab(kind, query);
    // There is one inbox: asked for again, the server answers with it.
    if (!tabs.some((had) => had.id === tab!.id)) setTabs(tabs.length, tab);
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

/**
 * Opens a tab on these entities alone: it holds them, and its query
 * filters them.
 */
export const openSelection = (ids: number[]) =>
  guard(async () => {
    const tab = await api.createTab("selection", "", undefined, ids);
    setTabs(tabs.length, tab);
    select(tab.id);
  });

/** Shows a set in its own tab, going to the one it has if any. */
export async function openSet(id: string) {
  const existing = tabs.find((tab) => tab.set?.set_id === id);
  if (existing) return select(existing.id);
  await guard(async () => {
    const tab = await api.createTab("set", "", id);
    setTabs(tabs.length, tab);
    select(tab.id);
  });
}

/**
 * Re-reads the tabs, after library changes: a set tab follows its set's
 * title, and goes when the set does.
 */
export const refresh = () =>
  guard(async () => {
    let list = await api.listTabs();
    if (list.length === 0) list = [await api.createTab("gallery", "")];
    const index = tabs.findIndex((tab) => tab.id === activeId());
    // A set tab goes with its set.
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
 * Brings the active tab's trail up to date with its sets: what they are
 * called. It ends where one is gone.
 */
async function followTrail() {
  const tab = activeId();
  const steps = trail();
  if (tab === null || steps.length === 0) return;
  const kept: Step[] = [];
  for (const step of steps) {
    const now = await current(step, step.query);
    if (!now) break;
    kept.push(now);
  }
  if (activeId() === tab && trails[tab]?.length === steps.length) {
    setTrails(tab, reconcile(kept, { merge: true }));
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
