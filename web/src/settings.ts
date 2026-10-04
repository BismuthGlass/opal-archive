import { createStore, reconcile } from "solid-js/store";
import * as api from "./api";

/** Settings live on the server, so every browser has the same ones. */
export type Settings = {
  /** Action to key, for the actions whose key is not the default. */
  hotkeys?: Record<string, string>;
  /** Tag type to what differs from its defaults: colours, aggregation. */
  tagTypes?: Record<string, { bg?: string; fg?: string; aggregate?: boolean }>;
  /** The tag types in the order they are listed, if not the default one. */
  tagTypeOrder?: string[];
  /** How the viewer plays through results by itself. */
  player?: { seconds?: number; random?: boolean };
  /** Queries kept to be used again, in the order they are offered. */
  savedQueries?: SavedQuery[];
};

/** A query kept under a name. One line: a single row of a stack. */
export type SavedQuery = { name: string; query: string };

const [settings, setSettings] = createStore<Settings>({});

export { settings };

export async function loadSettings() {
  try {
    setSettings(reconcile(await api.getSettings()));
  } catch {
    // Defaults apply until the server can be reached.
  }
}

/** Saves one setting; `null` puts it back to its default. */
export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K] | null) {
  setSettings(reconcile(await api.changeSettings({ [key]: value })));
}
