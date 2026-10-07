import { createSignal } from "solid-js";
import * as api from "./api";
import type { InboxState } from "./api";
import { notify } from "./notifications";
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

// A request that goes wrong is told of once. What each was doing when
// last asked says which have just ended; the number of the latest one told
// of is kept per browser, so that what went wrong while the page was shut
// is told of when it is next opened, and nothing is told of twice.
const TOLD_KEY = "opalarchive.inbox.told";
const statuses = new Map<number, string>();

function toldUpTo(): number | null {
  try {
    const stored = localStorage.getItem(TOLD_KEY);
    return stored === null ? null : Number(stored) || 0;
  } catch {
    return null;
  }
}

/** Gives notice of the requests that have gone wrong since last asked. */
function noteProblems(state: InboxState) {
  const told = toldUpTo();
  let latest = told ?? 0;
  for (const request of state.queue) {
    const before = statuses.get(request.id);
    statuses.set(request.id, request.status);
    const ended = request.status !== "queued" && request.status !== "running";
    if (!ended) continue;
    // Seen ending just now; or ended unseen, since the last one told of.
    // The first time ever, what is already there is old news.
    const fresh = before === undefined ? told !== null && request.id > told : before !== request.status;
    latest = Math.max(latest, request.id);
    const failed = request.status === "failed";
    if (!fresh || !(failed || (request.status === "done" && request.message))) continue;
    const downloader =
      state.downloaders.find((entry) => entry.downloader.name === request.downloader)?.downloader
        .title ?? request.downloader;
    notify({
      kind: failed ? "failed" : "problems",
      title: failed ? `${downloader} download failed` : `${downloader} download had problems`,
      url: request.url,
      from: "The inbox",
      messages: request.message.split("; ").filter(Boolean),
      request: request.id,
    });
  }
  try {
    localStorage.setItem(TOLD_KEY, String(latest));
  } catch {
    // Storage unavailable: what went wrong while the page was shut is not told of.
  }
}

/** Reads the inbox, and shows in its tab what has arrived since. */
export async function loadInbox(): Promise<InboxState> {
  const state = await api.getInbox();
  setInbox(state);
  noteProblems(state);
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
