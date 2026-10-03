import { saveSetting, settings } from "./settings";

/**
 * Things a key can be bound to. To add one, list it here with its default
 * key and handle it where hotkeys are dispatched, in App.
 */
export const ACTIONS = [
  {
    id: "quickTag",
    label: "Edit tags",
    description: "Opens the tag editor for the selected items, or for the file open in the viewer.",
    key: "t",
  },
  {
    id: "quickRate",
    label: "Quick rate",
    description: "Then press 1 to 7 to set the score, or 0 to clear it.",
    key: "r",
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
  const key = event.key.toLowerCase();
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

/** A key name as shown to the user: `Ctrl + Shift + T`. */
export function keyLabel(name: string): string {
  return name
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" + ");
}

export const keyFor = (action: Action): string =>
  settings.hotkeys?.[action] ?? ACTIONS.find((entry) => entry.id === action)!.key;

export const isDefault = (action: Action) => settings.hotkeys?.[action] === undefined;

/** The action bound to the key an event stands for, if any. */
export function actionFor(event: KeyboardEvent): Action | null {
  const key = keyOf(event);
  return ACTIONS.find((entry) => keyFor(entry.id) === key)?.id ?? null;
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
