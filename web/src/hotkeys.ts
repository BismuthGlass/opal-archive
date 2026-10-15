import { saveSetting, settings } from "./settings";

/**
 * Things a key can be bound to. To add one, list it here with its default
 * key and handle it where hotkeys are dispatched, in App.
 */
export const ACTIONS = [
  {
    id: "quickTag",
    label: "Edit tags",
    description: "Opens the tagger for the selected items, or for the file open in the viewer.",
    key: "t",
  },
  {
    id: "quickScore",
    label: "Score",
    description: "Then press 1 to 7 to set the score, or 0 to clear it.",
    key: "s",
  },
  {
    id: "quickRating",
    label: "Rating",
    description: "Then press 1 for safe, 2 for risky or 3 for nsfw, or 0 to clear the rating.",
    key: "r",
  },
  {
    id: "mark1",
    label: "Mark 1",
    description: "Gives mark 1, beside any other marks.",
    key: "1",
  },
  {
    id: "mark2",
    label: "Mark 2",
    description: "Gives mark 2, beside any other marks.",
    key: "2",
  },
  {
    id: "mark3",
    label: "Mark 3",
    description: "Gives mark 3, beside any other marks.",
    key: "3",
  },
  {
    id: "mark4",
    label: "Mark 4",
    description: "Gives mark 4, beside any other marks.",
    key: "4",
  },
  {
    id: "mark5",
    label: "Mark 5",
    description: "Gives mark 5, beside any other marks.",
    key: "5",
  },
  {
    id: "mark6",
    label: "Mark 6",
    description: "Gives mark 6, beside any other marks.",
    key: "6",
  },
  {
    id: "mark7",
    label: "Mark 7",
    description: "Gives mark 7, beside any other marks.",
    key: "7",
  },
  {
    id: "mark8",
    label: "Mark 8",
    description: "Gives mark 8, beside any other marks.",
    key: "8",
  },
  {
    id: "mark9",
    label: "Mark 9",
    description: "Gives mark 9, beside any other marks.",
    key: "9",
  },
  {
    id: "unmark1",
    label: "Take off mark 1",
    description: "Takes mark 1 off, and leaves any other marks.",
    key: "shift+1",
  },
  {
    id: "unmark2",
    label: "Take off mark 2",
    description: "Takes mark 2 off, and leaves any other marks.",
    key: "shift+2",
  },
  {
    id: "unmark3",
    label: "Take off mark 3",
    description: "Takes mark 3 off, and leaves any other marks.",
    key: "shift+3",
  },
  {
    id: "unmark4",
    label: "Take off mark 4",
    description: "Takes mark 4 off, and leaves any other marks.",
    key: "shift+4",
  },
  {
    id: "unmark5",
    label: "Take off mark 5",
    description: "Takes mark 5 off, and leaves any other marks.",
    key: "shift+5",
  },
  {
    id: "unmark6",
    label: "Take off mark 6",
    description: "Takes mark 6 off, and leaves any other marks.",
    key: "shift+6",
  },
  {
    id: "unmark7",
    label: "Take off mark 7",
    description: "Takes mark 7 off, and leaves any other marks.",
    key: "shift+7",
  },
  {
    id: "unmark8",
    label: "Take off mark 8",
    description: "Takes mark 8 off, and leaves any other marks.",
    key: "shift+8",
  },
  {
    id: "unmark9",
    label: "Take off mark 9",
    description: "Takes mark 9 off, and leaves any other marks.",
    key: "shift+9",
  },
  {
    id: "unmark",
    label: "Clear marks",
    description: "Takes every mark off.",
    key: "0",
  },
  {
    id: "mark",
    label: "Mark again",
    description: "Gives the mark last given with its own key, mark 1 at first.",
    key: "m",
  },
  {
    id: "selectByQuery",
    label: "Select by query",
    description: "Asks for a query, and selects what the view lists that it finds. In the gallery only.",
    key: "shift+q",
  },
  {
    id: "showSelected",
    label: "Go to selection",
    description: "Goes to the first selected item in the view, on whichever page it is, and points it out.",
    key: "g",
  },
  {
    id: "archive",
    label: "Archive",
    description: "Takes out of the inbox, where what is new to the library waits to be looked over.",
    key: "e",
  },
  {
    id: "unarchive",
    label: "Move to inbox",
    description: "Puts back in the inbox.",
    key: "shift+e",
  },
  {
    id: "trash",
    label: "Trash",
    description: "Moves to the trash. What is all in the trash already is deleted for good, once agreed to.",
    key: "ctrl+x",
  },
  {
    id: "moveToStart",
    label: "Move to start",
    description: "Puts at the start of this view. In the gallery only.",
    key: "ctrl+arrowleft",
  },
  {
    id: "moveToEnd",
    label: "Move to end",
    description: "Puts at the end of this view. In the gallery only.",
    key: "ctrl+arrowright",
  },
  {
    id: "hide",
    label: "Remove from view",
    description: "Takes out of this view only. Nothing is trashed, and searching again brings it back.",
    key: "h",
  },
  {
    id: "showRemoved",
    label: "Removed from view",
    description: "Lists what was taken out of this view, to put it back. In the gallery only.",
    key: "shift+h",
  },
  {
    id: "restore",
    label: "Restore",
    description: "Takes out of the trash.",
    key: "ctrl+shift+x",
  },
  {
    id: "undo",
    label: "Undo",
    description:
      "Undoes the last change made in this tab to marks, tags, scores or ratings, trashing, archiving, or what a view lists. Each tab has its own history, cleared when its view is searched for again.",
    key: "ctrl+z",
  },
  {
    id: "redo",
    label: "Redo",
    description: "Does again what was last undone in this tab.",
    key: "ctrl+shift+z",
  },
] as const;

