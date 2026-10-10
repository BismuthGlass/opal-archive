//! Reading and editing the metadata of entities, one or many at a time.

use std::collections::BTreeMap;

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use rusqlite::{
    Connection, OptionalExtension, params,
    types::Value as SqlValue,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    error::ApiError,
    files::{stored_name, thumbnail_name},
    query::{CONTENT_RATINGS, valid_date},
    sets, tags,
};

/// Single-valued metadata columns of `entity`.
pub const SCALARS: &[&str] = &[
    "title",
    "date",
    "score",
    "version",
    "content_rating",
    "description",
    "ai_description",
];

/// Restricts a statement to the IDs in a JSON array parameter.
const IN_IDS: &str = "IN (SELECT value FROM json_each(?1))";

#[derive(Deserialize)]
struct Ids {
    ids: Vec<i64>,
}

#[derive(Deserialize)]
struct EditInput {
    ids: Vec<i64>,
    /// Scalar field to new value; `null` or an empty string clears it.
    #[serde(default)]
    set: Map<String, Value>,
    /// Tag field to values to attach.
    #[serde(default)]
    add: BTreeMap<String, Vec<String>>,
    /// Tag field to values to detach.
    #[serde(default)]
    remove: BTreeMap<String, Vec<String>>,
    /// Source URLs to attach.
    #[serde(default)]
    add_source_url: Vec<String>,
    /// Source URLs to detach.
    #[serde(default)]
    remove_source_url: Vec<String>,
    /// Identifiers to attach.
    #[serde(default)]
    add_identifier: Vec<String>,
    /// Identifiers to detach.
    #[serde(default)]
    remove_identifier: Vec<String>,
    /// References to attach.
    #[serde(default)]
    add_reference: Vec<String>,
    /// References to detach.
    #[serde(default)]
    remove_reference: Vec<String>,
    /// Collections to attach: what the entities are part of where they
    /// came from.
    #[serde(default)]
    add_collection: Vec<String>,
    /// Collections to detach.
    #[serde(default)]
    remove_collection: Vec<String>,
    /// Sets to put the entities in, by set ID, after what each holds.
    #[serde(default)]
    add_set: Vec<String>,
    /// Sets to take them out of.
    #[serde(default)]
    remove_set: Vec<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/entities/{id}", get(entity))
        .route("/entities/metadata", post(metadata))
        .route("/entities/edit", post(edit))
        .route("/entities/trash", post(trash))
        .route("/entities/restore", post(restore))
        .route("/entities/archive", post(archive))
        .route("/entities/unarchive", post(unarchive))
        .route("/entities/delete", post(delete))
}

pub fn to_json(value: SqlValue) -> Value {
    match value {
        SqlValue::Integer(n) => json!(n),
        SqlValue::Real(n) => json!(n),
        SqlValue::Text(text) => json!(text),
        SqlValue::Null | SqlValue::Blob(_) => Value::Null,
    }
}

pub fn ids_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).expect("integers serialize")
}

/// A table of plain values per entity, and the column the value is in.
pub type List = (&'static str, &'static str);
pub const SOURCE_URLS: List = ("source_url", "url");
pub const IDENTIFIERS: List = ("identifier", "value");
pub const REFERENCES: List = ("reference", "value");
pub const COLLECTIONS: List = ("collection", "value");

/// An entity's values in a list.
pub fn list_of(conn: &Connection, list: List, id: i64) -> rusqlite::Result<Vec<String>> {
    let (table, column) = list;
    let mut stmt = conn.prepare(&format!(
        "SELECT {column} FROM {table} WHERE entity_id = ?1 ORDER BY {column}"
    ))?;
    stmt.query_map([id], |row| row.get(0))?.collect()
}

/// An entity's tags, by field.
pub fn tags_of(conn: &Connection, id: i64) -> rusqlite::Result<BTreeMap<String, Vec<String>>> {
    let mut tags: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT t.field, t.value FROM entity_tag et JOIN tag t ON t.id = et.tag_id
         WHERE et.entity_id = ?1 ORDER BY t.value",
    )?;
    for row in stmt.query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))? {
        let (field, value): (String, String) = row?;
        tags.entry(field).or_default().push(value);
    }
    Ok(tags)
}

