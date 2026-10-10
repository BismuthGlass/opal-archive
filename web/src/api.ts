export type TabKind = "gallery" | "upload" | "set" | "inbox" | "selection";

export type Tab = {
  id: number;
  position: number;
  kind: TabKind;
  query: string;
  /** Chosen by the user; empty if the tab goes by its query. */
  name: string;
  /** The set a set tab shows. */
  set: SetName | null;
};

/** Which set, by its ID, and what it is called: its title, or failing that the ID. */
export type SetName = { set_id: string; title: string | null };

/**
 * Files that belong together, in an order. A file can be in several, and a
 * set is not searched for: it is opened from one of its files.
 */
export type FileSet = SetName & {
  description: string | null;
  /** How many files it holds that are not in the trash. */
  files: number;
  source_url: string[];
  identifier: string[];
  reference: string[];
  /** What it is part of where it came from: a board, a thread. */
  collection: string[];
};

/** A downloader, as its manifest describes it. */
export type Downloader = {
  name: string;
  title: string;
  /** The `source` tag given to everything it downloads. */
  source: string;
  url_hint: string;
  /** The sites whose addresses are given to it. */
  sites?: string[];
  /** Present if it can use a login read from one of these browsers. */
  cookies: { browsers: string[] } | null;
  /** Its switches, and what each is set to: once, for every tab and the inbox. */
  options: { key: string; label: string; default: boolean }[];
  settings: Record<string, boolean>;
  /** When its login was saved, in seconds since 1970; `null` if none is. */
  login_saved: number | null;
  /**
   * Whether the server is where there is no browser to read a login from:
   * it is then sent one, as a cookie file.
   */
  headless: boolean;
};

/** How a download is going, or went. */
export type DownloadJob = {
  running: boolean;
  url: string;
  /** Things found to download; then how many were fetched, skipped, failed. */
  found: number;
  downloaded: number;
  skipped: number;
  failed: number;
  /** Files new to the library, and files it already had. */
  added: number;
  existing: number;
  message: string;
  errors: string[];
  /** Once ended: `done`, `cancelled`, or what stopped it. */
  outcome: string | null;
};

/** How an upload tab's download is going, or how its last one went. */
export type DownloadState = {
  /** How many things the tab has downloaded before, and will skip. */
  seen: number;
  job: DownloadJob | null;
};

/** Something the inbox was asked to download, and what became of it. */
export type InboxRequest = {
  id: number;
  url: string;
  /** The downloader it is for, by name. */
  downloader: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  /** Why it failed, or what went wrong on the way though it got there. */
  message: string;
  added: number;
  existing: number;
  date_queued: string;
  date_finished: string | null;
  /** Tags it brought for what it downloads: tag field to values. */
  tags: Record<string, string[]>;
};

/** The inbox: what was asked for from outside the interface. */
export type InboxState = {
  /** Its tab, once it has one. */
  tab: number | null;
  /** Every request not yet done, and the latest of the rest; oldest first. */
  queue: InboxRequest[];
  /** How the request being run is going. */
  job: DownloadJob | null;
  /** How many files its tab lists. */
  listed: number;
  /** Every downloader, and the tags it gives to what it downloads here. */
  downloaders: {
    downloader: Downloader;
    options: Record<string, boolean>;
    tags: Record<string, string[]>;
  }[];
};

/**
 * Files not in the trash, how many are in it, and how many of the rest
 * are in the inbox.
 */
export type Stats = { files: number; trashed: number; inbox: number };

export type MediaType = "image" | "video" | "audio" | "book" | "other";

export type FileEntity = {
  id: number;
  date_added: string;
  hash: string;
  extension: string;
  media_type: MediaType;
  size: number;
  original_name: string | null;
  width: number | null;
  height: number | null;
  page_count: number | null;
  length: number | null;
  has_thumbnail: boolean;
  /** What it shares with the files it is a variant of. */
  alt_group_id: string | null;
};

/** One entry of the results grid. */
export type Item = {
  id: number;
  title: string | null;
  media_type: MediaType;
  extension: string;
  length: number | null;
  /** The sets it is in, each with how many files not in the trash it holds. */
  set: (SetName & { files: number })[];
  /**
   * The group of variants it is one of, and how many files not in the
   * trash are in it, this one included.
   */
  alt_group_id: string | null;
  variants: number | null;
  has_thumbnail: boolean;
  /** Which file its thumbnail is of, for its address. */
  thumbnail_version: string | null;
  /** In the trash: deleted once, not yet for good. */
  trashed: boolean;
  /** In the inbox: new to the library, and not yet archived. */
  inbox: boolean;
};

