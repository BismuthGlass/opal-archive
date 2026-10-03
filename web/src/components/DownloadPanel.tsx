import { createResource, createSignal, For, onMount, Show } from "solid-js";
import * as api from "../api";
import type { DownloadJob, DownloadState } from "../api";
import { downloadState, loadDownload, startDownload } from "../downloads";
import type { PanelProps } from "../downloaders";
import { dateTime, errorMessage, fieldLabel, plural } from "../format";
import { pillStyle, readTag } from "../tagTypes";
import Icon from "./Icon";
import Modal from "./Modal";
import { createStoredFlag } from "./Panel";

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
  const [settingsOpen, setSettingsOpen] = createStoredFlag("tagutils.download.settings", true);
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
function Progress(props: { job: DownloadJob }) {
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
 * The tags given to everything the tab downloads: the downloader's own
 * source tag, which is always there, and any the user adds. They are typed
 * as anywhere else: `name` for a plain tag, `@cr:name` for a creator.
 */
function BaseTags(props: {
  data: DownloadState;
  onChange: (tags: Record<string, string[]>) => void;
}) {
  const [text, setText] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const entries = () =>
    Object.entries(props.data.tags).flatMap(([field, values]) =>
      values.map((value) => ({ field, value })),
    );

  const add = () => {
    const { field, value } = readTag(text());
    if (!value) return;
    if (!field) return setProblem("That is not a tag type. Write @cr:name, @ch:name and so on.");
    const tags = { ...props.data.tags, [field]: [...(props.data.tags[field] ?? []), value] };
    setText("");
    setProblem(null);
    props.onChange(tags);
  };
  const remove = (field: string, value: string) =>
    props.onChange({
      ...props.data.tags,
      [field]: props.data.tags[field].filter((other) => other !== value),
    });

  return (
    <>
      <span
        class="label"
        title={`Given to everything downloaded, besides the source tag ${props.data.downloader.source}`}
      >
        Tags to add
      </span>
      <div class="download-tags">
        <input
          type="text"
          aria-label="Add a tag given to everything downloaded"
          placeholder="wallpaper, @cr:name…"
          autocomplete="off"
          spellcheck={false}
          value={text()}
          onInput={(event) => {
            setText(event.currentTarget.value);
            setProblem(null);
          }}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
        <For each={entries()}>
          {(entry) => (
            <span
              class="chip tinted"
              style={pillStyle(entry.field)}
              title={`${fieldLabel(entry.field)}: ${entry.value}`}
            >
              <span class="chip-label">{entry.value}</span>
              <span class="chip-actions">
                <button
                  class="chip-remove"
                  aria-label={`Remove ${entry.value}`}
                  title="Remove"
                  onClick={() => remove(entry.field, entry.value)}
                >
                  <Icon name="close" />
                </button>
              </span>
            </span>
          )}
        </For>
        <Show when={problem()}>
          <p class="form-error">{problem()}</p>
        </Show>
      </div>
    </>
  );
}

/**
 * The downloader's login to its site, read from a browser and kept by the
 * server. It is shared by every tab of the downloader.
 */
function Login(props: { data: DownloadState; attempt: (action: () => Promise<unknown>) => void }) {
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
