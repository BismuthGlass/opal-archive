export type TabKind = "search" | "upload";

export type Tab = { id: number; position: number; kind: TabKind; query: string };

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
  collection: { collection_type: string; member_count: number } | null;
};

export type Scalar = { value: string | number | null; mixed: boolean };

/** What a set of entities has in common. */
export type Metadata = {
  count: number;
  files: number;
  collections: number;
  scalars: Record<string, Scalar>;
  collection_type: { value: string | null; mixed: boolean };
  tags: Record<string, { value: string; count: number }[]>;
  memberships: { id: number; title: string | null; collection_type: string; count: number }[];
};

export type Changes = {
  set?: Record<string, string | number | null>;
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
export const createTab = (kind: TabKind, query: string) =>
  request<Tab>("POST", "/tabs", { kind, query });
export const updateTab = (id: number, query: string) =>
  request<Tab>("PATCH", `/tabs/${id}`, { query });
export const deleteTab = (id: number) => request<void>("DELETE", `/tabs/${id}`);

/** `tab` narrows a search to the files uploaded through that upload tab. */
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
export const suggestTags = (field: string, q: string) =>
  request<{ value: string; count: number }[]>("GET", `/tags?${params({ field, q })}`);

export const createCollection = (collection_type: string, title: string, members: number[]) =>
  request<{ id: number }>("POST", "/collections", { collection_type, title, members });
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
