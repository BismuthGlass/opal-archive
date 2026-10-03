import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { dismiss, enqueue, uploads } from "../uploads";
import Icon from "./Icon";

export function UploadButton() {
  let input!: HTMLInputElement;
  return (
    <>
      <button class="upload-button" onClick={() => input.click()}>
        <Icon name="upload" />
        Upload
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={() => {
          enqueue([...(input.files ?? [])]);
          // Lets the same file be picked again later.
          input.value = "";
        }}
      />
    </>
  );
}

/** Accepts files dropped anywhere on the window. */
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
    enqueue([...(event.dataTransfer?.files ?? [])]);
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
              Uploading {Math.min(uploads.done + 1, uploads.total)} of {uploads.total}
            </strong>
          </header>
          <progress value={overall()} />
        </Show>
        <p>
          {uploads.added} added
          <Show when={uploads.duplicates > 0}>, {uploads.duplicates} already in the library</Show>
          <Show when={uploads.failures.length > 0}>
            , {plural(uploads.failures.length, "failure")}
          </Show>
        </p>
        <Show when={uploads.failures.length > 0}>
          <ul class="upload-failures">
            <For each={uploads.failures}>
              {(failure) => (
                <li>
                  <span class="name">{failure.name}</span> {failure.reason}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}
