import { createSignal } from "solid-js";

/** A tag the tag editor is to open on. */
export type EditedTag = { field: string; value: string };

// Whether the tag editor is open, and on which tag if it was opened for one.
const [tagEditor, setTagEditor] = createSignal<{ tag?: EditedTag } | null>(null);

export { tagEditor };

/** Opens the tag editor, on its list of tags. */
export const openTagEditor = () => setTagEditor({});

/** Opens the tag editor on one tag. */
export const editTag = (tag: EditedTag) => setTagEditor({ tag: { field: tag.field, value: tag.value } });

export const closeTagEditor = () => setTagEditor(null);
