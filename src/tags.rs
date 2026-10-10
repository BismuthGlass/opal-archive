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
    AppState, entities,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

/// Names a tag, to create, describe or delete it.
#[derive(Deserialize)]
struct TagInput {
    field: String,
    value: String,
    /// For describing: the new description; empty or absent clears it.
    description: Option<String>,
}

/// Names a tag in a query string.
#[derive(Deserialize)]
struct TagParams {
    field: String,
    value: String,
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

/// A tag and one of its child tags, to add the link or remove it.
#[derive(Deserialize)]
struct ChildInput {
    field: String,
    value: String,
    child_field: String,
    child: String,
    #[serde(default)]
    remove: bool,
}

#[derive(Deserialize)]
struct RenameInput {
    field: String,
    from: String,
    to: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tags", get(suggest).post(create))
        .route("/tags/describe", post(describe))
        .route("/tags/delete", post(delete))
        .route("/tags/all", get(list))
        .route("/tags/rename", post(rename))
        .route("/tags/alias", post(set_alias))
        .route("/tags/child", post(set_child))
        .route("/tags/children", get(children))
        .route("/tags/aliases/apply", post(apply_aliases))
}

pub fn check_field(field: &str) -> Result<(), ApiError> {
    if TAG_FIELDS.contains(&field) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "`{field}` is not a tag field"
        )))
    }
}

/// A tag value as it is stored: trimmed, with no space around the colons
/// of its namespaces. Empty values and empty parts are refused.
pub fn normalize(field: &str, value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ApiError::BadRequest(format!("empty value for `{field}`")));
    }
    // An @ at the start is how a tag's type is written, so no tag has one.
    if value.starts_with('@') {
        return Err(ApiError::BadRequest(format!(
            "`{value}`: a tag cannot start with @"
        )));
    }
    let parts: Vec<&str> = value.split(':').map(str::trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(ApiError::BadRequest(format!(
            "`{value}` has an empty part: write `namespace:tag`"
        )));
    }
    Ok(parts.join(":"))
}

/// Tags by field as they are kept: every field a tag field, every value
/// as `normalize` has it, none twice, and no field left with none.
pub fn checked(
    given: BTreeMap<String, Vec<String>>,
) -> Result<BTreeMap<String, Vec<String>>, ApiError> {
    let mut kept = BTreeMap::new();
    for (field, values) in given {
        check_field(&field)?;
        let mut normal = Vec::new();
        for value in values {
            let value = normalize(&field, &value)?;
            if !normal.contains(&value) {
                normal.push(value);
            }
        }
        if !normal.is_empty() {
            kept.insert(field, normal);
        }
    }
    Ok(kept)
}

impl Suggestion {
    fn tag(value: String, count: i64, description: Option<String>) -> Self {
        Suggestion {
            value,
            count,
            namespace: false,
            alias: None,
            description,
        }
    }
}

/// How well a name matches what was typed: 0 if it starts with it, 1 if it
/// only contains it.
fn rank(name: &str, typed: &str) -> Option<u8> {
    match name.to_lowercase().find(typed) {
        Some(0) => Some(0),
        Some(_) => Some(1),
        None => None,
    }
}

/// Splits what was typed into the namespace being looked in, with its
/// colon, and the start of a name inside it, in lower case.
fn split_typed(typed: &str) -> (String, String) {
    match typed.rfind(':') {
        Some(at) => {
            let parts: Vec<&str> = typed[..at].split(':').map(str::trim).collect();
            (
                format!("{}:", parts.join(":")),
                typed[at + 1..].trim().to_lowercase(),
            )
        }
        None => (String::new(), typed.to_lowercase()),
    }
}

/// Suggestions by a key that tells them apart, each with its rank: 0 and 1
/// as `rank` gives them, 2 for a tag deeper down whose own name starts
/// with what was typed.
type Found = HashMap<String, (u8, Suggestion)>;

