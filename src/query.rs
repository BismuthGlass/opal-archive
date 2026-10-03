//! The search query language described in `query.md`, parsed straight into
//! an SQL filter and ordering over the tables named in [`FROM`].

use rusqlite::types::Value;

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
    "identifier",
    "usage_tags",
    "ai_usage_tags",
    "source",
    "source_url",
];
pub const KINDS: &[&str] = &["file", "collection"];
pub const MEDIA_TYPES: &[&str] = &["image", "video", "audio", "book", "other"];
pub const COLLECTION_TYPES: &[&str] =
    &["variant", "set", "sourceset", "sequence", "usercollection"];
pub const CONTENT_RATINGS: &[&str] = &["safe", "risky", "nsfw"];
pub const AI_CONTENT: &[&str] = &["none", "partial", "full", "unknown"];

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
    /// Character offset into the query.
    pub position: usize,
}

pub struct Compiled {
    /// Boolean SQL expression.
    pub filter: String,
    pub filter_params: Vec<Value>,
    /// Contents of an ORDER BY clause.
    pub order: String,
    pub order_params: Vec<Value>,
}

type Res<T> = Result<T, QueryError>;

fn error<T>(message: impl Into<String>, position: usize) -> Res<T> {
    Err(QueryError {
        message: message.into(),
        position,
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
    Tag(&'static str),
    Text(char, &'static str),
    Choice(char, &'static str, &'static [&'static str]),
    Number(char, &'static str, Unit),
    Rating,
    Date { added: bool },
    Bool(char, &'static str),
    Has,
    Id,
    In,
    Contains,
    Sort,
}

fn lookup(name: &str) -> Option<Field> {
    if let Some(tag) = TAG_FIELDS.iter().find(|field| **field == name) {
        return Some(Field::Tag(tag));
    }
    Some(match name {
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
        "ai" => Field::Choice('e', "ai_content", AI_CONTENT),
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
    let digits = |part: &str, len: usize| part.len() == len && part.bytes().all(|b| b.is_ascii_digit());
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

struct Parser {
    chars: Vec<char>,
    pos: usize,
    /// Subquery nesting; numbers the table aliases.
    depth: usize,
    /// Non-zero inside parentheses, negations and subqueries, where `sort=`
    /// is not allowed.
    restricted: usize,
    params: Vec<Value>,
    sorts: Vec<Sort>,
    /// Collections named by top-level `in=<id>` terms, for `sort=position`.
    top_level_in: Vec<i64>,
}

impl Parser {
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
            let name: String = self.chars[start..end].iter().collect::<String>().to_ascii_lowercase();
            let Some(field) = lookup(&name) else {
                return error(format!("unknown field `{name}`"), start);
            };
            self.pos = end + len;
            return self.field_term(&name, field, op, start);
        }
        // A plain value searches the general tags.
        let values = self.parse_values()?;
        Ok(self.tag_term("tags", Op::Eq, &values))
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
                _ => error(format!("`{name}` does not take a subquery"), self.pos),
            };
        }
        let values = self.parse_values()?;

        let sql = match field {
            Field::Tag(tag) => {
                allow(STRING)?;
                return Ok(self.tag_term(tag, op, &values));
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
                for value in &values {
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
                format!(
                    "({column} IS NOT NULL AND {column} IN ({}))",
                    placeholders(values.len())
                )
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
                let [value] = &values[..] else {
                    return error(format!("`{name}` takes `true` or `false`"), start);
                };
                let flag = match value.text.to_ascii_lowercase().as_str() {
                    "true" => 1,
                    "false" => 0,
                    _ => return error(format!("`{name}` takes `true` or `false`"), value.pos),
                };
                self.params.push(Value::Integer(flag));
                format!("({column} IS NOT NULL AND {column} = ?)")
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
                let is_in = matches!(field, Field::In);
                if is_in
                    && self.restricted == 0
                    && op == Op::Eq
                    && values.len() == 1
                    && let Ok(id) = values[0].text.parse()
                {
                    self.top_level_in.push(id);
                }
                let ids = self.id_list(name, &values)?;
                let (near, far) = if is_in {
                    ("member_id", "collection_id")
                } else {
                    ("collection_id", "member_id")
                };
                format!(
                    "(EXISTS (SELECT 1 FROM membership m WHERE m.{near} = {} AND m.{far} IN ({ids})))",
                    self.column('e', "id")
                )
            }
            Field::Sort => {
                if op != Op::Eq {
                    return error("write sorting as `sort=key` or `sort=-key`", start);
                }
                if self.restricted > 0 {
                    return error(
                        "`sort=` is only allowed at the top level of the query",
                        start,
                    );
                }
                for value in &values {
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
                    });
                }
                // Not a filter; `parse_and` drops it.
                return Ok(String::new());
            }
        };
        Ok(negate_if(op == Op::Ne, sql))
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
        let matches = self.string_match("t.value", op, values);
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
                    let range = (!value.quoted).then(|| value.text.split_once("..")).flatten();
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
                self.params.push(Value::Real(number(&value.text, value.pos)?));
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
                    format!("`{text}` is not a date for `{name}` (use YYYY, YYYY-MM or YYYY-MM-DD)"),
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
                self.params.push(Value::Text(pad_date(&value.text, padding)));
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
            Some(Field::Tag(tag)) => format!(
                "EXISTS (SELECT 1 FROM entity_tag et JOIN tag t ON t.id = et.tag_id
                 WHERE et.entity_id = {entity} AND t.field = '{tag}')"
            ),
            Some(Field::In) => {
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

/// Compiles a query. `seed` fixes the order of `sort=random` so that pages
/// of one search agree with each other.
pub fn compile(source: &str, seed: i64) -> Res<Compiled> {
    let mut parser = Parser {
        chars: source.chars().collect(),
        pos: 0,
        depth: 0,
        restricted: 0,
        params: Vec::new(),
        sorts: Vec::new(),
        top_level_in: Vec::new(),
    };
    parser.skip_whitespace();
    let filter = if parser.at_end() {
        "1".to_string()
    } else {
        let sql = parser.parse_or()?;
        if !parser.at_end() {
            return error("unexpected `)`", parser.pos);
        }
        sql
    };

    if parser.sorts.is_empty() {
        parser.sorts.push(Sort {
            key: "added",
            descending: true,
            pos: 0,
        });
    }
    let mut clauses = Vec::new();
    let mut order_params = Vec::new();
    for sort in &parser.sorts {
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
                let [collection] = parser.top_level_in[..] else {
                    return error(
                        "`sort=position` needs exactly one top-level `in=<id>` term",
                        sort.pos,
                    );
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
    let tie = if parser.sorts[0].descending { "DESC" } else { "ASC" };
    clauses.push(format!("e0.id {tie}"));

    Ok(Compiled {
        filter,
        filter_params: parser.params,
        order: clauses.join(", "),
        order_params,
    })
}
