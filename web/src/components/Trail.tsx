import { For, Show } from "solid-js";
import { activeTab, inside, leave, openSet, trail } from "../tabs";
import { setName } from "../format";
import Icon from "./Icon";

/**
 * Goes back out of the set the tab is inside: by one, or to where
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
 * Above the grid while the tab is inside a set: the way back out, and a
 * way to give the set a tab of its own.
 */
export default function Trail() {
  return (
    <Show when={inside()}>
      {(current) => (
        <nav class="trail" aria-label="Sets gone into">
          <button aria-label="Back" title="Back out of this set (Backspace)" onClick={() => goBack()}>
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
                  <button class="link" title="Back to this set" onClick={() => goBack(index() + 1)}>
                    {setName(step)}
                  </button>
                </li>
              )}
            </For>
            <li aria-current="location">{setName(current())}</li>
          </ol>
          <button
            class="trail-open"
            title="Open this set in a tab of its own"
            onClick={() => openSet(current().id)}
          >
            <Icon name="open-in-new" />
            Open in a tab
          </button>
        </nav>
      )}
    </Show>
  );
}
