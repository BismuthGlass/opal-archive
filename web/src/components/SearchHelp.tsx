import { For, Show } from "solid-js";
import { TAG_FIELDS } from "../api";
import { TAG_PREFIXES } from "../tagTypes";
import Modal from "./Modal";

/** A part of the guide: ways to write a query, each with what it finds. */
type Part = { title: string; note?: string; rows: [string, string][] };

// A short form of query.md, which has the whole grammar.
const PARTS: Part[] = [
  {
    title: "Tags",
    note: "A word is a tag. Words side by side must all match.",
    rows: [
      ["cat", "has the tag cat"],
      ["cat dog", "has both"],
      ["cat or dog", "has either"],
      ["cat,dog", "has either, written short"],
      ["-cat", "does not have it"],
      ["(cat or dog) -bird", "brackets group"],
      ["c*t", "* stands for anything: cat, coat, cut"],
      ['"two words"', "quotes keep spaces, commas and brackets together"],
    ],
  },
  {
    title: "Tag types",
    note: "A tag of another type has @, the type's short name and a colon in front. The full name works too: @creator:rico.",
    rows: [
      ["@cr:rico", "the creator rico"],
      ['"@cr:John Smith"', "quoted as a whole, for the space"],
      ["@cr:*", "has any creator"],
      ["-@cr:*", "has no creator"],
      ["@ge:horror,scifi", "either genre"],
      ["@bu:reference", "kept in the bucket reference"],
    ],
  },
  {
    title: "Namespaces",
    note: "A tag may sit in namespaces, written with colons. They are part of the tag.",
    rows: [
      ["@ch:metroid:samus", "that tag exactly"],
      ["@ch:metroid:*", "everything under metroid"],
      ["@ch:*:samus", "samus in any namespace"],
      ["@ch:samus", "only the samus with no namespace"],
    ],
  },
  {
    title: "Text",
    note: "Fields: title, description, ai_description, version, name (the file's name), ext, hash, identifier, reference, collection, source_url, set_id, set_title, alt_group_id.",
    rows: [
      ["title=Sunset", "the title is exactly that"],
      ["title~holiday", "the title contains holiday"],
      ["name=IMG_*", "the file name starts with IMG_"],
      ["ext=png,jpg", "either extension"],
      ["source_url~pinterest", "came from an address containing that"],
    ],
  },
  {
    title: "Kinds",
    rows: [
      ["media=video", "image, video, audio, book or other"],
      ["rating<=risky", "safe, risky or nsfw, in that order"],
      ["looping=true", "true or false"],
    ],
  },
  {
    title: "Numbers",
    note: "Fields: score, width, height, pages, length, size. They take =, !=, <, <=, > and >=.",
    rows: [
      ["score>=5", "scored 5 or more"],
      ["score=3..5", "from 3 to 5; ..3 and 3.. leave a side open"],
      ["width>=1920", "at least that wide"],
      ["length<30s", "shorter than 30 seconds; also 5m, 1h30m"],
      ["size>10mb", "bigger than that; also kb, gb"],
    ],
  },
  {
    title: "Dates",
    note: "date is the work's date and added is when it came into the library. Written as a year, a month or a day.",
    rows: [
      ["date=2024", "some time in 2024"],
      ["added>=2026-03", "added in March 2026 or later"],
      ["date=2020..2022", "between the start of 2020 and the end of 2022"],
    ],
  },
  {
    title: "Present or missing",
    rows: [
      ["has=title", "has a title"],
      ["-has=score", "has not been rated"],
      ["has=set_id", "is in some set"],
      ["-has=alt_group_id", "is a variant of nothing"],
    ],
  },
  {
    title: "Sets and variants",
    note: "A file can be in several sets. A set is not found by itself: its files are, and what a set says of where it came from (source_url, identifier, reference, collection) its files are found by too.",
    rows: [
      ["set_id=pinterest:pin:123", "the files of that set"],
      ["set_id=pinterest:*", "the files of every set with such an ID"],
      ["set_title~holiday", "the files of sets titled so"],
      ["alt_group_id=alt:3f9a1c2e", "the variants of that group"],
      ["id=12,15", "those two files"],
    ],
  },
  {
    title: "Trash",
    note: "What is in the trash is left out unless the query says @trashed.",
    rows: [
      ["@trashed", "what is in the trash"],
      ["cat (@trashed or -@trashed)", "cats, trashed or not"],
    ],
  },
  {
    title: "Order",
    note: "Keys: added, date, score, title, name, size, width, height, length, pages, id, random. Newest added first if nothing is said.",
    rows: [
      ["sort=score", "lowest score first"],
      ["sort=-score", "highest first"],
      ["sort=-score sort=title", "by score, then by title"],
      ["sort=random", "shuffled"],
    ],
  },
  {
    title: "Rows",
    note: "The + under the box adds a row. Each row is a query of its own that narrows down what the rows above found. The bookmark saves a row, to add it again from the + later.",
    rows: [],
  },
];

/** How to write a query, for whoever has forgotten. */
export default function SearchHelp(props: { onClose: () => void }) {
  return (
    <Modal title="How to search" wide tall onClose={props.onClose}>
      <div class="search-help">
        <div class="search-help-parts">
          <For each={PARTS}>
            {(part) => (
              <section>
                <h3>{part.title}</h3>
                <Show when={part.note}>
                  <p class="hint">{part.note}</p>
                </Show>
                <Show when={part.rows.length > 0}>
                  <dl>
                    <For each={part.rows}>
                      {([written, found]) => (
                        <div>
                          <dt>
                            <code>{written}</code>
                          </dt>
                          <dd>{found}</dd>
                        </div>
                      )}
                    </For>
                  </dl>
                </Show>
                <Show when={part.title === "Tag types"}>
                  <ul class="search-help-types">
                    <For each={TAG_FIELDS}>
                      {(field) => (
                        <li>
                          <code>@{TAG_PREFIXES[field]}:</code>{" "}
                          {field.replaceAll("_", " ")}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            )}
          </For>
        </div>
      </div>
    </Modal>
  );
}
