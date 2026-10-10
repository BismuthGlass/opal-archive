import { createStore } from "solid-js/store";
import * as api from "./api";
import { downloadEnded, startDownload } from "./downloads";
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
  /** Things a downloader passed over, having downloaded them into the tab before. */
  skipped: 0,
  /** Collections made of the folders of archives. */
  collections: 0,
  failures: [] as Failure[],
  /** Fraction of the file currently uploading. */
  progress: 0,
  /** The archive the server is unpacking, once it has all of it. */
  unpacking: null as string | null,
  /** The address a downloader is at work on, and the tab it is for. */
  downloading: null as { url: string; tab: number } | null,
  /** The upload tabs it went into: it is spoken of in those. */
  tabs: [] as number[],
};

const [uploads, setUploads] = createStore({ ...idle });

export { uploads };

/**
 * What is uploaded: a file from this computer, or a web address. The
 * address may be a file's own, or one a downloader takes: a post, a board.
 */
type Source = File | string;

const nameOf = (source: Source) => (typeof source === "string" ? source : source.name);

/** A zip is unpacked by the server, not kept as a file. */
const isArchive = (source: Source): source is File =>
  typeof source !== "string" && /\.zip$/i.test(source.name);

const queue: { file: Source; tab: number }[] = [];

/**
 * Uploads files into the active tab if it is an upload tab, and into a new
 * upload tab otherwise. What is given as a web address is fetched by the
 * server: by the downloader for its site, or as a file if there is none.
 */
export async function upload(files: Source[]) {
  if (files.length === 0) return;
  const current = activeTab();
  const tab = current?.kind === "upload" ? current : await open("upload");
  if (tab) enqueue(files, tab.id);
}

/** Adds files to the batch in progress, or starts a new one. */
function enqueue(files: Source[], tab: number) {
  // A new batch starts afresh: what the last one came to is forgotten.
  if (!uploads.active) setUploads({ ...idle, failures: [], tabs: [] });
  if (!uploads.tabs.includes(tab)) setUploads("tabs", (tabs) => [...tabs, tab]);
  queue.push(...files.map((file) => ({ file, tab })));
  setUploads("total", (n) => n + files.length);
  if (!uploads.active) run();
}

/**
 * Has the downloader for an address's site download it into the tab, and
 * waits for it to end. Says whether there was a downloader for it: if not,
 * nothing was done. A tab runs one download at a time, so one already
 * running is waited for first.
 */
async function download(url: string, tab: number): Promise<boolean> {
  await downloadEnded(tab);
  if ((await startDownload(tab, url)) === null) return false;
  setUploads("downloading", { url, tab });
  const job = await downloadEnded(tab);
  if (!job) return true;
  setUploads("added", (n) => n + job.added);
  setUploads("duplicates", (n) => n + job.existing);
  setUploads("skipped", (n) => n + job.skipped);
  const problems = [...job.errors];
  if (job.outcome === "cancelled") problems.push("Cancelled");
  else if (job.outcome !== "done") problems.push(job.outcome ?? "The download failed");
  else if (job.downloaded + job.skipped === 0 && problems.length === 0) {
    problems.push("There was nothing to download");
  }
  const failed = problems.map((reason) => ({ name: url, reason }));
  setUploads("failures", (list) => [...list, ...failed]);
  return true;
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
      if (isArchive(file)) {
        const unpacked = await api.uploadArchive(file, tab, (fraction) => {
          setUploads("progress", fraction);
          // All of it sent: what is left is the server's work.
          if (fraction >= 1) setUploads("unpacking", file.name);
        });
        setUploads("added", (n) => n + unpacked.added);
        setUploads("duplicates", (n) => n + unpacked.duplicates);
        setUploads("collections", (n) => n + unpacked.collections);
        // Each of its files that was passed over is a failure of its own.
        const inside = unpacked.failures.map((failure) => ({
          name: `${file.name} › ${failure.name}`,
          reason: failure.reason,
        }));
        setUploads("failures", (list) => [...list, ...inside]);
      } else if (typeof file === "string" && (await download(file, tab))) {
        // A downloader took the address, and what came of it is counted.
      } else {
        // How far a fetch by the server has got is not known.
        const result =
          typeof file === "string"
            ? await api.fetchFile(file, tab)
            : await api.uploadFile(file, tab, (fraction) => setUploads("progress", fraction));
        setUploads(result.duplicate ? "duplicates" : "added", (n) => n + 1);
      }
    } catch (err) {
      const reason = errorMessage(err);
      setUploads("failures", (list) => [...list, { name: nameOf(file), reason }]);
    }
    setUploads({ done: uploads.done + 1, unpacking: null, downloading: null });
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