export type SearchPage = { total: number; offset: number; items: Item[] };

export type Entity = {
  id: number;
  date_added: string;
  title: string | null;
  file: Omit<FileEntity, "id" | "date_added">;
  /** The sets it is in, and where in each. */
  set: (SetName & { index: number | null })[];
};

export type Scalar = { value: string | number | null; mixed: boolean };

/** What a set of entities has in common. */
export type Metadata = {
  count: number;
  /** How many of them are in the trash. */
  trashed: number;
  /** How many of them are in the inbox. */
  inbox: number;
  scalars: Record<string, Scalar>;
  tags: Record<string, { value: string; count: number; description: string | null }[]>;
  source_url: { value: string; count: number }[];
  identifier: { value: string; count: number }[];
  reference: { value: string; count: number }[];
  /** What they are part of where they came from: a board, a thread. */
  collection: { value: string; count: number }[];
  /** The sets any of them are in, and how many are in each. */
  set: (SetName & { count: number })[];
};

export type Changes = {
  set?: Record<string, string | number | boolean | null>;
  add?: Record<string, string[]>;
  remove?: Record<string, string[]>;
  /**
   * False to add only the tags given, without the child tags they would
   * bring: the tagger's, which has shown the children already.
   */
  children?: boolean;
  /** Source URLs, which are a list of their own rather than tags. */
  add_source_url?: string[];
  remove_source_url?: string[];
  /** Identifiers, likewise a list of their own. */
  add_identifier?: string[];
  remove_identifier?: string[];
  /** References, another such list. */
  add_reference?: string[];
  remove_reference?: string[];
  /** Collections: what something is part of where it came from. */
  add_collection?: string[];
  remove_collection?: string[];
  /** Sets to put the files in, or take them out of, by set ID. */
  add_set?: string[];
  remove_set?: string[];
};

export const TAG_FIELDS = [
  "tags",
  "creator",
  "character",
  "source_work",
  "person",
  "genre",
  "style",
  "medium",
  "flaws",
  "language",
  "source",
  "usage_tags",
  "ai_usage_tags",
  "bucket",
] as const;

export const CONTENT_RATINGS = ["safe", "risky", "nsfw"];

export class ApiError extends Error {
  /** Character offset into the line, for query errors. */
  position?: number;
  /** The line of a stacked query the error is in, from 0. */
  line?: number;
  /** The HTTP status the server answered with. */
  status?: number;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const error = new ApiError(detail?.error ?? `HTTP ${res.status}`);
    error.position = detail?.position;
    error.line = detail?.line;
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const params = (values: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]));

export const getSettings = () => request<Record<string, never>>("GET", "/settings");
/** Sets the given settings (`null` removes one) and returns them all. */
export const changeSettings = (changes: Record<string, unknown>) =>
  request<Record<string, never>>("PATCH", "/settings", changes);

export const getStats = () => request<Stats>("GET", "/stats");

export const listTabs = () => request<Tab[]>("GET", "/tabs");
export const createTab = (
  kind: TabKind,
  query: string,
  set?: string,
  /** For a selection tab, the entities it is to hold. */
  ids?: number[],
) => request<Tab>("POST", "/tabs", { kind, query, set, ids });

export const listDownloaders = () => request<Downloader[]>("GET", "/downloaders");
/** Reads the downloader's login from a browser and keeps it. */
export const takeLogin = (name: string, browser: string) =>
  request<Downloader>("POST", `/downloaders/${name}/cookies`, { browser });
/** Keeps a login sent as the text of a cookie file, in the Netscape format. */
export const uploadLogin = (name: string, cookies: string) =>
  request<Downloader>("POST", `/downloaders/${name}/cookies/file`, { cookies });
export const forgetLogin = (name: string) =>
  request<Downloader>("DELETE", `/downloaders/${name}/cookies`);
export const getDownload = (tab: number) =>
  request<DownloadState>("GET", `/tabs/${tab}/download`);
/**
 * Sets a downloader's options, which every tab and the inbox use, or the
 * tags the inbox has it give.
 */
export const configureDownloader = (
  name: string,
  changes: { options?: Record<string, boolean>; tags?: Record<string, string[]> },
) => request<void>("PATCH", `/downloaders/${name}`, changes);
/**
 * Starts downloading an address into an upload tab, with the downloader
 * whose site it is of. With none for it, nothing is started and the name
 * answered is `null`.
 */
export const startDownload = (tab: number, url: string) =>
  request<{ downloader: string | null }>("POST", `/tabs/${tab}/download/start`, { url });
