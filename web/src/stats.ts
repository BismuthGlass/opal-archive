import { createSignal } from "solid-js";
import * as api from "./api";
import type { Stats } from "./api";

const [stats, setStats] = createSignal<Stats | null>(null);

export { stats };

export async function refreshStats() {
  try {
    setStats(await api.getStats());
  } catch {
    // Leave the last known numbers; the tab store reports connection errors.
  }
}
