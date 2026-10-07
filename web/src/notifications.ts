import { createSignal } from "solid-js";

/**
 * Something that went wrong while the user was not looking at it: a
 * download that failed, or finished without all of what it was after. It
 * is shown in the corner until dismissed, and opens to say more.
 */
export type Notice = {
  id: number;
  /** Whether it came to nothing, or got there with problems on the way. */
  kind: "failed" | "problems";
  title: string;
  /** When it was noticed, as an ISO timestamp. */
  when: string;
  /** The address that was being downloaded. */
  url: string;
  /** Where it was asked for: the inbox, or a tab by its name. */
  from: string;
  /** What went wrong, one thing each; the first is the summary. */
  messages: string[];
  /** The inbox request it is about, which can be asked for again. */
  request?: number;
};

const [notices, setNotices] = createSignal<Notice[]>([]);

export { notices };

let next = 1;

/** Shows a notice, the newest last. */
export function notify(notice: Omit<Notice, "id" | "when">) {
  setNotices([...notices(), { ...notice, id: next++, when: new Date().toISOString() }]);
}

export function dismiss(id: number) {
  setNotices(notices().filter((notice) => notice.id !== id));
}

export function dismissAll() {
  setNotices([]);
}