/// What is known of an entity as a file.
pub fn file_details(conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        "SELECT hash, extension, media_type, size, original_name, width, height,
                page_count, length, looping, has_thumbnail, alt_group_id
         FROM file WHERE entity_id = ?1",
        [id],
        |row| {
            Ok(json!({
                "hash": row.get::<_, String>(0)?,
                "extension": row.get::<_, String>(1)?,
                "media_type": row.get::<_, String>(2)?,
                "size": row.get::<_, i64>(3)?,
                "original_name": row.get::<_, Option<String>>(4)?,
                "width": row.get::<_, Option<i64>>(5)?,
                "height": row.get::<_, Option<i64>>(6)?,
                "page_count": row.get::<_, Option<i64>>(7)?,
                "length": row.get::<_, Option<f64>>(8)?,
                "looping": row.get::<_, Option<bool>>(9)?,
                "has_thumbnail": row.get::<_, bool>(10)?,
                "alt_group_id": row.get::<_, Option<String>>(11)?,
            }))
        },
    )
    .optional()
}

/// The sets a file is in, and where in each.
pub fn sets_of_file(conn: &Connection, id: i64) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT f.set_id, i.title, f.set_index
         FROM set_file f LEFT JOIN set_info i USING (set_id)
         WHERE f.file_id = ?1 ORDER BY f.set_id",
    )?;
    stmt.query_map([id], |row| {
        Ok(json!({
            "set_id": row.get::<_, String>(0)?,
            "title": row.get::<_, Option<String>>(1)?,
            "index": row.get::<_, Option<i64>>(2)?,
        }))
    })?
    .collect()
}

/// Everything known about one entity.
async fn entity(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let mut result = conn.query_row(
        &format!(
            "SELECT id, date_added, {} FROM entity WHERE id = ?1",
            SCALARS.join(", ")
        ),
        [id],
        |row| {
            let mut entity = Map::new();
            entity.insert("id".into(), json!(row.get::<_, i64>(0)?));
            entity.insert("date_added".into(), json!(row.get::<_, String>(1)?));
            for (i, field) in SCALARS.iter().enumerate() {
                entity.insert(field.to_string(), to_json(row.get(2 + i)?));
            }
            Ok(entity)
        },
    )?;
    result.insert("tags".into(), json!(tags_of(&conn, id)?));
    result.insert(
        "source_url".into(),
        json!(list_of(&conn, SOURCE_URLS, id)?),
    );
    result.insert(
        "identifier".into(),
        json!(list_of(&conn, IDENTIFIERS, id)?),
    );
    result.insert("reference".into(), json!(list_of(&conn, REFERENCES, id)?));
    result.insert("collection".into(), json!(list_of(&conn, COLLECTIONS, id)?));
    result.insert("file".into(), json!(file_details(&conn, id)?));
    result.insert("set".into(), json!(sets_of_file(&conn, id)?));
    Ok(Json(Value::Object(result)))
}

/// What a set of entities has of one field: the value they share, or that
/// they differ.
fn shared(value: Value, mixed: bool) -> Value {
    json!({ "value": if mixed { Value::Null } else { value }, "mixed": mixed })
}

/// Single-valued metadata columns of `file`, edited like the others.
const FILE_SCALARS: &[&str] = &["original_name", "alt_group_id"];