export const cancelDownload = (tab: number) =>
  request<void>("POST", `/tabs/${tab}/download/cancel`);
export const getInbox = () => request<InboxState>("GET", "/inbox");
/** Asks for an address to be downloaded, when its turn comes. */
export const sendToInbox = (url: string) => request<InboxRequest>("POST", "/inbox", { url });
/** Empties what the inbox lists, and its finished requests; the library keeps it all. */
export const clearInbox = () => request<void>("POST", "/inbox/clear", {});
/** Takes a request off the queue, or stops it if it is the one running. */
export const removeRequest = (id: number) => request<void>("DELETE", `/inbox/queue/${id}`);
export const retryRequest = (id: number) =>
  request<InboxRequest>("POST", `/inbox/queue/${id}/retry`, {});

/** What the tab has downloaded before, newest first. */
export const seenDownloads = (tab: number) =>
  request<{ key: string; date: string }[]>("GET", `/tabs/${tab}/download/seen`);
/** Forgets the given keys, or all of them, so they are downloaded again. */
export const forgetSeen = (tab: number, keys?: string[]) =>
  request<{ forgotten: number }>("POST", `/tabs/${tab}/download/seen/forget`, { keys });
export const updateTab = (id: number, changes: { query?: string; name?: string }) =>
  request<Tab>("PATCH", `/tabs/${id}`, changes);
/** The snapshot of its search that a tab shows. */
export type TabView = { query: string; ids: number[]; custom: boolean };

/** The view a tab was left with, if one is saved. */
export const getTabView = (id: number) => request<TabView | null>("GET", `/tabs/${id}/view`);
export const saveTabView = (id: number, view: TabView) =>
  request<void>("PUT", `/tabs/${id}/view`, view);

export const orderTabs = (ids: number[]) => request<Tab[]>("PUT", "/tabs/order", { ids });
export const deleteTab = (id: number) => request<void>("DELETE", `/tabs/${id}`);

/**
 * What a search is kept to within a tab: a set's files, a group's
 * variants, or what is part of a collection.
 */
export type Within = { set: string } | { variants: string } | { collection: string };

/**
 * `tab` narrows a search to what an upload or set tab holds, and `within`
 * to a set, a group of variants or a collection instead.
 */
const scoped = (tab: number | null, within: Within | null = null): Record<string, string | number> => ({
  ...(tab === null ? {} : { tab }),
  ...(within ?? {}),
});

export const search = (
  q: string,
  offset: number,
  limit: number,
  seed: number,
  tab: number | null = null,
  /** Without this, trashed entities only match a query with `@trashed`. */
  withTrashed = false,
) =>
  request<SearchPage>(
    "GET",
    `/search?${params({ q, offset, limit, seed, ...scoped(tab), ...(withTrashed ? { trashed: 1 } : {}) })}`,
  );
export const searchIds = (
  q: string,
  seed: number,
  tab: number | null,
  within: Within | null = null,
  /** Without this, trashed entities only match a query with `@trashed`. */
  withTrashed = false,
  /** Lists a set once, as the first of its files that the search finds. */
  collapse = false,
) =>
  request<{ ids: number[] }>(
    "GET",
    `/search/ids?${params({
      q,
      seed,
      ...scoped(tab, within),
      ...(withTrashed ? { trashed: 1 } : {}),
      ...(collapse ? { collapse: 1 } : {}),
    })}`,
  ).then((r) => r.ids);

export const getEntity = (id: number) => request<Entity>("GET", `/entities/${id}`);
export const getMetadata = (ids: number[]) =>
  request<Metadata>("POST", "/entities/metadata", { ids });
export const edit = (ids: number[], changes: Changes) =>
  request<{ updated: number }>("POST", "/entities/edit", { ids, ...changes });
/** Moves entities to the trash: out of searches, but not yet gone. */
export const trashEntities = (ids: number[]) =>
  request<{ changed: number }>("POST", "/entities/trash", { ids });
export const restoreEntities = (ids: number[]) =>
  request<{ changed: number }>("POST", "/entities/restore", { ids });
/** Takes entities out of the inbox they arrived in: they have been looked over. */
export const archiveEntities = (ids: number[]) =>
  request<{ changed: number }>("POST", "/entities/archive", { ids });
/** Puts entities back in the inbox. */
export const unarchiveEntities = (ids: number[]) =>
  request<{ changed: number }>("POST", "/entities/unarchive", { ids });
/** Deletes trashed entities for good; any not in the trash are left alone. */
export const deleteEntities = (ids: number[]) =>
  request<{ deleted: number }>("POST", "/entities/delete", { ids });
