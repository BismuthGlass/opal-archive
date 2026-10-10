import { createEffect, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { errorMessage } from "../format";
import { queryLabel, savedQueries, saveQuery } from "../savedQueries";
import { refresh, search } from "../search";
import { activeTab, filterInside, inside, setQuery, setShowsTrashed, showsTrashed } from "../tabs";
import Icon from "./Icon";

/** Writes a term into the search box on show, if there is one. */
let write: ((term: string) => void) | null = null;

/**
 * Adds a term to the query in the search box, without searching: it is
 * there to be added to, and searched when wanted.
 */
export const addToQuery = (term: string) => write?.(term);

/** A stacked query is kept as one line per row. */
const rowsOf = (query: string) => query.split("\n");

/**
 * The query of the active tab, with the error it produced, if any. It is a
 * stack of rows, each a query of its own: what is found is what every row
 * matches.
 */
export default function QueryBar() {
  const inputs: HTMLTextAreaElement[] = [];
  const [rows, setRows] = createSignal([""]);
  /** Whether the + button's menu of saved queries is open. */
  const [menu, setMenu] = createSignal(false);
  /** The row being saved, while its name is typed. */
  const [naming, setNaming] = createSignal<number | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  /** Whether the trash is to be listed too: like the rows, searched for when asked. */
  const [trashed, setTrashed] = createSignal(false);

  // Inside a set the box filters it, and the tab's own query waits.
  const stored = () => inside()?.query ?? activeTab()?.query ?? "";
  /** The saved queries there is something to add from. */
  const offered = () => savedQueries().filter((saved) => saved.query.trim() !== "");

  // Switching tabs, or a saved change, resets the rows to the tab's query.
  createEffect(() => {
    setRows(rowsOf(stored()));
    setNaming(null);
  });
  createEffect(() => setTrashed(showsTrashed()));

  // Rows left empty are not part of the query.
  const typed = () =>
    rows()
      .map((row) => row.trim())
      .filter((row) => row !== "")
      .join("\n");
  /** Whether searching would do anything: the query on show is this one. */
  const unchanged = () => typed() === stored() && trashed() === showsTrashed() && !search.idle;

  const submit = () => {
    const tab = activeTab();
    const query = typed();
    // Showing the trash, or not, is searched for as a change of query is.
    const switched = tab !== undefined && trashed() !== showsTrashed();
    if (switched) setShowsTrashed(tab.id, trashed());
    if (query === stored() && search.idle) {
      // The search a newly opened tab was waiting to be asked for.
      if (!switched) refresh();
    } else if (inside()) {
      if (query !== inside()!.query) filterInside(query);
    } else if (tab && query !== tab.query) {
      setQuery(tab.id, query);
    }
  };

  const setRow = (index: number, text: string) =>
    setRows(rows().map((row, i) => (i === index ? text : row)));

  const focus = (index: number) => queueMicrotask(() => inputs[index]?.focus());

  // A term goes at the end of the last row, unless that row has it already.
  write = (term) => {
    const last = rows().length - 1;
    const row = rows()[last].trimEnd();
    if (!row.split(/\s+/).includes(term)) setRow(last, row === "" ? term : `${row} ${term}`);
    queueMicrotask(() => {
      const input = inputs[last];
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  };
  onCleanup(() => (write = null));

  const addRow = () => {
    setRows([...rows(), ""]);
    focus(rows().length - 1);
  };

  /** Adds a saved query as a row, in place of a last row left empty. */
  const addSaved = (query: string) => {
    const kept = rows().at(-1)?.trim() === "" ? rows().slice(0, -1) : rows();
    setRows([...kept, query]);
    submit();
  };

  const removeRow = (index: number) => {
    const rest = rows().filter((_, i) => i !== index);
    setRows(rest.length > 0 ? rest : [""]);
    setNaming(null);
    submit();
  };

  const save = (index: number, name: string) => {
    setNaming(null);
    saveQuery(name.trim(), rows()[index].trim()).then(
      () => setSaveError(null),
      (err) => setSaveError(errorMessage(err)),
    );
  };

  // "/" focuses the search box from anywhere outside a text field.
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const typing = target.matches("input, textarea, select, [contenteditable]");
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      inputs[0].focus();
      inputs[0].select();
    }
  };
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  const placeholder = () =>
    inside() || activeTab()?.kind === "set"
      ? "Filter this set"
      : activeTab()?.kind === "upload"
        ? "Filter these uploads"
        : activeTab()?.kind === "selection"
          ? "Filter this selection"
          : "cat creator=someone score>=5";

  return (
    <form
      class="query"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Index each={rows()}>
        {(row, index) => {
          // The box grows with the query instead of scrolling sideways.
          createEffect(() => {
            row();
            const input = inputs[index];
            input.style.height = "auto";
            input.style.height = `${input.scrollHeight + 2}px`;
          });
          return (
            <>
              <div class="query-row">
                <textarea
                  ref={(el) => (inputs[index] = el)}
                  rows={1}
                  aria-label={rows().length > 1 ? `Search query, row ${index + 1}` : "Search query"}
                  aria-invalid={search.error?.line === index && rows().length > 1}
                  placeholder={index === 0 ? placeholder() : "Narrow it down"}
                  spellcheck={false}
                  autocomplete="off"
                  autocapitalize="off"
                  value={row()}
                  // A row is one line: line breaks become spaces.
                  onInput={(event) => setRow(index, event.currentTarget.value.replace(/\n/g, " "))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submit();
                    } else if (event.key === "Escape") {
                      setRows(rowsOf(stored()));
                      event.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  aria-label="Save this query"
                  title="Save this query, to use it again"
                  disabled={row().trim() === ""}
                  onClick={() => setNaming(naming() === index ? null : index)}
                >
                  <Icon name="bookmark-outline" />
                </button>
                <Show when={rows().length > 1}>
                  <button
                    type="button"
                    aria-label="Remove this row"
                    title="Remove this row"
                    onClick={() => removeRow(index)}
                  >
                    <Icon name="close" />
                  </button>
                </Show>
              </div>
              <Show when={naming() === index}>
                <input
                  class="query-name"
                  type="text"
                  aria-label="Name of the saved query"
                  placeholder="Name it, then Enter"
                  ref={(el) => queueMicrotask(() => el.focus())}
                  onBlur={() => setNaming(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      save(index, event.currentTarget.value);
                    } else if (event.key === "Escape") {
                      setNaming(null);
                    }
                  }}
                />
              </Show>
            </>
          );
        }}
      </Index>
      <div class="query-actions">
        <div
          class="query-add"
          // Closes when focus leaves the button and its menu.
          onFocusOut={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(false);
          }}
          // A native listener, so stopping the event keeps Escape from also
          // clearing the selection.
          on:keydown={(event) => {
            if (event.key === "Escape" && menu()) {
              event.stopPropagation();
              setMenu(false);
            }
          }}
        >
          <button
            type="button"
            aria-label="Add a row"
            title="Add a row, to narrow the results down"
            aria-haspopup={offered().length > 0 ? "menu" : undefined}
            aria-expanded={offered().length > 0 ? menu() : undefined}
            // With nothing saved there is nothing to choose from.
            onClick={() => (offered().length > 0 ? setMenu(!menu()) : addRow())}
          >
            <Icon name="add" />
          </button>
          <Show when={menu()}>
            <ul class="suggestions" role="menu">
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    addRow();
                  }}
                >
                  Empty row
                </button>
              </li>
              <li class="menu-divider" role="separator" />
              <For each={offered()}>
                {(saved) => (
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      title={saved.query}
                      onClick={() => {
                        setMenu(false);
                        addSaved(saved.query);
                      }}
                    >
                      {queryLabel(saved)}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
        <button
          type="submit"
          class="primary"
          disabled={unchanged()}
          title={
            unchanged()
              ? "These are the results of this query. Refresh calculates them again."
              : undefined
          }
        >
          Search
        </button>
      </div>
      <label
        class="check query-trashed"
        title="List what is in the trash along with the rest, the next time Search is pressed. Without it, only a query that says @trashed finds it."
      >
        <input
          type="checkbox"
          checked={trashed()}
          onChange={(event) => {
            setTrashed(event.currentTarget.checked);
            // Left with the focus, it would keep the gallery's hotkeys.
            event.currentTarget.blur();
          }}
        />
        Show trashed
      </label>
      <Show when={search.error}>
        {(error) => (
          <p class="form-error" role="alert">
            {error().message}
            <Show when={error().position !== undefined}>
              {" "}
              (
              <Show when={search.query.includes("\n")}>row {(error().line ?? 0) + 1}, </Show>
              at character {error().position! + 1})
            </Show>
          </p>
        )}
      </Show>
      <Show when={saveError()}>
        <p class="form-error" role="alert">
          {saveError()}
        </p>
      </Show>
    </form>
  );
}
