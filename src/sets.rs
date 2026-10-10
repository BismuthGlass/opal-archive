//! Sets: files that belong together, in an order. A file can be in several:
//! which, and where in each, is kept in `set_file`. A set is not an
//! entity: it has no tags and is not searched for, only opened from one of
//! its files. It has a set ID that tells it from every other, a title, a
//! description, and the lists that say where it came from.
//!
//! Variants are looser still: files with the same `alt_group_id`.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post, put},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{
    AppState,
    entities::{self, ids_json},
    error::ApiError,
    query::contains_pattern,
};

/// A table of plain values per set, and the column the value is in.
pub type List = (&'static str, &'static str);
pub const SOURCE_URLS: List = ("set_source_url", "url");
pub const IDENTIFIERS: List = ("set_identifier", "value");
pub const REFERENCES: List = ("set_reference", "value");
pub const COLLECTIONS: List = ("set_collection", "value");

#[derive(Deserialize)]
struct NewSet {
    /// What tells it from every other set; one is made up if not given.
    set_id: Option<String>,
    title: Option<String>,
    /// The files to put in it, in order.
    #[serde(default)]
    files: Vec<i64>,
}

#[derive(Deserialize)]
struct ListParams {
    /// Text the title or the set ID has to contain.
    #[serde(default)]
    q: String,
}

/// Most sets listed at once.
const MOST_LISTED: i64 = 200;

#[derive(Deserialize)]
struct FileChanges {
    #[serde(default)]
    add: Vec<i64>,
    #[serde(default)]
    remove: Vec<i64>,
}

#[derive(Deserialize)]
struct Ids {
    ids: Vec<i64>,
}

/// A change to a set, written as an edit of entities is.
#[derive(Deserialize)]
struct SetChanges {
    /// `set_id`, `title` or `description` to its new value.
    #[serde(default)]
    set: Map<String, Value>,
    #[serde(default)]
    add_source_url: Vec<String>,
    #[serde(default)]
    remove_source_url: Vec<String>,
    #[serde(default)]
    add_identifier: Vec<String>,
    #[serde(default)]
    remove_identifier: Vec<String>,
    #[serde(default)]
    add_reference: Vec<String>,
    #[serde(default)]
    remove_reference: Vec<String>,
    #[serde(default)]
    add_collection: Vec<String>,
    #[serde(default)]
    remove_collection: Vec<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sets", get(list).post(create))
        .route("/sets/{id}", get(one).patch(change).delete(dissolve))
        .route("/sets/{id}/files", post(change_files))
        .route("/sets/{id}/order", put(set_order))
        .route("/variants", post(group_variants))
}

/// Letters and digits that say nothing, for an ID that is made up.
fn random() -> String {
    // The standard library's source of randomness, seeded anew for each
    // hasher it builds.
    use std::hash::{BuildHasher, Hasher};
    let random = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    format!("{:08x}", random as u32)
}

/// A set ID no set has.
pub fn new_id(conn: &Connection) -> rusqlite::Result<String> {
    loop {
        let id = format!("set:{}", random());
        let taken: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM file_set WHERE set_id = ?1)",
            [&id],
            |row| row.get(0),
        )?;
        if !taken {
            return Ok(id);
        }
    }
}

/// The set with the set ID, or a new one with it. Returns it, and whether
/// it is new.
pub fn find_or_make(conn: &Connection, set_id: &str) -> rusqlite::Result<(i64, bool)> {
    let found = conn
        .query_row("SELECT id FROM file_set WHERE set_id = ?1", [set_id], |row| {
            row.get(0)
        })
        .optional()?;
    if let Some(found) = found {
        return Ok((found, false));
    }
    conn.execute("INSERT INTO file_set (set_id) VALUES (?1)", [set_id])?;
    Ok((conn.last_insert_rowid(), true))
}

/// Puts files in a set, in the order given, after what it holds. Those
/// already in it stay where they are. With `free`, only the files that
/// are in no set at all are put in it.
pub fn add_files(conn: &Connection, set: i64, files: &[i64], free: bool) -> rusqlite::Result<()> {
    let mut next: i64 = conn.query_row(
        "SELECT coalesce(max(set_index), -1) + 1 FROM set_file WHERE set_key = ?1",
        [set],
        |row| row.get(0),
    )?;
    let mut put = conn.prepare(
        "INSERT OR IGNORE INTO set_file (set_key, file_id, set_index)
         SELECT ?1, entity_id, ?3 FROM file
         WHERE entity_id = ?2
           AND NOT (?4 AND EXISTS (SELECT 1 FROM set_file WHERE file_id = ?2))",
    )?;
    for file in files {
        if put.execute(params![set, file, next, free])? == 1 {
            next += 1;
        }
    }
    Ok(())
}

/// Deletes the sets that hold no file: there is no way left to open one.
/// Done when the server starts, and whenever files leave the library or
/// sets are made for what arrives.
pub fn prune(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM file_set WHERE id NOT IN (SELECT set_key FROM set_file)",
        [],
    )?;
    Ok(())
}

