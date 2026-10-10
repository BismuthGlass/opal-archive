import { createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { errorMessage } from "../format";
import { Login } from "./DownloadPanel";
import Modal from "./Modal";

/**
 * What every downloader is set to, one under the other: its options, and
 * its login if its site has one. They are set once, here, for every tab
 * and for the inbox: an address is given to the downloader for its site,
 * which downloads it as it is set.
 */
export default function DownloaderSettings(props: { onClose: () => void }) {
  const [downloaders, { refetch }] = createResource(api.listDownloaders);
  const [error, setError] = createSignal<string | null>(null);

  /** Does something, shows what went wrong if anything, and reads the settings again. */
  const attempt = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    await refetch();
  };

  return (
    <Modal title="Downloader settings" medium onClose={props.onClose}>
      <p class="hint">
        An address pasted into an upload tab, or sent to the inbox, goes to the downloader for its
        site. Each is set here, once for all of them.
      </p>
      <div class="downloader-settings">
        <For each={downloaders.latest ?? []} fallback={<p class="hint">There are no downloaders.</p>}>
          {(downloader) => (
            <section aria-label={downloader.title}>
              <h3>{downloader.title}</h3>
              <For each={downloader.options}>
                {(option) => (
                  <label class="download-option">
                    <input
                      type="checkbox"
                      checked={downloader.settings[option.key] ?? option.default}
                      onChange={(event) => {
                        const value = event.currentTarget.checked;
                        attempt(() =>
                          api.configureDownloader(downloader.name, {
                            options: { [option.key]: value },
                          }),
                        );
                      }}
                    />
                    {option.label}
                  </label>
                )}
              </For>
              <Show when={downloader.cookies}>
                <div class="downloader-login">
                  <Login data={{ downloader }} attempt={attempt} />
                </div>
              </Show>
              <Show when={downloader.options.length === 0 && !downloader.cookies}>
                <p class="hint">Nothing to set.</p>
              </Show>
            </section>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </Modal>
  );
}
