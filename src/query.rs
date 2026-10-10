//! The search query language described in `query.md`, parsed straight into
//! an SQL filter and ordering over the tables named in [`FROM`].

use rusqlite::types::Value;

/// States an entity can be in, searched as `@trashed`.
pub const STATES: &[&str] = &["trashed"];

/// The tag types with the short name each goes by after an `@`: `@cr:name`
/// is the creator `name`. A tag with no `@` is a plain one, of type `tags`.
pub const TAG_PREFIXES: &[(&str, &str)] = &[
    ("tags", "ta"),
    ("creator", "cr"),
    ("character", "ch"),
    ("source_work", "sw"),
    ("person", "pe"),
    ("genre", "ge"),
    ("style", "st"),
    ("medium", "me"),
    ("flaws", "fl"),
    ("language", "la"),
    ("source", "so"),
    ("usage_tags", "us"),
    ("ai_usage_tags", "ai"),
    ("bucket", "bu"),
];

/// The tag type an `@` name stands for: its short name or its full one.
pub fn tag_type(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    TAG_PREFIXES
        .iter()
        .find(|(field, prefix)| *prefix == name || *field == name)
        .map(|(field, _)| *field)
}

pub const TAG_FIELDS: &[&str] = &[
    "creator",
    "medium",
    "genre",
    "style",
    "flaws",
    "person",
    "source_work",
    "character",
    "language",
    "tags",
    "usage_tags",
    "ai_usage_tags",
    "source",
    "bucket",
];
pub const KINDS: &[&str] = &["file", "collection"];
pub const MEDIA_TYPES: &[&str] = &["image", "video", "audio", "book", "other"];
pub const COLLECTION_TYPES: &[&str] =
    &["variant", "set", "sourceset", "sequence", "usercollection"];
pub const CONTENT_RATINGS: &[&str] = &["safe", "risky", "nsfw"];

const SORT_KEYS: &[&str] = &[
    "added", "date", "score", "title", "name", "size", "width", "height", "length", "pages", "id",
    "random", "position",
];

/// The tables a compiled filter refers to: `e0` is the entity, `f0` and `c0`
/// its file or collection row (whichever exists).
pub const FROM: &str = "entity e0
    LEFT JOIN file f0 ON f0.entity_id = e0.id
    LEFT JOIN collection c0 ON c0.entity_id = e0.id";

#[derive(Debug)]
pub struct QueryError {
    pub message: String,
    /// Character offset into the line.
    pub position: usize,
    /// Which line of a stacked query, from 0.
    pub line: usize,
}

pub struct Compiled {
    /// Boolean SQL expression.
    pub filter: String,
    pub filter_params: Vec<Value>,
    /// Contents of an ORDER BY clause.
    pub order: String,
    pub order_params: Vec<Value>,
    /// Whether the query names an order itself, with `sort=`.
    pub sorted: bool,
}

type Res<T> = Result<T, QueryError>;

fn error<T>(message: impl Into<String>, position: usize) -> Res<T> {
    Err(QueryError {
        message: message.into(),
        position,
        line: 0,
    })
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Like,
}

impl Op {
    fn symbol(self) -> &'static str {
        match self {
            Op::Eq => "=",
            Op::Ne => "!=",
            Op::Lt => "<",
            Op::Le => "<=",
            Op::Gt => ">",
            Op::Ge => ">=",
            Op::Like => "~",
        }
    }
}

#[derive(Clone, Copy)]
enum Unit {
    Plain,
    Duration,
    Size,
}

