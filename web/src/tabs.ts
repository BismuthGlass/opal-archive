import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import * as api from "./api";
import type { Tab } from "./api";

// Tabs live on the server; which one is active is remembered per browser.
const ACTIVE_KEY = "tagutils.activeTab";

const [tabs, setTabs] = createStore<Tab[]>([]);
const [activeId, setActiveId] = createSignal<number | null>(null);
const [error, setError] = createSignal<string | null>(null);

export { tabs, activeId, error };

export const activeTab = () => tabs.find((tab) => tab.id === activeId());

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
    setError(err instanceof Error ? err.message : String(err));
  }
}

export const load = () =>
  guard(async () => {
    let list = await api.listTabs();
    if (list.length === 0) list = [await api.createTab("")];
    setTabs(list);
    const saved = savedActiveId();
    select(list.some((tab) => tab.id === saved) ? saved! : list[0].id);
  });

export const open = (query = "") =>
  guard(async () => {
    const tab = await api.createTab(query);
    setTabs(tabs.length, tab);
    select(tab.id);
  });

export const close = (id: number) =>
  guard(async () => {
    await api.deleteTab(id);
    const index = tabs.findIndex((tab) => tab.id === id);
    const rest = tabs.filter((tab) => tab.id !== id);
    // There is always at least one tab.
    if (rest.length === 0) rest.push(await api.createTab(""));
    setTabs(rest);
    if (activeId() === id) select(rest[Math.min(index, rest.length - 1)].id);
  });

export const setQuery = (id: number, query: string) =>
  guard(async () => {
    const tab = await api.updateTab(id, query);
    setTabs((t) => t.id === id, "query", tab.query);
  });