/// A set's values in a list.
pub fn list_of(conn: &Connection, list: List, set: i64) -> rusqlite::Result<Vec<String>> {
    let (table, column) = list;
    let mut stmt = conn.prepare(&format!(
        "SELECT {column} FROM {table} WHERE set_key = ?1 ORDER BY {column}"
    ))?;
    stmt.query_map([set], |row| row.get(0))?.collect()
}

pub fn add_to_list(conn: &Connection, set: i64, list: List, value: &str) -> rusqlite::Result<()> {
    let (table, column) = list;
    conn.execute(
        &format!("INSERT OR IGNORE INTO {table} (set_key, {column}) VALUES (?1, ?2)"),
        params![set, value],
    )?;
    Ok(())
}

/// Everything known about a set, if there is one; `files` counts those not
/// in the trash.
pub fn describe(conn: &Connection, set: i64) -> rusqlite::Result<Option<Value>> {
    let found = conn
        .query_row(
            "SELECT s.id, s.set_id, s.title, s.description,
                    (SELECT count(*) FROM set_file f JOIN entity e ON e.id = f.file_id
                     WHERE f.set_key = s.id AND e.trashed = 0)
             FROM file_set s WHERE s.id = ?1",
            [set],
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "set_id": row.get::<_, String>(1)?,
                    "title": row.get::<_, Option<String>>(2)?,
                    "description": row.get::<_, Option<String>>(3)?,
                    "files": row.get::<_, i64>(4)?,
                }))
            },
        )
        .optional()?;
    let Some(mut found) = found else {
        return Ok(None);
    };
    for (name, list) in [
        ("source_url", SOURCE_URLS),
        ("identifier", IDENTIFIERS),
        ("reference", REFERENCES),
        ("collection", COLLECTIONS),
    ] {
        found[name] = json!(list_of(conn, list, set)?);
    }
    Ok(Some(found))
}

/// 404 if there is no such set.
fn exists(conn: &Connection, set: i64) -> Result<(), ApiError> {
    conn.query_row("SELECT 1 FROM file_set WHERE id = ?1", [set], |_| Ok(()))
        .optional()?
        .ok_or(ApiError::NotFound)
}

/// A set ID as it is kept, if `wanted` can be one and no other set has it.
fn free_id(conn: &Connection, set: Option<i64>, wanted: &str) -> Result<String, ApiError> {
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return Err(ApiError::bad_request("a set must have a set ID"));
    }
    let taken: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM file_set WHERE set_id = ?1 AND id IS NOT ?2)",
        params![wanted, set],
        |row| row.get(0),
    )?;
    if taken {
        return Err(ApiError::BadRequest(format!(
            "another set already has the ID `{wanted}`"
        )));
    }
    Ok(wanted.to_string())
}

/// The sets there are, for picking one: by title, then by set ID, with how
/// many files each holds.
async fn list(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT s.id, s.set_id, s.title,
                (SELECT count(*) FROM set_file f WHERE f.set_key = s.id)
         FROM file_set s
         WHERE s.title LIKE ?1 ESCAPE '\\' OR s.set_id LIKE ?1 ESCAPE '\\'
         ORDER BY s.title IS NULL, s.title COLLATE NOCASE, s.set_id COLLATE NOCASE LIMIT ?2",
    )?;
    let pattern = contains_pattern(params.q.trim());
    let sets = stmt
        .query_map(params![pattern, MOST_LISTED], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "set_id": row.get::<_, String>(1)?,
                "title": row.get::<_, Option<String>>(2)?,
                "files": row.get::<_, i64>(3)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!(sets)))
}

/// Makes a set of the files given.
async fn create(
    State(state): State<AppState>,
    Json(input): Json<NewSet>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let text = |text: &Option<String>| {
        let text = text.as_deref().map(str::trim);
        text.filter(|text| !text.is_empty()).map(str::to_string)
    };
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let set_id = match text(&input.set_id) {
        Some(wanted) => free_id(&tx, None, &wanted)?,
        None => new_id(&tx)?,
    };
    tx.execute(
        "INSERT INTO file_set (set_id, title) VALUES (?1, ?2)",
        params![set_id, text(&input.title)],
    )?;
    let id = tx.last_insert_rowid();
    add_files(&tx, id, &input.files, false)?;
    let held: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM set_file WHERE set_key = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if !held {
        return Err(ApiError::bad_request("a set is made of at least one file"));
    }
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id, "set_id": set_id }))))
}

async fn one(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    describe(&conn, id)?.map(Json).ok_or(ApiError::NotFound)
}

