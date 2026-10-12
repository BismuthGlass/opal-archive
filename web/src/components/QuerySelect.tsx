import { createEffect, createSignal, onMount, Show } from "solid-js";
import { ApiError } from "../api";
import { errorMessage, plural } from "../format";
import { selectByQuery } from "../search";
import { showToast } from "../toast";
import Modal from "./Modal";

const [open, setOpen] = createSignal(false);

/** Opens the dialog that selects by a query. */
export const openQuerySelect = () => setOpen(true);

/** The query last selected by, which the dialog opens on. */
let last = "";

/**
 * Selects by a query: of what the view on show lists, what the query
 * finds. The view itself stays as it is.
 */
export default function QuerySelect() {
  return (
    <Show when={open()}>
      <Dialog onClose={() => setOpen(false)} />
    </Show>
  );
}

function Dialog(props: { onClose: () => void }) {
  let input!: HTMLTextAreaElement;
  const [query, setQuery] = createSignal(last);
  /** Whether what is found joins what is selected, in place of replacing it. */
  const [add, setAdd] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [invalid, setInvalid] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // The box grows with the query instead of scrolling sideways.
  createEffect(() => {
    query();
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  });
  // The last query is there to be typed over, or used again.
  onMount(() => input.select());

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const typed = query().trim();
    setInvalid(false);
    if (typed === "") return setError("Write a query to select by.");
    last = typed;
    setBusy(true);
    try {
      const count = await selectByQuery(typed, add());
      if (count === 0) return setError("Nothing in this view matches.");
      showToast(
        add() ? `Added ${plural(count, "item")} to the selection` : `Selected ${plural(count, "item")}`,
      );
      props.onClose();
    } catch (err) {
      const at = err instanceof ApiError ? err.position : undefined;
      setInvalid(at !== undefined);
      setError(errorMessage(err) + (at === undefined ? "" : ` (at character ${at + 1})`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Select by query" onClose={props.onClose}>
      <form onSubmit={submit}>
        <div class="query">
          <textarea
            ref={input}
            rows={1}
            autofocus
            aria-label="Query to select by"
            aria-invalid={invalid()}
            placeholder="cat creator=someone score>=5"
            spellcheck={false}
            autocomplete="off"
            autocapitalize="off"
            value={query()}
            // The query is one line: line breaks become spaces.
            onInput={(event) => setQuery(event.currentTarget.value.replace(/\n/g, " "))}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
        </div>
        <p class="hint">
          Selects what this view lists that the query finds. The view stays as it is.
        </p>
        <label class="check">
          <input
            type="checkbox"
            checked={add()}
            onChange={(event) => setAdd(event.currentTarget.checked)}
          />
          Add to what is selected
        </label>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <footer>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={busy()}>
            Select
          </button>
        </footer>
      </form>
    </Modal>
  );
}
