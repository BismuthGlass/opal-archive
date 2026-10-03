export type TabKind = "gallery" | "upload" | "collection";

export type Tab = {
  id: number;
  position: number;
  kind: TabKind;
  query: string;
  /** Chosen by the user; empty if the tab goes by its query. */
  name: string;
  /** The collection a collection tab shows. */
  collection: { id: number; title: string | null; ordered: boolean } | null;
};

export type Stats = { files: number; collections: number };

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
  /** File whose thumbnail stands for this entry, if any. */
  thumbnail: number | null;
  member_count: number | null;
};

export type SearchPage = { total: number; offset: number; items: Item[] };

export type Entity = {
  id: number;
  kind: "file" | "collection";
  date_added: string;
  file: Omit<FileEntity, "id" | "date_added"> | null;
  collection: { collection_type: string; member_count: number; ordered: boolean } | null;
};

export type Scalar = { value: string | number | null; mixed: boolean };

/** What a set of entities has in common. */
export type Metadata = {
  count: number;
  files: number;
  collections: number;
  scalars: Record<string, Scalar>;
  collection_type: { value: string | null; mixed: boolean };
  /** Whether the selected collections keep their members in order. */
  ordered: { value: boolean | null; mixed: boolean };
  tags: Record<string, { value: string; count: number }[]>;
  memberships: { id: number; title: string | null; collection_type: string; count: number }[];
};

export type Changes = {
  set?: Record<string, string | number | boolean | null>;
  add?: Record<string, string[]>;
  remove?: Record<string, string[]>;
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
  "source_url",
  "identifier",
  "usage_tags",
  "ai_usage_tags",
] as const;

/** Tag fields whose values are not names: a colon in them is no namespace. */
export const FLAT_TAG_FIELDS: readonly string[] = ["source_url"];

export const COLLECTION_TYPES = ["usercollection", "set", "sequence", "variant", "sourceset"];
export const CONTENT_RATINGS = ["safe", "risky", "nsfw"];
export const AI_CONTENT = ["none", "partial", "full", "unknown"];

export class ApiError extends Error {
  /** Character offset into the query, for query errors. */
  position?: number;
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
    throw error;
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const params = (values: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]));

export const getStats = () => request<Stats>("GET", "/stats");

export const listTabs = () => request<Tab[]>("GET", "/tabs");
export const createTab = (kind: TabKind, query: string, collection?: number) =>
  request<Tab>("POST", "/tabs", { kind, query, collection });
export const updateTab = (id: number, changes: { query?: string; name?: string }) =>
  request<Tab>("PATCH", `/tabs/${id}`, changes);
export const orderTabs = (ids: number[]) => request<Tab[]>("PUT", "/tabs/order", { ids });
export const deleteTab = (id: number) => request<void>("DELETE", `/tabs/${id}`);

/** `tab` narrows a search to what an upload or collection tab holds. */
const scoped = (tab: number | null): Record<string, number> => (tab === null ? {} : { tab });

export const search = (
  q: string,
  offset: number,
  limit: number,
  seed: number,
  tab: number | null = null,
) => request<SearchPage>("GET", `/search?${params({ q, offset, limit, seed, ...scoped(tab) })}`);
export const searchIds = (q: string, seed: number, tab: number | null) =>
  request<{ ids: number[] }>("GET", `/search/ids?${params({ q, seed, ...scoped(tab) })}`).then(
    (r) => r.ids,
  );

export const getEntity = (id: number) => request<Entity>("GET", `/entities/${id}`);
export const getMetadata = (ids: number[]) =>
  request<Metadata>("POST", "/entities/metadata", { ids });
export const edit = (ids: number[], changes: Changes) =>
  request<{ updated: number }>("POST", "/entities/edit", { ids, ...changes });
export const deleteEntities = (ids: number[]) =>
  request<{ deleted: number }>("POST", "/entities/delete", { ids });
/** A tag, or a namespace (ending in a colon) to look further into. */
export type Suggestion = {
  value: string;
  count: number;
  namespace: boolean;
  /** The alias that was typed, when the tag was found through one. */
  alias?: string;
};

/** A tag in the tag editor, with the aliases that defer to it. */
export type TagEntry = {
  value: string;
  count: number;
  /** `count` is the items still carrying the alias itself. */
  aliases: { value: string; count: number }[];
};

export const suggestTags = (field: string, q: string) =>
  request<Suggestion[]>("GET", `/tags?${params({ field, q })}`);
/** Renames a namespace on every tag under it; an empty `to` removes it. */
export const renameNamespace = (field: string, from: string, to: string) =>
  request<{ renamed: number }>("POST", "/tags/rename", { field, from, to, namespace: true });
/** Renames a tag; if a tag named `to` exists the two are merged. */
export const renameTag = (field: string, from: string, to: string) =>
  request<{ renamed: number }>("POST", "/tags/rename", { field, from, to });
/** `pending` counts items, in any field, still carrying an alias. */
export const listTags = (field: string) =>
  request<{ tags: TagEntry[]; pending: number }>("GET", `/tags/all?${params({ field })}`);
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

export const thumbnailUrl = (fileId: number) => `/api/files/${fileId}/thumbnail`;
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
 * Uploads one file as the raw request body. `duplicate` is true when the
 * same content was already in the library. Uses XMLHttpRequest because
 * fetch cannot report upload progress.
 */
export function uploadFile(
  file: File,
  tab: number,
  onProgress: (fraction: number) => void,
): Promise<{ file: FileEntity; duplicate: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files?${params({ name: file.name, tab })}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        resolve({ file: xhr.response, duplicate: xhr.status === 200 });
      } else {
        reject(new Error(xhr.response?.error ?? `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("could not reach the server"));
    xhr.send(file);
  });
}
