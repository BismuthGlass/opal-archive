# Query grammar

A query is a line of text that selects files. The
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
set_id=pinterest:pin:123              the files of that set
alt_group_id=alt:3f9a1c2e             the variants of that group
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

Multi-valued: `identifier` `reference` `collection` `source_url`. These are plain lists, not tags.

Single-valued: `title` `description` `ai_description` `version` `name` `ext`
`hash` `set_id` `set_title` `alt_group_id`

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

`set_id` is the ID of a set a file is in, which no two sets share, and
`set_title` that set's title. A file can be in several sets, and is found
by any of them. A set is not found by itself: these find its files. A set ID may be namespaced with colons, as a tag is, and is searched
the same way:

```
set_id=pinterest:pin:924574998519073090   the files of that one set
set_id=pinterest:*                        the files of every Pinterest set
set_id=*:celebs                           whatever ends in celebs
set_title~holiday                         the files of sets titled so
has=set_id                                files that are in a set
-has=set_id                               files that are in none
```

`alt_group_id` is what a file shares with the files it is a variant of:
`alt_group_id=alt:3f9a1c2e` finds them all, and `has=alt_group_id` every file
that is a variant of something.

A set has plain lists of its own, of where it came from: `source_url`,
`identifier`, `reference` and `collection`. A file is found by its set's as by its own, so
`source_url~pinterest.com/pin/123` finds every file of the set that has that
address, and `has=source_url` a file one of whose sets has one.

### Choice fields

Only `=` and `!=`. A value outside the list is an error.

| Field   | Meaning                   | Values                                     |
| ------- | ------------------------- | ------------------------------------------ |
| `media` | Media type (`media_type`) | `image`, `video`, `audio`, `book`, `other` |

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
fields, has at least one value). Any field above except `media`,
`added`, `hash`, `ext` and `size` can be used. `-has=title` finds entities
with no title. For tags, use the wildcard instead: `@cr:*` has a creator.

### IDs

`id=12` is the file with that ID. It takes a list: `id=12,15`.

## Sorting

`sort=<key>` orders ascending, `sort=-<key>` descending. Several `sort=` terms
apply in the order written. Sort terms are only allowed at the top level, not
inside parentheses or negations. They are not filters: `cat or dog
sort=score` sorts the whole result.

Keys: `added` `date` `score` `title` `name` `size` `width` `height` `length`
`pages` `id` `random`.

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

- Results are files. A set is never a result: it is opened from one of its
  files.
- Negating a multi-valued term means "has no matching value": `-genre=horror`
  excludes anything with horror among its genres.
- Errors are reported with the character position, and the line for a
  stacked query, and nothing is searched.
  There is no fallback to a looser interpretation.

## Not in this draft

- Relative dates (`added>7d`).
- Counting values (`tags` has more than five entries).
- Full-text ranking; `~` is a plain substring match.
