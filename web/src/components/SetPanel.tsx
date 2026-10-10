import { Show } from "solid-js";
import * as api from "../api";
import type { FileSet } from "../api";
import { errorMessage, plural } from "../format";
import { changed } from "../search";
import { activeTab, inside, leave, openSet, shownSet } from "../tabs";
import { showToast } from "../toast";
import Detail from "./Detail";
import GroupPanel from "./GroupPanel";

/** The set on show, for the side panel while nothing in it is selected. */
export default function SetPanel(props: { set: string }) {
  /** Takes the set apart, once it has been agreed to. Its files stay. */
  const dissolve = async (set: FileSet, fail: (message: string) => void) => {
    const files = plural(set.files, "file");
    if (!confirm(`Take this set apart? Its ${files} stay in the library.`)) return;
    try {
      await api.deleteSet(set.set_id);
      showToast("Took the set apart");
      // Out of it, if the tab had gone into it; its own tab goes with it.
      if (inside() && shownSet()?.set_id === set.set_id) leave();
    } catch (err) {
      fail(errorMessage(err));
    }
    changed();
  };

  return (
    <GroupPanel
      of={props.set}
      load={() => api.getSet(props.set)}
      change={(changes) => api.changeSet(props.set, changes)}
      what="this set"
      lists={["identifier", "reference", "collection", "source_url"]}
      identity={(set, apply) => (
        <Detail
          label="Set ID"
          scalar={{ value: set.set_id, mixed: false }}
          // A set always has one: emptied, it stays as it was.
          onCommit={(set_id) => set_id && apply({ set: { set_id } })}
        />
      )}
      actions={(set, fail) => (
        <>
          <Show when={activeTab()?.set?.set_id !== set.set_id}>
            <button title="Open this set in a tab of its own" onClick={() => openSet(set.set_id)}>
              Open in a tab
            </button>
          </Show>
          <button
            class="danger"
            title="Take the set apart. Its files stay in the library."
            onClick={() => dissolve(set, fail)}
          >
            Take apart
          </button>
        </>
      )}
    />
  );
}