/// How many entities there are, and what they share of each scalar field.
fn shared_scalars(conn: &Connection, ids: &str) -> rusqlite::Result<(i64, Map<String, Value>)> {
    let mut scalars = Map::new();
    let mut count = 0;
    for (table, key, fields) in [("entity", "id", SCALARS), ("file", "entity_id", FILE_SCALARS)] {
        let columns: Vec<String> = fields
            .iter()
            .map(|field| format!("count(DISTINCT {field}), count({field}), min({field})"))
            .collect();
        conn.query_row(
            &format!(
                "SELECT count(*), {} FROM {table} WHERE {key} {IN_IDS}",
                columns.join(", ")
            ),
            [ids],
            |row| {
                count = row.get(0)?;
                for (i, field) in fields.iter().enumerate() {
                    let distinct: i64 = row.get(1 + i * 3)?;
                    let set: i64 = row.get(2 + i * 3)?;
                    // Mixed also covers "set on some, empty on others".
                    let mixed = distinct > 1 || (distinct == 1 && set < count);
                    scalars.insert(
                        field.to_string(),
                        shared(to_json(row.get(3 + i * 3)?), mixed),
                    );
                }
                Ok(())
            },
        )?;
    }
    Ok((count, scalars))
}

/// Each value the entities have in a list table, and how many have it.
fn counted(conn: &Connection, ids: &str, list: List) -> rusqlite::Result<Vec<Value>> {
    let (table, column) = list;
    let mut stmt = conn.prepare(&format!(
        "SELECT {column}, count(*) FROM {table} WHERE entity_id {IN_IDS}
         GROUP BY {column} ORDER BY {column}"
    ))?;
    stmt.query_map([ids], |row| {
        Ok(json!({ "value": row.get::<_, String>(0)?, "count": row.get::<_, i64>(1)? }))
    })?
    .collect()
}

/// Each tag the entities carry, by field, and how many carry it.
fn counted_tags(conn: &Connection, ids: &str) -> rusqlite::Result<BTreeMap<String, Vec<Value>>> {
    let mut tags: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT t.field, t.value, count(*), t.description
         FROM entity_tag et JOIN tag t ON t.id = et.tag_id
         WHERE et.entity_id {IN_IDS} GROUP BY t.id ORDER BY t.value"
    ))?;
    let rows = stmt.query_map([ids], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?;
    for row in rows {
        let (field, value, count, description): (String, String, i64, Option<String>) = row?;
        tags.entry(field)
            .or_default()
            .push(json!({ "value": value, "count": count, "description": description }));
    }
    Ok(tags)
}

/// The sets any of the entities are in, and how many are in each.
fn sets_of(conn: &Connection, ids: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT f.set_id, i.title, count(*)
         FROM set_file f LEFT JOIN set_info i USING (set_id)
         WHERE f.file_id {IN_IDS} GROUP BY f.set_id ORDER BY f.set_id"
    ))?;
    stmt.query_map([ids], |row| {
        Ok(json!({
            "set_id": row.get::<_, String>(0)?,
            "title": row.get::<_, Option<String>>(1)?,
            "count": row.get::<_, i64>(2)?,
        }))
    })?
    .collect()
}

/// The metadata a set of entities has in common, for editing them together.
/// Scalars report their shared value or that they are mixed; tags and
/// sets report how many of the entities carry each.
async fn metadata(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let ids = ids_json(&input.ids);
    let (count, scalars) = shared_scalars(&conn, &ids)?;
    let trashed: i64 = conn.query_row(
        &format!("SELECT count(*) FROM entity WHERE trashed = 1 AND id {IN_IDS}"),
        [&ids],
        |row| row.get(0),
    )?;
    let inbox: i64 = conn.query_row(
        &format!("SELECT count(*) FROM entity WHERE inbox = 1 AND id {IN_IDS}"),
        [&ids],
        |row| row.get(0),
    )?;
    Ok(Json(json!({
        "count": count,
        "trashed": trashed,
        "inbox": inbox,
        "scalars": scalars,
        "tags": counted_tags(&conn, &ids)?,
        "source_url": counted(&conn, &ids, SOURCE_URLS)?,
        "identifier": counted(&conn, &ids, IDENTIFIERS)?,
        "reference": counted(&conn, &ids, REFERENCES)?,
        "collection": counted(&conn, &ids, COLLECTIONS)?,
        "set": sets_of(&conn, &ids)?,
    })))
}