/// The tags and namespaces directly under `prefix` whose name matches
/// `rest`.
fn matching_tags(
    conn: &Connection,
    field: &str,
    prefix: &str,
    rest: &str,
) -> rusqlite::Result<Found> {
    let mut stmt = conn.prepare(
        // Left join: a pinned tag is offered though nothing carries it yet.
        "SELECT t.value, count(et.entity_id), t.description
         FROM tag t LEFT JOIN entity_tag et ON et.tag_id = t.id
         WHERE t.field = ?1 AND t.value LIKE ?2 ESCAPE '\\'
         GROUP BY t.id",
    )?;
    // contains_pattern gives %text%; without the first % it is a prefix.
    let pattern = &contains_pattern(prefix)[1..];
    let tags = stmt.query_map([field, pattern], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;

    let mut found = Found::new();
    for tag in tags {
        let (value, uses, description) = tag?;
        let Some(inside) = value.get(prefix.len()..) else {
            continue;
        };
        let Some((namespace, _)) = inside.split_once(':') else {
            if let Some(rank) = rank(inside, rest) {
                let key = value.to_lowercase();
                found.insert(key, (rank, Suggestion::tag(value, uses, description)));
            }
            continue;
        };
        // A tag further down counts towards the namespace it is under.
        if let Some(rank) = rank(namespace, rest) {
            let namespace = &value[..prefix.len() + namespace.len() + 1];
            found
                .entry(namespace.to_lowercase())
                .or_insert_with(|| {
                    let mut suggestion = Suggestion::tag(namespace.to_string(), 0, None);
                    suggestion.namespace = true;
                    (rank, suggestion)
                })
                .1
                .count += uses;
        }
        // Typing a bare name also finds it inside namespaces.
        let name = value.rsplit(':').next().unwrap_or("");
        if prefix.is_empty() && !rest.is_empty() && rank(name, rest) == Some(0) {
            let key = value.to_lowercase();
            found.insert(key, (2, Suggestion::tag(value, uses, description)));
        }
    }
    Ok(found)
}

/// Takes the aliases out of the suggestions, and for the aliases that
/// start with what was typed, offers the tags they defer to.
fn suggest_aliases(
    conn: &Connection,
    field: &str,
    typed: &str,
    found: &mut Found,
) -> rusqlite::Result<()> {
    // An alias is never offered as a tag, even while entities still carry it.
    let mut stmt = conn.prepare("SELECT alias FROM tag_alias WHERE field = ?1")?;
    let names = stmt.query_map([field], |row| row.get::<_, String>(0))?;
    for name in names {
        found.remove(&name?.to_lowercase());
    }
    if typed.is_empty() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT a.alias, a.target,
                (SELECT count(*) FROM tag t JOIN entity_tag et ON et.tag_id = t.id
                 WHERE t.field = a.field AND t.value = a.target)
         FROM tag_alias a WHERE a.field = ?1 AND a.alias LIKE ?2 ESCAPE '\\'",
    )?;
    let pattern = &contains_pattern(typed)[1..];
    let rows = stmt.query_map([field, pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?))
    })?;
    for row in rows {
        let (alias, value, count): (String, String, i64) = row?;
        // Keyed apart from the tags, so a tag and an alias of it both show.
        let key = format!("\0{}", alias.to_lowercase());
        let mut suggestion = Suggestion::tag(value, count, None);
        suggestion.alias = Some(alias);
        found.insert(key, (0, suggestion));
    }
    Ok(())
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
    let (prefix, rest) = split_typed(typed);

    let conn = state.db.lock().unwrap();
    let mut found = matching_tags(&conn, &params.field, &prefix, &rest)?;
    suggest_aliases(&conn, &params.field, typed, &mut found)?;

    // Best matches first, then the most used; a tag before an alias of it.
    let mut found: Vec<_> = found.into_values().collect();
    found.sort_by(|(rank_a, a), (rank_b, b)| {
        rank_a
            .cmp(rank_b)
            .then(b.count.cmp(&a.count))
            .then_with(|| a.value.to_lowercase().cmp(&b.value.to_lowercase()))
            .then_with(|| a.alias.cmp(&b.alias))
    });
    found.truncate(MAX_SUGGESTIONS);
    Ok(Json(
        found
            .into_iter()
            .map(|(_, suggestion)| suggestion)
            .collect(),
    ))
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
            // The merged tag keeps its own description, or failing that
            // takes the other's, and stays pinned if either was.
            conn.execute(
                "UPDATE tag SET
                     description = coalesce(description, (SELECT description FROM tag WHERE id = ?1)),
                     pinned = max(pinned, (SELECT pinned FROM tag WHERE id = ?1))
                 WHERE id = ?2",
                [id, target],
            )?;
            conn.execute("DELETE FROM tag WHERE id = ?1", [id])?;
        }
        None => {
            conn.execute(
                "UPDATE tag SET value = ?2 WHERE id = ?1",
                params![id, value],
            )?;
        }
    }
    Ok(())
}

