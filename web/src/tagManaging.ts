import { createSignal } from "solid-js";

/** A tag the tag manager is to open on. */
export type ManagedTag = { field: string; value: string };

// Whether the tag manager is open, and on which tag if it was opened for one.
const [tagManager, setTagManager] = createSignal<{ tag?: ManagedTag } | null>(null);

export { tagManager };

/** Opens the tag manager, on its list of tags. */
export const openTagManager = () => setTagManager({});

/** Opens the tag manager on one tag. */
export const manageTag = (tag: ManagedTag) => setTagManager({ tag: { field: tag.field, value: tag.value } });

export const closeTagManager = () => setTagManager(null);
