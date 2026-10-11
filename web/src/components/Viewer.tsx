import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import * as api from "../api";
import { contentUrl } from "../api";
import { dateTime, duration, fieldLabel, fileSize, setName } from "../format";
import { dataVersion, ensureRange, itemAt, marks, search } from "../search";
import { downloadNames, saveSetting, settings } from "../settings";
import type { ViewerPart } from "../settings";
import { enter, shownSet, shownVariants } from "../tabs";
import { aggregatedTypes, orderedTypes, tagTextStyle, tagType } from "../tagTypes";
import Icon from "./Icon";
import { modalOpen } from "./Modal";

/** How long each result stays up while playing, unless set otherwise. */
const DEFAULT_SECONDS = 5;
/** What cannot be shown is passed over this quickly while playing. */
const SKIP_SECONDS = 1;
/** After a step, how long further scrolling is let pass, in milliseconds. */
const WHEEL_PAUSE = 100;

/** What of the top bar can be put away, as the menu that does it lists them. */
const PARTS: { part: ViewerPart; label: string }[] = [
  { part: "player", label: "Player" },
];
/** How narrow and how wide the info pane can be dragged, and where its width is kept. */
const INFO_LEAST = 180;
const INFO_MOST = 520;
const INFO_WIDTH_KEY = "opalarchive.viewer.info.width";

function storedInfoWidth(): number | null {
  try {
    const width = Number(localStorage.getItem(INFO_WIDTH_KEY));
    return width >= INFO_LEAST && width <= INFO_MOST ? width : null;
  } catch {
    return null;
  }
}

function storeInfoWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(INFO_WIDTH_KEY);
    else localStorage.setItem(INFO_WIDTH_KEY, String(width));
  } catch {
    // The width is then only kept until the page is left.
  }
}

/** What the info pane says of the file besides its tags, where it is set. */
const DETAILS = [
  { field: "title", label: "Title" },
  { field: "date", label: "Date" },
  { field: "content_rating", label: "Rating" },
  { field: "score", label: "Score" },
  { field: "version", label: "Version" },
  { field: "description", label: "Description" },
];

/**
 * Full-window view of one result. Left / right step through the results,
 * as scrolling down / up does, and Escape closes. It can also play through them by itself: each stays up
 * for a set number of seconds, in order or at random. Given `only`, the
 * indexes of some of the results, it steps and plays through those alone.
 */
