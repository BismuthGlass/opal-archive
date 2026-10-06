import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import * as api from "../api";
import type { Item } from "../api";
import { errorMessage, plural } from "../format";
import {
  changed,
  clearMark,
  clearSelection,
  markCounts,
  moveItems,
  removeFromView,
  search,
  selectMarked,
  selected,
} from "../search";
import { inside, leave, open as openTab } from "../tabs";
import { editTag } from "../tagEditing";
import { fieldLabel, tagQuery } from "../format";
import { showToast } from "../toast";
import Icon from "./Icon";

/** A tag that was right-clicked, or with `under` the namespace of that name. */
export type MenuTag = { field: string; value: string; under?: boolean };

/** Where the menu is, and the item, tag or mark that was right-clicked. */
type Opened = {
  x: number;
  y: number;
  item?: Item;
  tag?: MenuTag;
  mark?: number;
  /** The collection on show, to be trashed. */
  shown?: { id: number; title: string | null };
};

const [opened, setOpened] = createSignal<Opened | null>(null);

/** Whether the menu is on screen; page-wide shortcuts stand down while it is. */
export const contextMenuOpen = () => opened() !== null;

/** Opens the menu of actions on the selection, at the pointer. */
export function openContextMenu(event: MouseEvent, item: Item) {
  event.preventDefault();
  setOpened({ x: event.clientX, y: event.clientY, item });
}

/** Opens the menu of what can be done with a tag, at the pointer. */
export function openTagMenu(event: MouseEvent, tag: MenuTag) {
  event.preventDefault();
  setOpened({ x: event.clientX, y: event.clientY, tag });
}

/** Opens the menu of what can be done with a mark, at the pointer. */
export function openMarkMenu(event: MouseEvent, mark: number) {
  event.preventDefault();
  setOpened({ x: event.clientX, y: event.clientY, mark });
}

/** Opens the menu of ways to trash the collection on show, under what was pressed. */
export function openTrashMenu(event: MouseEvent, shown: { id: number; title: string | null }) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  setOpened({ x: box.left, y: box.bottom + 2, shown });
}

const close = () => setOpened(null);

/**
 * Moves entities to the trash and, with `whole`, everything inside the
 * collections among them. Returns how many of what was inside went too.
 */
async function trash(ids: number[], whole: boolean): Promise<number> {
  const within = whole ? (await api.insideOf(ids)).filter((id) => !ids.includes(id)) : [];
  await api.trashEntities([...ids, ...within]);
  return within.length;
}

/**
 * The menu a right click on the grid brings up: what can be done with the
 * selection. Deleting is two steps, so what it offers depends on whether
 * the selection is in the trash already.
 */
export default function ContextMenu() {
  // Keyed, so the menu is given the value itself and can use it as it closes.
  return (
    <Show when={opened()} keyed>
      {(at) =>
        at.shown ? (
          <TrashMenu at={at} shown={at.shown} />
        ) : at.mark ? (
          <MarkMenu at={at} mark={at.mark} />
        ) : at.tag ? (
          <TagMenu at={at} tag={at.tag} />
        ) : (
          <Menu at={at} item={at.item!} />
        )
      }
    </Show>
  );
}

/** The ways to trash the collection on show. */
function TrashMenu(props: { at: Opened; shown: { id: number; title: string | null } }) {
  const shown = props.shown;
  const run = async (whole: boolean) => {
    close();
    try {
      const within = await trash([shown.id], whole);
      showToast(
        whole
          ? `Moved the collection and ${plural(within, "item")} inside it to the trash`
          : "Moved the collection to the trash",
      );
      // Out of it, if the tab had gone into it; its own tab stays on it.
      if (inside()?.id === shown.id) leave();
    } catch (err) {
      showToast(errorMessage(err));
    }
    changed();
  };
  return (
    <Shell at={props.at} label="Trash this collection">
      <li class="context-menu-title" role="none">
        This collection
      </li>
      <li role="none">
        <button
          class="danger"
          role="menuitem"
          title="Move the collection to the trash. What is in it stays in the library."
          onClick={() => run(false)}
        >
          <Icon name="delete-outline" />
          Trash the collection
        </button>
      </li>
      <li role="none">
        <button
          class="danger"
          role="menuitem"
          title="Move the collection to the trash, with everything inside it, at any depth"
          onClick={() => run(true)}
        >
          <Icon name="delete-outline" />
          Trash it and what is inside
        </button>
      </li>
    </Shell>
  );
}

