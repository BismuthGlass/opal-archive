import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the choice just won't survive a reload.
  }
}

/** A boolean signal remembered per browser. */
export function createStoredFlag(key: string, initial: boolean) {
  const saved = stored(key);
  const [flag, setFlag] = createSignal(saved === null ? initial : saved === "on");
  const set = (value: boolean) => {
    setFlag(value);
    store(key, value ? "on" : "off");
  };
  return [flag, set] as const;
}

/**
 * The side panel is a stack of these: a titled section that can be folded
 * away, and remembers whether it was. Adding something to the panel is a
 * matter of wrapping it in a Module.
 */
export function Module(props: {
  /** Names the stored folded state; unique within the panel. */
  id: string;
  title: string;
  /** Shown at the right of the header, e.g. a "Clear" link. */
  action?: JSX.Element;
  children: JSX.Element;
}) {
  const [open, setOpen] = createStoredFlag(`tagutils.module.${props.id}`, true);
  return (
    <section class="module" classList={{ open: open() }}>
      <header>
        <button class="module-toggle" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <span class="chevron">
            <Icon name="chevron-right" />
          </span>
          {props.title}
        </button>
        {props.action}
      </header>
      <Show when={open()}>
        <div class="module-body">{props.children}</div>
      </Show>
    </section>
  );
}
