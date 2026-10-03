//! Tags: the values of the multi-value fields. A tag's type is its field,
//! and its value may sit in a namespace, written `namespace:tag`, nested to
//! any depth.

use std::collections::{BTreeMap, HashMap};

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppState,
    error::ApiError,
    query::{Aliases, TAG_FIELDS, contains_pattern},
};

const MAX_SUGGESTIONS: usize = 50;

#[derive(Deserialize)]
struct SuggestParams {
    field: String,
    #[serde(default)]
    q: String,
}

#[derive(Serialize)]
struct Suggestion {
    /// A tag, or a namespace with its trailing colon.
    value: String,
    /// Entities carrying the tag, or uses of every tag in the namespace.
    count: i64,
    namespace: bool,
    /// Set when the suggestion was found through an alias of the tag.
    #[serde(skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
}

#[derive(Deserialize)]
struct ListParams {
    field: String,
}

#[derive(Deserialize)]
struct AliasInput {
    field: String,
    alias: String,
    #[serde(default)]
    target: String,
}

#[derive(Deserialize)]
struct RenameInput {
    field: String,
    /// The tag to rename, or the namespace, without a trailing colon.
    from: String,
    /// Its new name. For a namespace, empty moves its tags out of it.
    #[serde(default)]
    to: String,
    /// Whether `from` names a namespace rather than a tag.
    #[serde(default)]
    namespace: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tags", get(suggest))
        .route("/tags/all", get(list))
        .route("/tags/rename", post(rename))
        .route("/tags/alias", post(set_alias))
        .route("/tags/aliases/apply", post(apply_aliases))
}

pub fn check_field(field: &str) -> Result<(), ApiError> {
    if TAG_FIELDS.contains(&field) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!("`{field}` is not a tag field")))
    }
}

/// A tag value as it is stored: trimmed, with no space around the colons
/// of its namespaces. Empty values and empty parts are refused.
pub fn normalize(field: &str, value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ApiError::BadRequest(format!("empty value for `{field}`")));
    }
    let parts: Vec<&str> = value.split(':').map(str::trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(ApiError::BadRequest(format!(
            "`{value}` has an empty part: write `namespace:tag`"
        )));
    }
    Ok(parts.join(":"))
}

/// Completions for what has been typed into a tag field. They go one level
/// at a time: the namespaces and tags directly under the namespace typed so
/// far.
async fn suggest(
    State(state): State<AppState>,
    Query(params): Query<SuggestParams>,
) -> Result<Json<Vec<Suggestion>>, ApiError> {
    check_field(&params.field)?;
    let typed = params.q.trim();
    // What is typed splits into the namespace being looked in, with its
    // colon, and the start of a name inside it.
    let (prefix, rest) = match typed.rfind(':') {
        Some(at) => {
            let parts: Vec<&str> = typed[..at].split(':').map(str::trim).collect();
            (format!("{}:", parts.join(":")), typed[at + 1..].trim())
        }
        None => (String::new(), typed),
    };
    let rest = rest.to_lowercase();

    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT t.value, count(*) FROM tag t JOIN entity_tag et ON et.tag_id = t.id
         WHERE t.field = ?1 AND t.value LIKE ?2 ESCAPE '\\'
         GROUP BY t.id",
    )?;
    // contains_pattern gives %text%; without the first % it is a prefix.
    let pattern = &contains_pattern(&prefix)[1..];
    let tags = stmt
        .query_map([params.field.as_str(), pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Best matches first: 0 starts with what was typed, 1 contains it, 2 is
    // a tag deeper down whose own name starts with it.
    let mut found: HashMap<String, (u8, Suggestion)> = HashMap::new();
    let rank = |name: &str| {
        let name = name.to_lowercase();
        match name.find(&rest) {
            Some(0) => Some(0),
            Some(_) => Some(1),
            None => None,
        }
    };
    for (value, uses) in tags {
        let Some(inside) = value.get(prefix.len()..) else {
            continue;
        };
        let below = inside.split_once(':');
        match below {
            Some((namespace, _)) => {
                if let Some(rank) = rank(namespace) {
                    let namespace = &value[..prefix.len() + namespace.len() + 1];
                    found
                        .entry(namespace.to_lowercase())
                        .or_insert_with(|| {
                            let value = namespace.to_string();
                            (rank, Suggestion { value, count: 0, namespace: true, alias: None })
                        })
                        .1
                        .count += uses;
                }
                // Typing a bare name also finds it inside namespaces.
                let name = value.rsplit(':').next().unwrap_or("");
                if prefix.is_empty() && !rest.is_empty() && rank(name) == Some(0) {
                    let key = value.to_lowercase();
                    found.insert(key, (2, Suggestion { value, count: uses, namespace: false, alias: None }));
                }
            }
            None => {
                if let Some(rank) = rank(inside) {
                    let key = value.to_lowercase();
                    found.insert(key, (rank, Suggestion { value, count: uses, namespace: false, alias: None }));
                }
            }
        }
    }
    // An alias is never offered as a tag, even while entities still carry it.
    let mut stmt = conn.prepare("SELECT alias FROM tag_alias WHERE field = ?1")?;
    let names = stmt.query_map([&params.field], |row| row.get::<_, String>(0))?;
    for name in names {
        found.remove(&name?.to_lowercase());
    }
    // Typing an alias offers the tag it defers to.
    if !typed.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT a.alias, a.target,
                    (SELECT count(*) FROM tag t JOIN entity_tag et ON et.tag_id = t.id
                     WHERE t.field = a.field AND t.value = a.target)
             FROM tag_alias a WHERE a.field = ?1 AND a.alias LIKE ?2 ESCAPE '\\'",
        )?;
        let pattern = &contains_pattern(typed)[1..];
        let rows = stmt.query_map([params.field.as_str(), pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
        })?;
        for row in rows {
            let (alias, value, count): (String, String, i64) = row?;
            let key = format!("\0{}", alias.to_lowercase());
            let alias = Some(alias);
            found.insert(key, (0, Suggestion { value, count, namespace: false, alias }));
        }
    }
    let mut found: Vec<_> = found.into_values().collect();
    found.sort_by(|(rank_a, a), (rank_b, b)| {
        rank_a
            .cmp(rank_b)
            .then(b.count.cmp(&a.count))
            .then_with(|| a.value.to_lowercase().cmp(&b.value.to_lowercase()))
    });
    found.truncate(MAX_SUGGESTIONS);
    Ok(Json(found.into_iter().map(|(_, suggestion)| suggestion).collect()))
}

