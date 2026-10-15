/**
 * What has been done in each tab, to be undone and done again: marks given
 * and taken off, tags, scores and ratings changed, files trashed and
 * archived, and files taken out of a view and put back. Each tab has a
 * history of its own, kept while the page is open, until its view is
 * searched for again.
 */

/** Something done, as it can be undone and redone. */
export type Undoable = {
  /** What was done, to follow "Undid" or "Redid": "giving 3 items mark 2". */
  name: string;
  undo: () => Promise<unknown> | void;
  redo: () => Promise<unknown> | void;
};

/** How many things done a tab remembers; the oldest go first. */
const MOST = 200;

type History = {
  done: Undoable[];
  undone: Undoable[];
  /** Bumped when something new is done: what was undone before can no longer be redone. */
  era: number;
};

const histories = new Map<number, History>();

function historyOf(tab: number): History {
  let history = histories.get(tab);
  if (!history) histories.set(tab, (history = { done: [], undone: [], era: 0 }));
  return history;
}

/** Notes something just done in a tab. What was undone there can no longer be redone. */
export function record(tab: number | null, done: Undoable) {
  if (tab === null) return;
  const history = historyOf(tab);
  history.done.push(done);
  if (history.done.length > MOST) history.done.shift();
  history.undone = [];
  history.era += 1;
}

/** Undoing and redoing wait for each other, so that they happen in the order asked. */
let running: Promise<unknown> = Promise.resolve();

/**
 * Takes the last thing from one list, does it the way given, and puts it
 * on the other. Resolves to its name, or null when there was nothing to
 * do. If it fails it stays where it was.
 */
function step(tab: number, from: "done" | "undone", how: "undo" | "redo"): Promise<string | null> {
  const next = running.then(async () => {
    const history = histories.get(tab);
    const entry = history?.[from].pop();
    if (!history || !entry) return null;
    const era = history.era;
    try {
      await entry[how]();
    } catch (err) {
      history[from].push(entry);
      throw err;
    }
    const since = history.era - era;
    if (from === "done") {
      // Something done meanwhile has started the history afresh from
      // there: what was undone can no longer be redone.
      if (since === 0) history.undone.push(entry);
    } else {
      // Redone before what was done meanwhile, it is undone after it.
      history.done.splice(Math.max(0, history.done.length - since), 0, entry);
    }
    return entry.name;
  });
  running = next.catch(() => {});
  return next;
}

/** Undoes the last thing done in a tab, and resolves to what it was. */
export const undo = (tab: number) => step(tab, "done", "undo");

/** Does again the last thing undone in a tab, and resolves to what it was. */
export const redo = (tab: number) => step(tab, "undone", "redo");

/**
 * Drops the history of a tab: one closed, whose number is given out
 * again, or one whose view has been searched for again.
 */
export function forgetHistory(tab: number) {
  histories.delete(tab);
}