/** A tag, or a namespace (ending in a colon) to look further into. */
export type Suggestion = {
  value: string;
  count: number;
  namespace: boolean;
  /** The alias that was typed, when the tag was found through one. */
  alias?: string;
  description?: string;
};

/**
 * A tag in the tag manager, with the aliases that defer to it. An alias is
 * a tag there too: `alias_of` is the tag it defers to, and its `count` the
 * items still carrying the alias itself.
 */
export type TagEntry = {
  value: string;
  count: number;
  description: string | null;
  /** `count` is the items still carrying the alias itself. */
  aliases: { value: string; count: number }[];
  alias_of: string | null;
  /** The tags, of any type, added to an item along with this one. */
  children: { field: string; value: string }[];
};

export const suggestTags = (field: string, q: string) =>
  request<Suggestion[]>("GET", `/tags?${params({ field, q })}`);
/** Renames a tag; if a tag named `to` exists the two are merged. */
export const renameTag = (field: string, from: string, to: string) =>
  request<{ renamed: number }>("POST", "/tags/rename", { field, from, to });
/** `pending` counts items, in any field, still carrying an alias. */
export const listTags = (field: string) =>
  request<{ tags: TagEntry[]; pending: number }>("GET", `/tags/all?${params({ field })}`);
/** Creates a tag nothing carries yet; it is kept until deleted. */
export const createTag = (field: string, value: string) =>
  request<{ value: string }>("POST", "/tags", { field, value });
/** Sets a tag's description; an empty one clears it. */
export const describeTag = (field: string, value: string, description: string) =>
  request<{ value: string }>("POST", "/tags/describe", { field, value, description });
/** Deletes a tag that nothing carries. */
export const deleteTag = (field: string, value: string) =>
  request<void>("POST", "/tags/delete", { field, value });
/** Makes `alias` stand for `target`; an empty target removes the alias. */
export const setAlias = (field: string, alias: string, target: string) =>
  request<void>("POST", "/tags/alias", { field, alias, target });
/**
 * Gives a tag a child tag, added to an item whenever the tag is, or with
 * `remove` takes the child away. Items that carry the tag are not changed.
 */
export const setChild = (
  field: string,
  value: string,
  child: { field: string; value: string },
  remove = false,
) =>
  request<void>("POST", "/tags/child", {
    field,
    value,
    child_field: child.field,
    child: child.value,
    remove,
  });
/** Every tag that adding this one brings: its children, and theirs. */
export const childrenOf = (field: string, value: string) =>
  request<{ field: string; value: string }[]>("GET", `/tags/children?${params({ field, value })}`);
/** Replaces aliases still on items with the tags they stand for. */
export const applyAliases = () =>
  request<{ updated: number }>("POST", "/tags/aliases/apply", {});

/**
 * What can be changed of a set, written as an edit of entities is: its
 * `set_id`, `title` and `description`, and its plain lists. It has no tags.
 */
export type SetChanges = Omit<Changes, "add" | "remove" | "add_set" | "remove_set">;

/**
 * Puts the files in the set of an ID, in the order given, after what it
 * holds: the set that has the ID, or a new one of it. With no ID, a set is
 * made with one made up for it. The title is given to the set if it has
 * none.
 */
export const joinSet = (files: number[], title: string, set_id = "") =>
  request<{ set_id: string }>("POST", "/sets", { files, title, set_id });
/** What is known of a set, by its ID: it may be the ID alone. */
export const getSet = (set_id: string) => request<FileSet>("GET", `/sets?${params({ set_id })}`);
/**
 * What is known of a collection, by the name files and sets give it. It
 * may be the name alone: nothing is kept of a collection until something
 * is said of it.
 */
export type Collection = {
  name: string;
  title: string | null;
  description: string | null;
  /** How many files not in the trash are part of it, themselves or through a set. */
  files: number;
  source_url: string[];
  identifier: string[];
  reference: string[];
};

export const getCollection = (name: string) =>
  request<Collection>("GET", `/collections?${params({ name })}`);
/** Changes what is known of a collection; the first change is what keeps anything of it. */
export const changeCollection = (name: string, changes: SetChanges) =>
  request<Collection>("PATCH", `/collections?${params({ name })}`, changes);

/** Changes what is known of a set; `set.set_id` gives it another ID. */
export const changeSet = (set_id: string, changes: SetChanges) =>
  request<FileSet>("PATCH", `/sets?${params({ set_id })}`, changes);
/** Takes a set apart: its files stay, no longer in it. */
export const deleteSet = (set_id: string) =>
  request<void>("DELETE", `/sets?${params({ set_id })}`);
