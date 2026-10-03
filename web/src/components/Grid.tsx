import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { thumbnailUrl } from "../api";
import type { Item } from "../api";
import { duration, plural } from "../format";
import {
  PAGE,
  clickSelect,
  dataVersion,
  ensureRange,
  itemAt,
  search,
  searchCount,
  selected,
} from "../search";
import { stats } from "../stats";
import { open as openTab } from "../tabs";

// Layout constants, in pixels. Every tile has the same size, which is what
// lets the grid work out what is on screen without measuring anything.
const MIN_TILE = 160;
const GAP = 8;
const PADDING = 12;
/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN = 2;

const placeholder = (item: Item) =>
  item.kind === "collection"
    ? "collection"
    : item.extension
      ? item.extension.toUpperCase()
      : (item.media_type ?? "");

function badge(item: Item): string | null {
  if (item.kind === "collection") return plural(item.member_count ?? 0, "item");
  if (item.length !== null && item.media_type !== "image") return duration(item.length);
  return null;
}

/**
 * The results grid, showing one page of results. Only the tiles in or near
 * the viewport exist in the document.
 */
export default function Grid(props: { onOpen: (index: number) => void }) {
  let scroller!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);

  const columns = () =>
    Math.max(1, Math.floor((width() - 2 * PADDING + GAP) / (MIN_TILE + GAP)));
  const tile = () => (width() - 2 * PADDING - (columns() - 1) * GAP) / columns();
  const rowHeight = () => tile() + GAP;
  /** Result index of the first tile on this page, and how many it has. */
  const first = () => search.page * PAGE;
  const count = () => Math.max(0, Math.min(PAGE, search.total - first()));
  const rows = () => Math.ceil(count() / columns());

  const visible = createMemo(() => {
    if (width() === 0 || count() === 0) return [];
    const firstRow = Math.max(0, Math.floor((scrollTop() - PADDING) / rowHeight()) - OVERSCAN);
    const lastRow = Math.min(
      rows() - 1,
      Math.floor((scrollTop() + height() - PADDING) / rowHeight()) + OVERSCAN,
    );
    const start = firstRow * columns();
    const end = Math.min(count(), (lastRow + 1) * columns());
    return Array.from({ length: Math.max(0, end - start) }, (_, i) => first() + start + i);
  });

  createEffect(() => {
    dataVersion();
    const indices = visible();
    if (indices.length > 0) ensureRange(indices[0], indices[indices.length - 1]);
  });

  // A new search, or another page, starts at the top.
  createEffect(
    on([searchCount, () => search.page], () => {
      scroller.scrollTop = 0;
      setScrollTop(0);
    }),
  );

  onMount(() => {
    const observer = new ResizeObserver(() => {
      setWidth(scroller.clientWidth);
      setHeight(scroller.clientHeight);
    });
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
  });

  const activate = (index: number, item: Item) => {
    if (item.kind === "collection") openTab("search", `in=${item.id} sort=position`);
    else props.onOpen(index);
  };

  return (
    <div class="results" ref={scroller} onScroll={() => setScrollTop(scroller.scrollTop)}>
      <Show when={search.ready && search.total === 0 && !search.error}>
        <p class="empty">
          {stats()?.files === 0 && stats()?.collections === 0
            ? "The library is empty. Open an upload tab with +, or drop files here."
            : search.scope !== null && search.query === ""
              ? "Nothing uploaded in this tab yet."
              : "No results."}
        </p>
      </Show>
      <div class="grid" style={{ height: `${rows() * rowHeight() + 2 * PADDING - GAP}px` }}>
        <For each={visible()}>
          {(index) => {
            const item = () => itemAt(index);
            const place = () => index - first();
            const x = () => PADDING + (place() % columns()) * (tile() + GAP);
            const y = () => PADDING + Math.floor(place() / columns()) * rowHeight();
            return (
              <div
                class="tile"
                classList={{
                  selected: item() !== undefined && selected().has(item()!.id),
                  collection: item()?.kind === "collection",
                }}
                style={{
                  width: `${tile()}px`,
                  transform: `translate(${x()}px, ${y()}px)`,
                }}
                onClick={(event) => {
                  const current = item();
                  if (!current) return;
                  clickSelect(index, current.id, {
                    shift: event.shiftKey,
                    toggle: event.ctrlKey || event.metaKey,
                  });
                }}
                onDblClick={() => item() && activate(index, item()!)}
              >
                <div class="thumb" style={{ height: `${tile()}px` }}>
                  <Show when={item()}>
                    {(current) => (
                      <>
                        <Show
                          when={current().thumbnail !== null}
                          fallback={<span class="placeholder">{placeholder(current())}</span>}
                        >
                          <img
                            src={thumbnailUrl(current().thumbnail!)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                          />
                        </Show>
                        <Show when={badge(current())}>
                          {(text) => <span class="badge">{text()}</span>}
                        </Show>
                        {/* Only titled entries get a label, over the image. */}
                        <Show when={current().title}>
                          {(title) => (
                            <span class="tile-title" title={title()}>
                              {title()}
                            </span>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
