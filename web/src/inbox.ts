import { createSignal } from "solid-js";
import * as api from "./api";
import type { InboxState } from "./api";
import { addedTo } from "./search";
import { refresh as refreshTabs, tabs } from "./tabs";

// The inbox is fed from outside the page, by the browser extension for
// one, so the page has to keep asking what is in it: often while its queue
// is being worked through, now and then otherwise.
const [inbox, setInbox] = createSignal<InboxState | null>(null);

export { inbox };

/** How often it is asked while something is queued, and while nothing is. */
const BUSY = 1000;
const IDLE = 5000;

/** How many things its tab listed when last asked; -1 before the first time. */
let listed = -1;
let timer = 0;

/** Reads the inbox, and shows in its tab what has arrived since. */
export async function loadInbox(): Promise<InboxState> {
  const state = await api.getInbox();
  setInbox(state);
  if (state.tab !== null) {
    // Its tab is made by the first thing sent, which may be just now.
    if (!tabs.some((tab) => tab.id === state.tab)) await refreshTabs();
    if (listed >= 0 && state.listed !== listed) addedTo(state.tab);
  }
  listed = state.listed;
  return state;
}

/** Keeps the inbox up to date for as long as the page is open. */
export function watchInbox() {
  clearTimeout(timer);
  const tick = async () => {
    let busy = false;
    try {
      const state = await loadInbox();
      busy = state.queue.some((request) => request.status === "queued" || request.status === "running");
    } catch {
      // The server is away; it is asked again.
    }
    timer = window.setTimeout(tick, busy ? BUSY : IDLE);
  };
  tick();
}
