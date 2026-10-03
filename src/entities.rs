//! Reading and editing the metadata of entities, one or many at a time.

use std::collections::BTreeMap;

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    error::ApiError,
    files::{stored_name, thumbnail_name},
    query::{AI_CONTENT, COLLECTION_TYPES, CONTENT_RATINGS, valid_date},
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
    "ai_content",
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
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/entities/{id}", get(entity))
        .route("/entities/metadata", post(metadata))
        .route("/entities/edit", post(edit))
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

fn ids_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).expect("integers serialize")
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

    let mut tags: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut stmt = conn.prepare(
        "SELECT t.field, t.value FROM entity_tag et JOIN tag t ON t.id = et.tag_id
         WHERE et.entity_id = ?1 ORDER BY t.value",
    )?;
    for row in stmt.query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))? {
        let (field, value): (String, String) = row?;
        tags.entry(field).or_default().push(value);
    }
    result.insert("tags".into(), json!(tags));

    let file = conn
        .query_row(
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
        .optional()?;
    result.insert("file".into(), json!(file));

    let collection = conn
        .query_row(
            "SELECT collection_type,
                    (SELECT count(*) FROM membership WHERE collection_id = ?1)
             FROM collection WHERE entity_id = ?1",
            [id],
            |row| {
                Ok(json!({
                    "collection_type": row.get::<_, String>(0)?,
                    "member_count": row.get::<_, i64>(1)?,
                }))
            },
        )
        .optional()?;
    result.insert("collection".into(), json!(collection));

    Ok(Json(Value::Object(result)))
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

    let columns: Vec<String> = SCALARS
        .iter()
        .map(|field| format!("count(DISTINCT {field}), count({field}), min({field})"))
        .collect();
    let (count, files, scalars) = conn.query_row(
        &format!(
            "SELECT count(*), coalesce(sum(kind = 'file'), 0), {} FROM entity WHERE id {IN_IDS}",
            columns.join(", ")
        ),
        [&ids],
        |row| {
            let count: i64 = row.get(0)?;
            let mut scalars = Map::new();
            for (i, field) in SCALARS.iter().enumerate() {
                let distinct: i64 = row.get(2 + i * 3)?;
                let set: i64 = row.get(3 + i * 3)?;
                // Mixed also covers "set on some, empty on others".
                let mixed = distinct > 1 || (distinct == 1 && set < count);
                let value = if mixed { Value::Null } else { to_json(row.get(4 + i * 3)?) };
                scalars.insert(field.to_string(), json!({ "value": value, "mixed": mixed }));
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
        [&ids],
        |row| {
            let (distinct, set): (i64, i64) = (row.get(0)?, row.get(1)?);
            let mixed = distinct > 1 || (distinct == 1 && set < files);
            let value: Option<String> = row.get(2)?;
            Ok(json!({ "value": if mixed { None } else { value }, "mixed": mixed }))
        },
    )?;
    let mut scalars = scalars;
    scalars.insert("original_name".into(), original_name);

    let collection_type = conn.query_row(
        &format!(
            "SELECT count(DISTINCT collection_type), min(collection_type)
             FROM collection WHERE entity_id {IN_IDS}"
        ),
        [&ids],
        |row| {
            let distinct: i64 = row.get(0)?;
            let value: Option<String> = row.get(1)?;
            Ok(json!({ "value": if distinct > 1 { None } else { value }, "mixed": distinct > 1 }))
        },
    )?;

    let mut tags: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT t.field, t.value, count(*) FROM entity_tag et JOIN tag t ON t.id = et.tag_id
         WHERE et.entity_id {IN_IDS} GROUP BY t.id ORDER BY t.value"
    ))?;
    for row in stmt.query_map([&ids], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))? {
        let (field, value, count): (String, String, i64) = row?;
        tags.entry(field)
            .or_default()
            .push(json!({ "value": value, "count": count }));
    }

    let mut stmt = conn.prepare(&format!(
        "SELECT c.entity_id, e.title, c.collection_type, count(*)
         FROM membership m
         JOIN collection c ON c.entity_id = m.collection_id
         JOIN entity e ON e.id = c.entity_id
         WHERE m.member_id {IN_IDS} GROUP BY c.entity_id ORDER BY e.title, c.entity_id"
    ))?;
    let memberships = stmt
        .query_map([&ids], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "title": row.get::<_, Option<String>>(1)?,
                "collection_type": row.get::<_, String>(2)?,
                "count": row.get::<_, i64>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Json(json!({
        "count": count,
        "files": files,
        "collections": count - files,
        "scalars": scalars,
        "collection_type": collection_type,
        "tags": tags,
        "memberships": memberships,
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
        "ai_content" => choice(AI_CONTENT),
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

/// Deletes tag values no entity carries any more.
fn prune_tags(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM tag WHERE id NOT IN (SELECT tag_id FROM entity_tag)",
        [],
    )?;
    Ok(())
}

/// Applies the same change to every listed entity, all or nothing.
async fn edit(
    State(state): State<AppState>,
    Json(input): Json<EditInput>,
) -> Result<Json<Value>, ApiError> {
    let mut updates = Vec::new();
    for (field, value) in &input.set {
        if field == "collection_type" && value.is_null() {
            return Err(ApiError::bad_request("a collection must have a type"));
        }
        if !SCALARS.contains(&field.as_str())
            && field != "collection_type"
            && field != "original_name"
        {
            return Err(ApiError::BadRequest(format!(
                "`{field}` cannot be set"
            )));
        }
        updates.push((field.as_str(), scalar_value(field, value)?));
    }
    let added = tag_values(&input.add, true)?;
    let removed = tag_values(&input.remove, false)?;
    let ids = ids_json(&input.ids);

    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    for (field, value) in updates {
        let sql = if field == "collection_type" {
            format!("UPDATE collection SET collection_type = ?2 WHERE entity_id {IN_IDS}")
        } else if field == "original_name" {
            format!("UPDATE file SET original_name = ?2 WHERE entity_id {IN_IDS}")
        } else {
            format!("UPDATE entity SET {field} = ?2 WHERE id {IN_IDS}")
        };
        tx.execute(&sql, params![ids, value])?;
    }
    for (field, value) in &added {
        tx.execute(
            "INSERT INTO tag (field, value) VALUES (?1, ?2) ON CONFLICT (field, value) DO NOTHING",
            [field, &value.as_str()],
        )?;
        tx.execute(
            &format!(
                "INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
                 SELECT e.id, t.id FROM entity e, tag t
                 WHERE e.id {IN_IDS} AND t.field = ?2 AND t.value = ?3"
            ),
            params![ids, field, value],
        )?;
    }
    for (field, value) in &removed {
        tx.execute(
            &format!(
                "DELETE FROM entity_tag WHERE entity_id {IN_IDS}
                 AND tag_id IN (SELECT id FROM tag WHERE field = ?2 AND value = ?3)"
            ),
            params![ids, field, value],
        )?;
    }
    if !removed.is_empty() {
        prune_tags(&tx)?;
    }
    let count: i64 = tx.query_row(
        &format!("SELECT count(*) FROM entity WHERE id {IN_IDS}"),
        [&ids],
        |row| row.get(0),
    )?;
    tx.commit()?;
    Ok(Json(json!({ "updated": count })))
}

/// Deletes entities. Files leave internal storage; deleting a collection
/// leaves its members in place.
async fn delete(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    let ids = ids_json(&input.ids);
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let stored = {
        let mut stmt = tx.prepare(&format!(
            "SELECT hash, extension FROM file WHERE entity_id {IN_IDS}"
        ))?;
        stmt.query_map([&ids], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()?
    };
    let deleted = tx.execute(&format!("DELETE FROM entity WHERE id {IN_IDS}"), [&ids])?;
    prune_tags(&tx)?;
    tx.commit()?;

    // Only once the database no longer refers to them.
    for (hash, extension) in stored {
        let _ = std::fs::remove_file(state.storage.join(stored_name(&hash, &extension)));
        let _ = std::fs::remove_file(state.thumbnails.join(thumbnail_name(&hash)));
    }
    Ok(Json(json!({ "deleted": deleted })))
}
