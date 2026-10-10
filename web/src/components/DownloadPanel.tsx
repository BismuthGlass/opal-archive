import { createResource, createSignal, For, onMount, Show } from "solid-js";
import * as api from "../api";
import type { Changes, DownloadJob, DownloadState, Metadata } from "../api";
import { downloadState, loadDownload, startDownload } from "../downloads";
import type { PanelProps } from "../downloaders";
import { dateTime, errorMessage, fieldLabel, plural } from "../format";
import { pillStyle } from "../tagTypes";
import Icon from "./Icon";
import Modal from "./Modal";
import { createStoredFlag } from "./Panel";
import { TagsEditor } from "./Tags";

/** How a download went, or is going, in a sentence. */
function summary(job: DownloadJob) {
  const files =
    job.existing > 0
      ? `${plural(job.added, "new file")}, ${job.existing} already in the library`
      : plural(job.added, "new file");
  return [
    `${job.downloaded} downloaded (${files})`,
    ...(job.skipped > 0 ? [`${job.skipped} skipped as seen before`] : []),
    ...(job.failed > 0 ? [`${job.failed} failed`] : []),
  ].join(", ");
}

/**
 * The panel at the top of a download tab, built from the downloader's
 * manifest: the box an address is pasted into, and under it the settings
 * of this tab (the downloader's options, the tags given to everything
 * downloaded, the login, and what has been downloaded before).
 */
export default function DownloadPanel(props: PanelProps) {
  const [url, setUrl] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [settingsOpen, setSettingsOpen] = createStoredFlag("opalarchive.download.settings", true);
  const [showSeen, setShowSeen] = createSignal(false);
  const state = () => downloadState(props.tab);
  const running = () => state()?.job?.running ?? false;

  /** Does something, shows what went wrong if anything, and reads the state again. */
  const attempt = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    await loadDownload(props.tab).catch(() => {});
  };
  onMount(() => attempt(async () => {}));

  const start = () => {
    const address = url().trim();
    if (!address || running()) return;
    attempt(async () => {
      await startDownload(props.tab, address);
      setUrl("");
    });
  };

  return (
    <Show when={state()}>
      {(data) => (
        <section class="download-panel" aria-label={`${data().downloader.title} downloader`}>
          <div class="download-row">
            <input
              type="text"
              class="download-url"
              aria-label="Address to download"
              placeholder={data().downloader.url_hint || "An address to download"}
              autocomplete="off"
              spellcheck={false}
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && start()}
            />
            <Show
              when={running()}
              fallback={
                <button class="primary" disabled={!url().trim()} onClick={start}>
                  Download
                </button>
              }
            >
              <button onClick={() => attempt(() => api.cancelDownload(props.tab))}>Cancel</button>
            </Show>
            <button
              class="icon-button"
              aria-pressed={settingsOpen()}
              aria-label="Settings of this downloader"
              title={settingsOpen() ? "Hide the settings" : "Show the settings"}
              onClick={() => setSettingsOpen(!settingsOpen())}
            >
              <Icon name="settings-outline" />
            </button>
          </div>
          <Show when={error()}>
            <p class="form-error" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={data().job}>{(job) => <Progress job={job()} />}</Show>
          <Show when={settingsOpen()}>
            {/* A label beside each setting. */}
            <div class="download-settings">
              <Show when={data().downloader.options.length > 0}>
                <span class="label">Options</span>
              </Show>
              <div class="download-options">
                <For each={data().downloader.options}>
                  {(option) => (
                    <label class="download-option">
                      <input
                        type="checkbox"
                        checked={data().options[option.key] ?? option.default}
                        onChange={(event) => {
                          const value = event.currentTarget.checked;
                          attempt(() =>
                            api.configureDownload(props.tab, { options: { [option.key]: value } }),
                          );
                        }}
                      />
                      {option.label}
                    </label>
                  )}
                </For>
              </div>
              <BaseTags
                data={data()}
                error={error()}
                onChange={(tags) => attempt(() => api.configureDownload(props.tab, { tags }))}
              />
              <Show when={data().downloader.cookies}>
                <Login data={data()} attempt={attempt} />
              </Show>
              <span class="label">Seen before</span>
              <div>
                <Show
                  when={data().seen > 0}
                  fallback={
                    <span class="hint">
                      Nothing yet. What this tab downloads is skipped the next time.
                    </span>
                  }
                >
                  <button class="link" onClick={() => setShowSeen(true)}>
                    {plural(data().seen, "item")}, skipped when met again
                  </button>
                </Show>
              </div>
            </div>
          </Show>
          <Show when={showSeen()}>
            <SeenList
              tab={props.tab}
              onClose={() => {
                setShowSeen(false);
                attempt(async () => {});
              }}
            />
          </Show>
        </section>
      )}
    </Show>
  );
}

