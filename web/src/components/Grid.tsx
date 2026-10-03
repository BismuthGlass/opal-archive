import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { thumbnailUrl } from "../api";
import type { Item } from "../api";
import { duration, plural } from "../format";
import {
  PAGE,
  clickSelect,
  dataVersion,
  ensureRange,
  goToPage,
  itemAt,
  moveItems,
  search,
  searchCount,
  selected,
} from "../search";
import { stats } from "../stats";
import { openCollection } from "../tabs";

// Layout constants, in pixels. Every tile has the same size, which is what
// lets the grid work out what is on screen without measuring anything.
const MIN_TILE = 160;
const GAP = 8;
const PADDING = 12;
/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN = 2;
/** How far the pointer travels before a press on a tile becomes a drag. */
const DRAG_THRESHOLD = 6;
/** Dragging this close to the top or bottom edge scrolls the grid. */
const SCROLL_EDGE = 48;
/** Holding a drag over a pager button this long turns the page. */
const PAGE_HOLD = 600;

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
 *
 * Tiles can be dragged to reorder the results: the dragged tile, or the
 * whole selection if it is part of one. Holding the drag over a pager
 * button turns the page, so an item can be carried to any other page.
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
    if (item.kind === "collection") openCollection(item.id);
    else props.onOpen(index);
  };

  /** The IDs being dragged, and where the pointer is. */
  const [drag, setDrag] = createSignal<{ ids: number[]; x: number; y: number } | null>(null);
  /** Where a drop would land: a place on this page, 0 to `count()`. */
  const [slot, setSlot] = createSignal<number | null>(null);
  /** Swallows the click that ends a drag, so it does not also select. */
  let dragged = false;

  const slotAt = (clientX: number, clientY: number): number | null => {
    const box = scroller.getBoundingClientRect();
    if (clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) {
      return null;
    }
    const x = clientX - box.left - PADDING;
    const y = clientY - box.top + scroller.scrollTop - PADDING;
    const row = Math.max(0, Math.min(rows() - 1, Math.floor(y / rowHeight())));
    // Between two tiles: before whichever has its middle right of the pointer.
    const column = Math.max(0, Math.min(columns(), Math.round(x / (tile() + GAP))));
    return Math.min(count(), row * columns() + column);
  };

  const startDrag = (id: number, down: PointerEvent) => {
    if (down.button !== 0) return;
    let last = down;
    let frame = 0;
    let hold: { button: Element; timer: number } | null = null;

    const release = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    // Scrolls while the pointer rests near an edge, and keeps the slot
    // under a pointer that is not moving.
    const tick = () => {
      const box = scroller.getBoundingClientRect();
      const inside = last.clientX >= box.left && last.clientX <= box.right;
      if (inside && last.clientY < box.top + SCROLL_EDGE) scroller.scrollTop -= 12;
      else if (inside && last.clientY > box.bottom - SCROLL_EDGE) scroller.scrollTop += 12;
      setSlot(slotAt(last.clientX, last.clientY));
      frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      last = event;
      if (!drag()) {
        const far = Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY);
        if (far < DRAG_THRESHOLD) return;
        frame = requestAnimationFrame(tick);
      }
      setDrag({
        ids: drag()?.ids ?? (selected().has(id) ? [...selected()] : [id]),
        x: event.clientX,
        y: event.clientY,
      });
      // Resting on a pager button turns the page, again and again.
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const button = under?.closest(".pager button:not(:disabled)") ?? null;
      if (button !== (hold?.button ?? null)) {
        release();
        if (button) {
          const turn = () => {
            (button as HTMLButtonElement).click();
            if (hold) hold.timer = window.setTimeout(turn, PAGE_HOLD);
          };
          hold = { button, timer: window.setTimeout(turn, PAGE_HOLD) };
        }
      }
    };
    const onUp = (event: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(frame);
      release();
      const moving = drag();
      if (!moving) return;
      dragged = true;
      // The click, if one follows, comes before this timer.
      setTimeout(() => (dragged = false));
      const place = event.type === "pointerup" ? slotAt(event.clientX, event.clientY) : null;
      setDrag(null);
      setSlot(null);
      if (place !== null) moveItems(moving.ids, first() + place);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  onCleanup(() => setDrag(null));

  /** Where the insertion marker is drawn for a slot. */
  const marker = (place: number) => {
    // The end of a full row is shown there, not at the start of the next.
    const atRowEnd = place > 0 && place % columns() === 0 && place === count();
    const row = atRowEnd ? place / columns() - 1 : Math.floor(place / columns());
    const column = atRowEnd ? columns() : place % columns();
    return {
      transform: `translate(${PADDING + column * (tile() + GAP) - GAP / 2 - 1.5}px, ${PADDING + row * rowHeight()}px)`,
      height: `${tile()}px`,
    };
  };

  return (
    <div
      class="results"
      classList={{ reordering: drag() !== null }}
      ref={scroller}
      onScroll={() => setScrollTop(scroller.scrollTop)}
    >
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
                  moving: item() !== undefined && (drag()?.ids.includes(item()!.id) ?? false),
                }}
                style={{
                  width: `${tile()}px`,
                  transform: `translate(${x()}px, ${y()}px)`,
                }}
                onPointerDown={(event) => item() && startDrag(item()!.id, event)}
                onClick={(event) => {
                  const current = item();
                  if (!current || dragged) return;
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
        <Show when={slot() !== null}>
          <div class="drop-marker" style={marker(slot()!)} />
        </Show>
      </div>
      <Show when={drag()}>
        {(moving) => (
          <div class="drag-chip" style={{ left: `${moving().x + 14}px`, top: `${moving().y + 14}px` }}>
            Moving {plural(moving().ids.length, "item")}
          </div>
        )}
      </Show>
    </div>
  );
}