/// Checks a new scalar value and converts it for storage. Empty strings and
/// `null` both clear the field.
pub fn scalar_value(field: &str, value: &Value) -> Result<SqlValue, ApiError> {
    let invalid = |expected: &str| {
        Err(ApiError::BadRequest(format!(
            "`{field}` must be {expected}"
        )))
    };
    let text = match value {
        Value::Null => return Ok(SqlValue::Null),
        Value::String(text) if text.trim().is_empty() => return Ok(SqlValue::Null),
        Value::String(text) => Some(text.trim()),
        _ => None,
    };
    let choice = |choices: &[&str]| match text {
        Some(text) if choices.contains(&text) => Ok(SqlValue::Text(text.to_string())),
        _ => invalid(&format!("one of {}", choices.join(", "))),
    };
    match field {
        "score" => match value.as_i64() {
            Some(score @ 1..=7) => Ok(SqlValue::Integer(score)),
            _ => invalid("a whole number from 1 to 7"),
        },
        "date" => match text {
            Some(text) if valid_date(text) => Ok(SqlValue::Text(text.to_string())),
            _ => invalid("YYYY, YYYY-MM or YYYY-MM-DD"),
        },
        "content_rating" => choice(CONTENT_RATINGS),
        "original_name" => match text {
            Some(text) if !text.contains(['/', '\\']) => Ok(SqlValue::Text(text.to_string())),
            _ => invalid("a filename without a path"),
        },
        _ => match text {
            Some(text) => Ok(SqlValue::Text(text.to_string())),
            None => invalid("text"),
        },
    }
}

/// Checks tag input: a known field and well-formed values. Values to
/// remove are only trimmed, so a tag stored before a rule existed can still
/// be taken off.
fn tag_values(
    changes: &BTreeMap<String, Vec<String>>,
    adding: bool,
) -> Result<Vec<(&str, String)>, ApiError> {
    let mut pairs = Vec::new();
    for (field, values) in changes {
        tags::check_field(field)?;
        for value in values {
            let value = if adding {
                tags::normalize(field, value)?
            } else {
                value.trim().to_string()
            };
            pairs.push((field.as_str(), value));
        }
    }
    Ok(pairs)
}

/// A source URL as it is stored. It has to be a web address, since it is
/// shown as a link; one typed without a scheme gets `https://`.
pub fn source_url(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    // `host:8080/path` has a port; `javascript:…` or `mailto:…` has a scheme
    // that is not a web one, and is refused below for lacking `http`.
    let host = value.split('/').next().unwrap_or("");
    let other_scheme = host
        .split_once(':')
        .is_some_and(|(_, after)| !after.starts_with(|c: char| c.is_ascii_digit()));
    let url = if value.contains("://") || other_scheme {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let rest = ["http://", "https://"].iter().find_map(|scheme| {
        url.get(..scheme.len())
            .filter(|start| start.eq_ignore_ascii_case(scheme))
            .map(|_| &url[scheme.len()..])
    });
    match rest {
        Some(rest) if !rest.is_empty() && !url.contains(char::is_whitespace) => Ok(url),
        _ => Err(ApiError::BadRequest(format!(
            "`{value}` is not a web address (http or https)"
        ))),
    }
}

/// Deletes tag values no entity carries any more, except the pinned ones:
/// those created or described by hand.
fn prune_tags(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM tag WHERE pinned = 0 AND id NOT IN (SELECT tag_id FROM entity_tag)",
        [],
    )?;
    Ok(())
}

/// The table a field that can be set lives on, and that table's ID column.
fn home(field: &str) -> Option<(&'static str, &'static str)> {
    match field {
        field if FILE_SCALARS.contains(&field) => Some(("file", "entity_id")),
        field if SCALARS.contains(&field) => Some(("entity", "id")),
        _ => None,
    }
}

/// Puts a tag on the entities, creating it if it is new. Only that tag:
/// `tags::add` also brings its child tags.
pub fn attach_tag(conn: &Connection, ids: &str, field: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tag (field, value) VALUES (?1, ?2) ON CONFLICT (field, value) DO NOTHING",
        [field, value],
    )?;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
             SELECT e.id, t.id FROM entity e, tag t
             WHERE e.id {IN_IDS} AND t.field = ?2 AND t.value = ?3"
        ),
        params![ids, field, value],
    )?;
    Ok(())
}

