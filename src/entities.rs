//! Reading and editing the metadata of entities, one or many at a time.

use std::collections::BTreeMap;

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use rusqlite::{
    Connection, OptionalExtension, params,
    types::{FromSql, Value as SqlValue},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    error::ApiError,
    files::{stored_name, thumbnail_name},
    query::{COLLECTION_TYPES, CONTENT_RATINGS, valid_date},
    tags,
};

/// Single-valued metadata columns of `entity`.
const SCALARS: &[&str] = &[
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
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/entities/{id}", get(entity))
        .route("/entities/metadata", post(metadata))
        .route("/entities/edit", post(edit))
        .route("/entities/trash", post(trash))
        .route("/entities/restore", post(restore))
        .route("/entities/delete", post(delete))
}

fn to_json(value: SqlValue) -> Value {
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
const IDENTIFIERS: List = ("identifier", "value");
pub const REFERENCES: List = ("reference", "value");

/// An entity's values in a list.
fn list_of(conn: &Connection, list: List, id: i64) -> rusqlite::Result<Vec<String>> {
    let (table, column) = list;
    let mut stmt = conn.prepare(&format!(
        "SELECT {column} FROM {table} WHERE entity_id = ?1 ORDER BY {column}"
    ))?;
    stmt.query_map([id], |row| row.get(0))?.collect()
}

/// An entity's tags, by field.
fn tags_of(conn: &Connection, id: i64) -> rusqlite::Result<BTreeMap<String, Vec<String>>> {
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

/// What is known of an entity as a file, if it is one.
fn file_details(conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        "SELECT hash, extension, media_type, size, original_name, width, height,
                page_count, length, looping, has_thumbnail
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
            }))
        },
    )
    .optional()
}

/// What is known of an entity as a collection, if it is one.
fn collection_details(conn: &Connection, id: i64) -> rusqlite::Result<Option<Value>> {
    conn.query_row(
        "SELECT collection_type,
                (SELECT count(*) FROM membership WHERE collection_id = ?1), ordered,
                collection_id
         FROM collection WHERE entity_id = ?1",
        [id],
        |row| {
            Ok(json!({
                "collection_type": row.get::<_, String>(0)?,
                "member_count": row.get::<_, i64>(1)?,
                "ordered": row.get::<_, bool>(2)?,
                "collection_id": row.get::<_, Option<String>>(3)?,
            }))
        },
    )
    .optional()
}

