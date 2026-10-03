import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { Scalar } from "../api";

/** Whether a field has something to show: a value, or differing values. */
export const isSet = (scalar: Scalar) => scalar.mixed || (scalar.value !== null && scalar.value !== "");

/**
 * One row of the details list. Clicking the value swaps it for an input
 * (or a select, given `options`). Enter or leaving the input saves, Escape
 * cancels.
 */
export default function Detail(props: {
  label: string;
  scalar: Scalar;
  options?: string[];
  /** Leaves out the empty choice, for fields that must have a value. */
  required?: boolean;
  /** Multi-line text. */
  long?: boolean;
  placeholder?: string;
  /** Begin in editing mode, for a field that was just added. */
  startOpen?: boolean;
  onCommit: (value: string | null) => void;
  /** Editing ended; `saved` tells whether a change was sent. */
  onClose?: (saved: boolean) => void;
}) {
  const [editing, setEditing] = createSignal(props.startOpen ?? false);
  const value = () => String(props.scalar.value ?? "");

  /** Leaves editing mode, saving `text` if it is given and is a change. */
  const close = (text: string | null) => {
    if (!editing()) return;
    setEditing(false);
    const next = text?.trim() ?? null;
    // With mixed values, leaving the input empty means "no change".
    const changed =
      next !== null && (props.scalar.mixed ? next !== "" : next !== value());
    if (changed) props.onCommit(next || null);
    props.onClose?.(changed);
  };
  const focus = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) =>
    queueMicrotask(() => {
      element.focus();
      if (!(element instanceof HTMLSelectElement)) element.select();
    });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close(null);
    } else if (event.key === "Enter" && !(props.long && event.shiftKey)) {
      event.preventDefault();
      close((event.currentTarget as HTMLInputElement).value);
    }
  };

  return (
    <>
      <dt>{props.label}</dt>
      <dd class="detail">
        <Show
          when={editing()}
          fallback={
            <button
              class="detail-value"
              classList={{ unset: !isSet(props.scalar) || props.scalar.mixed }}
              title="Click to edit"
              onClick={() => setEditing(true)}
            >
              {props.scalar.mixed ? "(mixed)" : value() || "Not set"}
            </button>
          }
        >
          <Switch
            fallback={
              <input
                type="text"
                ref={focus}
                value={value()}
                placeholder={props.scalar.mixed ? "(mixed)" : (props.placeholder ?? "")}
                onBlur={(e) => close(e.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
            }
          >
            <Match when={props.options}>
              {(options) => (
                <select
                  ref={focus}
                  onChange={(e) => {
                    const choice = e.currentTarget.value;
                    if (!editing()) return;
                    setEditing(false);
                    if (choice !== "mixed") props.onCommit(choice || null);
                    props.onClose?.(choice !== "mixed");
                  }}
                  onBlur={() => close(null)}
                  onKeyDown={(e) => e.key === "Escape" && close(null)}
                >
                  <Show when={props.scalar.mixed}>
                    <option value="mixed" selected>
                      (mixed)
                    </option>
                  </Show>
                  <Show when={!props.required}>
                    <option value="" selected={!props.scalar.mixed && value() === ""}>
                      Not set
                    </option>
                  </Show>
                  <For each={options()}>
                    {(option) => (
                      <option value={option} selected={!props.scalar.mixed && value() === option}>
                        {option}
                      </option>
                    )}
                  </For>
                </select>
              )}
            </Match>
            <Match when={props.long}>
              <textarea
                ref={focus}
                rows={4}
                value={value()}
                placeholder={props.scalar.mixed ? "(mixed)" : "Shift+Enter for a new line"}
                onBlur={(e) => close(e.currentTarget.value)}
                onKeyDown={onKeyDown}
              />
            </Match>
          </Switch>
        </Show>
      </dd>
    </>
  );
}