/** How the tab's download is going, or how the last one went. */
export function Progress(props: { job: DownloadJob }) {
  const handled = () => props.job.downloaded + props.job.skipped + props.job.failed;
  return (
    <div class="download-progress" aria-live="polite">
      <Show
        when={props.job.running}
        fallback={
          <p>
            <strong>
              {props.job.outcome === "done"
                ? "Done"
                : props.job.outcome === "cancelled"
                  ? "Cancelled"
                  : "Failed"}
              :
            </strong>{" "}
            <Show when={props.job.outcome !== "done" && props.job.outcome !== "cancelled"}>
              {props.job.outcome}.{" "}
            </Show>
            {/* A download that got nowhere has nothing to count. */}
            <Show when={props.job.outcome === "done" || handled() > 0}>{summary(props.job)}</Show>
          </p>
        }
      >
        {/* With no value at all the bar shows that work is going on; it
            cannot be given an empty one. */}
        <Show when={props.job.found > 0} fallback={<progress />}>
          <progress value={handled() / props.job.found} />
        </Show>
        <p>
          <Show when={props.job.found > 0} fallback={props.job.message || "Starting"}>
            {handled()} of {props.job.found}: {summary(props.job)}
          </Show>
        </p>
      </Show>
      <Show when={props.job.errors.length > 0}>
        <details>
          <summary>{plural(props.job.errors.length, "problem")}</summary>
          <ul class="download-errors">
            <For each={props.job.errors}>{(message) => <li>{message}</li>}</For>
          </ul>
        </details>
      </Show>
    </div>
  );
}

/**
 * The tags given to everything the tab downloads, besides the downloader's
 * own source tag, which is implied. They are shown as pills and edited in
 * the same editor as a file's tags.
 */
export function BaseTags(props: {
  /** The tags, and the downloader if they are a downloader's. */
  data: Pick<DownloadState, "tags"> & { downloader?: DownloadState["downloader"] };
  /** What went wrong with the last change, if anything. */
  error: string | null;
  onChange: (tags: Record<string, string[]>) => void;
}) {
  /** What the tags are given to: what a downloader fetches, or what is uploaded. */
  const given = () => (props.data.downloader ? "downloaded" : "uploaded");
  const [editing, setEditing] = createSignal(false);
  const entries = () =>
    Object.entries(props.data.tags).flatMap(([field, values]) =>
      values.map((value) => ({ field, value })),
    );

  /** The tab's tags as the editor reads a selection's: one item with them all. */
  const asSelection = (): Metadata => ({
    count: 1,
    files: 0,
    collections: 0,
    trashed: 0,
    scalars: {},
    collection_type: { value: null, mixed: false },
    ordered: { value: null, mixed: false },
    collection_id: { value: null, mixed: false },
    tags: Object.fromEntries(
      Object.entries(props.data.tags).map(([field, values]) => [
        field,
        values.map((value) => ({ value, count: 1, description: null })),
      ]),
    ),
    source_urls: [],
    identifier: [],
    reference: [],
    memberships: [],
  });

  /** The editor's changes, made to the tab's tags. */
  const apply = (changes: Changes) => {
    const tags = { ...props.data.tags };
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    for (const [field, values] of Object.entries(changes.add ?? {})) {
      const fresh = values.filter((value) => !(tags[field] ?? []).some((had) => same(had, value)));
      tags[field] = [...(tags[field] ?? []), ...fresh];
    }
    for (const [field, values] of Object.entries(changes.remove ?? {})) {
      tags[field] = (tags[field] ?? []).filter((had) => !values.some((value) => same(had, value)));
    }
    props.onChange(tags);
  };

  return (
    <>
      <span
        class="label"
        title={
          props.data.downloader
            ? `Given to everything downloaded, besides the source tag ${props.data.downloader.source}`
            : "Given to everything uploaded into this tab from now on"
        }
      >
        Tags to add
      </span>
      <div class="chips download-tags">
        <For each={entries()}>
          {(entry) => (
            <span
              class="chip tinted"
              style={pillStyle(entry.field)}
              title={`${fieldLabel(entry.field)}: ${entry.value}`}
            >
              <span class="chip-label">{entry.value}</span>
            </span>
          )}
        </For>
        <button
          class="chip chip-edit"
          aria-label="Edit the tags to add"
          title={`Add or remove tags given to everything ${given()}`}
          onClick={() => setEditing(true)}
        >
          <Icon name="add" />
          <Show when={entries().length === 0}>Tags</Show>
        </button>
      </div>
      <Show when={editing()}>
        <Modal
          title={`Tags to add to everything ${given()}`}
          medium
          onClose={() => setEditing(false)}
        >
          <div class="field-editor">
            <TagsEditor data={asSelection()} apply={apply} />
          </div>
          <Show when={props.error}>
            <p class="form-error" role="alert">
              {props.error}
            </p>
          </Show>
        </Modal>
      </Show>
    </>
  );
}