/// What a field name refers to. Columns are given as table letter (`e`, `f`
/// or `c`) and column name; the nesting depth completes the alias.
#[derive(Clone, Copy)]
enum Field {
    /// A plain list of values kept in a table of its own (table, column):
    /// multi-valued like a tag field, but not tags.
    List(&'static str, &'static str),
    Text(char, &'static str),
    Choice(char, &'static str, &'static [&'static str]),
    Number(char, &'static str, Unit),
    Rating,
    Date {
        added: bool,
    },
    Bool(char, &'static str),
    Has,
    Id,
    In,
    /// In a collection, or in one inside it, at any depth.
    Within,
    Contains,
    Sort,
}

fn lookup(name: &str) -> Option<Field> {
    Some(match name {
        "source_url" => Field::List("source_url", "url"),
        "identifier" => Field::List("identifier", "value"),
        "reference" => Field::List("reference", "value"),
        "title" => Field::Text('e', "title"),
        "description" => Field::Text('e', "description"),
        "ai_description" => Field::Text('e', "ai_description"),
        "version" => Field::Text('e', "version"),
        "name" => Field::Text('f', "original_name"),
        "ext" => Field::Text('f', "extension"),
        "hash" => Field::Text('f', "hash"),
        "kind" => Field::Choice('e', "kind", KINDS),
        "media" => Field::Choice('f', "media_type", MEDIA_TYPES),
        "type" => Field::Choice('c', "collection_type", COLLECTION_TYPES),
        "collection_id" => Field::Text('c', "collection_id"),
        "score" => Field::Number('e', "score", Unit::Plain),
        "width" => Field::Number('f', "width", Unit::Plain),
        "height" => Field::Number('f', "height", Unit::Plain),
        "pages" => Field::Number('f', "page_count", Unit::Plain),
        "length" => Field::Number('f', "length", Unit::Duration),
        "size" => Field::Number('f', "size", Unit::Size),
        "rating" => Field::Rating,
        "date" => Field::Date { added: false },
        "added" => Field::Date { added: true },
        "looping" => Field::Bool('f', "looping"),
        "has" => Field::Has,
        "id" => Field::Id,
        "in" => Field::In,
        "within" => Field::Within,
        "contains" => Field::Contains,
        "sort" => Field::Sort,
        _ => return None,
    })
}

/// A value as written: a bare word or a quoted string.
struct Val {
    text: String,
    quoted: bool,
    pos: usize,
}

struct Sort {
    key: &'static str,
    descending: bool,
    pos: usize,
    line: usize,
}

/// Turns a value into a LIKE pattern (escape character `\`). `\*` and `\\`
/// are literal; a bare `*` is a wildcard when `wildcards` is set.
fn like_pattern(text: &str, wildcards: bool) -> String {
    let mut pattern = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let literal = match c {
            '\\' if matches!(chars.peek(), Some('*' | '\\')) => chars.next().unwrap(),
            '*' if wildcards => {
                pattern.push('%');
                continue;
            }
            other => other,
        };
        if matches!(literal, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(literal);
    }
    pattern
}

/// A LIKE pattern matching values that contain `text` literally.
pub fn contains_pattern(text: &str) -> String {
    let escaped: String = text
        .chars()
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            _ => vec![c],
        })
        .collect();
    format!("%{escaped}%")
}

fn parse_plain(text: &str) -> Option<f64> {
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// Seconds, either a plain number or `h` / `m` / `s` parts like `1h30m`.
fn parse_duration(text: &str) -> Option<f64> {
    if let Some(seconds) = parse_plain(text) {
        return Some(seconds);
    }
    let mut total = 0.0;
    let mut number = String::new();
    for c in text.chars() {
        match c.to_ascii_lowercase() {
            '0'..='9' | '.' => number.push(c),
            unit @ ('h' | 'm' | 's') => {
                let n = parse_plain(&number)?;
                number.clear();
                total += n * match unit {
                    'h' => 3600.0,
                    'm' => 60.0,
                    _ => 1.0,
                };
            }
            _ => return None,
        }
    }
    // Trailing digits with no unit, as in "1h30".
    number.is_empty().then_some(total)
}

/// Bytes, optionally with a `b` / `kb` / `mb` / `gb` unit (powers of 1024).
fn parse_size(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    let (number, factor) = if let Some(n) = lower.strip_suffix("kb") {
        (n, 1024.0)
    } else if let Some(n) = lower.strip_suffix("mb") {
        (n, 1024.0 * 1024.0)
    } else if let Some(n) = lower.strip_suffix("gb") {
        (n, 1024.0 * 1024.0 * 1024.0)
    } else if let Some(n) = lower.strip_suffix('b') {
        (n, 1.0)
    } else {
        (lower.as_str(), 1.0)
    };
    parse_plain(number).map(|n| n * factor)
}

fn parse_rating(text: &str) -> Option<f64> {
    let lower = text.to_ascii_lowercase();
    CONTENT_RATINGS
        .iter()
        .position(|rating| *rating == lower)
        .map(|rank| rank as f64)
}

/// Whether `text` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
pub fn valid_date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let digits =
        |part: &str, len: usize| part.len() == len && part.bytes().all(|b| b.is_ascii_digit());
    let in_range = |part: &str, max: u32| (1..=max).contains(&part.parse::<u32>().unwrap_or(0));
    match parts[..] {
        [year] => digits(year, 4),
        [year, month] => digits(year, 4) && digits(month, 2) && in_range(month, 12),
        [year, month, day] => {
            digits(year, 4)
                && digits(month, 2)
                && in_range(month, 12)
                && digits(day, 2)
                && in_range(day, 31)
        }
        _ => false,
    }
}

// A date stands for a period. Its first day is the date padded with
// "-01-01"; its end is padded with "-99-99", which sorts after every real
// day, so periods compare correctly as plain strings.
const PERIOD_START: &str = "-01-01";
const PERIOD_END: &str = "-99-99";

fn pad_date(date: &str, padding: &str) -> String {
    format!("{date}{padding}").chars().take(10).collect()
}

/// Tag aliases: field and lowercased alias to the tag it defers to.
pub type Aliases = std::collections::HashMap<(String, String), String>;

struct Parser<'a> {
    aliases: &'a Aliases,
    chars: Vec<char>,
    pos: usize,
    /// The line of a stacked query being parsed, from 0.
    line: usize,
    /// Subquery nesting; numbers the table aliases.
    depth: usize,
    /// How many `within` terms there have been; numbers their tables.
    walks: usize,
    /// Non-zero inside parentheses, negations and subqueries, where `sort=`
    /// is not allowed.
    restricted: usize,
    params: Vec<Value>,
    sorts: Vec<Sort>,
    /// Collections named by top-level `in=<id>` terms, for `sort=position`.
    top_level_in: Vec<i64>,
    /// Whether the query itself mentions `@trashed`.
    asks_trashed: bool,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn at_end(&self) -> bool {
        self.pos >= self.chars.len()
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.pos += 1;
        }
    }

    /// Whether the `or` keyword starts here.
    fn at_or(&self) -> bool {
        let is = |offset: usize, expected: char| {
            self.chars
                .get(self.pos + offset)
                .is_some_and(|c| c.eq_ignore_ascii_case(&expected))
        };
        let ends = match self.chars.get(self.pos + 2) {
            None => true,
            Some(c) => c.is_whitespace() || matches!(c, '(' | ')'),
        };
        is(0, 'o') && is(1, 'r') && ends
    }

    fn operator_at(&self, index: usize) -> Option<(Op, usize)> {
        let first = *self.chars.get(index)?;
        let second = self.chars.get(index + 1).copied();
        Some(match (first, second) {
            ('!', Some('=')) => (Op::Ne, 2),
            ('<', Some('=')) => (Op::Le, 2),
            ('>', Some('=')) => (Op::Ge, 2),
            ('=', _) => (Op::Eq, 1),
            ('<', _) => (Op::Lt, 1),
            ('>', _) => (Op::Gt, 1),
            ('~', _) => (Op::Like, 1),
            _ => return None,
        })
    }

    fn column(&self, table: char, name: &str) -> String {
        format!("{table}{}.{name}", self.depth)
    }

    fn parse_or(&mut self) -> Res<String> {
        let start = self.pos;
        let mut alternatives = vec![self.parse_and()?];
        self.skip_whitespace();
        while self.at_or() {
            self.pos += 2;
            alternatives.push(self.parse_and()?);
            self.skip_whitespace();
        }
        if alternatives.len() == 1 {
            // A query of nothing but `sort=` terms matches everything.
            return Ok(alternatives.remove(0).unwrap_or_else(|| "(1)".to_string()));
        }
        let alternatives: Option<Vec<String>> = alternatives.into_iter().collect();
        match alternatives {
            Some(alternatives) => Ok(format!("({})", alternatives.join(" OR "))),
            None => error("`sort=` alone cannot be one side of `or`", start),
        }
    }

    /// `None` if the terms were all `sort=`, which filter nothing.
    fn parse_and(&mut self) -> Res<Option<String>> {
        let mut terms = Vec::new();
        let mut sorted = false;
        loop {
            self.skip_whitespace();
            if self.at_end() || self.peek() == Some(')') || self.at_or() {
                break;
            }
            let term = self.parse_unary()?;
            if term.is_empty() {
                sorted = true;
            } else {
                terms.push(term);
            }
        }
        if !terms.is_empty() {
            Ok(Some(format!("({})", terms.join(" AND "))))
        } else if sorted {
            Ok(None)
        } else {
            error("expected a search term", self.pos)
        }
    }

    fn parse_unary(&mut self) -> Res<String> {
        if self.peek() != Some('-') {
            return self.parse_primary();
        }
        let start = self.pos;
        self.pos += 1;
        if self.peek().is_none_or(char::is_whitespace) {
            return error("nothing to negate after `-`", start);
        }
        self.restricted += 1;
        let inner = self.parse_unary()?;
        self.restricted -= 1;
        Ok(format!("(NOT {inner})"))
    }

    fn parse_primary(&mut self) -> Res<String> {
        if self.peek() == Some('(') {
            return self.parse_group();
        }
        self.parse_term()
    }

    /// A parenthesised expression; the opening parenthesis is next.
    fn parse_group(&mut self) -> Res<String> {
        let start = self.pos;
        self.pos += 1;
        self.restricted += 1;
        let inner = self.parse_or()?;
        self.restricted -= 1;
        self.skip_whitespace();
        if self.peek() != Some(')') {
            return error("missing `)`", start);
        }
        self.pos += 1;
        Ok(inner)
    }

    fn parse_term(&mut self) -> Res<String> {
        let start = self.pos;
        let mut end = start;
        while self
            .chars
            .get(end)
            .is_some_and(|c| c.is_ascii_alphabetic() || *c == '_')
        {
            end += 1;
        }
        if end > start
            && let Some((op, len)) = self.operator_at(end)
        {
            let name: String = self.chars[start..end]
                .iter()
                .collect::<String>()
                .to_ascii_lowercase();
            let Some(field) = lookup(&name) else {
                return error(format!("unknown field `{name}`"), start);
            };
            self.pos = end + len;
            return self.field_term(&name, field, op, start);
        }
        // Anything else is a tag: a plain one, or with `@type:` in front one
        // of another type. `@name` alone is a state.
        let mut values = self.parse_values()?;
        let Some(marked) = values[0].text.strip_prefix('@') else {
            return Ok(self.tag_term("tags", Op::Eq, &values));
        };
        let Some((name, rest)) = marked.split_once(':') else {
            let state = marked.to_ascii_lowercase();
            if values.len() > 1 || !STATES.contains(&state.as_str()) {
                return error(
                    format!(
                        "`@{marked}` is neither a state ({}) nor a tag type followed by `:`, \
                         as in `@cr:name`",
                        STATES
                            .iter()
                            .map(|s| format!("@{s}"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    start,
                );
            }
            // Asking about the trash is what lets trashed entities through;
            // see `compile`.
            if self.depth == 0 {
                self.asks_trashed = true;
            }
            // `trashed` is the only state so far.
            return Ok(format!("({} = 1)", self.column('e', "trashed")));
        };
        let Some(field) = tag_type(name) else {
            let known: Vec<String> = TAG_PREFIXES.iter().map(|(_, p)| format!("@{p}")).collect();
            return error(
                format!(
                    "`@{name}` is not a tag type (expected one of {})",
                    known.join(", ")
                ),
                start,
            );
        };
        if rest.is_empty() {
            return error(format!("nothing after `@{name}:`"), start);
        }
        // In a list, the type given to the first value holds for them all.
        values[0].text = rest.to_string();
        Ok(self.tag_term(field, Op::Eq, &values))
    }

    fn parse_values(&mut self) -> Res<Vec<Val>> {
        let mut values = Vec::new();
        loop {
            values.push(self.parse_value()?);
            if self.peek() != Some(',') {
                return Ok(values);
            }
            self.pos += 1;
        }
    }

    fn parse_value(&mut self) -> Res<Val> {
        let pos = self.pos;
        if self.peek() == Some('"') {
            self.pos += 1;
            let mut text = String::new();
            loop {
                match self.peek() {
                    None => return error("missing closing quote", pos),
                    Some('"') => break,
                    // Other backslashes are left for the pattern step.
                    Some('\\') if self.chars.get(self.pos + 1) == Some(&'"') => {
                        text.push('"');
                        self.pos += 1;
                    }
                    Some(c) => text.push(c),
                }
                self.pos += 1;
            }
            self.pos += 1;
            return Ok(Val {
                text,
                quoted: true,
                pos,
            });
        }
        let mut text = String::new();
        while let Some(c) = self.peek() {
            if c.is_whitespace() || matches!(c, '(' | ')' | ',' | '"') {
                break;
            }
            text.push(c);
            self.pos += 1;
        }
        if text.is_empty() {
            return error("expected a value", pos);
        }
        Ok(Val {
            text,
            quoted: false,
            pos,
        })
    }

    fn field_term(&mut self, name: &str, field: Field, op: Op, start: usize) -> Res<String> {
        let allow = |allowed: &[Op]| {
            if allowed.contains(&op) {
                Ok(())
            } else {
                error(
                    format!("`{}` cannot be used with `{name}`", op.symbol()),
                    start,
                )
            }
        };
        const EQUALITY: &[Op] = &[Op::Eq, Op::Ne];
        const STRING: &[Op] = &[Op::Eq, Op::Ne, Op::Like];
        const ORDERED: &[Op] = &[Op::Eq, Op::Ne, Op::Lt, Op::Le, Op::Gt, Op::Ge];

        if self.peek() == Some('(') {
            return match field {
                Field::In | Field::Contains => {
                    allow(EQUALITY)?;
                    let sql = self.relation_subquery(matches!(field, Field::In))?;
                    Ok(negate_if(op == Op::Ne, sql))
                }
                Field::Within => {
                    allow(EQUALITY)?;
                    self.depth += 1;
                    let n = self.depth;
                    let inner = self.parse_group();
                    self.depth -= 1;
                    let from = format!(
                        "SELECT e{n}.id FROM entity e{n}
                         LEFT JOIN file f{n} ON f{n}.entity_id = e{n}.id
                         LEFT JOIN collection c{n} ON c{n}.entity_id = e{n}.id
                         WHERE {}",
                        inner?
                    );
                    Ok(negate_if(op == Op::Ne, self.within(&from)))
                }
                _ => error(format!("`{name}` does not take a subquery"), self.pos),
            };
        }
        let values = self.parse_values()?;

        let sql = match field {
            Field::List(table, column) => {
                allow(STRING)?;
                let matches = self.string_match(&format!("l.{column}"), op, &values);
                format!(
                    "(EXISTS (SELECT 1 FROM {table} l
                      WHERE l.entity_id = {} AND {matches}))",
                    self.column('e', "id")
                )
            }
            Field::Text(table, column) => {
                allow(STRING)?;
                let column = self.column(table, column);
                let matches = self.string_match(&column, op, &values);
                format!("({column} IS NOT NULL AND {matches})")
            }
            Field::Choice(table, column, choices) => {
                allow(EQUALITY)?;
                let column = self.column(table, column);
                self.choice_term(name, &column, choices, &values)?
            }
            Field::Number(table, column, unit) => {
                allow(ORDERED)?;
                let column = self.column(table, column);
                let parse = match unit {
                    Unit::Plain => parse_plain,
                    Unit::Duration => parse_duration,
                    Unit::Size => parse_size,
                };
                let whole_seconds = matches!(unit, Unit::Duration);
                self.number_term(name, &column, &column, parse, whole_seconds, op, &values)?
            }
            Field::Rating => {
                allow(ORDERED)?;
                let column = self.column('e', "content_rating");
                let rank = format!(
                    "CASE {column} WHEN 'safe' THEN 0 WHEN 'risky' THEN 1 WHEN 'nsfw' THEN 2 END"
                );
                self.number_term(name, &rank, &column, parse_rating, false, op, &values)?
            }
            Field::Date { added } => {
                allow(ORDERED)?;
                self.date_term(name, added, op, &values)?
            }
            Field::Bool(table, column) => {
                allow(EQUALITY)?;
                let column = self.column(table, column);
                self.bool_term(name, &column, &values, start)?
            }
            Field::Has => {
                allow(EQUALITY)?;
                let mut alternatives = Vec::new();
                for value in &values {
                    alternatives.push(self.presence(value)?);
                }
                format!("({})", alternatives.join(" OR "))
            }
            Field::Id => {
                allow(EQUALITY)?;
                let ids = self.id_list(name, &values)?;
                format!("({} IN ({ids}))", self.column('e', "id"))
            }
            Field::In | Field::Contains => {
                allow(EQUALITY)?;
                self.membership_term(name, matches!(field, Field::In), op, &values)?
            }
            Field::Within => {
                allow(EQUALITY)?;
                let ids = self.id_list(name, &values)?;
                self.within(&format!("VALUES {}", ids.replace('?', "(?)")))
            }
            Field::Sort => {
                if op != Op::Eq {
                    return error("write sorting as `sort=key` or `sort=-key`", start);
                }
                self.sort_term(&values, start)?;
                // Not a filter; `parse_and` drops it.
                return Ok(String::new());
            }
        };
        Ok(negate_if(op == Op::Ne, sql))
    }

    /// A field that takes one of a fixed set of words.
    fn choice_term(
        &mut self,
        name: &str,
        column: &str,
        choices: &[&str],
        values: &[Val],
    ) -> Res<String> {
        for value in values {
            let lower = value.text.to_ascii_lowercase();
            if !choices.contains(&lower.as_str()) {
                return error(
                    format!(
                        "`{}` is not a valid value for `{name}` (expected {})",
                        value.text,
                        choices.join(", ")
                    ),
                    value.pos,
                );
            }
            self.params.push(Value::Text(lower));
        }
        Ok(format!(
            "({column} IS NOT NULL AND {column} IN ({}))",
            placeholders(values.len())
        ))
    }

    fn bool_term(&mut self, name: &str, column: &str, values: &[Val], start: usize) -> Res<String> {
        let [value] = values else {
            return error(format!("`{name}` takes `true` or `false`"), start);
        };
        let flag = match value.text.to_ascii_lowercase().as_str() {
            "true" => 1,
            "false" => 0,
            _ => return error(format!("`{name}` takes `true` or `false`"), value.pos),
        };
        self.params.push(Value::Integer(flag));
        Ok(format!("({column} IS NOT NULL AND {column} = ?)"))
    }

    /// `in=<ids>`: members of those collections; `contains=<ids>`:
    /// collections holding those entities.
    fn membership_term(&mut self, name: &str, is_in: bool, op: Op, values: &[Val]) -> Res<String> {
        // Remembered for `sort=position`, which needs to know the collection.
        if is_in
            && self.restricted == 0
            && op == Op::Eq
            && values.len() == 1
            && let Ok(id) = values[0].text.parse()
        {
            self.top_level_in.push(id);
        }
        let ids = self.id_list(name, values)?;
        let (near, far) = if is_in {
            ("member_id", "collection_id")
        } else {
            ("collection_id", "member_id")
        };
        Ok(format!(
            "(EXISTS (SELECT 1 FROM membership m WHERE m.{near} = {} AND m.{far} IN ({ids})))",
            self.column('e', "id")
        ))
    }

    /// Whether the entity is inside one of the collections `from` selects
    /// the IDs of: a member, or a member of a member, at any depth. What
    /// is inside them is worked out once, not for every entity.
    fn within(&mut self, from: &str) -> String {
        self.walks += 1;
        let inside = format!("inside{}", self.walks);
        format!(
            "({} IN (
                WITH RECURSIVE {inside} (id) AS (
                    SELECT member_id FROM membership WHERE collection_id IN ({from})
                    UNION
                    SELECT m.member_id FROM membership m JOIN {inside} ON m.collection_id = {inside}.id
                )
                SELECT id FROM {inside}))",
            self.column('e', "id")
        )
    }

