import { createEffect, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { contentUrl } from "../api";
import { ensureRange, itemAt, search } from "../search";
import Icon from "./Icon";
import { modalOpen } from "./Modal";

/**
 * Full-window view of one result. Left / right step through the results,
 * Escape closes.
 */
export default function Viewer(props: { index: number; onMove: (index: number | null) => void }) {
  const item = () => itemAt(props.index);

  createEffect(() => ensureRange(props.index, props.index));

  const step = (delta: number) => {
    const next = props.index + delta;
    if (next >= 0 && next < search.total) props.onMove(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // A modal over the viewer has the keyboard.
    if (modalOpen()) return;
    if (event.key === "Escape") props.onMove(null);
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else return;
    event.preventDefault();
    // Keep the page's own shortcuts from also acting on the key.
    event.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return (
    <div class="viewer" role="dialog" aria-modal="true" aria-label="Viewer">
      <header>
        <span class="viewer-title">{item()?.title ?? ""}</span>
        <span class="viewer-count">
          {props.index + 1} / {search.total}
        </span>
        <Show when={item()?.kind === "file"}>
          <a href={contentUrl(item()!.id, true)}>Download</a>
        </Show>
        <button aria-label="Close" onClick={() => props.onMove(null)}>
          <Icon name="close" />
        </button>
      </header>
      {/* Clicking the backdrop, but not the media, closes. */}
      <div class="viewer-body" onClick={(e) => e.target === e.currentTarget && props.onMove(null)}>
        <Show when={item()} keyed>
          {(current) => (
            <Switch
              fallback={
                <p class="viewer-note">
                  No preview for this file. <a href={contentUrl(current.id, true)}>Download it</a>
                </p>
              }
            >
              <Match when={current.kind === "collection"}>
                <p class="viewer-note">
                  Collection{current.title ? `: ${current.title}` : ""}. Double-click it in the
                  grid to open it.
                </p>
              </Match>
              <Match when={current.media_type === "image"}>
                <img src={contentUrl(current.id)} alt={current.title ?? ""} />
              </Match>
              <Match when={current.media_type === "video"}>
                <video src={contentUrl(current.id)} controls autoplay />
              </Match>
              <Match when={current.media_type === "audio"}>
                <audio src={contentUrl(current.id)} controls autoplay />
              </Match>
              <Match when={current.extension === "pdf"}>
                <iframe src={contentUrl(current.id)} title={current.title ?? "Document"} />
              </Match>
            </Switch>
          )}
        </Show>
      </div>
      <button class="viewer-step previous" aria-label="Previous" onClick={() => step(-1)}>
        <Icon name="chevron-left" />
      </button>
      <button class="viewer-step next" aria-label="Next" onClick={() => step(1)}>
        <Icon name="chevron-right" />
      </button>
    </div>
  );
}
