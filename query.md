# Query grammar

A query is a line of text that selects entities (files and collections). The
same string is used by the search box, persistent search tabs, mass edits,
bulk downloads and the future CLI.

## At a glance

```
cat                                   has the tag "cat"
cat -dog                              has "cat", does not have "dog"
metroid:samus                         has the tag "metroid:samus"
@ch:metroid:samus                     that character
@ch:metroid:*                         any character from metroid
"@cr:John Smith" score>=5             by that creator, scored 5 or more
@ge:horror,scifi                      horror or scifi
(cat or dog) rating=safe              grouping and alternatives
media=video -@cr:*                    videos with no creator
@bu:reference                         what is kept in the bucket "reference"
@trashed                              what is in the trash
in=(type=sequence title~holiday)      members of matching collections
within=12                             what is in collection 12, at any depth
width>=1920 length<30s sort=-score    attribute filters and ordering
```

An empty query matches everything.

## Structure

- Terms separated by whitespace are all required (AND).
- `or` between terms gives alternatives. AND binds tighter than `or`, so
  `a b or c` means `(a b) or c`.
- `-` directly in front of a term or group negates it: `-cat`, `-(a or b)`.
- Parentheses group.
- Keywords, field names and matching are case-insensitive.

```ebnf
query      = [ or_expr ] ;
or_expr    = and_expr { "or" and_expr } ;
and_expr   = unary { unary } ;
unary      = "-" unary | primary ;
primary    = "(" or_expr ")" | field_term | value ;
field_term = field operator operand ;
operator   = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" ;
operand    = "(" or_expr ")"                (* relation fields only *)
           | range
           | value { "," value } ;
range      = [ value ] ".." [ value ] ;     (* at least one side *)
field      = (* letters and underscores *) ;
value      = word | quoted ;
word       = (* run of characters with no whitespace, and none of ( ) , " *) ;
            (* a plain value may also be a comma-separated list *)
quoted     = '"' { any character, with \" and \\ as escapes } '"' ;
```

Lexical rules:

- A term is a field term when it **starts with letters or underscores
  immediately followed by an operator**. Anything else is a plain value.
- The colon is an ordinary character, so `metroid:samus` and
  `https://example.com/a` are plain values.
- A plain value is a tag. One that starts with `@` says what kind: a tag of
  another type (`@cr:name`) or a state (`@trashed`); see below.
- In a field term the name must be a known field. `socre>=5` is an error
  ("unknown field `socre`"), not a tag search. To search for a tag that looks
  like a field term, quote it: `"a=b"`.
- Quote a value to include whitespace, commas, parentheses or a leading `-`,
  or to use the word `or` as a value.
- `-` only negates at the start of a term. `jean-luc` is one word.
- No whitespace is allowed around operators, `,`, `..` or after `-`.

## Terms

A comma-separated list matches if **any** value matches: `cat,dog` is
`(cat or dog)`, and `media=image,video` is either. Lists work with `=`, `!=`
and `~`.

`!=` is the negation of `=`: `media!=video` is the same as `-media=video`.

Which operators a field accepts depends on its type.

### Tags

A plain value is a tag, matched whole; `*` stands for any run of characters.
Tags have types. A tag with nothing in front is a plain one; a tag of
another type has `@`, the type and a colon in front:

| Written  | Type          | Written  | Type          |
| -------- | ------------- | -------- | ------------- |
| `@cr:`   | creator       | `@me:`   | medium        |
| `@ch:`   | character     | `@fl:`   | flaws         |
| `@sw:`   | source work   | `@la:`   | language      |
| `@pe:`   | person        | `@so:`   | source        |
| `@ge:`   | genre         | `@us:`   | usage tags    |
| `@st:`   | style         | `@ai:`   | AI usage tags |
| `@ta:`   | plain tags    | `@bu:`   | bucket        |

The type's full name works too (`@creator:`, `@source_work:`). Only the first
colon ends the type; the rest is the tag, namespaces and all.

```
cat                         the plain tag cat
@cr:rico                    the creator rico
"@cr:John Smith"            quoted as a whole, for the space
@cr:*                       has any creator
-@cr:*                      has no creator
@ge:horror,scifi            either genre: the type holds for the whole list
c*t                         cat, coat, cut…
```