export type Action = (typeof ACTIONS)[number]["id"];

/** Keys that keep their usual meaning and cannot be bound. */
const RESERVED = new Set(["escape", "tab", "enter"]);
const MODIFIERS = new Set(["control", "alt", "meta", "shift"]);

/**
 * The name of the key combination an event stands for, such as `t` or
 * `ctrl+shift+t`; null while only modifiers are down.
 */
export function keyOf(event: KeyboardEvent): string | null {
  // With Shift a digit types a symbol, and which one depends on the
  // keyboard: the digit on the key is what is meant.
  const digit = event.shiftKey ? /^Digit(\d)$/.exec(event.code)?.[1] : undefined;
  const key = digit ?? event.key.toLowerCase();
  if (MODIFIERS.has(key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.metaKey) parts.push("meta");
  // For a symbol such as "?", Shift is already part of which key it is.
  if (event.shiftKey && (key.length > 1 || /[a-z0-9]/.test(key))) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

const ARROWS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
};

/** A key name as shown to the user: `Ctrl + Shift + T`. */
export function keyLabel(name: string): string {
  return name
    .split("+")
    .map((part) => ARROWS[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(" + ");
}

export const keyFor = (action: Action): string =>
  settings.hotkeys?.[action] ?? ACTIONS.find((entry) => entry.id === action)!.key;

export const isDefault = (action: Action) => settings.hotkeys?.[action] === undefined;

/** The action bound to the key an event stands for, if any. */
export function actionFor(event: KeyboardEvent): Action | null {
  const key = keyOf(event);
  if (key === null) return null;
  const bound = (name: string) => ACTIONS.find((entry) => keyFor(entry.id) === name)?.id ?? null;
  // Cmd stands in for Ctrl, unless the key with Cmd is bound to something.
  return bound(key) ?? (event.metaKey && !event.ctrlKey ? bound(key.replace("meta", "ctrl")) : null);
}

/**
 * Binds an action to a key, or with null back to its default. Returns why
 * not, if the key cannot be used.
 */
export async function bind(action: Action, key: string | null): Promise<string | null> {
  const wanted = key ?? ACTIONS.find((entry) => entry.id === action)!.key;
  if (RESERVED.has(wanted)) return `${keyLabel(wanted)} cannot be used as a hotkey.`;
  const taken = ACTIONS.find((entry) => entry.id !== action && keyFor(entry.id) === wanted);
  if (taken) return `${keyLabel(wanted)} is already used by “${taken.label}”.`;

  const hotkeys = { ...settings.hotkeys };
  if (key === null) delete hotkeys[action];
  else hotkeys[action] = key;
  await saveSetting("hotkeys", Object.keys(hotkeys).length > 0 ? hotkeys : null);
  return null;
}
