import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { search } from "../search";
import { activeTab, setQuery } from "../tabs";

/** The query of the active tab, with the error it produced, if any. */
export default function QueryBar() {
  let input!: HTMLTextAreaElement;
  const [draft, setDraft] = createSignal("");

  // Switching tabs, or a saved change, resets the box to the tab's query.
  createEffect(() => setDraft(activeTab()?.query ?? ""));

  // The box grows with the query instead of scrolling sideways.
  createEffect(() => {
    draft();
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  });

  const submit = () => {
    const tab = activeTab();
    if (tab && draft() !== tab.query) setQuery(tab.id, draft());
  };

  // "/" focuses the search box from anywhere outside a text field.
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const typing = target.matches("input, textarea, select, [contenteditable]");
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  };
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  return (
    <form
      class="query"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={input}
        rows={1}
        aria-label="Search query"
        placeholder={
          activeTab()?.kind === "upload"
            ? "Filter these uploads"
            : activeTab()?.kind === "collection"
              ? "Filter this collection"
              : "cat creator=someone score>=5"
        }
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        value={draft()}
        // A query is one line: line breaks become spaces.
        onInput={(event) => setDraft(event.currentTarget.value.replace(/\n/g, " "))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            setDraft(activeTab()?.query ?? "");
            input.blur();
          }
        }}
      />
      <button type="submit" class="primary">
        Search
      </button>
      <Show when={search.error}>
        {(error) => (
          <p class="form-error" role="alert">
            {error().message}
            <Show when={error().position !== undefined}>
              {" "}
              (at character {error().position! + 1})
            </Show>
          </p>
        )}
      </Show>
    </form>
  );
}