/// Gives the tag `id` a new value. If another tag of the field already has
/// that value the two are merged: its entities gain the tag and `id` goes.
fn move_tag(conn: &Connection, field: &str, id: i64, value: &str) -> rusqlite::Result<()> {
    let existing = conn
        .query_row(
            "SELECT id FROM tag WHERE field = ?1 AND value = ?2 AND id <> ?3",
            params![field, value, id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    match existing {
        Some(target) => {
            conn.execute(
                "INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
                 SELECT entity_id, ?2 FROM entity_tag WHERE tag_id = ?1",
                [id, target],
            )?;
            conn.execute("DELETE FROM tag WHERE id = ?1", [id])?;
        }
        None => {
            conn.execute("UPDATE tag SET value = ?2 WHERE id = ?1", params![id, value])?;
        }
    }
    Ok(())
}

/// Every alias, for the query compiler.
pub fn aliases(conn: &Connection) -> rusqlite::Result<Aliases> {
    let mut stmt = conn.prepare("SELECT field, alias, target FROM tag_alias")?;
    let rows = stmt.query_map([], |row| {
        let alias: String = row.get(1)?;
        Ok(((row.get(0)?, alias.to_ascii_lowercase()), row.get(2)?))
    })?;
    rows.collect()
}

/// The tag `value` stands for: the target if it is an alias, else itself.
pub fn resolve(conn: &Connection, field: &str, value: String) -> rusqlite::Result<String> {
    let target = conn
        .query_row(
            "SELECT target FROM tag_alias WHERE field = ?1 AND alias = ?2",
            [field, &value],
            |row| row.get(0),
        )
        .optional()?;
    Ok(target.unwrap_or(value))
}

/// Renames a tag, or with `namespace` a whole namespace: every tag under it
/// moves to the new one. Where a tag of the new name already exists the two
/// are merged. Aliases follow the tags they defer to.
async fn rename(
    State(state): State<AppState>,
    Json(input): Json<RenameInput>,
) -> Result<Json<Value>, ApiError> {
    check_field(&input.field)?;
    let field = input.field.as_str();
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;

    if !input.namespace {
        // Only trimmed, so a tag stored before a rule existed can be fixed.
        let from = input.from.trim();
        let to = normalize(field, &input.to)?;
        for name in [from, &to] {
            let target = resolve(&tx, field, name.to_string())?;
            if !target.eq_ignore_ascii_case(name) {
                return Err(ApiError::BadRequest(format!(
                    "`{name}` is an alias of `{target}`; remove the alias first"
                )));
            }
        }
        let id = tx
            .query_row(
                "SELECT id FROM tag WHERE field = ?1 AND value = ?2",
                [field, from],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let repointed = tx.execute(
            "UPDATE tag_alias SET target = ?3 WHERE field = ?1 AND target = ?2",
            [field, from, &to],
        )?;
        match id {
            Some(id) => move_tag(&tx, field, id, &to)?,
            // A tag nothing carries exists only as the target of aliases.
            None if repointed > 0 => {}
            None => return Err(ApiError::NotFound),
        }
        tx.commit()?;
        return Ok(Json(json!({ "renamed": 1 })));
    }

    let from = normalize(field, &input.from)?;
    let to = match input.to.trim() {
        "" => String::new(),
        to => format!("{}:", normalize(field, to)?),
    };
    let pattern = &contains_pattern(&format!("{from}:"))[1..];
    let renamed = |value: &str| format!("{to}{}", &value[from.len() + 1..]);

    let tags = {
        let mut stmt = tx.prepare(
            "SELECT id, value FROM tag WHERE field = ?1 AND value LIKE ?2 ESCAPE '\\'",
        )?;
        stmt.query_map([field, pattern], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let targets = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT target FROM tag_alias
             WHERE field = ?1 AND target LIKE ?2 ESCAPE '\\'",
        )?;
        stmt.query_map([field, pattern], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if tags.is_empty() && targets.is_empty() {
        return Err(ApiError::NotFound);
    }
    for (id, value) in &tags {
        move_tag(&tx, field, *id, &renamed(value))?;
    }
    for target in &targets {
        tx.execute(
            "UPDATE tag_alias SET target = ?3 WHERE field = ?1 AND target = ?2",
            [field, target, &renamed(target)],
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({ "renamed": tags.len() })))
}

/// Every tag of a field with the aliases that defer to it, for the tag
/// editor. An alias's count is the entities still carrying it, which
/// `apply_aliases` moves to the target. `pending` totals that over all
/// fields.
async fn list(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>, ApiError> {
    check_field(&params.field)?;
    let conn = state.db.lock().unwrap();

    let mut uses: BTreeMap<String, (String, i64)> = BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT t.value, count(*) FROM tag t JOIN entity_tag et ON et.tag_id = t.id
         WHERE t.field = ?1 GROUP BY t.id",
    )?;
    let rows = stmt.query_map([&params.field], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    for row in rows {
        let (value, count) = row?;
        uses.insert(value.to_lowercase(), (value, count));
    }

    let mut stmt = conn.prepare(
        "SELECT alias, target FROM tag_alias WHERE field = ?1 ORDER BY alias",
    )?;
    let alias_rows = stmt
        .query_map([&params.field], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut aliases: HashMap<String, Vec<Value>> = HashMap::new();
    for (alias, target) in alias_rows {
        // An alias some entity still carries is listed under its target,
        // not as a tag of its own.
        let count = uses.remove(&alias.to_lowercase()).map_or(0, |(_, count)| count);
        uses.entry(target.to_lowercase()).or_insert((target.clone(), 0));
        aliases
            .entry(target.to_lowercase())
            .or_default()
            .push(json!({ "value": alias, "count": count }));
    }

    let tags: Vec<Value> = uses
        .into_iter()
        .map(|(key, (value, count))| {
            let aliases = aliases.remove(&key).unwrap_or_default();
            json!({ "value": value, "count": count, "aliases": aliases })
        })
        .collect();
    let pending: i64 = conn.query_row(
        "SELECT count(*) FROM entity_tag et JOIN tag t ON t.id = et.tag_id
         JOIN tag_alias a ON a.field = t.field AND a.alias = t.value",
        [],
        |row| row.get(0),
    )?;
    Ok(Json(json!({ "tags": tags, "pending": pending })))
}

/// Makes `alias` defer to `target`, or with an empty target stops it being
/// an alias. Entities already carrying the alias keep it until
/// `apply_aliases`.
async fn set_alias(
    State(state): State<AppState>,
    Json(input): Json<AliasInput>,
) -> Result<Json<Value>, ApiError> {
    check_field(&input.field)?;
    let field = input.field.as_str();
    let alias = normalize(field, &input.alias)?;
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;

    if input.target.trim().is_empty() {
        let removed = tx.execute(
            "DELETE FROM tag_alias WHERE field = ?1 AND alias = ?2",
            [field, &alias],
        )?;
        if removed == 0 {
            return Err(ApiError::NotFound);
        }
    } else {
        // Aliases never chain: one naming an alias takes that alias's target.
        let target = resolve(&tx, field, normalize(field, &input.target)?)?;
        if target.eq_ignore_ascii_case(&alias) {
            return Err(ApiError::BadRequest(format!(
                "`{alias}` cannot be an alias of itself"
            )));
        }
        tx.execute(
            "UPDATE tag_alias SET target = ?3 WHERE field = ?1 AND target = ?2",
            [field, &alias, &target],
        )?;
        tx.execute(
            "INSERT INTO tag_alias (field, alias, target) VALUES (?1, ?2, ?3)
             ON CONFLICT (field, alias) DO UPDATE SET target = excluded.target",
            [field, &alias, &target],
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({ "ok": true })))
}

/// Replaces every alias still on an entity with the tag it defers to.
async fn apply_aliases(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let carried = {
        let mut stmt = tx.prepare(
            "SELECT t.id, t.field, a.target,
                    (SELECT count(*) FROM entity_tag et WHERE et.tag_id = t.id)
             FROM tag t JOIN tag_alias a ON a.field = t.field AND a.alias = t.value",
        )?;
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut updated = 0;
    for (id, field, target, count) in &carried {
        move_tag(&tx, field, *id, target)?;
        updated += count;
    }
    tx.commit()?;
    Ok(Json(json!({ "updated": updated })))
}
