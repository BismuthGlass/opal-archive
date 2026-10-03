import { createEffect, createSignal, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { contentUrl } from "../api";
import { ensureRange, itemAt, search } from "../search";
import { saveSetting, settings } from "../settings";
import Icon from "./Icon";
import { modalOpen } from "./Modal";

/** How long each result stays up while playing, unless set otherwise. */
const DEFAULT_SECONDS = 5;
/** What cannot be shown is passed over this quickly while playing. */
const SKIP_SECONDS = 1;

/**
 * Full-window view of one result. Left / right step through the results,
 * Escape closes. It can also play through them by itself: each stays up
 * for a set number of seconds, in order or at random.
 */
export default function Viewer(props: { index: number; onMove: (index: number | null) => void }) {
  const item = () => itemAt(props.index);

  createEffect(() => ensureRange(props.index, props.index));

  const step = (delta: number) => {
    const next = props.index + delta;
    if (next >= 0 && next < search.total) props.onMove(next);
  };

  const [playing, setPlaying] = createSignal(false);
  /** Whether what is on show has arrived: an image still loading has not. */
  const [shown, setShown] = createSignal(false);
  const seconds = () => settings.player?.seconds ?? DEFAULT_SECONDS;
  const random = () => settings.player?.random ?? false;
  const setPlayer = (change: { seconds?: number; random?: boolean }) =>
    saveSetting("player", { seconds: seconds(), random: random(), ...change }).catch(() => {});

  /** In random order: the results still to come, so none repeats before all were shown. */
  let bag: number[] = [];
  const advance = () => {
    if (search.total < 2) return setPlaying(false);
    if (!random()) return props.onMove((props.index + 1) % search.total);
    bag = bag.filter((index) => index < search.total && index !== props.index);
    if (bag.length === 0) {
      bag = Array.from({ length: search.total }, (_, index) => index).filter(
        (index) => index !== props.index,
      );
    }
    props.onMove(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
  };

  /** Video and audio play to their end instead of being cut off by the clock. */
  const timed = () => {
    const current = item();
    return current?.media_type === "video" || current?.media_type === "audio";
  };
  const showable = () => {
    const current = item();
    return (
      current?.kind === "file" &&
      (current.media_type === "image" || timed() || current.extension === "pdf")
    );
  };
  createEffect(on(() => item()?.id, () => setShown(item()?.media_type !== "image")));
  // The clock starts once the result is on show, and again for each one.
  createEffect(() => {
    if (!playing() || !item() || !shown() || (timed() && showable())) return;
    const wait = showable() ? Math.max(1, seconds()) : SKIP_SECONDS;
    const timer = setTimeout(advance, wait * 1000);
    onCleanup(() => clearTimeout(timer));
  });

  const onKeyDown = (event: KeyboardEvent) => {
    // A modal over the viewer has the keyboard.
    if (modalOpen()) return;
    // Typing the seconds is not stepping through results.
    if ((event.target as HTMLElement).matches?.("input")) {
      if (event.key === "Escape") (event.target as HTMLElement).blur();
      else return;
    } else if (event.key === "Escape") props.onMove(null);
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
        <div class="viewer-player">
          <button
            aria-pressed={playing()}
            aria-label={playing() ? "Pause" : "Play"}
            title={playing() ? "Stop playing through the results" : "Play through the results"}
            onClick={() => setPlaying(!playing())}
          >
            <Icon name={playing() ? "pause-outline" : "play-arrow-outline"} />
          </button>
          <label title="How long each result stays up. Video and audio play to their end.">
            <input
              type="number"
              min="1"
              step="1"
              aria-label="Seconds each result stays up"
              value={seconds()}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                if (value >= 1) setPlayer({ seconds: value });
                else event.currentTarget.value = String(seconds());
              }}
            />
            s
          </label>
          <button
            class="viewer-random"
            aria-pressed={random()}
            aria-label="Random order"
            title={random() ? "Playing in random order" : "Playing in order"}
            onClick={() => setPlayer({ random: !random() })}
          >
            <Icon name="shuffle" />
          </button>
        </div>
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
                <img
                  src={contentUrl(current.id)}
                  alt={current.title ?? ""}
                  onLoad={() => setShown(true)}
                  onError={() => setShown(true)}
                />
              </Match>
              <Match when={current.media_type === "video"}>
                <video
                  src={contentUrl(current.id)}
                  controls
                  autoplay
                  onEnded={() => playing() && advance()}
                  onError={() => playing() && advance()}
                />
              </Match>
              <Match when={current.media_type === "audio"}>
                <audio
                  src={contentUrl(current.id)}
                  controls
                  autoplay
                  onEnded={() => playing() && advance()}
                  onError={() => playing() && advance()}
                />
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
