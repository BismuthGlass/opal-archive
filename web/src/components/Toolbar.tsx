import { Show } from "solid-js";
import { plural } from "../format";
import { PAGE, clearSelection, goToPage, pageCount, search, selectAll, selected } from "../search";
import Icon from "./Icon";

/** Above the grid: selection of the whole result, and the pages of it. */
export default function Toolbar() {
  const from = () => search.page * PAGE + 1;
  const to = () => Math.min(search.total, (search.page + 1) * PAGE);
  const allSelected = () => search.total > 0 && selected().size >= search.total;

  return (
    <Show when={search.total > 0}>
      <div class="toolbar">
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
      </div>
    </Show>
  );
}
