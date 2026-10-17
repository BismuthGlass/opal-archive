import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import * as api from "../api";
import type { Item } from "../api";
import * as edits from "../edits";
import { downloadNames } from "../settings";
import { errorMessage, plural } from "../format";
import {
  changed,
  clearMark,
  clearSelection,
  listedMarked,
  listedSelected,
  markCounts,
  markNames,
  moveItems,
  nameMark,
  pageSize,
  removeFromView,
  removed,
  resetOrder,
  resultIds,
  search,
  selectAll,
  selectMarked,
  selected,
  showFirstSelected,
  shuffleOrder,
} from "../search";
import { activeTab, enter, inside, open as openTab, openSelection, shownMark, shownSet } from "../tabs";
import { clearFromDrop } from "../inbox";
import { manageTag } from "../tagManaging";
import { fieldLabel, tagQuery } from "../format";
import { showToast } from "../toast";
import type { GroupKind } from "./GroupDialog";
import { keyFor, keyLabel } from "../hotkeys";
import Icon from "./Icon";
import { openQuerySelect } from "./QuerySelect";
import { openRemoved } from "./RemovedDialog";
import type { IconName } from "./Icon";

/** A tag that was right-clicked, or with `under` the namespace of that name. */
export type MenuTag = { field: string; value: string; under?: boolean };

/** Opens the viewer on a result; with `only`, on those results alone. */
type Preview = (index: number, only: number[] | null) => void;

/**
 * Where the menu is, and the item, tag or mark that was right-clicked; or
 * with `view`, that it is the menu of the view, opened from its button; or
 * with `shown`, the file on show in the viewer and how to go to it.
 */
