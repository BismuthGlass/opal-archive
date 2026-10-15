import * as api from "./api";
import type { Change, Changes, Flagged } from "./api";
import { plural } from "./format";
import { changed } from "./search";
import { activeId } from "./tabs";
import { record } from "./undo";

/** The fields whose setting can be undone, and what they are called. */
const UNDOABLE: Record<string, string> = { score: "score", content_rating: "rating" };

/** Of what an edit did, what can be undone: tags, and the fields above. */
function undoable(changes: Change[]): Change[] {
  return changes.flatMap(({ id, set, add, remove }) => {
    const kept = Object.fromEntries(Object.entries(set ?? {}).filter(([field]) => field in UNDOABLE));
    const change: Change = { id, add, remove };
    if (Object.keys(kept).length > 0) change.set = kept;
    return change.set || add || remove ? [change] : [];
  });
}

async function apply(changes: Change[]) {
  try {
    await api.apply(changes);
  } finally {
    changed();
  }
}

/**
 * Edits entities, as `api.edit` does. What it does to their tags, score
 * and rating can be undone in the tab on show, file by file: each gets
 * back just what it had, and loses just the tags it gained.
 */
export async function edit(ids: number[], changes: Changes) {
  const tab = activeId();
  const result = await api.edit(ids, changes);
  const undo = undoable(result.undo);
  const redo = undoable(result.redo);
  if (redo.length > 0) {
    const what = new Set<string>();
    for (const change of redo) {
      for (const field of Object.keys(change.set ?? {})) what.add(`the ${UNDOABLE[field]}`);
      if (change.add || change.remove) what.add("the tags");
    }
    record(tab, {
      name: `changing ${[...what].join(" and ")} of ${plural(redo.length, "item")}`,
      undo: () => apply(undo),
      redo: () => apply(redo),
    });
  }
  return result;
}

/**
 * Sets a flag of entities with `set`, so that `unset` undoes it for those
 * it changed. `name` says what was done to how many.
 */
const flagging =
  (
    set: (ids: number[]) => Promise<Flagged>,
    unset: (ids: number[]) => Promise<Flagged>,
    name: (items: string) => string,
  ) =>
  async (ids: number[]): Promise<Flagged> => {
    const tab = activeId();
    const result = await set(ids);
    const done = result.ids;
    if (done.length > 0) {
      const again = (how: typeof set) => async () => {
        try {
          await how(done);
        } finally {
          changed();
        }
      };
      record(tab, { name: name(plural(done.length, "item")), undo: again(unset), redo: again(set) });
    }
    return result;
  };

/** Moves to the trash, so that it can be undone. */
export const trash = flagging(api.trashEntities, api.restoreEntities, (items) => `moving ${items} to the trash`);
/** Takes out of the trash, so that it can be undone. */
export const restore = flagging(api.restoreEntities, api.trashEntities, (items) => `taking ${items} out of the trash`);
/** Takes out of the inbox, so that it can be undone. */
export const archive = flagging(api.archiveEntities, api.unarchiveEntities, (items) => `archiving ${items}`);
/** Puts back in the inbox, so that it can be undone. */
export const unarchive = flagging(api.unarchiveEntities, api.archiveEntities, (items) => `moving ${items} to the inbox`);
