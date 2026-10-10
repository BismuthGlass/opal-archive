import { createSignal, onCleanup, onMount } from "solid-js";

/** How long the pointer rests on something before its tooltip shows, in milliseconds. */
const DELAY = 120;

/**
 * The page's own tooltip, for anything with a `data-tip`: it shows sooner
 * than the browser's, in the page's look, and says only what it is given.
 * There is one, moved to whatever the pointer is on.
 */
export default function Tooltip() {
  let box!: HTMLDivElement;
  const [text, setText] = createSignal("");
  let timer = 0;
  /** What the tooltip is of, or is about to be. */
  let over: Element | null = null;

  const hide = () => {
    clearTimeout(timer);
    over = null;
    if (box.matches(":popover-open")) box.hidePopover();
  };
  const show = (target: Element) => {
    setText(target.getAttribute("data-tip") ?? "");
    // Shown again each time, so that it is above a dialog opened since.
    if (box.matches(":popover-open")) box.hidePopover();
    box.showPopover();
    // Under what it is of, or above it where there is no room, and kept
    // inside the window.
    const of = target.getBoundingClientRect();
    const size = box.getBoundingClientRect();
    const below = of.bottom + 4;
    const top = below + size.height > window.innerHeight - 4 ? of.top - size.height - 4 : below;
    const left = Math.max(4, Math.min(of.left, window.innerWidth - size.width - 4));
    box.style.top = `${Math.max(4, top)}px`;
    box.style.left = `${left}px`;
  };
  const onOver = (event: MouseEvent) => {
    const target = (event.target as Element | null)?.closest?.("[data-tip]") ?? null;
    if (target === over) return;
    hide();
    if (!target?.getAttribute("data-tip")) return;
    over = target;
    timer = window.setTimeout(() => show(target), DELAY);
  };

  onMount(() => {
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
  });
  onCleanup(() => {
    clearTimeout(timer);
    document.removeEventListener("mouseover", onOver);
    document.removeEventListener("mousedown", hide, true);
    document.removeEventListener("keydown", hide, true);
    document.removeEventListener("scroll", hide, true);
    window.removeEventListener("blur", hide);
  });

  // A popover, so that it is above everything, the dialogs included.
  return (
    <div class="tooltip" role="tooltip" popover="manual" ref={box}>
      {text()}
    </div>
  );
}
