import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import * as api from "../api";
import { downloadNames } from "../settings";
import { dataVersion, previewed } from "../search";
import Icon from "./Icon";
import { createStoredFlag } from "./Panel";

const HEIGHT_KEY = "opalarchive.preview.height";
/** The drawer is never lower than this, nor leaves less of the panel above it. */
const LEAST = 120;

function storedHeight(): number | null {
  try {
    const height = Number(localStorage.getItem(HEIGHT_KEY));
    return height >= LEAST ? height : null;
  } catch {
    return null;
  }
}

/**
 * A drawer at the bottom of the side panel that shows the selected file,
 * or of several the one selected last, bigger than its tile and without
 * opening the viewer. Closed, it is only its heading; open, it comes up
 * over the lower part of the panel, as far as its top edge is dragged.
 */
export default function Preview() {
  const [open, setOpen] = createStoredFlag("opalarchive.preview", false);
  /** How tall it was dragged to be; until then, half the panel. */
  const [height, setHeight] = createSignal(storedHeight());
  let drawer!: HTMLElement;

  // Nothing is read while the drawer is closed.
  const [entity] = createResource(
    () => (open() && previewed() !== null ? ([previewed()!, dataVersion()] as const) : null),
    ([id]) => api.getEntity(id).catch(() => null),
  );
  /** What is on show: gone as soon as nothing is selected. */
  const shown = () => (previewed() === null ? null : (entity.latest ?? null));

  const resize = (event: PointerEvent) => {
    const grip = event.currentTarget as HTMLElement;
    const panel = drawer.parentElement!.getBoundingClientRect();
    grip.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => {
      const most = Math.max(LEAST, panel.height - 80);
      setHeight(Math.round(Math.max(LEAST, Math.min(most, panel.bottom - moved.clientY))));
    };
    const done = () => {
      grip.removeEventListener("pointermove", move);
      try {
        if (height() !== null) localStorage.setItem(HEIGHT_KEY, String(height()));
      } catch {
        // Storage unavailable; the height just won't survive a reload.
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done, { once: true });
    grip.addEventListener("pointercancel", done, { once: true });
  };

  return (
    <section
      class="preview"
      classList={{ open: open() }}
      ref={drawer}
      aria-label="Preview"
      style={open() ? { height: height() === null ? "50%" : `${height()}px` } : undefined}
    >
      <Show when={open()}>
        <div class="preview-grip" title="Drag to resize" onPointerDown={resize} />
      </Show>
      <header>
        <button class="module-toggle" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span class="chevron">
            <Icon name="chevron-right" />
          </span>
          Preview
        </button>
      </header>
      <Show when={open()}>
        <div class="preview-body">
          <Show
            when={shown()}
            keyed
            fallback={
              <p class="hint">
                {previewed() === null ? "Select a file to see it here." : " "}
              </p>
            }
          >
            {(current) => (
              <Switch
                fallback={
                  <p class="hint">
                    No preview for this file.{" "}
                    <a href={api.contentUrl(current.id, downloadNames())}>Download it</a>
                  </p>
                }
              >
                <Match when={current.file.media_type === "image"}>
                  <img src={api.contentUrl(current.id)} alt={current.title ?? ""} />
                </Match>
                <Match when={current.file.media_type === "video"}>
                  <video src={api.contentUrl(current.id)} controls preload="metadata" />
                </Match>
                <Match when={current.file.media_type === "audio"}>
                  <audio src={api.contentUrl(current.id)} controls preload="metadata" />
                </Match>
                <Match when={current.file.extension === "pdf"}>
                  <iframe src={api.contentUrl(current.id)} title={current.title ?? "Document"} />
                </Match>
              </Switch>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}