/// Everything known about one entity.
async fn entity(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let mut result = conn.query_row(
        &format!(
            "SELECT id, kind, date_added, {} FROM entity WHERE id = ?1",
            SCALARS.join(", ")
        ),
        [id],
        |row| {
            let mut entity = Map::new();
            entity.insert("id".into(), json!(row.get::<_, i64>(0)?));
            entity.insert("kind".into(), json!(row.get::<_, String>(1)?));
            entity.insert("date_added".into(), json!(row.get::<_, String>(2)?));
            for (i, field) in SCALARS.iter().enumerate() {
                entity.insert(field.to_string(), to_json(row.get(3 + i)?));
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
    result.insert("file".into(), json!(file_details(&conn, id)?));
    result.insert("collection".into(), json!(collection_details(&conn, id)?));
    Ok(Json(Value::Object(result)))
}

/// What a set of entities has of one field: the value they share, or that
/// they differ.
fn shared(value: Value, mixed: bool) -> Value {
    json!({ "value": if mixed { Value::Null } else { value }, "mixed": mixed })
}

/// How many entities there are, how many of them files, and what they share
/// of each scalar field.
fn shared_scalars(
    conn: &Connection,
    ids: &str,
) -> rusqlite::Result<(i64, i64, Map<String, Value>)> {
    let columns: Vec<String> = SCALARS
        .iter()
        .map(|field| format!("count(DISTINCT {field}), count({field}), min({field})"))
        .collect();
    let (count, files, mut scalars) = conn.query_row(
        &format!(
            "SELECT count(*), coalesce(sum(kind = 'file'), 0), {} FROM entity WHERE id {IN_IDS}",
            columns.join(", ")
        ),
        [ids],
        |row| {
            let count: i64 = row.get(0)?;
            let mut scalars = Map::new();
            for (i, field) in SCALARS.iter().enumerate() {
                let distinct: i64 = row.get(2 + i * 3)?;
                let set: i64 = row.get(3 + i * 3)?;
                // Mixed also covers "set on some, empty on others".
                let mixed = distinct > 1 || (distinct == 1 && set < count);
                scalars.insert(
                    field.to_string(),
                    shared(to_json(row.get(4 + i * 3)?), mixed),
                );
            }
            Ok((count, row.get::<_, i64>(1)?, scalars))
        },
    )?;

    // Lives on `file`, but is edited like the other scalars.
    let original_name = conn.query_row(
        &format!(
            "SELECT count(DISTINCT original_name), count(original_name), min(original_name)
             FROM file WHERE entity_id {IN_IDS}"
        ),
        [ids],
        |row| {
            let (distinct, set): (i64, i64) = (row.get(0)?, row.get(1)?);
            let mixed = distinct > 1 || (distinct == 1 && set < files);
            Ok(shared(to_json(row.get(2)?), mixed))
        },
    )?;
    scalars.insert("original_name".into(), original_name);
    Ok((count, files, scalars))
}

/// What the collections among the entities share of a column of theirs.
fn shared_of_collections<T: FromSql + Serialize>(
    conn: &Connection,
    ids: &str,
    column: &str,
) -> rusqlite::Result<Value> {
    conn.query_row(
        &format!(
            "SELECT count(DISTINCT {column}), min({column})
             FROM collection WHERE entity_id {IN_IDS}"
        ),
        [ids],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<T>>(1)?)),
    )
    .map(|(distinct, value)| shared(json!(value), distinct > 1))
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

/// The collections any of the entities are in, and how many are in each.
fn memberships(conn: &Connection, ids: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT c.entity_id, e.title, c.collection_type, count(*), c.collection_id
         FROM membership m
         JOIN collection c ON c.entity_id = m.collection_id
         JOIN entity e ON e.id = c.entity_id
         WHERE m.member_id {IN_IDS} GROUP BY c.entity_id ORDER BY e.title, c.entity_id"
    ))?;
    stmt.query_map([ids], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "title": row.get::<_, Option<String>>(1)?,
            "collection_type": row.get::<_, String>(2)?,
            "count": row.get::<_, i64>(3)?,
            "collection_id": row.get::<_, Option<String>>(4)?,
        }))
    })?
    .collect()
}

/// The metadata a set of entities has in common, for editing them together.
/// Scalars report their shared value or that they are mixed; tags and
/// collections report how many of the entities carry each.
async fn metadata(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let ids = ids_json(&input.ids);
    let (count, files, scalars) = shared_scalars(&conn, &ids)?;
    let trashed: i64 = conn.query_row(
        &format!("SELECT count(*) FROM entity WHERE trashed = 1 AND id {IN_IDS}"),
        [&ids],
        |row| row.get(0),
    )?;
    Ok(Json(json!({
        "count": count,
        "files": files,
        "collections": count - files,
        "trashed": trashed,
        "scalars": scalars,
        "collection_type": shared_of_collections::<String>(&conn, &ids, "collection_type")?,
        "ordered": shared_of_collections::<bool>(&conn, &ids, "ordered")?,
        "collection_id": shared_of_collections::<String>(&conn, &ids, "collection_id")?,
        "tags": counted_tags(&conn, &ids)?,
        "source_url": counted(&conn, &ids, SOURCE_URLS)?,
        "identifier": counted(&conn, &ids, IDENTIFIERS)?,
        "reference": counted(&conn, &ids, REFERENCES)?,
        "memberships": memberships(&conn, &ids)?,
    })))
}

