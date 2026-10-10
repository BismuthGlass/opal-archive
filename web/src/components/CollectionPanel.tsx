import * as api from "../api";
import { quoteValue } from "../format";
import { open } from "../tabs";
import GroupPanel from "./GroupPanel";

/**
 * The collection on show, for the side panel while nothing in it is
 * selected. A collection is its name, which the files and sets that are
 * part of it give: what else is known of it is kept from the first thing
 * said of it here.
 */
export default function CollectionPanel(props: { name: string }) {
  return (
    <GroupPanel
      of={props.name}
      load={() => api.getCollection(props.name)}
      change={(changes) => api.changeCollection(props.name, changes)}
      what="this collection"
      lists={["identifier", "reference", "source_url"]}
      identity={(collection) => (
        <>
          <dt>Name</dt>
          <dd>
            <span class="link-text" data-tip={collection.name}>
              {collection.name}
            </span>
          </dd>
        </>
      )}
      actions={(collection) => (
        <button
          title="Open a tab that searches for what is part of this collection"
          onClick={() => open("gallery", `collection=${quoteValue(collection.name)}`)}
        >
          Open in a tab
        </button>
      )}
    />
  );
}