    /// Records the keys of a `sort=` term.
    fn sort_term(&mut self, values: &[Val], start: usize) -> Res<()> {
        if self.restricted > 0 {
            return error(
                "`sort=` is only allowed at the top level of the query",
                start,
            );
        }
        for value in values {
            let (descending, key) = match value.text.strip_prefix('-') {
                Some(key) => (true, key),
                None => (false, value.text.as_str()),
            };
            let lower = key.to_ascii_lowercase();
            let Some(key) = SORT_KEYS.iter().find(|known| **known == lower) else {
                return error(
                    format!("cannot sort by `{key}` (expected {})", SORT_KEYS.join(", ")),
                    value.pos,
                );
            };
            self.sorts.push(Sort {
                key,
                descending,
                pos: value.pos,
                line: self.line,
            });
        }
        Ok(())
    }

    /// `(pattern OR pattern …)` over `column`, one alternative per value.
    fn string_match(&mut self, column: &str, op: Op, values: &[Val]) -> String {
        let alternatives: Vec<String> = values
            .iter()
            .map(|value| {
                let pattern = match op {
                    Op::Like => format!("%{}%", like_pattern(&value.text, false)),
                    _ => like_pattern(&value.text, true),
                };
                self.params.push(Value::Text(pattern));
                format!("{column} LIKE ? ESCAPE '\\'")
            })
            .collect();
        format!("({})", alternatives.join(" OR "))
    }