/// Changes what a set says of itself, all or nothing.
async fn change(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<SetChanges>,
) -> Result<Json<Value>, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    exists(&tx, id)?;
    for (field, value) in &input.set {
        let value = match (field.as_str(), value) {
            ("set_id", Value::String(wanted)) => Some(free_id(&tx, Some(id), wanted)?),
            ("set_id", _) => return Err(ApiError::bad_request("a set must have a set ID")),
            ("title" | "description", Value::Null) => None,
            ("title" | "description", Value::String(text)) => {
                Some(text.trim().to_string()).filter(|text| !text.is_empty())
            }
            ("title" | "description", _) => {
                return Err(ApiError::BadRequest(format!("`{field}` must be text")));
            }
            _ => return Err(ApiError::BadRequest(format!("`{field}` cannot be set"))),
        };
        tx.execute(
            &format!("UPDATE file_set SET {field} = ?2 WHERE id = ?1"),
            params![id, value],
        )?;
    }
    for url in &input.add_source_url {
        add_to_list(&tx, id, SOURCE_URLS, &entities::source_url(url)?)?;
    }
    let plain = [
        (IDENTIFIERS, &input.add_identifier, "identifier"),
        (REFERENCES, &input.add_reference, "reference"),
        (COLLECTIONS, &input.add_collection, "collection"),
    ];
    for (list, values, what) in plain {
        for value in values {
            match value.trim() {
                "" => return Err(ApiError::BadRequest(format!("empty {what}"))),
                value => add_to_list(&tx, id, list, value)?,
            }
        }
    }
    let removed = [
        (SOURCE_URLS, &input.remove_source_url),
        (IDENTIFIERS, &input.remove_identifier),
        (REFERENCES, &input.remove_reference),
        (COLLECTIONS, &input.remove_collection),
    ];
    for ((table, column), values) in removed {
        for value in values {
            tx.execute(
                &format!("DELETE FROM {table} WHERE set_key = ?1 AND {column} = ?2"),
                params![id, value.trim()],
            )?;
        }
    }
    let changed = describe(&tx, id)?.ok_or(ApiError::NotFound)?;
    tx.commit()?;
    Ok(Json(changed))
}

/// Takes the set apart: its files stay, in no set.
async fn dissolve(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let conn = state.db.lock().unwrap();
    match conn.execute("DELETE FROM file_set WHERE id = ?1", [id])? {
        0 => Err(ApiError::NotFound),
        _ => Ok(StatusCode::NO_CONTENT),
    }
}

/// Puts files in the set, or takes them out of it. A set left with none
/// stays for now, so that what was taken out by mistake can be put back:
/// it goes the next time empty sets are cleared away.
async fn change_files(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<FileChanges>,
) -> Result<Json<Value>, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    exists(&tx, id)?;
    tx.execute(
        "DELETE FROM set_file
         WHERE set_key = ?1 AND file_id IN (SELECT value FROM json_each(?2))",
        params![id, ids_json(&input.remove)],
    )?;
    add_files(&tx, id, &input.add, false)?;
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM set_file WHERE set_key = ?1",
        [id],
        |row| row.get(0),
    )?;
    tx.commit()?;
    Ok(Json(json!({ "files": count })))
}

/// Puts the set's files in the order of `ids`. Those left out follow them,
/// in the order they had.
async fn set_order(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<Ids>,
) -> Result<StatusCode, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    exists(&tx, id)?;
    let rest = {
        let mut stmt = tx.prepare(
            "SELECT file_id FROM set_file WHERE set_key = ?1
             ORDER BY set_index IS NULL, set_index, file_id",
        )?;
        stmt.query_map([id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let listed: std::collections::HashSet<i64> = input.ids.iter().copied().collect();
    let order = input
        .ids
        .iter()
        .chain(rest.iter().filter(|file| !listed.contains(file)));
    for (index, file) in order.enumerate() {
        tx.execute(
            "UPDATE set_file SET set_index = ?1 WHERE set_key = ?2 AND file_id = ?3",
            params![index as i64, id, file],
        )?;
    }
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

/// Makes the files variants of each other. They join the group one of
/// them is in already, the oldest if there are several, and a new group
/// otherwise.
async fn group_variants(
    State(state): State<AppState>,
    Json(input): Json<Ids>,
) -> Result<Json<Value>, ApiError> {
    let ids = ids_json(&input.ids);
    let conn = state.db.lock().unwrap();
    let had: Option<String> = conn.query_row(
        "SELECT alt_group_id FROM file
         WHERE entity_id IN (SELECT value FROM json_each(?1)) AND alt_group_id IS NOT NULL
         ORDER BY entity_id LIMIT 1",
        [&ids],
        |row| row.get(0),
    )
    .optional()?;
    let group = match had {
        Some(group) => group,
        None => loop {
            let group = format!("alt:{}", random());
            let taken: bool = conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM file WHERE alt_group_id = ?1)",
                [&group],
                |row| row.get(0),
            )?;
            if !taken {
                break group;
            }
        },
    };
    let updated = conn.execute(
        "UPDATE file SET alt_group_id = ?2 WHERE entity_id IN (SELECT value FROM json_each(?1))",
        params![ids, group],
    )?;
    Ok(Json(json!({ "alt_group_id": group, "updated": updated })))
}
