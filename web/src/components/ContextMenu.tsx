import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import * as api from "../api";
import type { Item } from "../api";
import { plural } from "../format";
import { changed, clearSelection, moveItems, removeFromView, search, selected } from "../search";
import { showToast } from "../toast";
import Icon from "./Icon";

/** Where the menu is, and the item that was right-clicked. */
type Opened = { x: number; y: number; item: Item };

const [opened, setOpened] = createSignal<Opened | null>(null);

/** Whether the menu is on screen; page-wide shortcuts stand down while it is. */
export const contextMenuOpen = () => opened() !== null;

/** Opens the menu of actions on the selection, at the pointer. */
export function openContextMenu(event: MouseEvent, item: Item) {
  event.preventDefault();
  setOpened({ x: event.clientX, y: event.clientY, item });
}

const close = () => setOpened(null);

/**
 * The menu a right click on the grid brings up: what can be done with the
 * selection. Deleting is two steps, so what it offers depends on whether
 * the selection is in the trash already.
 */
export default function ContextMenu() {
  // Keyed, so the menu is given the value itself and can use it as it closes.
  return (
    <Show when={opened()} keyed>
      {(at) => <Menu at={at} />}
    </Show>
  );
}

function Menu(props: { at: Opened }) {
  let menu!: HTMLUListElement;
  // Read once, here: after the menu closes, what it was opened with can no
  // longer be asked for.
  const ids = [...selected()];
  const clicked = props.at.item;
  const [position, setPosition] = createSignal({ left: props.at.x, top: props.at.y });
  // Whether everything selected is in the trash, which the items on other
  // pages may or may not be.
  const [state] = createResource(() => api.getMetadata(ids));
  const allTrashed = () => state() !== undefined && state()!.trashed === state()!.count;

  const run = async (action: (ids: number[]) => Promise<unknown>, gone = false) => {
    close();
    try {
      await action(ids);
      // Trashed and restored items stay listed, and selected; deleted ones
      // are gone.
      if (gone) clearSelection();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
    changed();
  };

  const download = () => {
    close();
    // One file downloads as itself; anything else as a zip.
    if (ids.length === 1 && clicked.kind === "file") {
      location.href = api.contentUrl(ids[0], true);
    } else {
      api.exportZip(ids);
    }
  };

  /** Does something to the view only, not to the entities. */
  const arrange = (action: () => Promise<void>) => {
    close();
    action().catch((err) => showToast(err instanceof Error ? err.message : String(err)));
  };

  const remove = () => {
    close();
    if (confirm(`Delete ${plural(ids.length, "item")} for good? This cannot be undone.`)) {
      run(api.deleteEntities, true);
    }
  };

  // Any press outside the menu, a scroll or Escape puts it away.
  const onPointerDown = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // The arrows walk the items, starting from the first or the last.
      event.preventDefault();
      event.stopImmediatePropagation();
      const items = [...menu.querySelectorAll("button")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : at + step;
      items[(next + items.length) % items.length]?.focus();
    }
  };
  onMount(() => {
    // Kept inside the window, opening leftwards or upwards near its edges.
    const box = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(props.at.x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(props.at.y, window.innerHeight - box.height - 4)),
    });
    // The menu takes the keyboard without lighting up any one item.
    menu.focus();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
  });
  onCleanup(() => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("wheel", close);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", close);
  });

  return (
    <ul
      class="context-menu"
      role="menu"
      tabindex={-1}
      ref={menu}
      aria-label={`Actions on ${plural(ids.length, "item")}`}
      style={{ left: `${position().left}px`, top: `${position().top}px` }}
      // The menu's own right click does nothing.
      onContextMenu={(event) => event.preventDefault()}
    >
      <li class="context-menu-title" role="none">
        {plural(ids.length, "item")}
      </li>
      <li role="none">
        <button role="menuitem" onClick={download}>
          <Icon name="download" />
          Download
        </button>
      </li>
      <li class="menu-divider" role="separator" />
      <li role="none">
        <button
          role="menuitem"
          title="Put at the start of this view"
          onClick={() => arrange(() => moveItems(ids, 0))}
        >
          <Icon name="vertical-align-top" />
          Move to start
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          title="Put at the end of this view"
          onClick={() => arrange(() => moveItems(ids, search.total))}
        >
          <Icon name="vertical-align-bottom" />
          Move to end
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          title="Take out of this view only. Nothing is trashed, and Refresh brings it back."
          onClick={() => arrange(() => removeFromView(ids))}
        >
          <Icon name="visibility-off-outline" />
          Remove from view
        </button>
      </li>
      <li class="menu-divider" role="separator" />
      <Show
        when={allTrashed()}
        fallback={
          <li role="none">
            <button
              class="danger"
              role="menuitem"
              title="Move to the trash"
              onClick={() => run(api.trashEntities)}
            >
              <Icon name="delete-outline" />
              Trash
            </button>
          </li>
        }
      >
        <li role="none">
          <button
            role="menuitem"
            title="Take out of the trash"
            onClick={() => run(api.restoreEntities)}
          >
            <Icon name="restore-from-trash-outline" />
            Restore
          </button>
        </li>
        <li role="none">
          <button class="danger" role="menuitem" title="Delete for good" onClick={remove}>
            <Icon name="delete-forever-outline" />
            Delete for good
          </button>
        </li>
      </Show>
    </ul>
  );
}
