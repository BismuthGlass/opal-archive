import * as api from "./api";
import type { Changes, Retag } from "./api";
import { plural } from "./format";
import { changed } from "./search";
import { activeId } from "./tabs";
import { record } from "./undo";

/** Undoes what was done to tags: each file loses what it gained and gets back what it lost. */
const inverse = (changes: Retag[]): Retag[] =>
  changes.map(({ id, add, remove }) => ({ id, add: remove, remove: add }));

async function retag(changes: Retag[]) {
  try {
    await api.retag(changes);
  } finally {
    changed();
  }
}

/**
 * Edits entities, as `api.edit` does. What it does to their tags can be
 * undone in the tab on show, file by file: each loses just the tags it
 * gained, and gets back just those it lost.
 */
export async function edit(ids: number[], changes: Changes) {
  const tab = activeId();
  const result = await api.edit(ids, changes);
  const done = result.tags;
  if (done.length > 0) {
    record(tab, {
      name: `changing the tags of ${plural(done.length, "item")}`,
      undo: () => retag(inverse(done)),
      redo: () => retag(done),
    });
  }
  return result;
}
