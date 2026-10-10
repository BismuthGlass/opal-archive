import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import * as api from "../api";
import { fieldLabel } from "../format";
import { prefixOf, readTag, tagTextStyle, typesStarting } from "../tagTypes";
import Icon from "./Icon";

/** How many suggestions are listed at once. */
const MAX_SUGGESTIONS = 8;
/** How much of a tag has to be typed before tags are suggested for it. */
const MIN_TYPED = 2;

type Option =
  | { kind: "type"; field: string }
  | { kind: "tag"; field: string; value: string; count: number; namespace: boolean; alias?: string };

/**
 * A box to name one tag in, of any type, with the suggestions the tagger
 * gives in a list over it: the types while only `@…` is typed, and a
 * type's tags after its colon, or the plain tags with no type. Enter, or
 * a click, hands the tag over and empties the box; a name that is not
 * suggested is handed over as typed.
 */
export default function TagPicker(props: {
  label: string;
  placeholder: string;
  onPick: (tag: { field: string; value: string }) => void;
}) {
  const [text, setText] = createSignal("");
  const [open, setOpen] = createSignal(false);
  /** Highlighted suggestion; -1 means the typed text itself. */
  const [active, setActive] = createSignal(-1);
  const read = createMemo(() => readTag(text()));
  const enough = () => read().value.length >= MIN_TYPED;
  const [fetched] = createResource(
    () => {
      const { field, value } = read();
      return field && enough() ? { field, typed: value } : null;
    },
    ({ field, typed }) => api.suggestTags(field, typed),
  );

  const options = createMemo<Option[]>(() => {
    const { field, naming } = read();
    if (naming !== null) return typesStarting(naming).map((field) => ({ kind: "type", field }));
    if (!field || !enough()) return [];
    return (fetched.latest ?? [])
      .slice(0, MAX_SUGGESTIONS)
      .map((option) => ({ kind: "tag", field, ...option }));
  });
  /** What to say in place of suggestions, if anything. */
  const note = () =>
    read().field === null && read().naming === null
      ? `${read().lead.slice(0, -1)} is not a tag type. Type @ to see them.`
      : enough() && !fetched.loading && options().length === 0
        ? "No tag like that yet. Enter names a new one."
        : null;

  const reset = (next = "") => {
    setText(next);
    setActive(-1);
  };

  const pick = (option: Option) => {
    // A type writes its prefix, ready for the tag; a namespace steps into
    // it; a tag is handed over.
    if (option.kind === "type") reset(option.field === "tags" ? "" : `@${prefixOf(option.field)}:`);
    else if (option.namespace) reset(read().lead + option.value);
    else {
      reset();
      props.onPick({ field: option.field, value: option.value });
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const count = options().length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1 >= count ? -1 : i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i < 0 ? count - 1 : i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const { field, value, naming } = read();
      if (active() >= 0) pick(options()[active()]);
      else if (naming !== null) {
        // An unfinished `@…` names a type; it is never a tag.
        if (count > 0) pick(options()[0]);
      } else if (field && value) {
        reset();
        props.onPick({ field, value });
      }
    } else if (event.key === "Escape" && text() !== "") {
      // Only empties the box; without this Escape would close the modal.
      event.preventDefault();
      event.stopPropagation();
      reset();
    }
  };

  return (
    <div class="tag-picker">
      <input
        type="text"
        role="combobox"
        aria-label={props.label}
        aria-expanded={open()}
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck={false}
        placeholder={props.placeholder}
        value={text()}
        onInput={(event) => {
          setText(event.currentTarget.value);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <Show when={open() && (options().length > 0 || note())}>
        <ul class="suggestions above" role="listbox">
          <For each={options()} fallback={<li class="hint">{note()}</li>}>
            {(option, i) => (
              <li
                role="option"
                aria-selected={i() === active()}
                classList={{ active: i() === active() }}
                // Keeps the cursor in the box.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
              >
                <Show
                  when={option.kind === "tag" && option}
                  fallback={
                    <>
                      <span class="tag-name" style={tagTextStyle(option.field)}>
                        {fieldLabel(option.field)}
                      </span>
                      <span class="suggestion-count">
                        {option.field === "tags" ? "no @ needed" : `@${prefixOf(option.field)}:`}
                      </span>
                    </>
                  }
                >
                  {(tag) => (
                    <>
                      <span class="suggestion-value">
                        <Show when={tag().alias}>
                          <span class="suggestion-alias">
                            <s>{tag().alias}</s> →{" "}
                          </span>
                        </Show>
                        <span class="tag-name" style={tagTextStyle(tag().field)}>
                          {tag().value}
                        </span>
                      </span>
                      <span class="suggestion-count">
                        {tag().count}
                        <Show when={tag().namespace}>
                          <Icon name="chevron-right" />
                        </Show>
                      </span>
                    </>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