export default function Viewer(props: {
  index: number;
  only?: number[];
  onMove: (index: number | null) => void;
}) {
  const item = () => itemAt(props.index);
  /** How many there are to step through, and which of them is on show. */
  const count = () => props.only?.length ?? search.total;
  const place = () => (props.only ? props.only.indexOf(props.index) : props.index);
  /** The result at a place among them. */
  const at = (place: number) => (props.only ? props.only[place] : place);

  createEffect(() => ensureRange(props.index, props.index));

  /**
   * Whether a part of the viewer is on show. What is in the top bar is,
   * until put away; the info pane is not, until opened.
   */
  const shows = (part: ViewerPart) => settings.viewer?.[part] ?? part !== "info";
  const toggle = (part: ViewerPart) =>
    saveSetting("viewer", { ...settings.viewer, [part]: !shows(part) }).catch(() => {});
  const [choosing, setChoosing] = createSignal(false);
  let chooser: HTMLDivElement | undefined;
  // A press anywhere else closes the menu of what is shown, and does no
  // more than that: on the backdrop it does not close the viewer too.
  let dismissing = false;
  const pressed = (event: PointerEvent) => {
    dismissing = choosing() && !chooser?.contains(event.target as Node);
    if (dismissing) setChoosing(false);
  };
  onMount(() => window.addEventListener("pointerdown", pressed, true));
  onCleanup(() => window.removeEventListener("pointerdown", pressed, true));

  // What is shown of the file is only asked for while it is shown. `latest`
  // keeps the last file's on screen until the next one's arrives.
  const [entity] = createResource(
    () => (shows("info") && item() ? ([item()!.id, dataVersion()] as const) : null),
    ([id]) => api.getEntity(id),
  );
  // The pane's width, where its edge was dragged to; null is as it is made.
  const [infoWidth, setInfoWidth] = createSignal(storedInfoWidth());
  const resizeInfo = (event: PointerEvent) => {
    const grip = event.currentTarget as HTMLElement;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => {
      // Never so wide that what is shown is left less than half the window.
      const most = Math.max(INFO_LEAST, Math.min(INFO_MOST, window.innerWidth / 2));
      setInfoWidth(Math.round(Math.max(INFO_LEAST, Math.min(most, moved.clientX))));
    };
    const done = () => {
      grip.removeEventListener("pointermove", move);
      storeInfoWidth(infoWidth());
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done, { once: true });
    grip.addEventListener("pointercancel", done, { once: true });
  };
  /** A double click on the edge puts the width back as it was made. */
  const resetInfoWidth = () => {
    setInfoWidth(null);
    storeInfoWidth(null);
  };
  const [metadata] = createResource(
    () => (shows("info") && item() ? ([item()!.id, dataVersion()] as const) : null),
    ([id]) => api.getMetadata([id]),
  );
  /** What the info pane is about, once both answers are in. */
  const info = () => {
    const [file, data] = [entity.latest, metadata.latest];
    return shows("info") && file && data ? { file, data } : undefined;
  };
  /**
   * The file's tags as the side panel lists them: those of the aggregated
   * types in one list, then each other type that has any under its name.
   */
  const tagLists = (tags: api.Metadata["tags"]) => {
    const of = (field: string) => (tags[field] ?? []).map((tag) => ({ field, value: tag.value }));
    return [
      { label: "Tags", tags: aggregatedTypes().flatMap(of) },
      ...orderedTypes()
        .filter((field) => !tagType(field).aggregate)
        .map((field) => ({ label: fieldLabel(field), tags: of(field) })),
    ].filter((list) => list.tags.length > 0);
  };

  // The sets the result is in, named before its title: the one on show
  // first.
  const sets = () => {
    const here = shownSet()?.set_id;
    return [...(item()?.set ?? [])].sort(
      (a, b) => Number(b.set_id === here) - Number(a.set_id === here),
    );
  };
  /** Leaves the viewer for the set, or the variants: the tab goes into them. */
  const goInto = (into: { set_id: string } | { variants: string }) => {
    props.onMove(null);
    enter(into);
  };
  /** The result's group of variants, if there are others to show. */
  const variants = () => {
    const current = item();
    const more = (current?.variants ?? 0) > 1 && current?.alt_group_id !== shownVariants();
    return more ? current!.alt_group_id! : undefined;
  };

  const step = (delta: number) => {
    const next = place() + delta;
    if (next >= 0 && next < count()) props.onMove(at(next));
  };

  // Scrolling steps too: down to the next, up to the one before. Each turn
  // of the wheel is a step, however small the move it reports: a notch can
  // be a few pixels or a hundred, by the mouse, the system and how fast it
  // is turned. What follows within a moment is the same turn still arriving.
  let steppedAt = 0;
  const onWheel = (event: WheelEvent) => {
    // Pinching to zoom arrives as a wheel with Control held.
    if (event.ctrlKey || event.deltaY === 0 || modalOpen()) return;
    if ((event.target as HTMLElement).matches?.("input")) return;
    // Over the info pane, the wheel is for scrolling it.
    if ((event.target as HTMLElement).closest?.(".viewer-info")) return;
    const now = performance.now();
    if (now - steppedAt < WHEEL_PAUSE) return;
    steppedAt = now;
    step(Math.sign(event.deltaY));
  };

  const [playing, setPlaying] = createSignal(false);
  /** Whether what is on show has arrived: an image still loading has not. */
  const [shown, setShown] = createSignal(false);
  const seconds = () => settings.player?.seconds ?? DEFAULT_SECONDS;
  const random = () => settings.player?.random ?? false;
  const setPlayer = (change: { seconds?: number; random?: boolean }) =>
    saveSetting("player", { seconds: seconds(), random: random(), ...change }).catch(() => {});

  /** In random order: the places still to come, so none repeats before all were shown. */
  let bag: number[] = [];
  const advance = () => {
    if (count() < 2) return setPlaying(false);
    if (!random()) return props.onMove(at((place() + 1) % count()));
    bag = bag.filter((index) => index < count() && index !== place());
    if (bag.length === 0) {
      bag = Array.from({ length: count() }, (_, index) => index).filter(
        (index) => index !== place(),
      );
    }
    props.onMove(at(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]));
  };

  /** Video and audio play to their end instead of being cut off by the clock. */
  const timed = () => {
    const current = item();
    return current?.media_type === "video" || current?.media_type === "audio";
  };
  const showable = () => {
    const current = item();
    return current?.media_type === "image" || timed() || current?.extension === "pdf";
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
    } else if (event.key === "Escape") {
      if (choosing()) setChoosing(false);
      else props.onMove(null);
    } else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else if (event.key === "i" && !event.ctrlKey && !event.metaKey && !event.altKey) toggle("info");
    else return;
    event.preventDefault();
    // Keep the page's own shortcuts from also acting on the key.
    event.stopPropagation();
  };
  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

  return (
    <div
      class="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Viewer"
      onWheel={onWheel}
    >
      <Show when={shows("info")}>
        <div
          class="viewer-side"
          style={{ "--info-width": infoWidth() === null ? undefined : `${infoWidth()}px` }}
        >
          <aside class="viewer-info" aria-label="Info">
            <Show when={info()}>
              {(about) => (
                <>
                  <dl>
                    <dt>Name</dt>
                    <dd>{about().file.file.original_name ?? "—"}</dd>
                    <dt>Type</dt>
                    <dd>
                      {about().file.file.media_type}
                      {about().file.file.extension && ` (${about().file.file.extension})`}
                    </dd>
                    <Show when={about().file.file.width && about().file.file.height}>
                      <dt>Size</dt>
                      <dd>
                        {about().file.file.width} × {about().file.file.height}
                      </dd>
                    </Show>
                    <Show when={about().file.file.length !== null}>
                      <dt>Length</dt>
                      <dd>{duration(about().file.file.length!)}</dd>
                    </Show>
                    <Show when={about().file.file.page_count !== null}>
                      <dt>Pages</dt>
                      <dd>{about().file.file.page_count}</dd>
                    </Show>
                    <dt>On disk</dt>
                    <dd>{fileSize(about().file.file.size)}</dd>
                    <dt>Added</dt>
                    <dd>{dateTime(about().file.date_added)}</dd>
                    <dt>ID</dt>
                    <dd>{about().file.id}</dd>
                    <For each={DETAILS}>
                      {(detail) => (
                        <Show when={about().data.scalars[detail.field]?.value != null}>
                          <dt>{detail.label}</dt>
                          <dd>{about().data.scalars[detail.field].value}</dd>
                        </Show>
                      )}
                    </For>
                  </dl>
                  <For each={tagLists(about().data.tags)}>
                    {(list) => (
                      <>
                        <h3>{list.label}</h3>
                        <ul class="tag-lines">
                          <For each={list.tags}>
                            {(tag) => (
                              <li class="tag-line">
                                <span class="tag-name" style={tagTextStyle(tag.field)}>
                                  {tag.value}
                                </span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </>
                    )}
                  </For>
                  <Show when={about().data.source_url.length > 0}>
                    <h3>Links</h3>
                    <ul class="viewer-links">
                      <For each={about().data.source_url}>
                        {(link) => (
                          <li>
                            <a href={link.value} target="_blank" rel="noreferrer">
                              {link.value}
                            </a>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </>
              )}
            </Show>
          </aside>
          <div
            class="viewer-grip"
            title="Drag to resize; double-click to put it back"
            onPointerDown={resizeInfo}
            onDblClick={resetInfoWidth}
          />
        </div>
      </Show>
      <div class="viewer-stage">
        <header>
          <button
            aria-pressed={shows("info")}
            aria-label="Info pane"
            title={shows("info") ? "Close the info pane (I)" : "Show the file's details and tags (I)"}
            onClick={() => toggle("info")}
          >
            <Icon name={shows("info") ? "left-panel-close-outline" : "left-panel-open-outline"} />
          </button>
          <span class="viewer-title">
            <Show when={sets().length > 0}>
              <span class="viewer-set">
                <For each={sets()}>
                  {(set, index) => (
                    <>
                      {index() > 0 ? ", " : ""}
                      <button
                        title={
                          set.set_id === shownSet()?.set_id
                            ? "The set on show: back to it"
                            : "Go into this set"
                        }
                        onClick={() => goInto(set)}
                      >
                        {setName(set)}
                      </button>
                    </>
                  )}
                </For>
              </span>
              <Show when={item()?.title}>
                <span class="viewer-inside" aria-hidden="true">
                  ›
                </span>
              </Show>
            </Show>
            <span class="viewer-name">{item()?.title ?? ""}</span>
          </span>
          <Show when={variants()}>
            {(group) => (
              <span class="viewer-set">
                <button title="Show the variants of this, in the tab" onClick={() => goInto({ variants: group() })}>
                  {item()?.variants} variants
                </button>
              </span>
            )}
          </Show>
          <For each={(item() && marks().get(item()!.id)) || []}>
            {(mark) => <span class={`mark-badge mark-${mark}`}>Mark {mark}</span>}
          </For>
          <Show when={item()?.inbox}>
            <span class="viewer-new" title="In the inbox: not yet archived">
              <Icon name="inbox-outline" />
            </span>
          </Show>
          <Show when={item()?.trashed}>
            <span class="viewer-trashed" title="In the trash">
              <Icon name="delete-outline" />
            </span>
          </Show>
          <span class="viewer-count" title={props.only ? "Only what was selected is shown" : undefined}>
            {place() + 1} / {count()}
            {props.only ? " selected" : ""}
          </span>
          <Show when={shows("player")}>
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
          </Show>
          <div class="viewer-chooser" ref={chooser}>
            <button
              aria-haspopup="menu"
              aria-expanded={choosing()}
              aria-label="What is shown"
              title="Choose what the bar shows"
              onClick={() => setChoosing(!choosing())}
            >
              <Icon name="visibility-outline" />
            </button>
            <Show when={choosing()}>
              <ul class="context-menu viewer-menu" role="menu">
                <li class="context-menu-title">Show</li>
                <For each={PARTS}>
                  {(entry) => (
                    <li>
                      <button
                        role="menuitemcheckbox"
                        aria-checked={shows(entry.part)}
                        onClick={() => toggle(entry.part)}
                      >
                        <span class="viewer-check">
                          <Show when={shows(entry.part)}>
                            <Icon name="check" />
                          </Show>
                        </span>
                        {entry.label}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
          <Show when={item()}>
            {(current) => <a href={contentUrl(current().id, downloadNames())}>Download</a>}
          </Show>
          <button aria-label="Close" onClick={() => props.onMove(null)}>
            <Icon name="close" />
          </button>
        </header>
        {/* Clicking the backdrop, but not the media, closes. */}
        <div
          class="viewer-body"
          onClick={(e) => e.target === e.currentTarget && !dismissing && props.onMove(null)}
        >
          <Show when={item()} keyed>
            {(current) => (
              <Switch
                fallback={
                  <p class="viewer-note">
                    No preview for this file. <a href={contentUrl(current.id, downloadNames())}>Download it</a>
                  </p>
                }
              >
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
    </div>
  );
}
