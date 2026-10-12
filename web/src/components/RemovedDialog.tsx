import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { thumbnailUrl } from "../api";
import type { Item } from "../api";
import { errorMessage, plural } from "../format";
import { removed, removedItems, restoreToView } from "../search";
import { showToast } from "../toast";
import Modal from "./Modal";

const [open, setOpen] = createSignal(false);

/** Opens the list of what has been taken out of the view on show. */
export const openRemoved = () => setOpen(true);

/**
 * What has been taken out of the view on show since it was last searched
 * for, what went last first, to be put back: all of it, or what is picked.
 */
export default function RemovedDialog() {
  return (
    <Show when={open()}>
      <Dialog onClose={() => setOpen(false)} />
    </Show>
  );
}

const placeholder = (item: Item) =>
  item.extension ? item.extension.toUpperCase() : item.media_type;

function Dialog(props: { onClose: () => void }) {
  // Read again as some are put back.
  const [items] = createResource(removed, removedItems);
  const [picked, setPicked] = createSignal<ReadonlySet<number>>(new Set());
  const [error, setError] = createSignal<string | null>(null);

  // With nothing left to put back, there is nothing to show.
  createEffect(() => {
    if (removed().length === 0) props.onClose();
  });

  const toggle = (id: number) => {
    const next = new Set(picked());
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };

  const restore = async (ids: number[]) => {
    try {
      await restoreToView(ids);
      setPicked(new Set<number>());
      showToast(`Put ${plural(ids.length, "item")} back in this view`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title="Removed from this view" wide onClose={props.onClose}>
      <p class="hint">
        What was taken out of this view since it was last searched for, the latest first. Pick
        what to put back where it was, or put it all back.
      </p>
      <ul class="removed-list" aria-label="Removed from this view">
        <For each={items.latest ?? []}>
          {(item) => (
            <li>
              <button
                type="button"
                class="removed-tile"
                aria-pressed={picked().has(item.id)}
                title={item.title ?? undefined}
                onClick={() => toggle(item.id)}
                onDblClick={() => restore([item.id])}
              >
                <span class="thumb">
                  <Show
                    when={item.has_thumbnail}
                    fallback={<span class="placeholder">{placeholder(item)}</span>}
                  >
                    <img
                      src={thumbnailUrl(item.id, item.thumbnail_version)}
                      alt={item.title ?? ""}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                    />
                  </Show>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={error() ?? (items.error ? errorMessage(items.error) : null)}>
        {(message) => (
          <p class="form-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <footer>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
        <button type="button" onClick={() => restore(removed().map((was) => was.id))}>
          Put all {removed().length} back
        </button>
        <button
          type="button"
          class="primary"
          disabled={picked().size === 0}
          onClick={() => restore([...picked()])}
        >
          {picked().size > 0 ? `Put ${picked().size} back` : "Put back"}
        </button>
      </footer>
    </Modal>
  );
}