type Opened = {
  x: number;
  y: number;
  item?: Item;
  tag?: MenuTag;
  mark?: number;
  view?: true;
  shown?: { item: Item; goTo: () => void };
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

/** Opens the menu of the file on show in the viewer, at the pointer. */
export function openViewerMenu(event: MouseEvent, item: Item, goTo: () => void) {
  event.preventDefault();
  setOpened({ x: event.clientX, y: event.clientY, shown: { item, goTo } });
}

/** When the menu was last put away: a press on its own button does that first. */
let closedAt = 0;
const close = () => {
  if (opened() !== null) closedAt = Date.now();
  setOpened(null);
};

/**
 * Opens the menu of the view on show, under the button pressed: what is
 * selected in it and the order it is in. A press on the button while the
 * menu is open only puts it away.
 */
export function openViewMenu(button: HTMLElement) {
  if (Date.now() - closedAt < 250) return;
  const box = button.getBoundingClientRect();
  setOpened({ x: box.left, y: box.bottom + 4, view: true });
}

/**
 * Deletes trashed files for good, once it has been agreed to. What is not
 * in the trash is never deleted. Returns whether anything was.
 */
export async function removeForGood(ids: number[]): Promise<boolean> {
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
  onPreview: Preview;
  /** Asks for the given files to be put in a set, or a collection. */
  onGroup: (kind: GroupKind, ids: number[]) => void;
}) {
  // Keyed, so the menu is given the value itself and can use it as it closes.
  return (
    <Show when={opened()} keyed>
      {(at) =>
        at.view ? (
          <ViewMenu at={at} onPreview={props.onPreview} />
        ) : at.shown ? (
          <ViewerMenu at={at} shown={at.shown} />
        ) : at.mark ? (
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

/** What the button above the grid brings up: the view's selection, and its order. */
function ViewMenu(props: { at: Opened; onPreview: Preview }) {
  const none = () => selected().size === 0;
  /** Opens the viewer on the selected alone, in the order they are listed. */
  const previewSelected = async () => {
    const chosen = selected();
    const only = (await resultIds()).flatMap((id, index) => (chosen.has(id) ? [index] : []));
    if (only.length > 0) props.onPreview(only[0], only);
  };
  /** Focuses on the selected: goes into them, in the order they are listed. */
  const focusSelected = async () => enter({ selection: await listedSelected(), at: Date.now() });
  /** Does one thing and puts the menu away. */
  const then = (action: () => unknown) => () => {
    close();
    action();
  };
  return (
    <Shell at={props.at} label="Selection and order of this view">
      <li role="none">
        <button
          role="menuitem"
          disabled={search.total === 0}
          title="Open the viewer on the first result of this page, to step through them all"
          onClick={then(() => props.onPreview(search.page * pageSize(), null))}
        >
          <Icon name="visibility-outline" />
          Preview
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          disabled={none()}
          title="Open the viewer on the selected items alone"
          onClick={then(previewSelected)}
        >
          <Icon name="visibility-outline" />
          Preview selected
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          disabled={none()}
          title="Focus on what is selected: the view becomes those files alone, with a way back"
          onClick={then(focusSelected)}
        >
          <Icon name="folder-outline" />
          Focus on selected
        </button>
      </li>
      <li class="menu-divider" role="separator" />
      <li role="none">
        <button
          role="menuitem"
          disabled={search.total === 0 || selected().size >= search.total}
          title="Select every result, on every page (Ctrl+A)"
          onClick={then(selectAll)}
        >
          <Icon name="select-all" />
          Select all {search.total}
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          disabled={search.total === 0}
          title={`Select what this view lists that a query finds (${keyLabel(keyFor("selectByQuery"))})`}
          onClick={then(openQuerySelect)}
        >
          <Icon name="search" />
          Select by query…
        </button>
      </li>
      <li role="none">
        <button
          role="menuitem"
          disabled={none()}
          title="Go to the first selected item, on whichever page it is"
          onClick={then(showFirstSelected)}
        >
          <Icon name="subdirectory-arrow-right" />
          Go to selected
        </button>
      </li>
      <li role="none">
        <button role="menuitem" disabled={none()} onClick={then(clearSelection)}>
          <Icon name="close" />
          Clear selection
        </button>
      </li>
      <li class="menu-divider" role="separator" />
      <li role="none">
        <button
          role="menuitem"
          disabled={removed().length === 0}
          title={`What was taken out of this view since it was last searched for, to put back (${keyLabel(keyFor("showRemoved"))})`}
          onClick={then(openRemoved)}
        >
          <Icon name="undo" />
          Removed from view… {removed().length > 0 ? `(${removed().length})` : ""}
        </button>
      </li>
      <Submenu icon="sort" label="Order">
        <li role="none">
          <button
            role="menuitem"
            disabled={search.total < 2}
            title="Put every result of this view in an order drawn by lot"
            onClick={then(shuffleOrder)}
          >
            <Icon name="shuffle" />
            Shuffle
          </button>
        </li>
        <li role="none">
          <button
            role="menuitem"
            disabled={!search.custom}
            title={
              search.custom
                ? "Go back to the order the search gives"
                : "The order is the one the search gives"
            }
            onClick={then(resetOrder)}
          >
            <Icon name="undo" />
            Reset
          </button>
        </li>
      </Submenu>
    </Shell>
  );
}

/** What a right click on a mark's count brings up. */
function MarkMenu(props: { at: Opened; mark: number }) {
  const mark = props.mark;
  // Read once, here: the menu is gone by the time it is used.
  const named = markNames()[mark];
  /** Asks what the mark is for here. Nothing given leaves it as it was. */
  const name = () => {
    close();
    const given = prompt(`What is mark ${mark} for, in this tab?`, named ?? "");
    if (given !== null) nameMark(mark, given);
  };
  return (
    <Shell at={props.at} label={`Actions on mark ${mark}`}>
      <li class="context-menu-title" role="none">
        Mark {mark}
        {named ? ` (${named})` : ""}: {plural(markCounts()[mark], "item")}
      </li>
      <li role="none">
        <button
          role="menuitem"
          disabled={shownMark() === mark}
          title={
            shownMark() === mark
              ? "This is what is on show"
              : "Focus on what has this mark in this view: the view becomes those files alone, with a way back"
          }
          onClick={async () => {
            close();
            enter({ mark, ids: await listedMarked(mark) });
          }}
        >
          <Icon name="subdirectory-arrow-right" />
          Focus
        </button>
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
      <li class="menu-divider" role="separator" />
      <li role="none">
        <button
          role="menuitem"
          title="Say what this mark is for in this tab. The name is shown beside its count."
          onClick={name}
        >
          <Icon name="edit-outline" />
          {named ? "Rename…" : "Name…"}
        </button>
      </li>
      <Show when={named}>
        <li role="none">
          <button
            role="menuitem"
            onClick={() => {
              close();
              nameMark(mark, null);
            }}
          >
            <Icon name="undo" />
            Clear name
          </button>
        </li>
      </Show>
      <li role="none">
        <button
          role="menuitem"
          title="Take this mark off everything in this tab that has it, listed here or not"
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

/**
 * Puts an image on the clipboard, as a PNG: the one kind of picture every
 * browser takes there, so any other is drawn into one first.
 */
async function copyImage(id: number) {
  const png = (async () => {
    const blob = await (await fetch(api.contentUrl(id))).blob();
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (drawn) => (drawn ? resolve(drawn) : reject(new Error("The image could not be drawn."))),
        "image/png",
      ),
    );
  })();
  try {
    // Handed over while still being made, so the press that asked still counts.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    showToast("Copied the image");
  } catch (err) {
    showToast(`Could not copy the image: ${errorMessage(err)}. Shift and right click brings up the browser's own menu.`);
  }
}

/** What a right click in the viewer brings up, for the file on show. */
function ViewerMenu(props: { at: Opened; shown: { item: Item; goTo: () => void } }) {
  const { item, goTo } = props.shown;
  return (
    <Shell at={props.at} label="Actions on this file">
      <li role="none">
        <button
          role="menuitem"
          title="Close the viewer and go to this file in the view"
          onClick={() => {
            close();
            goTo();
          }}
        >
          <Icon name="subdirectory-arrow-right" />
          Go to file
        </button>
      </li>
      <Show when={item.media_type === "image"}>
        <li role="none">
          <button
            role="menuitem"
            title="Put the image on the clipboard, to paste elsewhere. Shift and right click brings up the browser's own menu."
            onClick={() => {
              close();
              copyImage(item.id);
            }}
          >
            <Icon name="content-copy-outline" />
            Copy image
          </button>
        </li>
      </Show>
      <li role="none">
        <button
          role="menuitem"
          onClick={() => {
            close();
            location.href = api.contentUrl(item.id, downloadNames());
          }}
        >
          <Icon name="download" />
          Download
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
              manageTag(tag);
            }}
          >
            <Icon name="label-outline" />
            Open in the tag manager
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
  // Kept inside the window, opening leftwards or upwards near its edges.
  const place = () => {
    const box = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(props.at.x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(props.at.y, window.innerHeight - box.height - 4)),
    });
  };
  // Placed again whenever its size changes: some items only show once
  // what is known of the selection has arrived, and it grows by them.
  const sized = new ResizeObserver(place);
  onMount(() => {
    place();
    sized.observe(menu);
    // The menu takes the keyboard without lighting up any one item.
    menu.focus();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
  });
  onCleanup(() => {
    sized.disconnect();
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

/**
 * An item of the menu that opens a menu of its own beside it, while the
 * pointer is on either, or when it is pressed.
 */
function Submenu(props: { icon: IconName; label: string; children: JSX.Element }) {
  let item!: HTMLLIElement;
  const [open, setOpen] = createSignal(false);
  /** Whether it opens to the left, for want of room on the right. */
  const [left, setLeft] = createSignal(false);
  const show = () => {
    setLeft(item.getBoundingClientRect().right + 190 > window.innerWidth);
    setOpen(true);
  };
  return (
    <li
      class="has-submenu"
      role="none"
      ref={item}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => (open() ? setOpen(false) : show())}
      >
        <Icon name={props.icon} />
        {props.label}
        <span class="submenu-arrow">
          <Icon name="chevron-right" />
        </span>
      </button>
      <Show when={open()}>
        <ul class="context-submenu" classList={{ left: left() }} role="menu" aria-label={props.label}>
          {props.children}
        </ul>
      </Show>
    </li>
  );
}

/** What a right click on the grid brings up. */
function Menu(props: {
  at: Opened;
  item: Item;
  onPreview: Preview;
  onGroup: (kind: GroupKind, ids: number[]) => void;
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

  /** How many of the selection are in the inbox, once that is known. */
  const inInbox = () => state()?.inbox ?? 0;

  /** Whether any of the selection is a variant of something, to be ungrouped. */
  const grouped = () => {
    const group = state()?.scalars.alt_group_id;
    return group !== undefined && (group.mixed || group.value !== null);
  };
  /** The set on show, which the selection can be taken out of. */
  const set = shownSet();
  /** How many of the selection are in it. */
  const inShown = () => state()?.set.find((held) => held.set_id === set?.set_id)?.count ?? 0;
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
          title="Focus on these: the view becomes them alone, with a way back"
          onClick={async () => {
            close();
            enter({ selection: await listedSelected(), at: Date.now() });
          }}
        >
          <Icon name="folder-outline" />
          Focus
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
      {/* Every way of saying files belong together, under one item. */}
      <Submenu icon="photo-library-outline" label="Group">
        <li role="none">
          <button
            role="menuitem"
            title="Put in a set, by its ID: one there is already, or a new one"
            onClick={() => {
              close();
              props.onGroup("set", ids);
            }}
          >
            <Icon name="photo-library-outline" />
            Set…
          </button>
        </li>
        <li role="none">
          <button
            role="menuitem"
            title="Make part of a collection, by its ID: one there is already, or a new one"
            onClick={() => {
              close();
              props.onGroup("collection", ids);
            }}
          >
            <Icon name="folder-outline" />
            Collection…
          </button>
        </li>
        <li role="none">
          <button
            role="menuitem"
            disabled={ids.length < 2}
            title={
              ids.length < 2
                ? "Select the files that are variants of each other"
                : "Mark these as variants of each other: they share a variant group"
            }
            onClick={() =>
              group(async () => {
                await api.groupVariants(ids);
                return `Grouped ${plural(ids.length, "file")} as variants`;
              })
            }
          >
            <Icon name="content-copy-outline" />
            Variant
          </button>
        </li>
      </Submenu>
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
                      await api.changeSetFiles(shown().set_id, { remove: ids });
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
                      await api.changeSetFiles(shown().set_id, { add: ids });
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
          title="Take out of this view only. Nothing is trashed, and searching again brings it back."
          onClick={() => arrange(() => removeFromView(ids))}
        >
          <Icon name="visibility-off-outline" />
          Remove from view
        </button>
      </li>
      {/* Opal Drop lists what it downloaded until that is cleared from it. */}
      <Show when={activeTab()?.kind === "inbox" && !inside()}>
        <li role="none">
          <button
            role="menuitem"
            title="Take off the list of what Opal Drop downloaded. It stays in the library."
            onClick={() => arrange(() => clearFromDrop(ids))}
          >
            <Icon name="do-not-disturb-on-outline" />
            Clear from Opal Drop
          </button>
        </li>
      </Show>
      <Show when={inInbox() > 0}>
        <li role="none">
          <button
            role="menuitem"
            title="Take out of the inbox: these have been looked over"
            onClick={() => run(edits.archive)}
          >
            <Icon name="archive-outline" />
            Archive
          </button>
        </li>
      </Show>
      <Show when={state() !== undefined && inInbox() < state()!.count}>
        <li role="none">
          <button
            role="menuitem"
            title="Put back in the inbox, to be looked over"
            onClick={() => run(edits.unarchive)}
          >
            <Icon name="unarchive-outline" />
            Move to inbox
          </button>
        </li>
      </Show>
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
                onClick={() => run(edits.trash)}
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
            onClick={() => run(edits.restore)}
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
