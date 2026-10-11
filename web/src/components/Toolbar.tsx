import { For, Show } from "solid-js";
import { plural } from "../format";
import * as api from "../api";
import {
  MARKS,
  PAGE,
  clearSelection,
  goToPage,
  markCounts,
  pageCount,
  resetOrder,
  resultIds,
  search,
  selectAll,
  selectMarked,
  selected,
  showFirstSelected,
} from "../search";
import { openMarkMenu } from "./ContextMenu";
import { shownSet } from "../tabs";
import Icon from "./Icon";

/**
 * Above the grid: selection of the whole result, the order it has been
 * dragged into, and the pages of it.
 */
export default function Toolbar() {
  const from = () => search.page * PAGE + 1;
  const to = () => Math.min(search.total, (search.page + 1) * PAGE);
  const allSelected = () => search.total > 0 && selected().size >= search.total;
  const filtered = () => search.query.trim() !== "";

  const saveOrder = async (id: string) => {
    await api.setOrder(id, await resultIds());
    // The set's own order is now the one on show.
    resetOrder();
  };

  return (
    <div class="toolbar">
      <Show when={search.total > 0}>
        <button
          onClick={selectAll}
          disabled={allSelected()}
          title="Select every result, on every page (Ctrl+A)"
        >
          <Icon name="select-all" />
          Select all {search.total}
        </button>
        <Show when={selected().size > 0}>
          <button
            class="link toolbar-note"
            title="Go to the first selected item, on whichever page it is"
            onClick={showFirstSelected}
          >
            {plural(selected().size, "item")} selected
          </button>
          <button class="link" onClick={clearSelection}>
            Clear
          </button>
        </Show>
        {/* One count for each mark in use, of how many results have it:
            joined end to end, as one strip of the marks' colours. */}
        <Show when={markCounts().some((count) => count > 0)}>
          <span class="mark-counts">
            <For each={Array.from({ length: MARKS }, (_, index) => index + 1)}>
              {(mark) => (
                <Show when={markCounts()[mark] > 0}>
                  <button
                    class={`mark-badge mark-${mark}`}
                    aria-label={`Mark ${mark}: ${plural(markCounts()[mark], "item")}`}
                    title={`${plural(markCounts()[mark], "item")} with mark ${mark}. Click to select, Ctrl or Cmd and click to add to the selection, right click for more.`}
                    // Cmd stands in for Ctrl, as it does on a tile.
                    onClick={(event) => selectMarked(mark, event.ctrlKey || event.metaKey)}
                    onContextMenu={(event) => openMarkMenu(event, mark)}
                  >
                    {markCounts()[mark]}
                  </button>
                </Show>
              )}
            </For>
          </span>
        </Show>
        <Show when={shownSet()}>
          {(set) => (
            <button
              class="primary"
              disabled={!search.custom || filtered()}
              title={
                filtered()
                  ? "Clear the filter to save the order of the whole set"
                  : search.custom
                    ? "Save this order as the set's order"
                    : "Drag items to reorder them, then save the order here"
              }
              onClick={() => saveOrder(set().set_id)}
            >
              Update order
            </button>
          )}
        </Show>
        <Show when={search.custom}>
          <span class="toolbar-note">{shownSet() ? "Order not saved" : "Custom order"}</span>
          <button class="link" title="Go back to the order before dragging" onClick={resetOrder}>
            Reset
          </button>
        </Show>
        <nav class="pager" aria-label="Pages">
          <span class="toolbar-note">
            {from()}–{to()} of {search.total}
          </span>
          <Show when={pageCount() > 1}>
            <button
              aria-label="First page"
              title="First page"
              disabled={search.page === 0}
              onClick={() => goToPage(0)}
            >
              <Icon name="first-page" />
            </button>
            <button
              aria-label="Previous page"
              title="Previous page"
              disabled={search.page === 0}
              onClick={() => goToPage(search.page - 1)}
            >
              <Icon name="chevron-left" />
            </button>
            <span class="pager-page">
              Page {search.page + 1} of {pageCount()}
            </span>
            <button
              aria-label="Next page"
              title="Next page"
              disabled={search.page >= pageCount() - 1}
              onClick={() => goToPage(search.page + 1)}
            >
              <Icon name="chevron-right" />
            </button>
            <button
              aria-label="Last page"
              title="Last page"
              disabled={search.page >= pageCount() - 1}
              onClick={() => goToPage(pageCount() - 1)}
            >
              <Icon name="last-page" />
            </button>
          </Show>
        </nav>
      </Show>
    </div>
  );
}