Tags may sit in namespaces, written `namespace:tag` and nested to any depth.
A namespace is part of the tag, so the wildcard is how to search one:

```
@ch:metroid:samus           that tag exactly
@ch:metroid:*               everything under metroid, at any depth
@ch:*:samus                 samus in any namespace
@ch:samus                   only the samus that has no namespace
```

A bucket (`@bu:`) is the tag type for keeping apart things that have little
to do with each other: the broad pile something is kept in, such as
`reference` or `wallpapers`. Something can be in several buckets, and buckets
nest with namespaces like any tag. A bucket narrows a search only when the
query names one; otherwise every bucket is searched.

```
@bu:reference               kept in the bucket reference
@bu:reference:*             in any bucket under reference
@bu:reference cat           cats, among the reference only
-@bu:*                      not in any bucket yet
```

In a stacked query a bucket does well as a row of its own, and as a saved
query to add that row with.

A tag can be an alias of another tag. Searching for an alias searches for the
tag it stands for, so if `kitty` is an alias of `cat`, `kitty` and `-kitty`
mean `cat` and `-cat`. Only whole tags are replaced: a pattern (`kit*`)
matches the tags that are actually stored. Write `\*` for a literal asterisk.

### States

`@` with a single word and no colon is a state. The only one so far is
`@trashed`: deleted once, and not yet for good.

```
@trashed                    what is in the trash
@trashed media=video        trashed videos
cat (@trashed or -@trashed) cats, trashed or not
```

Trashed entities are left out of every search that does not mention
`@trashed`, so plain searches never show them.

### String fields

Multi-valued: `identifier` `source_url`. These are plain lists, not tags.

Single-valued: `title` `description` `ai_description` `version` `name` `ext`
`hash` `collection_id`

| Operator | Matches when                                               |
| -------- | ---------------------------------------------------------- |
| `=`      | the whole value matches; `*` stands for any run of characters |
| `~`      | the text appears anywhere in the value                     |

```
title=Sunset                exactly that title
title~holiday               title contains "holiday"
identifier=pixiv:*          starts with "pixiv:"
hash=3fa9*                  hash prefix
```

For multi-valued fields the term matches if any one of the entity's values
matches. Write `\*` for a literal asterisk.

`name` is the filename the file was uploaded with, and `ext` its extension
without the dot.

`collection_id` is a collection's identifier, which no two collections
share, so it finds one collection whatever it is titled. An ID may be
namespaced with colons, as a tag is, and is searched the same way:

```
collection_id=pinterest:pin:924574998519073090   that one collection
collection_id=pinterest:someone:women            the board, and not its sections
collection_id=pinterest:someone:women:*          its sections, at any depth
collection_id=pinterest:someone:*                everything of that user
collection_id=4chan:g:*                          every thread of a board
collection_id=*:celebs                           whatever ends in celebs
has=collection_id                                collections that have an ID
```

These find the collections themselves. What is in them is found with `in=`
(their own members) or `within=` (those, and whatever is inside the
collections among them):

```
in=(collection_id=4chan:g:*)                     the files of those threads
within=(collection_id=pinterest:someone:women)   everything in the board, sections and all
within=(collection_id=pinterest:someone:women) kind=file
                                                 only the files of it
```

### Choice fields

Only `=` and `!=`. A value outside the list is an error.

| Field   | Meaning                             | Values                                                      |
| ------- | ----------------------------------- | ----------------------------------------------------------- |
| `kind`  | Entity kind                         | `file`, `collection`                                        |
| `media` | Media type (`media_type`)           | `image`, `video`, `audio`, `book`, `other`                  |
| `type`  | Collection type (`collection_type`) | `variant`, `set`, `sourceset`, `sequence`, `usercollection` |

### Number fields

`score` `width` `height` `pages` `length` `size`

```
score=5        score>=5       score!=1
score=3..5     score=..3      width=1920..
```

Ranges include both ends, and can be mixed into a list: `score=1,5..7`.

- `length` is a duration: plain seconds or `h` / `m` / `s` units, e.g. `90`,
  `90s`, `5m`, `1h30m`. Equality and range ends cover the whole second, so
  `length=90` matches a file 90.4 seconds long.
