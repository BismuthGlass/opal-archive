import { createSignal, For, onMount, Show } from "solid-js";
import * as api from "../api";
import type { InboxRequest } from "../api";
import { errorMessage, fieldLabel, plural } from "../format";
import { tagTextStyle } from "../tagTypes";
import { inbox, loadInbox } from "../inbox";
import { BaseTags, Progress } from "./DownloadPanel";
import DownloaderSettings from "./DownloaderSettings";
import Icon from "./Icon";
import { createStoredFlag } from "./Panel";

/** The tags a request brought with it, each in its type's colour. */
function RequestTags(props: { request: InboxRequest }) {
  const entries = () =>
    Object.entries(props.request.tags).flatMap(([field, values]) =>
      values.map((value) => ({ field, value })),
    );
  return (
    <Show when={entries().length > 0}>
      <span class="chips inbox-tags" title="Tags sent with it">
        <For each={entries()}>
          {(entry) => (
            <span
              class="tag-name"
              style={tagTextStyle(entry.field)}
              title={`${fieldLabel(entry.field)}: ${entry.value}`}
            >
              {entry.value}
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}

const WAITING: Record<InboxRequest["status"], string> = {
  queued: "Waiting",
  running: "Downloading",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

/**
 * The panel at the top of the inbox: what was sent to it from outside, by
 * the browser extension for one, and is waiting, being downloaded, or
 * failed; and under it the tags each downloader gives to what it downloads here.
 * The tab lists everything downloaded this way until it is cleared.
 */
export default function InboxPanel() {
  const [url, setUrl] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [settingsOpen, setSettingsOpen] = createStoredFlag("opalarchive.inbox.settings", false);
  const [showDownloaders, setShowDownloaders] = createSignal(false);

  /** Does something, shows what went wrong if anything, and reads the inbox again. */
  const attempt = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    await loadInbox().catch(() => {});
  };
  onMount(() => attempt(async () => {}));

  const add = () => {
    const address = url().trim();
    if (!address) return;
    attempt(async () => {
      await api.sendToInbox(address);
      setUrl("");
    });
  };

  const title = (name: string) =>
    inbox()?.downloaders.find((entry) => entry.downloader.name === name)?.downloader.title ?? name;
  const queue = () => inbox()?.queue ?? [];
  /** What is not done with: on show, the one being downloaded first. */
  const open = () =>
    queue()
      .filter((request) => request.status !== "done")
      .sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
  const done = () => queue().filter((request) => request.status === "done");

  const clear = () => {
    const listed = inbox()?.listed ?? 0;
    const kept = listed > 0 ? ` The ${plural(listed, "item")} it lists stay in the library.` : "";
    if (confirm(`Clear Opal Drop?${kept}`)) attempt(api.clearInbox);
  };

  return (
    <Show when={inbox()}>
      {(data) => (
        <section class="download-panel inbox-panel" aria-label="Opal Drop">
          <div class="download-row">
            <input
              type="text"
              class="download-url"
              aria-label="Address to download"
              placeholder="An address to add to the queue; the browser extension sends them here"
              autocomplete="off"
              spellcheck={false}
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
              onKeyDown={(event) => event.key === "Enter" && add()}
            />
            <button class="primary" disabled={!url().trim()} onClick={add}>
              Add
            </button>
            <button
              disabled={data().listed === 0 && done().length === 0 && open().length === 0}
              title="Empty the list of what was downloaded. Nothing leaves the library, and what is still waiting stays."
              onClick={clear}
            >
              Clear
            </button>
            <button
              class="icon-button"
              aria-pressed={settingsOpen()}
              aria-label="Tags each downloader gives here"
              title={settingsOpen() ? "Hide the tags each downloader gives here" : "Show the tags each downloader gives here"}
              onClick={() => setSettingsOpen(!settingsOpen())}
            >
              <Icon name="label-outline" />
            </button>
            <button
              title="The options and login of each downloader, for every tab and Opal Drop"
              onClick={() => setShowDownloaders(true)}
            >
              <Icon name="settings-outline" />
              Downloader settings
            </button>
          </div>
          <Show when={error()}>
            <p class="form-error" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={open().length > 0}>
            <ul class="inbox-queue" aria-label="Queue">
              <For each={open()}>
                {(request) => (
                  <li classList={{ [request.status]: true }}>
                    <span class="inbox-status">{WAITING[request.status]}</span>
                    <span class="inbox-site">{title(request.downloader)}</span>
                    <a class="inbox-url" href={request.url} target="_blank" rel="noreferrer">
                      {request.url}
                    </a>
                    <RequestTags request={request} />
                    <Show when={request.status === "failed" || request.status === "cancelled"}>
                      <button class="link" onClick={() => attempt(() => api.retryRequest(request.id))}>
                        Retry
                      </button>
                    </Show>
                    <button
                      class="inbox-remove"
                      aria-label={request.status === "running" ? "Stop" : "Remove"}
                      title={request.status === "running" ? "Stop this download" : "Take it off the queue"}
                      onClick={() => attempt(() => api.removeRequest(request.id))}
                    >
                      <Icon name="close" />
                    </button>
                    <Show when={request.status === "running" && data().job}>
                      {(job) => (
                        <div class="inbox-detail">
                          <Progress job={job()} />
                        </div>
                      )}
                    </Show>
                    <Show when={request.message}>
                      <p class="inbox-detail inbox-message">{request.message}</p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={done().length > 0}>
            <details class="inbox-done">
              <summary>{plural(done().length, "download")} done</summary>
              <ul class="inbox-queue">
                {/* The latest first. */}
                <For each={[...done()].reverse()}>
                  {(request) => (
                    <li class="done">
                      <span class="inbox-site">{title(request.downloader)}</span>
                      <a class="inbox-url" href={request.url} target="_blank" rel="noreferrer">
                        {request.url}
                      </a>
                      <RequestTags request={request} />
                      <span class="hint">
                        {request.existing > 0
                          ? `${plural(request.added, "new file")}, ${request.existing} already in the library`
                          : plural(request.added, "new file")}
                      </span>
                      <Show when={request.message}>
                        <p class="inbox-detail inbox-message">{request.message}</p>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </Show>
          <Show when={open().length === 0 && done().length === 0 && data().listed === 0}>
            <p class="hint">
              Nothing has been sent here yet. What the browser extension sends is downloaded one at
              a time and listed in this tab until you clear it.
            </p>
          </Show>
          <Show when={settingsOpen()}>
            {/* What each downloader gives to what it downloads here. Its
                options and login are every tab's, set in their own window. */}
            <For each={data().downloaders}>
              {(entry) => (
                <div class="download-settings">
                  <strong class="inbox-downloader">{entry.downloader.title}</strong>
                  <BaseTags
                    data={entry}
                    error={error()}
                    onChange={(tags) =>
                      attempt(() => api.configureDownloader(entry.downloader.name, { tags }))
                    }
                  />
                </div>
              )}
            </For>
          </Show>
          <Show when={showDownloaders()}>
            <DownloaderSettings
              onClose={() => {
                setShowDownloaders(false);
                attempt(async () => {});
              }}
            />
          </Show>
        </section>
      )}
    </Show>
  );
}
