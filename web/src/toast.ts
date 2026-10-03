import { createSignal } from "solid-js";

/** A short message at the bottom of the window, over whatever is open. */
const [toast, setToast] = createSignal<string | null>(null);

export { toast };

let timer = 0;

/** Shows a message. It goes by itself unless `sticky`; `hideToast` ends it. */
export function showToast(text: string, sticky = false) {
  clearTimeout(timer);
  setToast(text);
  if (!sticky) timer = window.setTimeout(() => setToast(null), 2500);
}

export function hideToast() {
  clearTimeout(timer);
  setToast(null);
}
