import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { Changes, Metadata } from "../api";
import { errorMessage } from "../format";
import { changed, dataVersion } from "../search";
import Detail, { isSet } from "./Detail";
import Modal from "./Modal";
import PlainList, { PLAIN_LISTS, PlainListRow } from "./PlainList";
import { AddField } from "./Sidebar";

/** What a set and a collection both say of themselves. */
export type GroupInfo = {
  title: string | null;
  description: string | null;
  /** How many files not in the trash it holds, or are part of it. */
  files: number;
  source_url: string[];
  identifier: string[];
  reference: string[];
  collection?: string[];
};

/** The single-valued fields one may have or not, in the order they are listed. */
const FIELDS = [
  { field: "title", label: "Title", long: false },
  { field: "description", label: "Description", long: true },
] as const;

/** Its lists as the list editors read a selection's: one item with them all. */
const asSelection = (info: GroupInfo): Metadata => {
  const counted = (values: string[] = []) => values.map((value) => ({ value, count: 1 }));
  return {
    count: 1,
    trashed: 0,
    inbox: 0,
    scalars: {},
    tags: {},
    source_url: counted(info.source_url),
    identifier: counted(info.identifier),
    reference: counted(info.reference),
    collection: counted(info.collection),
    set: [],
  };
};

/**
 * What a set or a collection says of itself, for the side panel while it
 * is on show and nothing in it is selected: to read and to change. Only
 * what is set is listed, as for a file: "Add field" brings in one of the
 * rest.
 */
export default function GroupPanel<T extends GroupInfo>(props: {
  /** Which one: another's half-added field is not this one's. */
  of: string | number;
  load: () => Promise<T | undefined>;
  change: (changes: Changes) => Promise<unknown>;
  /** What it is, for a title: "this set". */
  what: string;
  /** The plain lists it has, by field. */
  lists: string[];
  /** The rows that say which one it is, after its title and description. */
  identity: (info: T, apply: (changes: Changes) => void) => JSX.Element;
  /** What can be done with the whole of it. */
  actions: (info: T, fail: (message: string) => void) => JSX.Element;
}) {
  const [error, setError] = createSignal<string | null>(null);
  /** The list open in the modal where its values are added and removed. */
  const [editingList, setEditingList] = createSignal<string | null>(null);
  /** An unset field picked from "Add field", shown while it is filled in. */
  const [adding, setAdding] = createSignal<string | null>(null);
  // A half-added field belongs to the one it began on.
  createEffect(on(() => props.of, () => setAdding(null), { defer: true }));
  const lists = () => PLAIN_LISTS.filter((list) => props.lists.includes(list.field));
  const pick = (field: string) => {
    if (lists().some((list) => list.field === field)) setEditingList(field);
    else setAdding(field);
  };
  const [loaded] = createResource(
    () => [props.of, dataVersion()] as const,
    () => props.load().catch(() => undefined),
  );
  // `latest` keeps the previous answer on screen while a new one loads.
  const info = () => loaded.latest;

  const apply = async (changes: Changes) => {
    try {
      await props.change(changes);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
    changed();
  };
  const scalar = (value: string | null) => ({ value, mixed: false });
  // Once a newly added field's value has been saved and reloaded, the row
  // shows because it is set, and no longer needs to be held open.
  let addedSaved = false;
  createEffect(
    on(
      () => loaded.latest,
      () => {
        if (addedSaved) setAdding(null);
        addedSaved = false;
      },
      { defer: true },
    ),
  );

  return (
    <Show when={info()}>
      {(current) => (
        <>
          <dl class="facts">
            <For each={FIELDS}>
              {(detail) => (
                <Show when={isSet(scalar(current()[detail.field])) || adding() === detail.field}>
                  <Detail
                    label={detail.label}
                    scalar={scalar(current()[detail.field])}
                    long={detail.long}
                    startOpen={adding() === detail.field}
                    onCommit={(value) => apply({ set: { [detail.field]: value } })}
                    onClose={(saved) => {
                      if (adding() !== detail.field) return;
                      if (saved) addedSaved = true;
                      else setAdding(null);
                    }}
                  />
                </Show>
              )}
            </For>
            {props.identity(current(), apply)}
            <dt>Files</dt>
            <dd>{current().files}</dd>
            <For each={lists()}>
              {(list) => (
                <Show when={list.values(asSelection(current())).length > 0}>
                  <PlainListRow
                    list={list}
                    data={asSelection(current())}
                    apply={apply}
                    onEdit={() => setEditingList(list.field)}
                  />
                </Show>
              )}
            </For>
          </dl>
          <AddField
            groups={[
              FIELDS.filter(
                (detail) => !isSet(scalar(current()[detail.field])) && adding() !== detail.field,
              ).map(({ field, label }) => ({ field, label })),
              lists()
                .filter((list) => list.values(asSelection(current())).length === 0)
                .map(({ field, label }) => ({ field, label })),
            ]}
            onPick={pick}
          />
          <Show when={error()}>
            <p class="form-error" role="alert">
              {error()}
            </p>
          </Show>
          <div class="panel-actions">{props.actions(current(), setError)}</div>
          <Show when={lists().find((list) => list.field === editingList())} keyed>
            {(list) => (
              <Modal title={`${list.label} of ${props.what}`} onClose={() => setEditingList(null)}>
                <div class="field-editor">
                  <PlainList list={list} data={asSelection(current())} apply={apply} />
                </div>
                <Show when={error()}>
                  <p class="form-error" role="alert">
                    {error()}
                  </p>
                </Show>
              </Modal>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
