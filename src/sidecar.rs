//! The metadata of a file or collection as a JSON sidecar, in the format
//! `schema.md` describes: written beside each file of an export, and read
//! back from the sidecars of a zip that is uploaded.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params, types::Value as SqlValue};
use serde_json::{Map, Value, json};

use crate::{
    archive::reason,
    entities::{self, IDENTIFIERS, REFERENCES, SCALARS, SOURCE_URLS},
    error::ApiError,
    query::{COLLECTION_TYPES, TAG_FIELDS},
    tags,
};

/// What a sidecar holds: field to value.
pub type Metadata = Map<String, Value>;

/// The sidecar of an entity. `names` is what the export calls each of its
/// collections, for the entity to say which of them it is in.
pub fn write(
    conn: &Connection,
    id: i64,
    names: &HashMap<i64, String>,
) -> rusqlite::Result<Metadata> {
    let mut meta = conn.query_row(
        &format!(
            "SELECT kind, date_added, {} FROM entity WHERE id = ?1",
            SCALARS.join(", ")
        ),
        [id],
        |row| {
            let mut meta = Map::new();
            meta.insert("metadata_type".into(), json!(row.get::<_, String>(0)?));
            meta.insert("date_added".into(), json!(row.get::<_, String>(1)?));
            for (i, field) in SCALARS.iter().enumerate() {
                meta.insert(field.to_string(), entities::to_json(row.get(2 + i)?));
            }
            Ok(meta)
        },
    )?;
    for (field, values) in entities::tags_of(conn, id)? {
        meta.insert(field, json!(values));
    }
    for list in [SOURCE_URLS, IDENTIFIERS, REFERENCES] {
        meta.insert(list.0.into(), json!(entities::list_of(conn, list, id)?));
    }

    let mut stmt = conn.prepare(
        "SELECT m.collection_id, c.collection_type, m.position
         FROM membership m JOIN collection c ON c.entity_id = m.collection_id
         WHERE m.member_id = ?1 ORDER BY m.collection_id",
    )?;
    let rows = stmt.query_map([id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?;
    let mut inside = Vec::new();
    for row in rows {
        let (collection, collection_type, position): (i64, String, Option<i64>) = row?;
        let Some(name) = names.get(&collection) else {
            continue;
        };
        let mut within = Map::new();
        within.insert("id".into(), json!(name));
        within.insert("collection_type".into(), json!(collection_type));
        if let Some(position) = position {
            within.insert("index".into(), json!(position));
        }
        inside.push(Value::Object(within));
    }
    meta.insert("collection".into(), json!(inside));

    // What it is as a file or as a collection; the counts and flags that
    // are the library's own business stay out.
    let details = [
        entities::file_details(conn, id)?,
        entities::collection_details(conn, id)?,
    ];
    for detail in details.into_iter().flatten() {
        let Value::Object(detail) = detail else { continue };
        for (field, value) in detail {
            if !["has_thumbnail", "member_count"].contains(&field.as_str()) {
                meta.insert(field, value);
            }
        }
    }
    // A field with nothing in it is left out.
    meta.retain(|_, value| !value.is_null() && value.as_array().is_none_or(|list| !list.is_empty()));
    Ok(meta)
}

/// The text values of a field that holds a list of them. One by itself is
/// taken as a list of one.
fn texts<'a>(meta: &'a Metadata, field: &str, problems: &mut Vec<String>) -> Vec<&'a str> {
    let all = |values: &'a Vec<Value>| values.iter().map(Value::as_str).collect::<Option<Vec<_>>>();
    match meta.get(field) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(value)) => vec![value],
        Some(Value::Array(values)) if all(values).is_some() => all(values).unwrap_or_default(),
        Some(_) => {
            problems.push(format!("`{field}` must be a list of text"));
            Vec::new()
        }
    }
}