    fn tag_term(&mut self, field: &str, op: Op, values: &[Val]) -> String {
        // A value naming an alias stands for the tag the alias defers to.
        // Patterns are left alone: they match stored tags, which an alias
        // is not.
        let values: Vec<Val> = values
            .iter()
            .map(|value| {
                let key = (field.to_string(), value.text.to_ascii_lowercase());
                let target = self.aliases.get(&key).filter(|_| op != Op::Like);
                Val {
                    text: target.map_or_else(
                        || value.text.clone(),
                        // Escaped, so the target is read back literally.
                        |target| target.replace('\\', "\\\\").replace('*', "\\*"),
                    ),
                    quoted: value.quoted,
                    pos: value.pos,
                }
            })
            .collect();
        let matches = self.string_match("t.value", op, &values);
        let sql = format!(
            "(EXISTS (SELECT 1 FROM entity_tag et JOIN tag t ON t.id = et.tag_id
              WHERE et.entity_id = {} AND t.field = '{field}' AND {matches}))",
            self.column('e', "id")
        );
        negate_if(op == Op::Ne, sql)
    }

    /// Comparisons, lists and ranges over a numeric expression. `guard` is
    /// the column that must be set for the term to match at all. With
    /// `whole_seconds`, equality and range ends cover the full second, so
    /// `length=90` matches a file 90.4 seconds long.
    #[allow(clippy::too_many_arguments)]
    fn number_term(
        &mut self,
        name: &str,
        expr: &str,
        guard: &str,
        parse: fn(&str) -> Option<f64>,
        whole_seconds: bool,
        op: Op,
        values: &[Val],
    ) -> Res<String> {
        let number = |text: &str, pos: usize| match parse(text) {
            Some(n) => Ok(n),
            None => error(format!("`{text}` is not a valid value for `{name}`"), pos),
        };
        let body = match op {
            Op::Eq | Op::Ne => {
                let mut alternatives = Vec::new();
                for value in values {
                    let range = (!value.quoted)
                        .then(|| value.text.split_once(".."))
                        .flatten();
                    let Some((low, high)) = range else {
                        let n = number(&value.text, value.pos)?;
                        self.params.push(Value::Real(n));
                        if whole_seconds {
                            self.params.push(Value::Real(n + 1.0));
                            alternatives.push(format!("{expr} >= ? AND {expr} < ?"));
                        } else {
                            alternatives.push(format!("{expr} = ?"));
                        }
                        continue;
                    };
                    if low.is_empty() && high.is_empty() {
                        return error("a range needs at least one end", value.pos);
                    }
                    let mut bounds = Vec::new();
                    if !low.is_empty() {
                        self.params.push(Value::Real(number(low, value.pos)?));
                        bounds.push(format!("{expr} >= ?"));
                    }
                    if !high.is_empty() {
                        let n = number(high, value.pos)?;
                        if whole_seconds {
                            self.params.push(Value::Real(n + 1.0));
                            bounds.push(format!("{expr} < ?"));
                        } else {
                            self.params.push(Value::Real(n));
                            bounds.push(format!("{expr} <= ?"));
                        }
                    }
                    alternatives.push(bounds.join(" AND "));
                }
                format!("({})", alternatives.join(") OR ("))
            }
            comparison => {
                let [value] = values else {
                    return error(
                        format!("`{}` takes a single value", comparison.symbol()),
                        values[0].pos,
                    );
                };
                self.params
                    .push(Value::Real(number(&value.text, value.pos)?));
                format!("{expr} {} ?", comparison.symbol())
            }
        };
        Ok(format!("({guard} IS NOT NULL AND ({body}))"))
    }

    fn date_term(&mut self, name: &str, added: bool, op: Op, values: &[Val]) -> Res<String> {
        let stored = if added {
            format!("substr({}, 1, 10)", self.column('e', "date_added"))
        } else {
            self.column('e', "date")
        };
        let start = format!("substr({stored} || '{PERIOD_START}', 1, 10)");
        let end = format!("substr({stored} || '{PERIOD_END}', 1, 10)");
        let check = |text: &str, pos: usize| {
            if valid_date(text) {
                Ok(())
            } else {
                error(
                    format!(
                        "`{text}` is not a date for `{name}` (use YYYY, YYYY-MM or YYYY-MM-DD)"
                    ),
                    pos,
                )
            }
        };
        let body = match op {
            Op::Eq | Op::Ne => {
                let mut alternatives = Vec::new();
                for value in values {
                    let (low, high) = match value.text.split_once("..") {
                        Some(range) if !value.quoted => range,
                        _ => (value.text.as_str(), value.text.as_str()),
                    };
                    if low.is_empty() && high.is_empty() {
                        return error("a range needs at least one end", value.pos);
                    }
                    let mut bounds = Vec::new();
                    if !low.is_empty() {
                        check(low, value.pos)?;
                        self.params.push(Value::Text(pad_date(low, PERIOD_START)));
                        bounds.push(format!("{start} >= ?"));
                    }
                    if !high.is_empty() {
                        check(high, value.pos)?;
                        self.params.push(Value::Text(pad_date(high, PERIOD_END)));
                        bounds.push(format!("{end} <= ?"));
                    }
                    alternatives.push(bounds.join(" AND "));
                }
                format!("({})", alternatives.join(") OR ("))
            }
            comparison => {
                let [value] = values else {
                    return error(
                        format!("`{}` takes a single value", comparison.symbol()),
                        values[0].pos,
                    );
                };
                check(&value.text, value.pos)?;
                // Strictly before / after compare against the far edge of
                // the stored period; the inclusive forms against the near one.
                let (side, padding) = match comparison {
                    Op::Lt => (&end, PERIOD_START),
                    Op::Le => (&end, PERIOD_END),
                    Op::Gt => (&start, PERIOD_END),
                    _ => (&start, PERIOD_START),
                };
                self.params
                    .push(Value::Text(pad_date(&value.text, padding)));
                format!("{side} {} ?", comparison.symbol())
            }
        };
        Ok(format!("({stored} IS NOT NULL AND ({body}))"))
    }

    /// The condition for one `has=` value.
    fn presence(&mut self, value: &Val) -> Res<String> {
        let name = value.text.to_ascii_lowercase();
        let entity = self.column('e', "id");
        let set = |column: String| format!("{column} IS NOT NULL");
        Ok(match lookup(&name) {
            Some(Field::List(table, _)) => {
                format!("EXISTS (SELECT 1 FROM {table} l WHERE l.entity_id = {entity})")
            }
            Some(Field::In | Field::Within) => {
                format!("EXISTS (SELECT 1 FROM membership m WHERE m.member_id = {entity})")
            }
            Some(Field::Contains) => {
                format!("EXISTS (SELECT 1 FROM membership m WHERE m.collection_id = {entity})")
            }
            Some(Field::Rating) => set(self.column('e', "content_rating")),
            Some(Field::Date { added: false }) => set(self.column('e', "date")),
            Some(Field::Bool(table, column)) => set(self.column(table, column)),
            Some(
                Field::Text(table, column)
                | Field::Choice(table, column, _)
                | Field::Number(table, column, _),
            ) if !matches!(name.as_str(), "kind" | "media" | "hash" | "ext" | "size") => {
                set(self.column(table, column))
            }
            Some(Field::Has | Field::Id | Field::Sort) | None => {
                return error(format!("unknown field `{}`", value.text), value.pos);
            }
            Some(_) => return error(format!("`{name}` is always set"), value.pos),
        })
    }

    /// Pushes the values as integer parameters and returns their placeholders.
    fn id_list(&mut self, name: &str, values: &[Val]) -> Res<String> {
        for value in values {
            match value.text.parse::<i64>() {
                Ok(id) => self.params.push(Value::Integer(id)),
                Err(_) => {
                    return error(
                        format!("`{}` is not an ID for `{name}`", value.text),
                        value.pos,
                    );
                }
            }
        }
        Ok(placeholders(values.len()))
    }

    /// `in=(…)` or `contains=(…)`; the opening parenthesis is next.
    fn relation_subquery(&mut self, is_in: bool) -> Res<String> {
        let outer = self.column('e', "id");
        self.depth += 1;
        let n = self.depth;
        let inner = self.parse_group();
        self.depth -= 1;
        let inner = inner?;
        let (near, far) = if is_in {
            ("member_id", "collection_id")
        } else {
            ("collection_id", "member_id")
        };
        Ok(format!(
            "(EXISTS (SELECT 1 FROM membership m{n}
              JOIN entity e{n} ON e{n}.id = m{n}.{far}
              LEFT JOIN file f{n} ON f{n}.entity_id = e{n}.id
              LEFT JOIN collection c{n} ON c{n}.entity_id = e{n}.id
              WHERE m{n}.{near} = {outer} AND {inner}))"
        ))
    }
}

