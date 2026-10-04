import { createStore } from "solid-js/store";
import * as api from "./api";
import { errorMessage } from "./format";
import { addedTo } from "./search";
import { activeTab, open } from "./tabs";

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

/** What is uploaded: a file from this computer, or one at a web address. */
type Source = File | string;

const nameOf = (source: Source) => (typeof source === "string" ? source : source.name);

const queue: { file: Source; tab: number }[] = [];

/**
 * Uploads files into the active tab if it is an upload tab, and into a new
 * upload tab otherwise. A file given as a web address is fetched by the
 * server.
 */
export async function upload(files: Source[]) {
  if (files.length === 0) return;
  const current = activeTab();
  const tab = current?.kind === "upload" ? current : await open("upload");
  if (tab) enqueue(files, tab.id);
}

/** Adds files to the batch in progress, or starts a new one. */
function enqueue(files: Source[], tab: number) {
  if (!uploads.active) setUploads({ ...idle, failures: [] });
  queue.push(...files.map((file) => ({ file, tab })));
  setUploads("total", (n) => n + files.length);
  if (!uploads.active) run();
}

// Files go up one at a time, in order.
async function run() {
  setUploads("active", true);
  let lastRefresh = Date.now();
  /** Upload tabs with files their view has not been told about yet. */
  const waiting = new Set<number>();
  while (queue.length > 0) {
    const { file, tab } = queue.shift()!;
    setUploads("progress", 0);
    try {
      // How far a fetch by the server has got is not known.
      const result =
        typeof file === "string"
          ? await api.fetchFile(file, tab)
          : await api.uploadFile(file, tab, (fraction) => setUploads("progress", fraction));
      setUploads(result.duplicate ? "duplicates" : "added", (n) => n + 1);
    } catch (err) {
      const reason = errorMessage(err);
      setUploads("failures", (list) => [...list, { name: nameOf(file), reason }]);
    }
    setUploads("done", (n) => n + 1);
    waiting.add(tab);
    // Show new files as they arrive, without reloading for every one.
    if (Date.now() - lastRefresh > 2000) {
      lastRefresh = Date.now();
      waiting.forEach(addedTo);
      waiting.clear();
    }
  }
  setUploads({ active: false, progress: 0 });
  waiting.forEach(addedTo);
}

export function dismiss() {
  if (!uploads.active) setUploads({ ...idle, failures: [] });
}