/** What a right click on a mark's count brings up. */
function MarkMenu(props: { at: Opened; mark: number }) {
  const mark = props.mark;
  return (
    <Shell at={props.at} label={`Actions on mark ${mark}`}>
      <li class="context-menu-title" role="none">
        Mark {mark}: {plural(markCounts()[mark], "item")}
      </li>
      <li role="none">
        <button
          role="menuitem"
          onClick={() => {
            close();
            selectMarked(mark);
          }}
        >
          <Icon name="select-all" />
          Select
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          title="Take this mark off everything that has it"
          onClick={() => {
            close();
            clearMark(mark);
          }}
        >
          <Icon name="close" />
          Clear mark
        </button>
      </li>
    </Shell>
  );
}

/** What a right click on a tag brings up. */
function TagMenu(props: { at: Opened; tag: MenuTag }) {
  const tag = props.tag;
  return (
    <Shell at={props.at} label={`Actions on ${tag.value}`}>
      <li class="context-menu-title" role="none">
        {fieldLabel(tag.field)}: {tag.value}
        {tag.under ? ":*" : ""}
      </li>
      <li role="none">
        <button
          role="menuitem"
          onClick={() => {
            close();
            openTab("gallery", tagQuery(tag.field, tag.value, tag.under));
          }}
        >
          <Icon name="open-in-new" />
          Search in a new tab
        </button>
      </li>
      <Show when={!tag.under}>
        <li role="none">
          <button
            role="menuitem"
            title="Rename, merge, describe or alias it"
            onClick={() => {
              close();
              editTag(tag);
            }}
          >
            <Icon name="label-outline" />
            Open in the tag editor
          </button>
        </li>
      </Show>
    </Shell>
  );
}

/** The menu itself: where it is, and how it is put away. */
function Shell(props: { at: Opened; label: string; children: JSX.Element }) {
  let menu!: HTMLUListElement;
  const [position, setPosition] = createSignal({ left: props.at.x, top: props.at.y });

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
      aria-label={props.label}
      style={{ left: `${position().left}px`, top: `${position().top}px` }}
      // The menu's own right click does nothing.
      onContextMenu={(event) => event.preventDefault()}
    >
      {props.children}
    </ul>
  );
}

/** What a right click on the grid brings up. */
function Menu(props: { at: Opened; item: Item }) {
  // Read once, here: after the menu closes, what it was opened with can no
  // longer be asked for.
  const ids = [...selected()];
  const clicked = props.item;
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
      showToast(errorMessage(err));
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
    action().catch((err) => showToast(errorMessage(err)));
  };

  const remove = () => {
    close();
    if (confirm(`Delete ${plural(ids.length, "item")} for good? This cannot be undone.`)) {
      run(api.deleteEntities, true);
    }
  };

  return (
    <Shell at={props.at} label={`Actions on ${plural(ids.length, "item")}`}>
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
          <>
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
            {/* For collections: what is in them goes too. */}
            <Show when={(state()?.collections ?? 0) > 0}>
              <li role="none">
                <button
                  class="danger"
                  role="menuitem"
                  title="Move to the trash, with everything inside the collections, at any depth"
                  onClick={() => run((ids) => trash(ids, true))}
                >
                  <Icon name="delete-outline" />
                  Trash with what is inside
                </button>
              </li>
            </Show>
          </>
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
    </Shell>
  );
}
