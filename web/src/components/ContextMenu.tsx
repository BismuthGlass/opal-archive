import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import * as api from "../api";
import type { Item } from "../api";
import { downloadNames } from "../settings";
import { errorMessage, plural } from "../format";
import {
  changed,
  clearMark,
  clearSelection,
  markCounts,
  moveItems,
  removeFromView,
  resultIds,
  search,
  selectMarked,
  selected,
} from "../search";
import { open as openTab, openSelection, shownSet } from "../tabs";
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

const close = () => setOpened(null);

/**
 * Deletes trashed files for good, once it has been agreed to. What is not
 * in the trash is never deleted. Returns whether anything was.
 */
async function removeForGood(ids: number[]): Promise<boolean> {
  if (!confirm(`Delete ${plural(ids.length, "item")} for good? This cannot be undone.`)) {
    return false;
  }
  await api.deleteEntities(ids);
  return true;
}

/**
 * The menu a right click on the grid brings up: what can be done with the
 * selection. Deleting is two steps, so what it offers depends on whether
 * the selection is in the trash already.
 */
export default function ContextMenu(props: {
  /** Opens the viewer on a result; with `only`, on those results alone. */
  onPreview: (index: number, only: number[] | null) => void;
  /** Asks for the given files to be put into a set. */
  onGroup: (ids: number[]) => void;
}) {
  // Keyed, so the menu is given the value itself and can use it as it closes.
  return (
    <Show when={opened()} keyed>
      {(at) =>
        at.mark ? (
          <MarkMenu at={at} mark={at.mark} />
        ) : at.tag ? (
          <TagMenu at={at} tag={at.tag} />
        ) : (
          <Menu at={at} item={at.item!} onPreview={props.onPreview} onGroup={props.onGroup} />
        )
      }
    </Show>
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
function Menu(props: {
  at: Opened;
  item: Item;
  onPreview: (index: number, only: number[] | null) => void;
  onGroup: (ids: number[]) => void;
}) {
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
    if (ids.length === 1) {
      location.href = api.contentUrl(ids[0], downloadNames());
    } else {
      api.exportZip(ids, downloadNames());
    }
  };

  /** Always a zip: the files, and their metadata beside them. */
  const exportAll = () => {
    close();
    api.exportZip(ids, downloadNames(), true);
  };

  /**
   * Opens the viewer on what was clicked: among all the results, or with
   * `chosen` among the selected ones alone, in the order they are listed.
   */
  const preview = async (chosen: boolean) => {
    close();
    const all = await resultIds();
    const at = all.indexOf(clicked.id);
    if (!chosen) {
      if (at >= 0) props.onPreview(at, null);
      return;
    }
    const picked = new Set(ids);
    const only = all.flatMap((id, index) => (picked.has(id) ? [index] : []));
    if (only.length > 0) props.onPreview(only.includes(at) ? at : only[0], only);
  };

  /** Does something to the view only, not to the entities. */
  const arrange = (action: () => Promise<void>) => {
    close();
    action().catch((err) => showToast(errorMessage(err)));
  };

  /** Whether any of the selection is a variant of something, to be ungrouped. */
  const grouped = () => {
    const group = state()?.scalars.alt_group_id;
    return group !== undefined && (group.mixed || group.value !== null);
  };
  /** The set on show, which the selection can be taken out of. */
  const set = shownSet();
  /** How many of the selection are in it. */
  const inShown = () => state()?.sets.find((held) => held.id === set?.id)?.count ?? 0;
  /** Says what was done to the selection's sets or variants, once it is. */
  const group = async (action: () => Promise<string>) => {
    close();
    try {
      showToast(await action());
    } catch (err) {
      showToast(errorMessage(err));
    }
    changed();
  };

  const remove = async () => {
    close();
    try {
      if (!(await removeForGood(ids))) return;
      // What was deleted is gone from the view, and so from the selection.
      clearSelection();
    } catch (err) {
      showToast(errorMessage(err));
    }
    changed();
  };

  return (
    <Shell at={props.at} label={`Actions on ${plural(ids.length, "item")}`}>
      <li class="context-menu-title" role="none">
        {plural(ids.length, "item")}
      </li>
      <li role="none">
        <button
          role="menuitem"
          title="Open this in the viewer, to step through all the results from it"
          onClick={() => preview(false)}
        >
          <Icon name="visibility-outline" />
          Preview
        </button>
      </li>
      <Show when={ids.length > 1}>
        <li role="none">
          <button
            role="menuitem"
            title="Open the viewer on the selected items alone"
            onClick={() => preview(true)}
          >
            <Icon name="visibility-outline" />
            Preview selected
          </button>
        </li>
      </Show>
      <li class="menu-divider" role="separator" />
      <li role="none">
        <button role="menuitem" onClick={download}>
          <Icon name="download" />
          Download
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          title="Download as a zip with the metadata beside each file, to upload to a library again"
          onClick={exportAll}
        >
          <Icon name="download" />
          Export with metadata
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          title="Open a tab that shows only these, to look through or filter further"
          onClick={() => {
            close();
            openSelection(ids);
          }}
        >
          <Icon name="open-in-new" />
          Open in a new tab
        </button>
      </li>
      <li class="menu-divider" role="separator" />
      <li role="none">
        <button
          role="menuitem"
          title="Put in a set, new or existing, besides any they are in"
          onClick={() => {
            close();
            props.onGroup(ids);
          }}
        >
          <Icon name="photo-library-outline" />
          Put in a set…
        </button>
      </li>
      {/* In a set: what of the selection is in it can be taken out, and
          what was taken out, and is still listed, put back. */}
      <Show when={set}>
        {(shown) => (
          <>
            <Show when={inShown() > 0}>
              <li role="none">
                <button
                  role="menuitem"
                  title="Take out of the set on show. The files stay in the library, and stay listed here, marked, until the view is refreshed."
                  onClick={() =>
                    group(async () => {
                      await api.changeSetFiles(shown().id, { remove: ids });
                      return `Took ${plural(inShown(), "file")} out of the set`;
                    })
                  }
                >
                  <Icon name="do-not-disturb-on-outline" />
                  Take out of this set
                </button>
              </li>
            </Show>
            <Show when={state() !== undefined && inShown() < ids.length}>
              <li role="none">
                <button
                  role="menuitem"
                  title="Put back in the set on show, after the files it holds"
                  onClick={() =>
                    group(async () => {
                      const back = ids.length - inShown();
                      await api.changeSetFiles(shown().id, { add: ids });
                      return `Put ${plural(back, "file")} back in the set`;
                    })
                  }
                >
                  <Icon name="add" />
                  Put back in this set
                </button>
              </li>
            </Show>
          </>
        )}
      </Show>
      <Show when={grouped()}>
        <li role="none">
          <button
            role="menuitem"
            title="Take these out of their variant groups. What else is in a group stays grouped."
            onClick={() =>
              group(async () => {
                await api.edit(ids, { set: { alt_group_id: null } });
                return `Ungrouped ${plural(ids.length, "file")}`;
              })
            }
          >
            <Icon name="close" />
            Ungroup variants
          </button>
        </li>
      </Show>
      <Show when={ids.length > 1}>
        <li role="none">
          <button
            role="menuitem"
            title="Mark these as variants of each other: they share a variant group"
            onClick={() =>
              group(async () => {
                await api.groupVariants(ids);
                return `Grouped ${plural(ids.length, "file")} as variants`;
              })
            }
          >
            <Icon name="label-outline" />
            Group as variants
          </button>
        </li>
      </Show>
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
          <button
            class="danger"
            role="menuitem"
            title="Delete for good"
            onClick={remove}
          >
            <Icon name="delete-forever-outline" />
            Delete for good
          </button>
        </li>
      </Show>
    </Shell>
  );
}