fn detach_tag(conn: &Connection, ids: &str, field: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "DELETE FROM entity_tag WHERE entity_id {IN_IDS}
             AND tag_id IN (SELECT id FROM tag WHERE field = ?2 AND value = ?3)"
        ),
        params![ids, field, value],
    )?;
    Ok(())
}

pub fn add_to_list(conn: &Connection, ids: &str, list: List, value: &str) -> rusqlite::Result<()> {
    let (table, column) = list;
    conn.execute(
        &format!(
            "INSERT OR IGNORE INTO {table} (entity_id, {column})
             SELECT id, ?2 FROM entity WHERE id {IN_IDS}"
        ),
        params![ids, value],
    )?;
    Ok(())
}

fn remove_from_list(conn: &Connection, ids: &str, list: List, value: &str) -> rusqlite::Result<()> {
    let (table, column) = list;
    conn.execute(
        &format!("DELETE FROM {table} WHERE entity_id {IN_IDS} AND {column} = ?2"),
        params![ids, value],
    )?;
    Ok(())
}

/// The values to add to a plain list, as they are stored. `what` names one
/// of them, for refusing an empty one.
fn plain_values<'a>(values: &'a [String], what: &str) -> Result<Vec<&'a str>, ApiError> {
    values
        .iter()
        .map(|value| match value.trim() {
            "" => Err(ApiError::BadRequest(format!("empty {what}"))),
            value => Ok(value),
        })
        .collect()
}

/// Applies the same change to every listed entity, all or nothing.
async fn edit(
    State(state): State<AppState>,
    Json(input): Json<EditInput>,
) -> Result<Json<Value>, ApiError> {
    // Everything is checked before anything is changed.
    let mut updates = Vec::new();
    for (field, value) in &input.set {
        let Some(home) = home(field) else {
            return Err(ApiError::BadRequest(format!("`{field}` cannot be set")));
        };
        updates.push((field.as_str(), home, scalar_value(field, value)?));
    }
    let added = tag_values(&input.add, true)?;
    let removed = tag_values(&input.remove, false)?;
    let added_urls = input
        .add_source_url
        .iter()
        .map(|url| source_url(url))
        .collect::<Result<Vec<_>, _>>()?;
    let added_identifiers = plain_values(&input.add_identifier, "identifier")?;
    let added_references = plain_values(&input.add_reference, "reference")?;
    let added_collections = plain_values(&input.add_collection, "collection")?;
    let added_sets = plain_values(&input.add_set, "set")?;
    let ids = ids_json(&input.ids);

    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    for (field, (table, key), value) in updates {
        tx.execute(
            &format!("UPDATE {table} SET {field} = ?2 WHERE {key} {IN_IDS}"),
            params![ids, value],
        )?;
    }
    for (field, value) in added {
        // Adding an alias adds the tag it defers to.
        let value = tags::resolve(&tx, field, value)?;
        tags::add(&tx, &ids, field, &value)?;
    }
    for (field, value) in &removed {
        detach_tag(&tx, &ids, field, value)?;
    }
    if !removed.is_empty() {
        prune_tags(&tx)?;
    }
    for url in &added_urls {
        add_to_list(&tx, &ids, SOURCE_URLS, url)?;
    }
    // Removed as written, so one stored before the rules can be taken off.
    for url in &input.remove_source_url {
        remove_from_list(&tx, &ids, SOURCE_URLS, url.trim())?;
    }
    for value in &added_identifiers {
        add_to_list(&tx, &ids, IDENTIFIERS, value)?;
    }
    for value in &input.remove_identifier {
        remove_from_list(&tx, &ids, IDENTIFIERS, value.trim())?;
    }
    for value in &added_references {
        add_to_list(&tx, &ids, REFERENCES, value)?;
    }
    for value in &input.remove_reference {
        remove_from_list(&tx, &ids, REFERENCES, value.trim())?;
    }
    for value in &added_collections {
        add_to_list(&tx, &ids, COLLECTIONS, value)?;
    }
    for value in &input.remove_collection {
        remove_from_list(&tx, &ids, COLLECTIONS, value.trim())?;
    }
    for set in &added_sets {
        sets::add_files(&tx, set, &input.ids, false)?;
    }
    for set in &input.remove_set {
        tx.execute(
            &format!("DELETE FROM set_file WHERE set_id = ?2 AND file_id {IN_IDS}"),
            params![ids, set.trim()],
        )?;
    }
    let count: i64 = tx.query_row(
        &format!("SELECT count(*) FROM entity WHERE id {IN_IDS}"),
        [&ids],
        |row| row.get(0),
    )?;
    tx.commit()?;
    Ok(Json(json!({ "updated": count })))
}