/// Gives an entity what a sidecar says of it. Tags, source URLs,
/// identifiers and references are added to what it has; a field that
/// holds one value is only filled in where the entity has none. What only
/// the library decides (when it was added, the name of the file) is taken
/// from the sidecar for an entity that is `new`, and left alone otherwise.
/// What the file itself says (its hash, its size, its dimensions) is never
/// read from a sidecar. Each thing in it that could not be used is added
/// to `problems`, and the rest still is.
pub fn apply(
    conn: &Connection,
    id: i64,
    meta: &Metadata,
    new: bool,
    problems: &mut Vec<String>,
) -> rusqlite::Result<()> {
    let scalar = |field: &str, problems: &mut Vec<String>| {
        let value = meta.get(field)?;
        match entities::scalar_value(field, value) {
            Ok(SqlValue::Null) => None,
            Ok(value) => Some(value),
            Err(err) => {
                problems.push(reason(err));
                None
            }
        }
    };
    for field in SCALARS {
        if let Some(value) = scalar(field, problems) {
            conn.execute(
                &format!("UPDATE entity SET {field} = ?2 WHERE id = ?1 AND {field} IS NULL"),
                params![id, value],
            )?;
        }
    }
    if new {
        if let Some(name) = scalar("original_name", problems) {
            conn.execute(
                "UPDATE file SET original_name = ?2 WHERE entity_id = ?1",
                params![id, name],
            )?;
        }
        match meta.get("looping") {
            None | Some(Value::Null) => {}
            Some(Value::Bool(looping)) => {
                conn.execute(
                    "UPDATE file SET looping = ?2 WHERE entity_id = ?1",
                    params![id, looping],
                )?;
            }
            Some(_) => problems.push("`looping` must be true or false".to_string()),
        }
        if let Some(added) = meta.get("date_added").filter(|added| !added.is_null()) {
            // Only as the library writes it: to the second, in UTC.
            let set = match added.as_str() {
                Some(added) => conn.execute(
                    "UPDATE entity SET date_added = ?2
                     WHERE id = ?1 AND strftime('%Y-%m-%dT%H:%M:%SZ', ?2) = ?2",
                    params![id, added],
                )?,
                None => 0,
            };
            if set == 0 {
                problems.push(
                    "`date_added` must be a date and time like 2026-10-03T12:20:37Z".to_string(),
                );
            }
        }
    }

    let ids = entities::ids_json(&[id]);
    for field in TAG_FIELDS {
        for value in texts(meta, field, problems) {
            match tags::normalize(field, value) {
                Ok(value) => {
                    // An alias stands for the tag it defers to.
                    let value = tags::resolve(conn, field, value)?;
                    entities::attach_tag(conn, &ids, field, &value)?;
                }
                Err(err) => problems.push(reason(err)),
            }
        }
    }
    for url in texts(meta, "source_url", problems) {
        match entities::source_url(url) {
            Ok(url) => entities::add_to_list(conn, &ids, SOURCE_URLS, &url)?,
            Err(err) => problems.push(reason(err)),
        }
    }
    for list in [IDENTIFIERS, REFERENCES] {
        for value in texts(meta, list.0, problems) {
            match value.trim() {
                "" => problems.push(format!("empty {}", list.0)),
                value => entities::add_to_list(conn, &ids, list, value)?,
            }
        }
    }
    Ok(())
}

/// A collection type a sidecar gives, if it is one there is.
fn collection_type(value: Option<&Value>, problems: &mut Vec<String>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(given)) if COLLECTION_TYPES.contains(&given.as_str()) => {
            Some(given.clone())
        }
        Some(_) => {
            problems.push(format!(
                "`collection_type` must be one of {}",
                COLLECTION_TYPES.join(", ")
            ));
            None
        }
    }
}

/// A collection an entity is to be put in, as its sidecar asks.
pub struct Wanted {
    pub member: i64,
    /// What the sidecar calls the collection: its collection ID, or the
    /// name of its sidecar in the same archive.
    pub id: String,
    pub collection_type: Option<String>,
    /// Where among the collection's members it comes.
    pub index: Option<i64>,
}

/// The collections a sidecar says its entity is in.
pub fn memberships(meta: &Metadata, member: i64, problems: &mut Vec<String>) -> Vec<Wanted> {
    let listed = match meta.get("collection") {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(listed)) => listed.iter().collect(),
        Some(one) => vec![one],
    };
    let mut wanted = Vec::new();
    for within in listed {
        let id = within.get("id").and_then(Value::as_str).map(str::trim);
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            problems.push("each of `collection` must have an `id`".to_string());
            continue;
        };
        wanted.push(Wanted {
            member,
            id: id.to_string(),
            collection_type: collection_type(within.get("collection_type"), problems),
            index: within.get("index").and_then(Value::as_i64),
        });
    }
    wanted
}

/// What a sidecar says of the collection it is of.
#[derive(Default)]
pub struct Described {
    pub collection_id: Option<String>,
    pub collection_type: Option<String>,
    pub ordered: Option<bool>,
}

pub fn described(meta: &Metadata, problems: &mut Vec<String>) -> Described {
    let collection_id = match meta.get("collection_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.trim().to_string()).filter(|id| !id.is_empty()),
        Some(_) => {
            problems.push("`collection_id` must be text".to_string());
            None
        }
    };
    let ordered = match meta.get("ordered") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(ordered)) => Some(*ordered),
        Some(_) => {
            problems.push("`ordered` must be true or false".to_string());
            None
        }
    };
    Described {
        collection_id,
        collection_type: collection_type(meta.get("collection_type"), problems),
        ordered,
    }
}

/// The collection that has the collection ID, or a new one, made with it
/// (or with none) and without a title. Returns it, and whether it is new.
/// One the library already has keeps its type and order.
pub fn find_or_make(
    conn: &Connection,
    collection_id: Option<&str>,
    collection_type: &str,
    ordered: bool,
) -> Result<(i64, bool), ApiError> {
    if let Some(collection_id) = collection_id {
        let found = conn
            .query_row(
                "SELECT entity_id FROM collection WHERE collection_id = ?1",
                [collection_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(found) = found {
            return Ok((found, false));
        }
    }
    conn.execute("INSERT INTO entity (kind) VALUES ('collection')", [])?;
    let collection = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO collection (entity_id, collection_type, ordered, collection_id)
         VALUES (?1, ?2, ?3, ?4)",
        params![collection, collection_type, ordered, collection_id],
    )?;
    Ok((collection, true))
}
