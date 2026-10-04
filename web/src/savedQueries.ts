import { saveSetting, settings } from "./settings";
import type { SavedQuery } from "./settings";

/** The saved queries, in the order they are offered. */
export const savedQueries = (): SavedQuery[] => settings.savedQueries ?? [];

/** What a saved query is listed as: its name, or the query if it has none. */
export const queryLabel = (saved: SavedQuery) => saved.name || saved.query;

export const setSavedQueries = (list: SavedQuery[]) =>
  saveSetting("savedQueries", list.length > 0 ? list.map((saved) => ({ ...saved })) : null);

/** Keeps a query under a name, after the ones already saved. */
export const saveQuery = (name: string, query: string) =>
  setSavedQueries([...savedQueries(), { name, query }]);
