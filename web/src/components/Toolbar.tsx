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
  refresh,
  resetOrder,
  resultIds,
  search,
  selectAll,
  selectMarked,
  selected,
} from "../search";
import { openMarkMenu, openTrashMenu } from "./ContextMenu";
import { shownCollection } from "../tabs";
import Icon from "./Icon";

/**
 * Above the grid: selection of the whole result, the order it has been
 * dragged into, and the pages of it.
 */
export default function Toolbar() {
  const from = () => search.page * PAGE + 1;
  const to = () => Math.min(search.total, (search.page + 1) * PAGE);
  const allSelected = () => search.total > 0 && selected().size >= search.total;
  /** The ordered collection on show, whose order can be saved. */
  const ordered = () => {
    const collection = shownCollection();
    return collection?.ordered ? collection : null;
  };
  const filtered = () => search.query.trim() !== "";

  const saveOrder = async (id: number) => {
    await api.setOrder(id, await resultIds());
    // The collection's own order is now the one on show.
    resetOrder();
  };

  return (
    <div class="toolbar">
      <button
        aria-label="Refresh"
        title="Calculate this search again. Until then the results listed stay as they are."
        onClick={refresh}
      >
        <Icon name="refresh" />
        Refresh
      </button>
      <Show when={shownCollection()}>
        {(collection) => (
          <button
            aria-label="Trash this collection"
            aria-haspopup="menu"
            title="Trash this collection, with or without what is inside it"
            onClick={(event) => openTrashMenu(event, collection())}
          >
            <Icon name="delete-outline" />
            Trash collection
          </button>
        )}
      </Show>
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
          <span class="toolbar-note">{plural(selected().size, "item")} selected</span>
          <button class="link" onClick={clearSelection}>
            Clear
          </button>
        </Show>
        {/* One badge for each mark in use, with how many results have it. */}
        <For each={Array.from({ length: MARKS }, (_, index) => index + 1)}>
          {(mark) => (
            <Show when={markCounts()[mark] > 0}>
              <button
                class={`mark-badge mark-${mark}`}
                aria-label={`Mark ${mark}: ${plural(markCounts()[mark], "item")}`}
                title={`${plural(markCounts()[mark], "item")} with mark ${mark}. Click to select, right click for more.`}
                onClick={() => selectMarked(mark)}
                onContextMenu={(event) => openMarkMenu(event, mark)}
              >
                {markCounts()[mark]}
              </button>
            </Show>
          )}
        </For>
        <Show when={ordered()}>
          {(collection) => (
            <button
              class="primary"
              disabled={!search.custom || filtered()}
              title={
                filtered()
                  ? "Clear the filter to save the order of the whole collection"
                  : search.custom
                    ? "Save this order as the collection's order"
                    : "Drag items to reorder them, then save the order here"
              }
              onClick={() => saveOrder(collection().id)}
            >
              Update order
            </button>
          )}
        </Show>
        <Show when={search.custom}>
          <span class="toolbar-note">{ordered() ? "Order not saved" : "Custom order"}</span>
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
