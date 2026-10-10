import { For, Show } from "solid-js";
import { activeTab, inside, leave, openCollection, trail } from "../tabs";
import { collectionName } from "../format";
import Icon from "./Icon";

/**
 * Goes back out of the collection the tab is inside: by one, or to where
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
  if (tab.kind === "collection" && tab.collection) return collectionName(tab.collection);
  if (tab.kind === "inbox") return "Inbox";
  if (tab.kind === "selection") return "Selection";
  return tab.kind === "upload" ? "Uploads" : "Results";
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
                    {collectionName(step)}
                  </button>
                </li>
              )}
            </For>
            <li aria-current="location">{collectionName(current())}</li>
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
