import { createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { dateTime, errorMessage } from "../format";
import { loadInbox } from "../inbox";
import { dismiss, dismissAll, notices } from "../notifications";
import type { Notice } from "../notifications";
import { open as openTab } from "../tabs";
import Icon from "./Icon";
import Modal from "./Modal";

/** How many notices are on show at once; the rest wait their turn. */
const SHOWN = 4;

/**
 * The notices, stacked in the bottom right corner with the newest lowest.
 * Pressing one opens it, to say what went wrong in full.
 */
export default function Notifications() {
  /** The notice opened to be read. */
  const [reading, setReading] = createSignal<Notice | null>(null);
  const shown = () => notices().slice(-SHOWN);
  const waiting = () => notices().length - shown().length;

  return (
    <>
      <Show when={notices().length > 0}>
        <section class="notices" aria-label="Notifications">
          <Show when={notices().length > 1}>
            <div class="notices-bar">
              <Show when={waiting() > 0}>
                <span>{waiting()} more</span>
              </Show>
              <button class="link" onClick={dismissAll}>
                Dismiss all
              </button>
            </div>
          </Show>
          <For each={shown()}>
            {(notice) => (
              <div class="notice" classList={{ [notice.kind]: true }} role="alert">
                <button
                  class="notice-open"
                  title="Show what went wrong"
                  onClick={() => setReading(notice)}
                >
                  <Icon name={notice.kind === "failed" ? "error-outline" : "warning-outline"} />
                  <span class="notice-text">
                    <strong>{notice.title}</strong>
                    <span class="notice-summary">{notice.messages[0]}</span>
                  </span>
                </button>
                <button
                  class="notice-dismiss"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={() => dismiss(notice.id)}
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
          </For>
        </section>
      </Show>
      {/* Keyed: the dialog is given the notice itself. */}
      <Show when={reading()} keyed>
        {(notice) => <NoticeDialog notice={notice} onClose={() => setReading(null)} />}
      </Show>
    </>
  );
}

/** A notice in full: what was being downloaded, and everything that went wrong. */
function NoticeDialog(props: { notice: Notice; onClose: () => void }) {
  const notice = props.notice;
  const [error, setError] = createSignal<string | null>(null);
  /** The notice has been dealt with: it goes, and so does the dialog. */
  const done = () => {
    dismiss(notice.id);
    props.onClose();
  };
  const retry = async () => {
    try {
      await api.retryRequest(notice.request!);
      await loadInbox().catch(() => {});
      done();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={notice.title} medium onClose={props.onClose}>
      <dl class="facts">
        <dt>Address</dt>
        <dd>
          <a href={notice.url} target="_blank" rel="noreferrer">
            {notice.url}
          </a>
        </dd>
        <dt>Asked for in</dt>
        <dd>{notice.from}</dd>
        <dt>When</dt>
        <dd>{dateTime(notice.when)}</dd>
      </dl>
      <p class="label">{notice.kind === "failed" ? "Why it failed" : "What went wrong"}</p>
      <ul class="notice-messages">
        <For each={notice.messages}>{(message) => <li>{message}</li>}</For>
      </ul>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
      <footer>
        <Show when={notice.request !== undefined}>
          <button
            onClick={() => {
              props.onClose();
              openTab("inbox");
            }}
          >
            Open the inbox
          </button>
        </Show>
        <button onClick={done}>Dismiss</button>
        <Show when={notice.request !== undefined && notice.kind === "failed"}>
          <button class="primary" title="Put it back in the queue" onClick={retry}>
            Try again
          </button>
        </Show>
      </footer>
    </Modal>
  );
}