/**
 * The downloader's login to its site, read from a browser and kept by the
 * server. It is shared by every tab of the downloader.
 */
export function Login(props: {
  data: Pick<DownloadState, "downloader">;
  attempt: (action: () => Promise<unknown>) => void;
}) {
  const downloader = () => props.data.downloader;
  const [browser, setBrowser] = createSignal(downloader().cookies?.browsers[0] ?? "");
  const [reading, setReading] = createSignal(false);
  const saved = () => downloader().login_saved;

  const take = () => {
    setReading(true);
    props.attempt(() =>
      api.takeLogin(downloader().name, browser()).finally(() => setReading(false)),
    );
  };
  /** Sends a cookie file: what a server with no browser is given instead. */
  let picker!: HTMLInputElement;
  const upload = () => {
    const file = picker.files?.[0];
    if (!file) return;
    setReading(true);
    props.attempt(async () => {
      try {
        await api.uploadLogin(downloader().name, await file.text());
      } finally {
        setReading(false);
        // The same file can be chosen again.
        picker.value = "";
      }
    });
  };

  return (
    <>
      <span class="label">Login</span>
      <div class="download-login">
        <Show
          when={saved()}
          fallback={
            <span class="hint">
              None saved: only what {downloader().title} shows to visitors can be downloaded.
            </span>
          }
        >
          {(time) => <span>Saved {dateTime(new Date(time() * 1000).toISOString())}</span>}
        </Show>
        <Show
          when={downloader().headless}
          fallback={
            <>
              <select
                aria-label="Browser to read the login from"
                value={browser()}
                onChange={(event) => setBrowser(event.currentTarget.value)}
              >
                <For each={downloader().cookies?.browsers ?? []}>
                  {(name) => <option value={name}>{fieldLabel(name)}</option>}
                </For>
              </select>
              <button
                disabled={reading()}
                title={`Reads your ${downloader().title} login from the browser and keeps it for later downloads`}
                onClick={take}
              >
                {reading() ? "Reading…" : saved() ? "Read it again" : "Get it from the browser"}
              </button>
            </>
          }
        >
          {/* The server has no browser: it is sent the login. */}
          <input
            ref={picker}
            type="file"
            accept=".txt,text/plain"
            hidden
            aria-label="Cookie file to upload"
            onChange={upload}
          />
          <button
            disabled={reading()}
            title={`Upload a cookie file exported from a browser logged in to ${downloader().title} (a cookies.txt). Only ${downloader().title}'s cookies are kept. The browser extension can send the login for you instead.`}
            onClick={() => picker.click()}
          >
            {reading() ? "Sending…" : saved() ? "Upload another" : "Upload a cookie file"}
          </button>
        </Show>
        <Show when={saved()}>
          <button
            class="link"
            onClick={() => props.attempt(() => api.forgetLogin(downloader().name))}
          >
            Forget
          </button>
        </Show>
      </div>
    </>
  );
}

/** What the tab has downloaded before; forgetting one has it fetched again. */
function SeenList(props: { tab: number; onClose: () => void }) {
  const [seen, { refetch }] = createResource(() => props.tab, api.seenDownloads);
  const [error, setError] = createSignal<string | null>(null);
  const forget = async (keys?: string[]) => {
    try {
      await api.forgetSeen(props.tab, keys);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    refetch();
  };
  return (
    <Modal title="Downloaded before in this tab" wide tall onClose={props.onClose}>
      <p class="hint">
        These are skipped when met again. Forget one to have it downloaded the next time. The list
        belongs to this tab alone.
      </p>
      <ul class="seen-list">
        <For each={seen.latest ?? []} fallback={<li class="hint">Nothing.</li>}>
          {(entry) => (
            <li>
              <a href={entry.key} target="_blank" rel="noopener noreferrer" title={entry.key}>
                {entry.key}
              </a>
              <span class="seen-date" title={entry.date}>
                {dateTime(entry.date)}
              </span>
              <button
                class="plain"
                aria-label={`Forget ${entry.key}`}
                title="Forget: download it again when met"
                onClick={() => forget([entry.key])}
              >
                <Icon name="close" />
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <footer>
        <button
          disabled={(seen.latest ?? []).length === 0}
          onClick={() =>
            confirm("Forget everything this tab has downloaded? All of it will be fetched again.") &&
            forget()
          }
        >
          Forget all
        </button>
        <button class="primary" onClick={props.onClose}>
          Done
        </button>
      </footer>
    </Modal>
  );
}
