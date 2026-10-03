import type { Changes, Metadata } from "../api";
import Icon from "./Icon";

/** What every editor of a field is given: the selection's metadata, and the way to change it. */
export type FieldProps = { data: Metadata; apply: (changes: Changes) => void };

/**
 * A list field is drawn two ways: in the panel as just its values, under
 * a label that opens the editor; and with `editing`, in that editor's
 * modal, with the box to add values and the buttons to remove them.
 */
export type ListMode = { editing?: boolean; onEdit?: () => void };

/** A list field's label in the panel: click it to edit the list. */
export function ListLabel(props: ListMode & { label: string }) {
  return (
    <button class="label list-label" title={`Edit ${props.label}`} onClick={props.onEdit}>
      {props.label}
      <Icon name="edit-outline" />
    </button>
  );
}
