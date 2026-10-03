import { createStore } from "solid-js/store";
import * as api from "./api";
import { changed } from "./search";

type Failure = { name: string; reason: string };

const idle = {
  active: false,
  total: 0,
  done: 0,
  added: 0,
  duplicates: 0,
  failures: [] as Failure[],
  /** Fraction of the file currently uploading. */
  progress: 0,
};

const [uploads, setUploads] = createStore({ ...idle });

export { uploads };

const queue: File[] = [];

/** Adds files to the batch in progress, or starts a new one. */
export function enqueue(files: File[]) {
  if (files.length === 0) return;
  if (!uploads.active) setUploads({ ...idle, failures: [] });
  queue.push(...files);
  setUploads("total", (n) => n + files.length);
  if (!uploads.active) run();
}

// Files go up one at a time, in order.
async function run() {
  setUploads("active", true);
  let lastRefresh = Date.now();
  while (queue.length > 0) {
    const file = queue.shift()!;
    setUploads("progress", 0);
    try {
      const result = await api.uploadFile(file, (fraction) => setUploads("progress", fraction));
      setUploads(result.duplicate ? "duplicates" : "added", (n) => n + 1);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setUploads("failures", (list) => [...list, { name: file.name, reason }]);
    }
    setUploads("done", (n) => n + 1);
    // Show new files as they arrive, without reloading for every one.
    if (Date.now() - lastRefresh > 2000) {
      lastRefresh = Date.now();
      changed();
    }
  }
  setUploads({ active: false, progress: 0 });
  changed();
}

export function dismiss() {
  if (!uploads.active) setUploads({ ...idle, failures: [] });
}