/// Puts a tag on the entities, given as a JSON array of IDs, and with it
/// its child tags, and theirs. Only the entities that did not carry the
/// tag get the children: it is adding the tag that brings them, once, so
/// a child taken off an entity does not come back when the parent is
/// added again over it. That also ends a circle of children.
pub fn add(conn: &Connection, ids: &str, field: &str, value: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT e.id FROM entity e WHERE e.id IN (SELECT value FROM json_each(?1))
         AND NOT EXISTS (
             SELECT 1 FROM entity_tag et JOIN tag t ON t.id = et.tag_id
             WHERE et.entity_id = e.id AND t.field = ?2 AND t.value = ?3)",
    )?;
    let fresh = stmt
        .query_map([ids, field, value], |row| row.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if fresh.is_empty() {
        return Ok(());
    }
    let fresh = entities::ids_json(&fresh);
    entities::attach_tag(conn, &fresh, field, value)?;
    for (child_field, child) in children_of(conn, field, value)? {
        // A child that has since become an alias stands for its tag.
        let child = resolve(conn, &child_field, child)?;
        add(conn, &fresh, &child_field, &child)?;
    }
    Ok(())
}

/// A tag's child tags, as field and value.
fn children_of(
    conn: &Connection,
    field: &str,
    value: &str,
) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT child_field, child FROM tag_child WHERE field = ?1 AND parent = ?2
         ORDER BY child_field, child",
    )?;
    stmt.query_map([field, value], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
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

/// Renames one tag. If a tag of the new name exists the two are merged;
/// aliases of the tag follow it.
fn rename_tag(conn: &Connection, field: &str, from: &str, to: &str) -> Result<(), ApiError> {
    // Only trimmed, so a tag stored before a rule existed can be fixed.
    let from = from.trim();
    let to = normalize(field, to)?;
    for name in [from, &to] {
        let target = resolve(conn, field, name.to_string())?;
        if !target.eq_ignore_ascii_case(name) {
            return Err(ApiError::BadRequest(format!(
                "`{name}` is an alias of `{target}`; remove the alias first"
            )));
        }
    }
    let id = conn
        .query_row(
            "SELECT id FROM tag WHERE field = ?1 AND value = ?2",
            [field, from],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let repointed = conn.execute(
        "UPDATE tag_alias SET target = ?3 WHERE field = ?1 AND target = ?2",
        [field, from, &to],
    )?;
    // Child tags follow the name, as parent and as child. Where the new
    // name already had the link, the old one is dropped, and a tag merged
    // with its own child is not left as a child of itself.
    conn.execute(
        "UPDATE OR IGNORE tag_child SET parent = ?3 WHERE field = ?1 AND parent = ?2",
        [field, from, &to],
    )?;
    conn.execute(
        "UPDATE OR IGNORE tag_child SET child = ?3 WHERE child_field = ?1 AND child = ?2",
        [field, from, &to],
    )?;
    forget_children(conn, field, from)?;
    conn.execute(
        "DELETE FROM tag_child WHERE field = child_field AND parent = child",
        [],
    )?;
    match id {
        Some(id) => Ok(move_tag(conn, field, id, &to)?),
        // A tag nothing carries exists only as the target of aliases.
        None if repointed > 0 => Ok(()),
        None => Err(ApiError::NotFound),
    }
}

/// Renames a tag. Where a tag of the new name already exists the two are
/// merged. Aliases follow the tag they defer to.
async fn rename(
    State(state): State<AppState>,
    Json(input): Json<RenameInput>,
) -> Result<Json<Value>, ApiError> {
    check_field(&input.field)?;
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    rename_tag(&tx, &input.field, &input.from, &input.to)?;
    tx.commit()?;
    Ok(Json(json!({ "renamed": 1 })))
}

/// Every tag of a field with the aliases that defer to it and its child
/// tags, for the tag manager. An alias is listed under its target and as a tag of its own,
/// with `alias_of` naming the target: its count is the entities still
/// carrying it, which `apply_aliases` moves to the target. `pending`
/// totals that over all fields.
async fn list(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>, ApiError> {
    check_field(&params.field)?;
    let conn = state.db.lock().unwrap();

    let mut uses: BTreeMap<String, (String, i64)> = BTreeMap::new();
    let mut descriptions: HashMap<String, String> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT t.value, count(et.entity_id), t.description
         FROM tag t LEFT JOIN entity_tag et ON et.tag_id = t.id
         WHERE t.field = ?1 GROUP BY t.id",
    )?;
    let rows = stmt.query_map([&params.field], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    for row in rows {
        let (value, count, description) = row?;
        if let Some(description) = description {
            descriptions.insert(value.to_lowercase(), description);
        }
        uses.insert(value.to_lowercase(), (value, count));
    }

    let mut stmt =
        conn.prepare("SELECT alias, target FROM tag_alias WHERE field = ?1 ORDER BY alias")?;
    let alias_rows = stmt
        .query_map([&params.field], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut aliases: HashMap<String, Vec<Value>> = HashMap::new();
    let mut alias_of: HashMap<String, String> = HashMap::new();
    for (alias, target) in alias_rows {
        // An alias nothing carries has no tag of its own to be listed by.
        let count = uses
            .entry(alias.to_lowercase())
            .or_insert((alias.clone(), 0))
            .1;
        uses.entry(target.to_lowercase())
            .or_insert((target.clone(), 0));
        aliases
            .entry(target.to_lowercase())
            .or_default()
            .push(json!({ "value": alias, "count": count }));
        alias_of.insert(alias.to_lowercase(), target);
    }

    let mut children: HashMap<String, Vec<Value>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT parent, child_field, child FROM tag_child WHERE field = ?1
         ORDER BY child_field, child",
    )?;
    let child_rows = stmt.query_map([&params.field], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in child_rows {
        let (parent, field, value) = row?;
        children
            .entry(parent.to_lowercase())
            .or_default()
            .push(json!({ "field": field, "value": value }));
    }

    let tags: Vec<Value> = uses
        .into_iter()
        .map(|(key, (value, count))| {
            let aliases = aliases.remove(&key).unwrap_or_default();
            let children = children.remove(&key).unwrap_or_default();
            json!({
                "value": value,
                "count": count,
                "description": descriptions.get(&key),
                "aliases": aliases,
                "alias_of": alias_of.get(&key),
                "children": children,
            })
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

/// The tag row for a value: its ID, and how many entities carry it.
/// Every tag that adding this one brings: its children, theirs, and so on,
/// each once and in the order they are met. For the tagger, to show them
/// before anything is saved.
async fn children(
    State(state): State<AppState>,
    Query(params): Query<TagParams>,
) -> Result<Json<Value>, ApiError> {
    check_field(&params.field)?;
    let conn = state.db.lock().unwrap();
    let root = resolve(&conn, &params.field, normalize(&params.field, &params.value)?)?;
    let key = |field: &str, value: &str| (field.to_string(), value.to_lowercase());
    let mut met = vec![key(&params.field, &root)];
    let mut found: Vec<(String, String)> = Vec::new();
    let mut next = 0;
    let mut parent = (params.field.clone(), root);
    loop {
        for (child_field, child) in children_of(&conn, &parent.0, &parent.1)? {
            let child = resolve(&conn, &child_field, child)?;
            if !met.contains(&key(&child_field, &child)) {
                met.push(key(&child_field, &child));
                found.push((child_field, child));
            }
        }
        // Each tag found is looked into in turn, for children of its own.
        let Some(found) = found.get(next) else { break };
        parent = found.clone();
        next += 1;
    }
    let found: Vec<Value> = found
        .into_iter()
        .map(|(field, value)| json!({ "field": field, "value": value }))
        .collect();
    Ok(Json(json!(found)))
}

/// Drops every link a tag is in, as parent or as child.
fn forget_children(conn: &Connection, field: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM tag_child WHERE (field = ?1 AND parent = ?2)
         OR (child_field = ?1 AND child = ?2)",
        [field, value],
    )?;
    Ok(())
}

/// Gives a tag a child tag, of any field, or with `remove` takes one away.
/// Nothing changes on the entities that carry the tag already: a child is
/// added when its parent is. The parent is kept from now on, as a tag that
/// was created is.
async fn set_child(
    State(state): State<AppState>,
    Json(input): Json<ChildInput>,
) -> Result<Json<Value>, ApiError> {
    check_field(&input.child_field)?;
    let conn = state.db.lock().unwrap();
    // An alias is never added itself, so has no use for children.
    let parent = definable(&conn, &input.field, &input.value)?;
    let child = normalize(&input.child_field, &input.child)?;
    if input.remove {
        let removed = conn.execute(
            "DELETE FROM tag_child
             WHERE field = ?1 AND parent = ?2 AND child_field = ?3 AND child = ?4",
            [&input.field, &parent, &input.child_field, &child],
        )?;
        if removed == 0 {
            return Err(ApiError::NotFound);
        }
    } else {
        let child = resolve(&conn, &input.child_field, child)?;
        if input.field == input.child_field && child.eq_ignore_ascii_case(&parent) {
            return Err(ApiError::BadRequest(format!(
                "`{parent}` cannot be a child of itself"
            )));
        }
        pin(&conn, &input.field, &parent)?;
        conn.execute(
            "INSERT OR IGNORE INTO tag_child (field, parent, child_field, child)
             VALUES (?1, ?2, ?3, ?4)",
            [&input.field, &parent, &input.child_field, &child],
        )?;
    }
    Ok(Json(json!({ "ok": true })))
}

fn find(conn: &Connection, field: &str, value: &str) -> rusqlite::Result<Option<(i64, i64)>> {
    conn.query_row(
        "SELECT t.id, (SELECT count(*) FROM entity_tag et WHERE et.tag_id = t.id)
         FROM tag t WHERE t.field = ?1 AND t.value = ?2",
        [field, value],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

/// The value to pin, checked: well-formed and not an alias.
fn definable(conn: &Connection, field: &str, value: &str) -> Result<String, ApiError> {
    check_field(field)?;
    let value = normalize(field, value)?;
    let target = resolve(conn, field, value.clone())?;
    if !target.eq_ignore_ascii_case(&value) {
        return Err(ApiError::BadRequest(format!(
            "`{value}` is an alias of `{target}`"
        )));
    }
    Ok(value)
}

/// Pins a tag, creating it if need be, and returns its ID.
fn pin(conn: &Connection, field: &str, value: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO tag (field, value, pinned) VALUES (?1, ?2, 1)
         ON CONFLICT (field, value) DO UPDATE SET pinned = 1
         RETURNING id",
        [field, value],
        |row| row.get(0),
    )
}

/// Creates a tag nothing carries yet, so that it can be described, given
/// aliases and offered as a suggestion. A tag that exists is left as it is,
/// only kept from now on when its last use goes.
async fn create(
    State(state): State<AppState>,
    Json(input): Json<TagInput>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let value = definable(&conn, &input.field, &input.value)?;
    let id = pin(&conn, &input.field, &value)?;
    if let Some(description) = input.description.as_deref().map(str::trim)
        && !description.is_empty()
    {
        conn.execute(
            "UPDATE tag SET description = ?2 WHERE id = ?1",
            params![id, description],
        )?;
    }
    Ok(Json(json!({ "value": value })))
}

/// Sets a tag's description; an empty one clears it. Describing a tag also
/// keeps it when nothing carries it. An alias can be described too: it is
/// still a tag, on the entities that carry it and again if it stops being
/// an alias.
async fn describe(
    State(state): State<AppState>,
    Json(input): Json<TagInput>,
) -> Result<Json<Value>, ApiError> {
    check_field(&input.field)?;
    let value = normalize(&input.field, &input.value)?;
    let conn = state.db.lock().unwrap();
    let description = input
        .description
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let id = pin(&conn, &input.field, &value)?;
    conn.execute(
        "UPDATE tag SET description = ?2 WHERE id = ?1",
        params![id, description],
    )?;
    Ok(Json(json!({ "value": value })))
}

/// Deletes a tag nothing carries. One still on entities is refused: it
/// would have to be taken off them first.
async fn delete(
    State(state): State<AppState>,
    Json(input): Json<TagInput>,
) -> Result<Json<Value>, ApiError> {
    check_field(&input.field)?;
    let conn = state.db.lock().unwrap();
    let value = input.value.trim();
    match find(&conn, &input.field, value)? {
        None => Err(ApiError::NotFound),
        Some((_, uses)) if uses > 0 => Err(ApiError::BadRequest(format!(
            "`{value}` is still on {uses} items"
        ))),
        Some((id, _)) => {
            conn.execute("DELETE FROM tag WHERE id = ?1", [id])?;
            forget_children(&conn, &input.field, value)?;
            Ok(Json(json!({ "deleted": true })))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn tags_are_normalized() {
        assert_eq!(normalize("tags", "  cat ").unwrap(), "cat");
        assert_eq!(normalize("tags", "art : line art").unwrap(), "art:line art");
        assert_eq!(normalize("tags", "a:b : c").unwrap(), "a:b:c");
        assert!(normalize("tags", "").is_err());
        assert!(normalize("tags", "  ").is_err());
        assert!(normalize("tags", "art:").is_err());
        assert!(normalize("tags", ":cat").is_err());
        assert!(normalize("tags", "a::b").is_err());
        assert!(normalize("tags", "@cat").is_err());
    }
}
