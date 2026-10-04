import { For, Show } from "solid-js";
import { activeTab, inside, leave, openCollection, trail } from "../tabs";
import type { Step } from "../tabs";
import Icon from "./Icon";

/**
 * Goes back out of the collection the tab is inside: by one, or to where
 * the trail was `depth` long. The view outside comes back as it was left.
 */
export function goBack(depth?: number) {
  leave(depth);
}

const named = (step: Step) => step.title || `#${step.id}`;

/** What the tab shows when it is inside nothing. */
function outermost(): string {
  const tab = activeTab();
  if (!tab) return "Results";
  if (tab.name) return tab.name;
  if (tab.kind === "collection") return tab.collection?.title || `#${tab.collection?.id}`;
  return tab.kind === "upload" ? "Uploads" : tab.kind === "download" ? "Downloads" : "Results";
}

/**
 * Above the grid while the tab is inside a collection: the way back out,
 * the collections gone through to get here, and a way to give this one a
 * tab of its own.
 */
export default function Trail() {
  return (
    <Show when={inside()}>
      {(current) => (
        <nav class="trail" aria-label="Collections gone into">
          <button aria-label="Back" title="Back out of this collection (Backspace)" onClick={() => goBack()}>
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
                  <button class="link" title="Back to this collection" onClick={() => goBack(index() + 1)}>
                    {named(step)}
                  </button>
                </li>
              )}
            </For>
            <li aria-current="location">{named(current())}</li>
          </ol>
          <button
            class="trail-open"
            title="Open this collection in a tab of its own"
            onClick={() => openCollection(current().id)}
          >
            <Icon name="open-in-new" />
            Open in a tab
          </button>
        </nav>
      )}
    </Show>
  );
}
