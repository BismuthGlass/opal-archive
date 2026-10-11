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
import { fieldLabel, setName } from "../format";
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

/** What of the viewer can be put away, as the menu that does it lists them. */
const PARTS: { part: ViewerPart; label: string }[] = [
  { part: "player", label: "Player" },
  { part: "filename", label: "File name" },
  { part: "tags", label: "Tags" },
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

  /** Whether a part of the viewer is on show: all are, until put away. */
  const shows = (part: ViewerPart) => settings.viewer?.[part] ?? true;
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
    () => (shows("filename") && item() ? ([item()!.id, dataVersion()] as const) : null),
    ([id]) => api.getEntity(id),
  );
  /** What the file is called: the name it came under, or else its hash. */
  const fileName = () => {
    const file = shows("filename") ? entity.latest?.file : undefined;
    if (!file) return undefined;
    return file.original_name ?? (file.extension ? `${file.hash}.${file.extension}` : file.hash);
  };
  const [metadata] = createResource(
    () => (shows("tags") && item() ? ([item()!.id, dataVersion()] as const) : null),
    ([id]) => api.getMetadata([id]),
  );
  /**
   * The file's tags as the side panel lists them: those of the aggregated
   * types in one list, then each other type that has any under its name.
   */
  const tagLists = () => {
    const tags = shows("tags") ? metadata.latest?.tags : undefined;
    if (!tags) return [];
    const of = (field: string) => (tags[field] ?? []).map((tag) => ({ field, value: tag.value }));
    return [
      { label: null as string | null, tags: aggregatedTypes().flatMap(of) },
      ...orderedTypes()
        .filter((field) => !tagType(field).aggregate)
        .map((field) => ({ label: fieldLabel(field) as string | null, tags: of(field) })),
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
    // Over the tags, the wheel scrolls them when there are more than fit.
    const list = (event.target as HTMLElement).closest?.(".viewer-tags");
    if (list && list.scrollHeight > list.clientHeight) return;
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
    }
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
    <div class="viewer" role="dialog" aria-modal="true" aria-label="Viewer" onWheel={onWheel}>
      <header>
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
          <Show when={fileName()}>
            {(name) => (
              <span class="viewer-file" title={`The file's name: ${name()}`}>
                <Icon name="draft-outline" />
                <span>{name()}</span>
              </span>
            )}
          </Show>
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
            title="Choose what the viewer shows"
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
        <Show when={tagLists().length > 0}>
          <aside class="viewer-tags" aria-label="Tags">
            <For each={tagLists()}>
              {(list) => (
                <>
                  <Show when={list.label}>
                    <span class="label">{list.label}:</span>
                  </Show>
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
          </aside>
        </Show>
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
  );
}