/** Puts files in a set, or takes them out of it. */
export const changeSetFiles = (set_id: string, changes: { add?: number[]; remove?: number[] }) =>
  request<{ files: number }>("POST", `/sets/files?${params({ set_id })}`, changes);
/** Sets the order of a set's files. */
export const setOrder = (set_id: string, ids: number[]) =>
  request<void>("PUT", `/sets/order?${params({ set_id })}`, { ids });
/** Makes files variants of each other: they share the group answered. */
export const groupVariants = (ids: number[]) =>
  request<{ alt_group_id: string }>("POST", "/variants", { ids });

/**
 * With the version a search result gives, the address is of that one
 * file's thumbnail and no other's, and the browser keeps it for good.
 */
export const thumbnailUrl = (fileId: number, version: string | null) =>
  `/api/files/${fileId}/thumbnail${version ? `?v=${version}` : ""}`;
/**
 * What a file is called when it leaves the library: the name it was
 * uploaded under, its title where it has one, its hash, or letters and
 * digits that say nothing of it.
 */
export type Naming = "original" | "title" | "hash" | "random";

/** The file, to show; or with `names`, to save under a name of that sort. */
export const contentUrl = (fileId: number, names?: Naming) =>
  `/api/files/${fileId}/content${names ? `?download=1&names=${names}` : ""}`;

/**
 * Downloads the files as one zip. Submitted as a form so the browser
 * handles it as a download. With `sidecars` it is an export: each file has
 * its metadata beside it, as `<name>.json`, and each set that says
 * something of itself a sidecar of its own, for a zip that gives a library
 * all of it back when it is uploaded. `names` is what the files are called
 * in it.
 */
export function exportZip(ids: number[], names: Naming, sidecars = false) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/export";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "ids";
  input.value = ids.join(",");
  form.append(input);
  const fields = { names, ...(sidecars ? { sidecars: "1" } : {}) };
  for (const [name, value] of Object.entries(fields)) {
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = name;
    field.value = value;
    form.append(field);
  }
  document.body.append(form);
  form.submit();
  form.remove();
}

/**
 * Has the server fetch the file at a web address, as an upload of it.
 * `duplicate` is true when the same content was already in the library.
 */
export async function fetchFile(
  url: string,
  tab: number,
): Promise<{ file: FileEntity; duplicate: boolean }> {
  const res = await fetch("/api/files/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, tab }),
  });
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw new Error(answer?.error ?? `HTTP ${res.status}`);
  return { file: answer, duplicate: res.status === 200 };
}

/**
 * Uploads one file as the raw request body. `duplicate` is true when the
 * same content was already in the library. Uses XMLHttpRequest because
 * fetch cannot report upload progress.
 */
/** Sends a file as the body of a request, saying how far it has got. */
function sendFile(
  path: string,
  file: File,
  tab: number,
  onProgress: (fraction: number) => void,
): Promise<{ status: number; answer: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}?${params({ name: file.name, tab })}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        resolve({ status: xhr.status, answer: xhr.response });
      } else {
        reject(new Error(xhr.response?.error ?? `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("could not reach the server"));
    xhr.send(file);
  });
}

export const uploadFile = (file: File, tab: number, onProgress: (fraction: number) => void) =>
  sendFile("/files", file, tab, onProgress).then(({ status, answer }) => ({
    file: answer as FileEntity,
    duplicate: status === 200,
  }));

/** The tags an upload tab gives to everything uploaded into it: tag field to values. */
export const getUploadTags = (tab: number) =>
  request<{ tags: Record<string, string[]> }>("GET", `/tabs/${tab}/upload`).then((r) => r.tags);
export const setUploadTags = (tab: number, tags: Record<string, string[]>) =>
  request<void>("PATCH", `/tabs/${tab}/upload`, { tags });

/** What came of unpacking an archive into the library. */
export type Unpacked = {
  /** Files that were new to the library, and ones it already had. */
  added: number;
  duplicates: number;
  /** Sets made of its folders, and for its sidecars. */
  sets: number;
  /**
   * The files in it that were not taken in, by where they are in it, and
   * the sidecars some of which could not be used.
   */
  failures: { name: string; reason: string }[];
};

/**
 * Uploads a zip to be unpacked: its files go into the library, its folders
 * become sets, its sidecars give both their metadata, and the archive
 * itself is not kept.
 */
export const uploadArchive = (file: File, tab: number, onProgress: (fraction: number) => void) =>
  sendFile("/files/archive", file, tab, onProgress).then(({ answer }) => answer as Unpacked);
