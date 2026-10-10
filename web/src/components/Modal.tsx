import { createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";

const [openCount, setOpenCount] = createSignal(0);

/** Whether a modal is on screen; page-wide shortcuts stand down while one is. */
export const modalOpen = () => openCount() > 0;

/**
 * A window over the page, with a title and a close button. Escape, the
 * close button and a click outside it all close it. Render one inside a
 * `<Show>` and unmount it from `onClose`.
 */
export default function Modal(props: {
  title: string;
  /** For content that needs room, such as a list with actions. */
  wide?: boolean;
  /** Between the usual width and `wide`: room for two narrow columns. */
  medium?: boolean;
  /**
   * A fixed height, for content that comes and goes (lists, panes): the
   * modal stays the size it is and the content scrolls inside it.
   */
  tall?: boolean;
  onClose: () => void;
  /**
   * Asked before Escape, the close button or a click outside closes it:
   * answering false keeps it open, as for changes not yet saved.
   */
  canClose?: () => boolean;
  children: JSX.Element;
}) {
  let dialog!: HTMLDialogElement;
  /** When closing was last asked for, so that one Escape asks once. */
  let asked = 0;
  const close = () => {
    const allowed = !props.canClose || props.canClose();
    asked = performance.now();
    if (allowed) dialog.close();
  };

  onMount(() => {
    dialog.showModal();
    setOpenCount((n) => n + 1);
  });
  onCleanup(() => setOpenCount((n) => n - 1));

  return (
    <dialog
      ref={dialog}
      class="dialog"
      classList={{ wide: props.wide, medium: props.medium, tall: props.tall }}
      onClose={props.onClose}
      // Escape is answered here rather than left to the browser, which
      // lets a second Escape in a row close the dialog unasked.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
      // Any other way the browser has of closing it is asked about too.
      onCancel={(event) => {
        event.preventDefault();
        if (performance.now() - asked > 100) close();
      }}
      // The dialog element itself is only hit through its backdrop.
      onClick={(event) => event.target === dialog && close()}
    >
      <div class="dialog-box">
        <header class="dialog-header">
          <h2>{props.title}</h2>
          <button class="plain" aria-label="Close" title="Close" onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {props.children}
      </div>
    </dialog>
  );
}