/// Moves entities to the trash, or back out of it.
fn set_trashed(state: &AppState, ids: &[i64], trashed: bool) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let changed = conn.execute(
        &format!("UPDATE entity SET trashed = ?2 WHERE trashed <> ?2 AND id {IN_IDS}"),
        params![ids_json(ids), trashed],
    )?;
    Ok(Json(json!({ "changed": changed })))
}

/// The first step of deleting: trashed entities drop out of searches but
/// keep their file and metadata.
async fn trash(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    set_trashed(&state, &input.ids, true)
}

async fn restore(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    set_trashed(&state, &input.ids, false)
}

/// Takes entities out of the inbox, or puts them back in it.
fn set_inbox(state: &AppState, ids: &[i64], inbox: bool) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let changed = conn.execute(
        &format!("UPDATE entity SET inbox = ?2 WHERE inbox <> ?2 AND id {IN_IDS}"),
        params![ids_json(ids), inbox],
    )?;
    Ok(Json(json!({ "changed": changed })))
}

/// Archives entities: they have been looked over, and leave the inbox they
/// arrived in. Nothing else about them changes.
async fn archive(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    set_inbox(&state, &input.ids, false)
}

async fn unarchive(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    set_inbox(&state, &input.ids, true)
}

/// The second step: deletes for good those of the entities that are in the
/// trash. Any that are not are left alone. Files leave internal storage,
/// and a set left with no files goes with them.
async fn delete(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    let ids = ids_json(&input.ids);
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let stored = {
        let mut stmt = tx.prepare(&format!(
            "SELECT f.hash, f.extension FROM file f JOIN entity e ON e.id = f.entity_id
             WHERE e.trashed = 1 AND f.entity_id {IN_IDS}"
        ))?;
        stmt.query_map([&ids], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()?
    };
    let deleted = tx.execute(
        &format!("DELETE FROM entity WHERE trashed = 1 AND id {IN_IDS}"),
        [&ids],
    )?;
    prune_tags(&tx)?;
    sets::prune(&tx)?;
    tx.commit()?;

    // Only once the database no longer refers to them.
    for (hash, extension) in stored {
        let _ = std::fs::remove_file(state.storage.join(stored_name(&hash, &extension)));
        let _ = std::fs::remove_file(state.thumbnails.join(thumbnail_name(&hash)));
    }
    Ok(Json(json!({ "deleted": deleted })))
}

#[cfg(test)]
mod tests {
    use super::source_url;

    #[test]
    fn source_urls_are_web_addresses() {
        assert_eq!(
            source_url(" https://example.com/a ").unwrap(),
            "https://example.com/a"
        );
        assert_eq!(
            source_url("HTTP://example.com").unwrap(),
            "HTTP://example.com"
        );
        assert_eq!(
            source_url("example.com/a").unwrap(),
            "https://example.com/a"
        );
        assert_eq!(
            source_url("localhost:8080/x").unwrap(),
            "https://localhost:8080/x"
        );
        assert!(source_url("javascript:alert(1)").is_err());
        assert!(source_url("mailto:someone@example.com").is_err());
        assert!(source_url("ftp://example.com").is_err());
        assert!(source_url("https://").is_err());
        assert!(source_url("two words.com").is_err());
    }
}
