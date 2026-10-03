# Query grammar

A query is a line of text that selects entities (files and collections). The
same string is used by the search box, persistent search tabs, mass edits,
bulk downloads and the future CLI.

## At a glance

```
cat                                   has the tag "cat"
cat -dog                              has "cat", does not have "dog"
metroid:samus                         has the tag "metroid:samus"
character=metroid:samus               that character
character=metroid:*                   any character from metroid
creator="John Smith" score>=5         by that creator, scored 5 or more
genre=horror,scifi                    horror or scifi
(cat or dog) rating=safe              grouping and alternatives
media=video -has=creator              videos with no creator set
in=(type=sequence title~holiday)      members of matching collections
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
- In a field term the name must be a known field. `socre>=5` is an error
  ("unknown field `socre`"), not a tag search. To search for a tag that looks
  like a field term, quote it: `"a=b"`.
- Quote a value to include whitespace, commas, parentheses or a leading `-`,
  or to use the word `or` as a value.
- `-` only negates at the start of a term. `jean-luc` is one word.
- No whitespace is allowed around operators, `,`, `..` or after `-`.

## Terms

A plain value is shorthand for the `tags` field: `cat` means `tags=cat`.

A comma-separated list matches if **any** value matches: `genre=horror,scifi`
is `(genre=horror or genre=scifi)`, and `cat,dog` is `(cat or dog)`. Lists
work with `=`, `!=` and `~`.

`!=` is the negation of `=`: `genre!=horror` is the same as `-genre=horror`.

Which operators a field accepts depends on its type.

### String fields

Multi-valued: `creator` `medium` `genre` `style` `flaws` `person`
`source_work` `character` `language` `tags` `identifier` `usage_tags`
`ai_usage_tags` `source` `source_url`

Single-valued: `title` `description` `ai_description` `version` `name` `ext`
`hash`

| Operator | Matches when                                               |
| -------- | ---------------------------------------------------------- |
| `=`      | the whole value matches; `*` stands for any run of characters |
| `~`      | the text appears anywhere in the value                     |

```
character=metroid:samus     exactly that value
character=metroid:*         starts with "metroid:"
character~samus             contains "samus"
title~holiday               title contains "holiday"
hash=3fa9*                  hash prefix
```

For multi-valued fields the term matches if any one of the entity's values
matches. Write `\*` for a literal asterisk.

Tags may sit in namespaces, written `namespace:tag` and nested to any depth.
A namespace is part of the tag's value, so the wildcard is how to search one:

```
character=metroid:samus     that tag exactly
character=metroid:*         everything under metroid, at any depth
character=*:samus           samus in any namespace
character=samus             only the samus that has no namespace
```

A tag can be an alias of another tag. Searching for an alias searches for the
tag it stands for, so if `kitty` is an alias of `cat`, `kitty` and `-kitty`
mean `cat` and `-cat`. Only whole values are replaced: patterns (`kit*`,
`tags~kit`) match the tags that are actually stored.

`name` is the filename the file was uploaded with, and `ext` its extension
without the dot.

### Choice fields

Only `=` and `!=`. A value outside the list is an error.

| Field   | Meaning                             | Values                                                      |
| ------- | ----------------------------------- | ----------------------------------------------------------- |
| `kind`  | Entity kind                         | `file`, `collection`                                        |
| `media` | Media type (`media_type`)           | `image`, `video`, `audio`, `book`, `other`                  |
| `type`  | Collection type (`collection_type`) | `variant`, `set`, `sourceset`, `sequence`, `usercollection` |
| `ai`    | AI content (`ai_content`)           | `none`, `partial`, `full`, `unknown`                        |

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
`added`, `hash`, `ext` and `size` can be used. `-has=creator` finds entities
with no creator.

### States

`is=<state>` matches entities in that state. The only state so far is
`trashed`: deleted once, and not yet for good.

```
is=trashed                  what is in the trash
is=trashed media=video      trashed videos
cat (is=trashed or -is=trashed)   cats, trashed or not
```

Trashed entities are left out of every search that has no `is=` term, so
plain searches never show them.

### Relations

| Term            | Matches                                                   |
| --------------- | --------------------------------------------------------- |
| `id=12`         | The entity with that ID. Takes a list: `id=12,15`.        |
| `in=12`         | Direct members of collection 12                           |
| `in=(…)`        | Direct members of any collection matching the subquery    |
| `contains=12`   | Collections that directly contain entity 12               |
| `contains=(…)`  | Collections that directly contain a match of the subquery |
| `has=in`        | Entities that belong to at least one collection           |
| `has=contains`  | Collections with at least one member                      |

Subqueries are full queries and can nest.

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

## Semantics worth knowing

- Results include both files and collections unless `kind=` says otherwise.
- A file-only field (`width`, `ext`, `media`, …) never matches a collection,
  and `type` never matches a file. Negating such a term therefore includes
  the other kind: `-ext=png` returns collections too.
- Negating a multi-valued term means "has no matching value": `-genre=horror`
  excludes anything with horror among its genres.
- Errors are reported with the character position and nothing is searched.
  There is no fallback to a looser interpretation.

## Not in this draft

- Relative dates (`added>7d`).
- Transitive membership (members of members).
- Counting values (`tags` has more than five entries).
- Full-text ranking; `~` is a plain substring match.