fn negate_if(negate: bool, sql: String) -> String {
    if negate { format!("(NOT {sql})") } else { sql }
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// The contents of an ORDER BY clause for the given keys, and its
/// parameters. `top_level_in` is what `sort=position` orders by.
fn order_by(sorts: &[Sort], top_level_in: &[i64], seed: i64) -> Res<(String, Vec<Value>)> {
    let mut clauses = Vec::new();
    let mut order_params = Vec::new();
    for sort in sorts {
        let direction = if sort.descending { "DESC" } else { "ASC" };
        let expr = match sort.key {
            "random" => {
                // `shuffle` is defined in db.rs: a different order per seed,
                // and the same one for every page of a search.
                order_params.push(Value::Integer(seed));
                clauses.push("shuffle(e0.id, ?)".to_string());
                continue;
            }
            "position" => {
                let [collection] = top_level_in[..] else {
                    return Err(QueryError {
                        message: "`sort=position` needs exactly one top-level `in=<id>` term"
                            .to_string(),
                        position: sort.pos,
                        line: sort.line,
                    });
                };
                // The expression appears twice below.
                order_params.extend([Value::Integer(collection), Value::Integer(collection)]);
                "(SELECT position FROM membership WHERE collection_id = ? AND member_id = e0.id)"
            }
            "added" => "e0.date_added",
            "date" => "e0.date",
            "score" => "e0.score",
            "title" => "e0.title COLLATE NOCASE",
            "name" => "f0.original_name COLLATE NOCASE",
            "size" => "f0.size",
            "width" => "f0.width",
            "height" => "f0.height",
            "length" => "f0.length",
            "pages" => "f0.page_count",
            _ => "e0.id",
        };
        // Entities without a value sort last in either direction.
        clauses.push(format!("{expr} IS NULL, {expr} {direction}"));
    }
    let tie = if sorts[0].descending { "DESC" } else { "ASC" };
    clauses.push(format!("e0.id {tie}"));

    Ok((clauses.join(", "), order_params))
}

/// Compiles a query. A query of several lines is a stack: each line is a
/// query of its own, and what is found is what all of them match. Their
/// `sort=` terms apply in the order written. `seed` fixes the order of `sort=random` so that pages
/// of one search agree with each other.
///
/// Trashed entities are left out unless the query mentions `@trashed` or
/// `include_trashed` is set.
pub fn compile(source: &str, seed: i64, aliases: &Aliases, include_trashed: bool) -> Res<Compiled> {
    let mut parser = Parser {
        aliases,
        chars: Vec::new(),
        pos: 0,
        line: 0,
        depth: 0,
        walks: 0,
        restricted: 0,
        params: Vec::new(),
        sorts: Vec::new(),
        top_level_in: Vec::new(),
        asks_trashed: false,
    };
    let mut filters = Vec::new();
    for (line, text) in source.lines().enumerate() {
        parser.chars = text.chars().collect();
        parser.pos = 0;
        parser.line = line;
        parser.skip_whitespace();
        if parser.at_end() {
            continue;
        }
        let parsed = parser.parse_or().and_then(|sql| {
            if parser.at_end() {
                Ok(sql)
            } else {
                error("unexpected `)`", parser.pos)
            }
        });
        filters.push(parsed.map_err(|err| QueryError { line, ..err })?);
    }
    let filter = match filters.len() {
        0 => "1".to_string(),
        1 => filters.remove(0),
        _ => format!("({})", filters.join(") AND (")),
    };

    // Trashed entities stay out of every search that does not ask about
    // the trash with `@trashed` (or its negation).
    let filter = if parser.asks_trashed || include_trashed {
        filter
    } else {
        format!("({filter}) AND e0.trashed = 0")
    };

    let sorted = !parser.sorts.is_empty();
    if parser.sorts.is_empty() {
        // Newest first unless the query says otherwise.
        parser.sorts.push(Sort {
            key: "added",
            descending: true,
            pos: 0,
            line: 0,
        });
    }
    let (order, order_params) = order_by(&parser.sorts, &parser.top_level_in, seed)?;
    Ok(Compiled {
        filter,
        filter_params: parser.params,
        order,
        order_params,
        sorted,
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rusqlite::{Connection, params_from_iter};

    use super::*;

    /// A small library: three files and a book, one of them trashed, and a
    /// collection holding two of them.
    fn library() -> Connection {
        let conn = crate::db::open(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO entity (id, kind, date_added, title, date, score, content_rating, trashed)
             VALUES (1, 'file', '2026-01-01T00:00:01Z', 'Cat on a mat', '2020-05-01', 5, 'safe', 0),
                    (2, 'file', '2026-01-01T00:00:02Z', NULL, NULL, 2, 'nsfw', 0),
                    (3, 'file', '2026-01-01T00:00:03Z', NULL, NULL, NULL, NULL, 1),
                    (4, 'collection', '2026-01-01T00:00:04Z', 'Pets', NULL, NULL, NULL, 0),
                    (5, 'file', '2026-01-01T00:00:05Z', NULL, NULL, NULL, NULL, 0);
             INSERT INTO file
                 (entity_id, hash, extension, media_type, size, original_name, width, height,
                  page_count, length)
             VALUES (1, printf('%064d', 1), 'jpg', 'image', 1000, 'cat.jpg', 800, 600, NULL, NULL),
                    (2, printf('%064d', 2), 'mp4', 'video', 5000000, 'dog.mp4', 1920, 1080, NULL, 90),
                    (3, printf('%064d', 3), 'png', 'image', 2000, 'old.png', 10, 10, NULL, NULL),
                    (5, printf('%064d', 5), 'epub', 'book', 3000, 'book.epub', NULL, NULL, 120, NULL);
             INSERT INTO collection (entity_id, collection_type) VALUES (4, 'set');
             INSERT INTO membership (collection_id, member_id, position) VALUES (4, 1, 2), (4, 2, 1);
             INSERT INTO tag (id, field, value)
             VALUES (1, 'tags', 'cat'), (2, 'tags', 'animal:feline'), (3, 'tags', 'dog'),
                    (4, 'creator', 'Abba'), (5, 'creator', 'Beta');
             INSERT INTO entity_tag (entity_id, tag_id)
             VALUES (1, 1), (1, 2), (1, 4), (2, 3), (2, 5), (3, 1);
             INSERT INTO identifier (entity_id, value) VALUES (5, 'isbn-1');
             INSERT INTO reference (entity_id, value) VALUES (5, 'ref-1');
             INSERT INTO source_url (entity_id, url) VALUES (5, 'https://example.com/a');",
        )
        .unwrap();
        conn
    }

    /// The IDs a query finds, in the order it gives them.
    fn ordered(conn: &Connection, source: &str, aliases: &Aliases) -> Vec<i64> {
        let compiled = compile(source, 7, aliases, false)
            .unwrap_or_else(|err| panic!("`{source}`: {}", err.message));
        let sql = format!(
            "SELECT e0.id FROM {FROM} WHERE {} ORDER BY {}",
            compiled.filter, compiled.order
        );
        let params = compiled.filter_params.iter().chain(&compiled.order_params);
        conn.prepare(&sql)
            .unwrap()
            .query_map(params_from_iter(params), |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// The IDs a query finds, lowest first.
    fn found(conn: &Connection, source: &str) -> Vec<i64> {
        let mut ids = ordered(conn, source, &Aliases::new());
        ids.sort();
        ids
    }

    fn fails(source: &str) -> bool {
        compile(source, 7, &Aliases::new(), false).is_err()
    }

    #[test]
    fn lines_stack() {
        let conn = library();
        // A line is taken whole: its `or` does not reach into the next.
        assert_eq!(found(&conn, "cat or dog\n\nscore<5"), [2]);
        assert_eq!(found(&conn, "cat or dog score<5"), [1, 2]);
        // Every line is a top level: each may sort, in the order written.
        let aliases = Aliases::new();
        assert_eq!(
            ordered(&conn, "sort=score\nsort=-id", &aliases),
            ordered(&conn, "sort=score sort=-id", &aliases)
        );
        let err = compile("cat\ndog (cat", 7, &aliases, false).err().unwrap();
        assert_eq!((err.line, err.position), (1, 4));
    }

    #[test]
    fn collection_ids_are_searched_by_namespace() {
        let conn = library();
        conn.execute_batch(
            "INSERT INTO entity (id, kind, date_added) VALUES
                 (10, 'collection', '2026-01-02T00:00:00Z'),
                 (11, 'collection', '2026-01-02T00:00:01Z'),
                 (12, 'collection', '2026-01-02T00:00:02Z');
             INSERT INTO collection (entity_id, collection_type, collection_id) VALUES
                 (10, 'sourceset', 'pinterest:someone:women'),
                 (11, 'sourceset', 'pinterest:someone:women:celebs'),
                 (12, 'set', 'pinterest:pin:77');
             INSERT INTO membership (collection_id, member_id) VALUES (10, 11), (11, 1), (12, 2);",
        )
        .unwrap();
        // As with a tag: the name alone is that one, `:*` what is under it.
        assert_eq!(found(&conn, "collection_id=pinterest:someone:women"), [10]);
        assert_eq!(
            found(&conn, "collection_id=pinterest:someone:women:*"),
            [11]
        );
        assert_eq!(found(&conn, "collection_id=pinterest:someone:*"), [10, 11]);
        assert_eq!(found(&conn, "collection_id=pinterest:*"), [10, 11, 12]);
        assert_eq!(found(&conn, "collection_id=*:celebs"), [11]);
        assert_eq!(found(&conn, "collection_id=PINTEREST:PIN:*"), [12]);
        assert!(found(&conn, "collection_id=pinterest").is_empty());
        // What is in them, and which have an ID at all.
        assert_eq!(
            found(&conn, "in=(collection_id=pinterest:someone:*)"),
            [1, 11]
        );
        assert_eq!(found(&conn, "has=collection_id"), [10, 11, 12]);
        assert_eq!(found(&conn, "kind=collection -has=collection_id"), [4]);
    }

    #[test]
    fn within_reaches_through_collections() {
        let conn = library();
        // 10 holds 11 and the book; 11 holds 12 and the cat; 12 the dog.
        conn.execute_batch(
            "INSERT INTO entity (id, kind, date_added) VALUES
                 (10, 'collection', '2026-01-02T00:00:00Z'),
                 (11, 'collection', '2026-01-02T00:00:01Z'),
                 (12, 'collection', '2026-01-02T00:00:02Z');
             INSERT INTO collection (entity_id, collection_type, collection_id) VALUES
                 (10, 'sourceset', 'site:board'),
                 (11, 'sourceset', 'site:board:section'),
                 (12, 'set', 'site:pin:77');
             INSERT INTO membership (collection_id, member_id) VALUES
                 (10, 11), (10, 5), (11, 12), (11, 1), (12, 2);",
        )
        .unwrap();
        // `in` is one level; `within` is every level.
        assert_eq!(found(&conn, "in=10"), [5, 11]);
        assert_eq!(found(&conn, "within=10"), [1, 2, 5, 11, 12]);
        assert_eq!(found(&conn, "within=11"), [1, 2, 12]);
        assert_eq!(found(&conn, "within=12"), [2]);
        assert_eq!(found(&conn, "within=12,4"), [1, 2]);
        assert_eq!(found(&conn, "within=10 kind=file"), [1, 2, 5]);
        assert_eq!(found(&conn, "within=10 dog"), [2]);
        // Negated, and with the collections found by a query of their own.
        assert_eq!(found(&conn, "kind=file -within=11"), [5]);
        assert_eq!(found(&conn, "kind=file within!=11"), [5]);
        assert_eq!(
            found(&conn, "within=(collection_id=site:board)"),
            [1, 2, 5, 11, 12]
        );
        assert_eq!(
            found(&conn, "within=(collection_id=site:board:*) kind=file"),
            [1, 2]
        );
        assert_eq!(found(&conn, "within=(type=set)"), [1, 2]);
        // Inside one another, and beside one another.
        assert_eq!(found(&conn, "within=(within=10 type=set)"), [2]);
        assert_eq!(found(&conn, "within=4 within=10 kind=file"), [1, 2]);
        assert_eq!(found(&conn, "in=(within=10)"), [1, 2, 12]);
        assert!(fails("within=cat"));
        assert!(fails("within>10"));
    }

    #[test]
    fn plain_terms_are_tags() {
        let conn = library();
        assert_eq!(found(&conn, ""), [1, 2, 4, 5]);
        assert_eq!(found(&conn, "cat"), [1]);
        assert_eq!(found(&conn, "CAT"), [1]);
        assert_eq!(found(&conn, "ca*"), [1]);
        assert_eq!(found(&conn, "animal:*"), [1]);
        assert_eq!(found(&conn, "animal:feline"), [1]);
        assert_eq!(found(&conn, "bird"), [] as [i64; 0]);
    }

    #[test]
    fn at_names_a_tag_type() {
        let conn = library();
        assert_eq!(found(&conn, "@cr:Abba"), [1]);
        assert_eq!(found(&conn, "@creator:abba"), [1]);
        assert_eq!(found(&conn, "@cr:Abba,Beta"), [1, 2]);
        assert_eq!(found(&conn, "@cr:*"), [1, 2]);
        assert_eq!(found(&conn, "-@cr:*"), [4, 5]);
        assert_eq!(found(&conn, "@ta:cat"), [1]);
        // A creator is not a plain tag.
        assert_eq!(found(&conn, "Abba"), [] as [i64; 0]);
        assert!(fails("@zz:cat"));
    }

    #[test]
    fn trash_is_left_out_unless_asked_for() {
        let conn = library();
        assert_eq!(found(&conn, "@trashed"), [3]);
        assert_eq!(found(&conn, "cat @trashed"), [3]);
        assert_eq!(found(&conn, "ext=png"), [] as [i64; 0]);
        assert_eq!(found(&conn, "ext=png @trashed"), [3]);
        let all = compile("cat", 7, &Aliases::new(), true).unwrap();
        assert!(!all.filter.contains("trashed"));
    }

    #[test]
    fn terms_combine() {
        let conn = library();
        assert_eq!(found(&conn, "cat or dog"), [1, 2]);
        assert_eq!(found(&conn, "-cat"), [2, 4, 5]);
        assert_eq!(found(&conn, "(cat or dog) score>=3"), [1]);
        assert_eq!(found(&conn, "cat dog"), [] as [i64; 0]);
        assert!(fails("(cat"));
        assert!(fails("cat)"));
    }

    #[test]
    fn fields_compare() {
        let conn = library();
        assert_eq!(found(&conn, "score>=3"), [1]);
        assert_eq!(found(&conn, "score=1..2"), [2]);
        assert_eq!(found(&conn, "rating=nsfw"), [2]);
        assert_eq!(found(&conn, "media=video"), [2]);
        assert_eq!(found(&conn, "kind=collection"), [4]);
        assert_eq!(found(&conn, "type=set"), [4]);
        assert_eq!(found(&conn, "title~mat"), [1]);
        assert_eq!(found(&conn, "length>1m"), [2]);
        assert_eq!(found(&conn, "size>1mb"), [2]);
        assert_eq!(found(&conn, "pages>100"), [5]);
        assert_eq!(found(&conn, "width>=1920"), [2]);
        assert_eq!(found(&conn, "date=2020"), [1]);
        assert_eq!(found(&conn, "date>=2021"), [] as [i64; 0]);
        assert_eq!(found(&conn, "has=title"), [1, 4]);
        assert_eq!(found(&conn, "identifier=isbn-1"), [5]);
        assert_eq!(found(&conn, "reference=ref-*"), [5]);
        assert_eq!(found(&conn, "source_url~example"), [5]);
        assert!(fails("score>many"));
        assert!(fails("media=film"));
        assert!(fails("nosuchfield=1"));
        assert_eq!(found(&conn, "media=image,video"), [1, 2]);
        // The negation of `=`: what has no media type is not an image either.
        assert_eq!(found(&conn, "media!=image"), [2, 4, 5]);
        assert_eq!(found(&conn, "id=1,5"), [1, 5]);
        assert_eq!(found(&conn, "looping=true"), [] as [i64; 0]);
        assert!(fails("looping=maybe"));
        assert!(fails("looping=true,false"));
        assert!(fails("media>image"));
        assert!(fails("in=(sort=id)"));
        assert!(fails("sort>id"));
        assert_eq!(found(&conn, "in!=4"), [4, 5]);
        assert_eq!(found(&conn, "contains=1,2"), [4]);
    }

    #[test]
    fn collections_relate() {
        let conn = library();
        assert_eq!(found(&conn, "in=4"), [1, 2]);
        assert_eq!(found(&conn, "in=(title~pets)"), [1, 2]);
        assert_eq!(found(&conn, "contains=1"), [4]);
        assert_eq!(found(&conn, "has=in"), [1, 2]);
        assert_eq!(found(&conn, "has=contains"), [4]);
    }

    #[test]
    fn results_are_ordered() {
        let conn = library();
        let none = Aliases::new();
        // Newest first unless told otherwise.
        assert_eq!(ordered(&conn, "", &none), [5, 4, 2, 1]);
        assert_eq!(ordered(&conn, "sort=id", &none), [1, 2, 4, 5]);
        // Those without a score come last in either direction.
        assert_eq!(ordered(&conn, "kind=file sort=score", &none), [2, 1, 5]);
        assert_eq!(ordered(&conn, "kind=file sort=-score", &none), [1, 2, 5]);
        assert_eq!(ordered(&conn, "in=4 sort=position", &none), [2, 1]);
        assert!(fails("sort=position"));
        assert!(fails("sort=nothing"));
        assert!(!compile("cat", 7, &none, false).unwrap().sorted);
        assert!(compile("cat sort=id", 7, &none, false).unwrap().sorted);
    }

    #[test]
    fn aliases_stand_for_their_tag() {
        let conn = library();
        let mut aliases = Aliases::new();
        aliases.insert(("tags".into(), "kitty".into()), "cat".into());
        assert_eq!(ordered(&conn, "kitty", &aliases), [1]);
        assert_eq!(ordered(&conn, "kitty", &Aliases::new()), [] as [i64; 0]);
    }

    #[test]
    fn units_and_dates_parse() {
        assert_eq!(parse_duration("90"), Some(90.0));
        assert_eq!(parse_duration("1m30s"), Some(90.0));
        assert_eq!(parse_size("1kb"), Some(1024.0));
        assert!(valid_date("2020"));
        assert!(valid_date("2020-05"));
        assert!(valid_date("2020-05-01"));
        assert!(!valid_date("2020-5-1"));
        assert_eq!(tag_type("cr"), Some("creator"));
        assert_eq!(tag_type("Creator"), Some("creator"));
        assert_eq!(tag_type("nope"), None);
    }
}