/// Checks a new scalar value and converts it for storage. Empty strings and
/// `null` both clear the field.
fn scalar_value(field: &str, value: &Value) -> Result<SqlValue, ApiError> {
    let invalid = |expected: &str| {
        Err(ApiError::BadRequest(format!(
            "`{field}` must be {expected}"
        )))
    };
    if field == "ordered" {
        return match value {
            Value::Bool(ordered) => Ok(SqlValue::Integer(*ordered as i64)),
            _ => invalid("true or false"),
        };
    }
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
        "collection_type" => match text {
            Some(text) if COLLECTION_TYPES.contains(&text) => Ok(SqlValue::Text(text.to_string())),
            _ => invalid(&format!("one of {}", COLLECTION_TYPES.join(", "))),
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
        "collection_type" | "ordered" | "collection_id" => Some(("collection", "entity_id")),
        "original_name" => Some(("file", "entity_id")),
        field if SCALARS.contains(&field) => Some(("entity", "id")),
        _ => None,
    }
}

/// Checks that a collection ID can be given to the collections among `ids`:
/// it is one collection's alone, so there can be only one of them, and no
/// other collection may have it.
pub fn claim_collection_id(conn: &Connection, ids: &[i64], wanted: &str) -> Result<(), ApiError> {
    let json = ids_json(ids);
    let collections: i64 = conn.query_row(
        &format!("SELECT count(*) FROM collection WHERE entity_id {IN_IDS}"),
        [&json],
        |row| row.get(0),
    )?;
    if collections > 1 {
        return Err(ApiError::bad_request(
            "a collection ID is one collection's alone: it cannot be given to several",
        ));
    }
    let taken: bool = conn.query_row(
        &format!(
            "SELECT EXISTS (SELECT 1 FROM collection
                            WHERE collection_id = ?2 AND entity_id NOT {IN_IDS})"
        ),
        params![json, wanted],
        |row| row.get(0),
    )?;
    if taken {
        return Err(ApiError::BadRequest(format!(
            "another collection already has the ID `{wanted}`"
        )));
    }
    Ok(())
}

/// Gives positions to the members of ordered collections that have none,
/// after any that already have one: for collections that have just become
/// ordered.
fn number_members(conn: &Connection, ids: &str) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "WITH numbered AS (
                 SELECT m.collection_id, m.member_id,
                        (SELECT coalesce(max(position), -1) FROM membership x
                         WHERE x.collection_id = m.collection_id)
                        + row_number() OVER (
                            PARTITION BY m.collection_id ORDER BY m.member_id
                        ) AS position
                 FROM membership m JOIN collection c ON c.entity_id = m.collection_id
                 WHERE m.position IS NULL AND c.ordered = 1 AND m.collection_id {IN_IDS}
             )
             UPDATE membership SET position = (
                 SELECT n.position FROM numbered n
                 WHERE n.collection_id = membership.collection_id
                   AND n.member_id = membership.member_id
             )
             WHERE (collection_id, member_id) IN (
                 SELECT collection_id, member_id FROM numbered
             )"
        ),
        [ids],
    )?;
    Ok(())
}

/// Puts a tag on the entities, creating it if it is new.
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
        if field == "collection_type" && value.is_null() {
            return Err(ApiError::bad_request("a collection must have a type"));
        }
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
    let ids = ids_json(&input.ids);

    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    for (field, _, value) in &updates {
        if let ("collection_id", SqlValue::Text(wanted)) = (*field, value) {
            claim_collection_id(&tx, &input.ids, wanted)?;
        }
    }
    for (field, (table, key), value) in updates {
        tx.execute(
            &format!("UPDATE {table} SET {field} = ?2 WHERE {key} {IN_IDS}"),
            params![ids, value],
        )?;
        if field == "ordered" {
            number_members(&tx, &ids)?;
        }
    }
    for (field, value) in added {
        // Adding an alias adds the tag it defers to.
        let value = tags::resolve(&tx, field, value)?;
        attach_tag(&tx, &ids, field, &value)?;
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

/// The second step: deletes for good those of the entities that are in the
/// trash. Any that are not are left alone. Files leave internal storage;
/// deleting a collection leaves its members in place.
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
