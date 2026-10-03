import { For } from "solid-js";
import { activeId, close, open, select, tabs } from "../tabs";
import Icon from "./Icon";

export default function TabBar() {
  return (
    <nav class="tabs" role="tablist" aria-label="Searches">
      <For each={tabs}>
        {(tab) => (
          <div
            class="tab"
            classList={{ active: tab.id === activeId() }}
            // Middle click closes, as in a browser.
            onAuxClick={(event) => event.button === 1 && close(tab.id)}
          >
            <button
              class="tab-label"
              role="tab"
              aria-selected={tab.id === activeId()}
              title={tab.query}
              onClick={() => select(tab.id)}
            >
              {tab.query || "New search"}
            </button>
            <button class="tab-close" aria-label="Close tab" onClick={() => close(tab.id)}>
              <Icon name="close" />
            </button>
          </div>
        )}
      </For>
      <button class="tab-new" aria-label="New tab" title="New tab" onClick={() => open()}>
        <Icon name="add" />
      </button>
    </nav>
  );
}
