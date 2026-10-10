import { For, Show } from "solid-js";
import { activeTab, inside, leave, open, openSet, stepName, trail } from "../tabs";
import type { Step } from "../tabs";
import { quoteValue, setName } from "../format";
import Icon from "./Icon";

/**
 * Goes back out of the set or group the tab is inside: by one, or to where
 * the trail was `depth` long. The view outside comes back as it was left.
 */
export function goBack(depth?: number) {
  leave(depth);
}

/** What the tab shows when it is inside nothing. */
function outermost(): string {
  const tab = activeTab();
  if (!tab) return "Results";
  if (tab.name) return tab.name;
  if (tab.kind === "set" && tab.set) return setName(tab.set);
  if (tab.kind === "inbox") return "Inbox";
  if (tab.kind === "selection") return "Selection";
  return tab.kind === "upload" ? "Uploads" : "Results";
}

/**
 * Gives what the tab is inside a tab of its own: a set's, or a search for
 * the variants or for the collection.
 */
const openInTab = (step: Step) =>
  "variants" in step
    ? open("gallery", `alt_group_id=${quoteValue(step.variants)}`)
    : "collection" in step
      ? open("gallery", `collection=${quoteValue(step.collection)}`)
      : openSet(step.set_id);

/**
 * Above the grid while the tab is inside a set or a group of variants: the
 * way back out, what was gone through to get here, and a way to give this
 * a tab of its own.
 */
export default function Trail() {
  return (
    <Show when={inside()}>
      {(current) => (
        <nav class="trail" aria-label="Gone into">
          <button aria-label="Back" title="Back out (Backspace)" onClick={() => goBack()}>
            <Icon name="arrow-back" />
            Back
          </button>
          <ol>
            <li>
              <button class="link" title="Back to where this started" onClick={() => goBack(0)}>
                {outermost()}
              </button>
            </li>
            <For each={trail().slice(0, -1)}>
              {(step, index) => (
                <li>
                  <button class="link" title="Back to this" onClick={() => goBack(index() + 1)}>
                    {stepName(step)}
                  </button>
                </li>
              )}
            </For>
            <li aria-current="location">{stepName(current())}</li>
          </ol>
          <button
            class="trail-open"
            title="Open this in a tab of its own"
            onClick={() => openInTab(current())}
          >
            <Icon name="open-in-new" />
            Open in a tab
          </button>
        </nav>
      )}
    </Show>
  );
}
