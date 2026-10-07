export type TabKind = "gallery" | "upload" | "collection" | "download" | "inbox" | "selection";

export type Tab = {
  id: number;
  position: number;
  kind: TabKind;
  query: string;
  /** Chosen by the user; empty if the tab goes by its query. */
  name: string;
  /** The collection a collection tab shows. */
  collection: {
    id: number;
    title: string | null;
    ordered: boolean;
    /** Its identifier, if it has one. */
    collection_id: string | null;
  } | null;
  /** The downloader a download tab uses, by name. */
  downloader: string | null;
};

/** A downloader, as its manifest describes it. */
export type Downloader = {
  name: string;
  title: string;
  /** The `source` tag given to everything it downloads. */
  source: string;
  url_hint: string;
  /** The sites whose addresses the inbox gives it. */
  sites?: string[];
  /** Present if it can use a login read from one of these browsers. */
  cookies: { browsers: string[] } | null;
  /** Switches set per tab. */
  options: { key: string; label: string; default: boolean }[];
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

/** Everything a download tab's panel shows. */
export type DownloadState = {
  downloader: Downloader;
  options: Record<string, boolean>;
  /** Tags given to everything downloaded: tag field to values. */
  tags: Record<string, string[]>;
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
  /** How many files and collections its tab lists. */
  listed: number;
  /** Every downloader, as it is set for the inbox. */
  downloaders: {
    downloader: Downloader;
    options: Record<string, boolean>;
    tags: Record<string, string[]>;
  }[];
};

/** Files and collections not in the trash, and how many entities are in it. */
export type Stats = { files: number; collections: number; trashed: number };

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
};

/** One entry of the results grid. */
export type Item = {
  id: number;
  kind: "file" | "collection";
  title: string | null;
  media_type: MediaType | null;
  extension: string | null;
  length: number | null;
  collection_type: string | null;
  /** A collection's identifier, if it has one. */
  collection_id: string | null;
  /** File whose thumbnail stands for this entry, if any. */
  thumbnail: number | null;
  /** Which file that thumbnail is of, for its address. */
  thumbnail_version: string | null;
  member_count: number | null;
  /** In the trash: deleted once, not yet for good. */
  trashed: boolean;
};

export type SearchPage = { total: number; offset: number; items: Item[] };

export type Entity = {
  id: number;
  kind: "file" | "collection";
  date_added: string;
  title: string | null;
  file: Omit<FileEntity, "id" | "date_added"> | null;
  collection: {
    collection_type: string;
    member_count: number;
    ordered: boolean;
    /** Its identifier, which no other collection has. */
    collection_id: string | null;
  } | null;
};

export type Scalar = { value: string | number | null; mixed: boolean };

/** What a set of entities has in common. */
export type Metadata = {
  count: number;
  files: number;
  collections: number;
  /** How many of them are in the trash. */
  trashed: number;
  scalars: Record<string, Scalar>;
  collection_type: { value: string | null; mixed: boolean };
  /** Whether the selected collections keep their members in order. */
  ordered: { value: boolean | null; mixed: boolean };
  /** The identifier of the selected collection: one collection's alone. */
  collection_id: { value: string | null; mixed: boolean };
  tags: Record<string, { value: string; count: number; description: string | null }[]>;
  source_urls: { value: string; count: number }[];
  identifiers: { value: string; count: number }[];
  memberships: {
    id: number;
    title: string | null;
    collection_type: string;
    count: number;
    /** Its identifier, if it has one. */
    collection_id: string | null;
  }[];
};

export type Changes = {
  set?: Record<string, string | number | boolean | null>;
  add?: Record<string, string[]>;
  remove?: Record<string, string[]>;
  /** Source URLs, which are a list of their own rather than tags. */
  add_urls?: string[];
  remove_urls?: string[];
  /** Identifiers, likewise a list of their own. */
  add_identifiers?: string[];
  remove_identifiers?: string[];
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

export const COLLECTION_TYPES = ["usercollection", "set", "sequence", "variant", "sourceset"];
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
  collection?: number,
  downloader?: string,
  /** For a selection tab, the entities it is to hold. */
  ids?: number[],
) => request<Tab>("POST", "/tabs", { kind, query, collection, downloader, ids });

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
export const configureDownload = (
  tab: number,
  changes: { options?: Record<string, boolean>; tags?: Record<string, string[]> },
) => request<void>("PATCH", `/tabs/${tab}/download`, changes);
export const startDownload = (tab: number, url: string) =>
  request<void>("POST", `/tabs/${tab}/download/start`, { url });
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
export const configureInbox = (
  downloader: string,
  changes: { options?: Record<string, boolean>; tags?: Record<string, string[]> },
) => request<void>("PATCH", `/inbox/settings/${downloader}`, changes);

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
 * `tab` narrows a search to what an upload or collection tab holds, and
 * `collection` to the members of a collection instead.
 */
