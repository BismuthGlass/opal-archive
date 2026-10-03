import { createStore, reconcile } from "solid-js/store";
import * as api from "./api";
import type { DownloadState } from "./api";
import { addedTo } from "./search";

// What each download tab is set to and how its download is going. Kept
// here rather than in the panel, so that a download is followed, and its
// files shown, while another tab is in front.
const [states, setStates] = createStore<Record<number, DownloadState>>({});

export const downloadState = (tab: number): DownloadState | undefined => states[tab];

/** How often a running download is asked how it is going. */
const POLL = 1000;
/** New files are shown in the tab at most this often while they arrive. */
const SHOW = 2000;

/** The downloads being followed: the files of each already on show. */
const following = new Map<number, { files: number; shown: number }>();

const files = (state: DownloadState) => (state.job ? state.job.added + state.job.existing : 0);

/** Reads a tab's state, and follows its download if one is running. */
export async function loadDownload(tab: number) {
  const state = await api.getDownload(tab);
  setStates(tab, reconcile(state));
  if (state.job?.running && !following.has(tab)) {
    following.set(tab, { files: files(state), shown: Date.now() });
    setTimeout(() => follow(tab), POLL);
  }
}

async function follow(tab: number) {
  const watch = following.get(tab);
  if (!watch) return;
  let state: DownloadState;
  try {
    state = await api.getDownload(tab);
  } catch {
    // The tab was closed.
    following.delete(tab);
    return;
  }
  setStates(tab, reconcile(state));
  const now = files(state);
  if (!state.job?.running) {
    following.delete(tab);
    if (now > watch.files) addedTo(tab);
    return;
  }
  if (now > watch.files && Date.now() - watch.shown > SHOW) {
    watch.files = now;
    watch.shown = Date.now();
    addedTo(tab);
  }
  setTimeout(() => follow(tab), POLL);
}

export async function startDownload(tab: number, url: string) {
  await api.startDownload(tab, url);
  await loadDownload(tab);
}