- `size` is in bytes, or with a `kb` / `mb` / `gb` unit (powers of 1024),
  e.g. `size>10mb`.
- `pages` is `page_count`.

### Rating

`rating` (`content_rating`) is ordered `safe` < `risky` < `nsfw`, so
comparisons work: `rating<=risky`.

### Date fields

`date` (the work's date) and `added` (`date_added`).

A date is written `YYYY`, `YYYY-MM` or `YYYY-MM-DD` and stands for that whole
period. Stored dates can be partial too, so both sides are periods:

| Query            | Matches when the stored period…                    |
| ---------------- | -------------------------------------------------- |
| `date=2024`      | lies inside 2024                                   |
| `date<2024`      | ends before 2024 starts                            |
| `date>2024`      | starts after 2024 ends                             |
| `date>=2024-03`  | starts on or after 1 March 2024                    |
| `date<=2024-03`  | ends on or before 31 March 2024                    |
| `date=2020..2022`| lies between the start of 2020 and the end of 2022 |

A work dated just `2024` therefore matches `date=2024` but not
`date>=2024-03`, because it may predate March.

### Boolean fields

`looping=true`, `looping=false`.

### Presence

`has=<field>` matches entities where the field is set (for multi-valued
fields, has at least one value). Any field above except `kind`, `media`,
`added`, `hash`, `ext` and `size` can be used. `-has=title` finds entities
with no title. For tags, use the wildcard instead: `@cr:*` has a creator.

### Relations

| Term            | Matches                                                   |
| --------------- | --------------------------------------------------------- |
| `id=12`         | The entity with that ID. Takes a list: `id=12,15`.        |
| `in=12`         | Direct members of collection 12                           |
| `in=(…)`        | Direct members of any collection matching the subquery    |
| `within=12`     | What is inside collection 12 at any depth: its members, their members, and so on |
| `within=(…)`    | The same, for every collection matching the subquery      |
| `contains=12`   | Collections that directly contain entity 12               |
| `contains=(…)`  | Collections that directly contain a match of the subquery |
| `has=in`        | Entities that belong to at least one collection           |
| `has=contains`  | Collections with at least one member                      |

Subqueries are full queries and can nest.

`in` looks one level down and `within` every level: with a board that holds
a section that holds a file, `in=<board>` finds the section, and
`within=<board>` the section and the file. A trashed collection on the way
does not hide what is inside it. `sort=position` goes with `in`, not
`within`: only direct members have a position.

## Sorting

`sort=<key>` orders ascending, `sort=-<key>` descending. Several `sort=` terms
apply in the order written. Sort terms are only allowed at the top level, not
inside parentheses, negations or subqueries. They are not filters: `cat or dog
sort=score` sorts the whole result.

Keys: `added` `date` `score` `title` `name` `size` `width` `height` `length`
`pages` `id` `random`, and `position` (order within the collection, valid
only when the query has exactly one top-level `in=<id>` term).

Entities with no value for the key sort last in either direction. The default
is `sort=-added`. Ties are broken by `id`, in the direction of the first key.

## Stacked queries

A query may be several lines. Each line is a query of its own, and the
result is what every line matches: each narrows down what the ones before it
found. The search box shows them as rows.

```
cat or dog
rating=safe score>=5
```

is `(cat or dog) (rating=safe score>=5)`, without the parentheses having to be
written. Every line is a top level, so each may carry `sort=` terms (they
apply in the order written, across lines) and `@trashed`. Empty lines are
skipped.

## Semantics worth knowing

- Results include both files and collections unless `kind=` says otherwise.
- A file-only field (`width`, `ext`, `media`, …) never matches a collection,
  and `type` never matches a file. Negating such a term therefore includes
  the other kind: `-ext=png` returns collections too.
- Negating a multi-valued term means "has no matching value": `-genre=horror`
  excludes anything with horror among its genres.
- Errors are reported with the character position, and the line for a
  stacked query, and nothing is searched.
  There is no fallback to a looser interpretation.

## Not in this draft

- Relative dates (`added>7d`).
- Transitive containment (`contains` through several levels); membership
  has it, as `within`.
- Counting values (`tags` has more than five entries).
- Full-text ranking; `~` is a plain substring match.