const scoped = (tab: number | null, collection: number | null = null): Record<string, number> => ({
  ...(tab === null ? {} : { tab }),
  ...(collection === null ? {} : { collection }),
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
  collection: number | null = null,
  /** Without this, trashed entities only match a query with `@trashed`. */
  withTrashed = false,
) =>
  request<{ ids: number[] }>(
    "GET",
    `/search/ids?${params({ q, seed, ...scoped(tab, collection), ...(withTrashed ? { trashed: 1 } : {}) })}`,
  ).then((r) => r.ids);

export const getEntity = (id: number) => request<Entity>("GET", `/entities/${id}`);
export const getMetadata = (ids: number[]) =>
  request<Metadata>("POST", "/entities/metadata", { ids });
export const edit = (ids: number[], changes: Changes) =>
  request<{ updated: number }>("POST", "/entities/edit", { ids, ...changes });
/** Moves entities to the trash: out of searches, but not yet gone. */
export const trashEntities = (ids: number[]) =>
  request<{ changed: number }>("POST", "/entities/trash", { ids });
/**
 * What is inside these collections, at any depth: what of it is not in the
 * trash or, with `trashed`, what of it is.
 */
export async function insideOf(ids: number[], trashed = false): Promise<number[]> {
  const found = new Set<number>();
  // In batches, to keep each address a reasonable length.
  for (let at = 0; at < ids.length; at += 200) {
    const batch = ids.slice(at, at + 200).join(",");
    const query = `within=(id=${batch})${trashed ? " @trashed" : ""}`;
    for (const id of await searchIds(query, 0, null)) found.add(id);
  }
  return [...found];
}
export const restoreEntities = (ids: number[]) =>
  request<{ changed: number }>("POST", "/entities/restore", { ids });
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

/** A tag in the tag editor, with the aliases that defer to it. */
export type TagEntry = {
  value: string;
  count: number;
  description: string | null;
  /** `count` is the items still carrying the alias itself. */
  aliases: { value: string; count: number }[];
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
/** Replaces aliases still on items with the tags they stand for. */
export const applyAliases = () =>
  request<{ updated: number }>("POST", "/tags/aliases/apply", {});

export const createCollection = (
  collection_type: string,
  title: string,
  members: number[],
  /** `parent` is a collection to put the new one into. */
  options: { ordered?: boolean; parent?: number } = {},
) =>
  request<{ id: number }>("POST", "/collections", { collection_type, title, members, ...options });
/** Sets the order of an ordered collection's members. */
export const setOrder = (id: number, ids: number[]) =>
  request<void>("PUT", `/collections/${id}/order`, { ids });
export const changeMembers = (id: number, changes: { add?: number[]; remove?: number[] }) =>
  request<{ member_count: number }>("POST", `/collections/${id}/members`, changes);

/**
 * With the version a search result gives, the address is of that one
 * file's thumbnail and no other's, and the browser keeps it for good.
 */
export const thumbnailUrl = (fileId: number, version: string | null) =>
  `/api/files/${fileId}/thumbnail${version ? `?v=${version}` : ""}`;
export const contentUrl = (fileId: number, download = false) =>
  `/api/files/${fileId}/content${download ? "?download=1" : ""}`;

/**
 * Downloads the files behind `ids` (collections included, at any depth) as
 * one zip. Submitted as a form so the browser handles it as a download.
 */
export function exportZip(ids: number[]) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/export";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "ids";
  input.value = ids.join(",");
  form.append(input);
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
  /** Collections made of its folders. */
  collections: number;
  /** The files in it that were not taken in, by where they are in it. */
  failures: { name: string; reason: string }[];
};

/**
 * Uploads a zip to be unpacked: its files go into the library, its folders
 * become collections, and the archive itself is not kept.
 */
export const uploadArchive = (file: File, tab: number, onProgress: (fraction: number) => void) =>
  sendFile("/files/archive", file, tab, onProgress).then(({ answer }) => answer as Unpacked);
