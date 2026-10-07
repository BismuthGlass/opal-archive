import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import * as api from "../api";
import { errorMessage } from "../format";
import { activeTab } from "../tabs";
import { dismiss, upload, uploads } from "../uploads";
import { BaseTags } from "./DownloadPanel";
import Icon from "./Icon";
import Modal from "./Modal";

/**
 * The box at the top of an upload tab: click to pick files, or drop them.
 * Under it, a field for the web addresses of files to fetch.
 */
export function UploadBox() {
  let input!: HTMLInputElement;
  const [addresses, setAddresses] = createSignal("");
  // Several addresses can be pasted at once, with spaces or lines between.
  const fetchAll = () => {
    upload(addresses().split(/\s+/).filter(Boolean));
    setAddresses("");
  };
  // The tags this tab gives to everything uploaded into it. The box is the
  // same one for every upload tab, so they are read again for each.
  const tab = () => activeTab()?.id;
  const [tags, { mutate, refetch }] = createResource(tab, api.getUploadTags);
  const [tagError, setTagError] = createSignal<string | null>(null);
  const setTags = async (next: Record<string, string[]>) => {
    const id = tab();
    if (id === undefined) return;
    try {
      await api.setUploadTags(id, next);
      setTagError(null);
      // Shown at once; then as the server kept them.
      mutate(next);
    } catch (err) {
      setTagError(errorMessage(err));
    }
    refetch();
  };
  return (
    <>
      <button class="upload-box" onClick={() => input.click()}>
        <Icon name="upload" />
        <span>
          <strong>Choose files</strong> or drop them anywhere
          <small>A zip is unpacked: its files are added, and its folders become collections</small>
        </span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={() => {
          upload([...(input.files ?? [])]);
          // Lets the same file be picked again later.
          input.value = "";
        }}
      />
      <form
        class="upload-url"
        onSubmit={(event) => {
          event.preventDefault();
          fetchAll();
        }}
      >
        <input
          type="text"
          aria-label="Address of a file to fetch"
          placeholder="Or paste the address of a file: https://example.com/picture.jpg"
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          value={addresses()}
          onInput={(event) => setAddresses(event.currentTarget.value)}
        />
        <button type="submit" class="primary" disabled={addresses().trim() === ""}>
          Fetch
        </button>
      </form>
      <div class="upload-tags">
        <BaseTags data={{ tags: tags.latest ?? {} }} error={tagError()} onChange={setTags} />
      </div>
    </>
  );
}

/**
 * Accepts files dropped anywhere on the window. They go to the active tab
 * if it is an upload tab, and open a new upload tab otherwise.
 */
export function DropTarget() {
  const [dragging, setDragging] = createSignal(false);
  // dragenter/dragleave fire for every element crossed, so count them.
  let depth = 0;

  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

  const onEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    depth += 1;
    setDragging(true);
  };
  const onLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  };
  const onOver = (event: DragEvent) => {
    // Without this the browser navigates to the dropped file.
    if (hasFiles(event)) event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    setDragging(false);
    upload([...(event.dataTransfer?.files ?? [])]);
  };

  onMount(() => {
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
  });
  onCleanup(() => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("drop", onDrop);
  });

  return (
    <Show when={dragging()}>
      <div class="drop-overlay">Drop files to upload</div>
    </Show>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function UploadPanel() {
  const overall = () => (uploads.done + uploads.progress) / uploads.total;
  /** Whether the list of what failed is open. */
  const [showFailed, setShowFailed] = createSignal(false);

  return (
    <Show when={uploads.total > 0}>
      <section class="upload-panel" aria-live="polite">
        <Show
          when={uploads.active}
          fallback={
            <header>
              <strong>Upload finished</strong>
              <button class="link" onClick={dismiss}>
                Dismiss
              </button>
            </header>
          }
        >
          <header>
            <strong>
              <Show
                when={uploads.unpacking}
                fallback={`Uploading ${Math.min(uploads.done + 1, uploads.total)} of ${uploads.total}`}
              >
                Unpacking {uploads.unpacking}
              </Show>
            </strong>
          </header>
          {/* With no value the bar shows that work is going on, how much
              of it being unknown. */}
          <Show when={uploads.unpacking} fallback={<progress value={overall()} />}>
            <progress />
          </Show>
        </Show>
        <p>
          {uploads.added} added
          <Show when={uploads.collections > 0}>
            , in {plural(uploads.collections, "collection")}
          </Show>
          <Show when={uploads.duplicates > 0}>, {uploads.duplicates} already in the library</Show>
        </p>
        <Show when={uploads.failures.length > 0}>
          <button
            class="link upload-failed"
            title="Show what was not taken in, and why"
            onClick={() => setShowFailed(true)}
          >
            {uploads.failures.length} failed: show {uploads.failures.length === 1 ? "it" : "them"}
          </button>
        </Show>
      </section>
      <Show when={showFailed()}>
        <Modal
          title={`${plural(uploads.failures.length, "upload")} failed`}
          medium
          onClose={() => setShowFailed(false)}
        >
          <p class="hint">
            What was not taken into the library, and why. A file inside a zip is named with the
            zip and where it is in it.
          </p>
          <ul class="upload-failures">
            <For each={uploads.failures}>
              {(failure) => (
                <li>
                  <span class="name">{failure.name}</span>
                  <span class="reason">{failure.reason}</span>
                </li>
              )}
            </For>
          </ul>
        </Modal>
      </Show>
    </Show>
  );
}
