//! Sets: files that belong together, in an order. A set is the ID its
//! files give, as a collection is the name: which sets a file gives, and
//! where in each it comes, is kept in `set_file`, and files that give the
//! same ID are a set. A file can be in several.
//!
//! What is known of a set itself (a title, a description, where it came
//! from) is kept by that ID, in `set_info`, once there is something to
//! keep and not before. A set is not an entity: it has no tags and is not
//! searched for, only opened from one of its files.
//!
//! Variants are looser still: files with the same `alt_group_id`.

use axum::{
    Json, Router,
    extract::{Query, State},
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
};

/// A table of plain values per set, and the column the value is in.
pub type List = (&'static str, &'static str);
pub const SOURCE_URLS: List = ("set_source_url", "url");
pub const IDENTIFIERS: List = ("set_identifier", "value");
pub const REFERENCES: List = ("set_reference", "value");
pub const COLLECTIONS: List = ("set_collection", "value");

/// The lists a set has, by the field each is given as.
const LISTS: [(&str, List); 4] = [
    ("source_url", SOURCE_URLS),
    ("identifier", IDENTIFIERS),
    ("reference", REFERENCES),
    ("collection", COLLECTIONS),
];

#[derive(Deserialize)]
struct Named {
    /// The set, as its files give it.
    set_id: String,
}

#[derive(Deserialize)]
struct Joined {
    /// The set the files are to be in: the one that has this ID, or a new
    /// one of it. One is made up if it is not given.
    set_id: Option<String>,
    /// Given to the set if it has no title.
    title: Option<String>,
    /// The files to put in it, in order.
    #[serde(default)]
    files: Vec<i64>,
}

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
        .route("/sets", get(one).post(join).patch(change).delete(dissolve))
        .route("/sets/files", post(change_files))
        .route("/sets/order", put(set_order))
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

/// Whether there is a set of this ID: files that give it, or something
/// known of it.
pub fn exists(conn: &Connection, set_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM set_file WHERE set_id = ?1)
             OR EXISTS (SELECT 1 FROM set_info WHERE set_id = ?1)",
        [set_id],
        |row| row.get(0),
    )
}

/// A set ID no set has.
pub fn new_id(conn: &Connection) -> rusqlite::Result<String> {
    loop {
        let id = format!("set:{}", random());
        if !exists(conn, &id)? {
            return Ok(id);
        }
    }
}

/// Puts files in a set, in the order given, after what it holds. Those
/// already in it stay where they are. With `free`, only the files that
/// are in no set at all are put in it.
pub fn add_files(conn: &Connection, set: &str, files: &[i64], free: bool) -> rusqlite::Result<()> {
    let mut next: i64 = conn.query_row(
        "SELECT coalesce(max(set_index), -1) + 1 FROM set_file WHERE set_id = ?1",
        [set],
        |row| row.get(0),
    )?;
    let mut put = conn.prepare(
        "INSERT OR IGNORE INTO set_file (set_id, file_id, set_index)
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

/// Forgets what was known of sets no file gives any more: there is no way
/// left to open one. Done when the server starts, and whenever files
/// leave the library or arrive.
pub fn prune(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM set_info WHERE set_id NOT IN (SELECT set_id FROM set_file)",
        [],
    )?;
    Ok(())
}

/// Makes sure there is somewhere to keep what is known of a set.
fn know(conn: &Connection, set: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR IGNORE INTO set_info (set_id) VALUES (?1)", [set])?;
    Ok(())
}

/// Gives a set a title or a description (`field`) if it has none.
pub fn fill(conn: &Connection, set: &str, field: &str, value: &str) -> rusqlite::Result<()> {
    know(conn, set)?;
    conn.execute(
        &format!("UPDATE set_info SET {field} = ?2 WHERE set_id = ?1 AND {field} IS NULL"),
        params![set, value],
    )?;
    Ok(())
}

pub fn add_to_list(conn: &Connection, set: &str, list: List, value: &str) -> rusqlite::Result<()> {
    know(conn, set)?;
    let (table, column) = list;
    conn.execute(
        &format!("INSERT OR IGNORE INTO {table} (set_id, {column}) VALUES (?1, ?2)"),
        params![set, value],
    )?;
    Ok(())
}

/// Forgets a set of which nothing is known any more: it is its ID again.
fn forget_if_empty(conn: &Connection, set: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM set_info
         WHERE set_id = ?1 AND title IS NULL AND description IS NULL
           AND NOT EXISTS (SELECT 1 FROM set_source_url WHERE set_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM set_identifier WHERE set_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM set_reference WHERE set_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM set_collection WHERE set_id = ?1)",
        [set],
    )?;
    Ok(())
}

/// Whether anything is known of a set beyond its ID.
pub fn known(conn: &Connection, set: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM set_info WHERE set_id = ?1)",
        [set],
        |row| row.get(0),
    )
}

/// What is known of a set, which may be its ID alone; `files` counts those
/// not in the trash.
pub fn describe(conn: &Connection, set: &str) -> rusqlite::Result<Value> {
    let info: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT title, description FROM set_info WHERE set_id = ?1",
            [set],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (title, description) = info.unwrap_or_default();
    let files: i64 = conn.query_row(
        "SELECT count(*) FROM set_file f JOIN entity e ON e.id = f.file_id
         WHERE f.set_id = ?1 AND e.trashed = 0",
        [set],
        |row| row.get(0),
    )?;
    let mut found = json!({
        "set_id": set,
        "title": title,
        "description": description,
        "files": files,
    });
    for (field, (table, column)) in LISTS {
        let mut stmt = conn.prepare(&format!(
            "SELECT {column} FROM {table} WHERE set_id = ?1 ORDER BY {column}"
        ))?;
        let values = stmt
            .query_map([set], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        found[field] = json!(values);
    }
    Ok(found)
}

/// A set ID as it is kept.
fn named(set_id: &str) -> Result<&str, ApiError> {
    match set_id.trim() {
        "" => Err(ApiError::bad_request("a set has a set ID")),
        set_id => Ok(set_id),
    }
}

/// Puts files in the set of an ID: the set that has it, or a new one of
/// it. Given no ID, a set is made with one made up for it.
async fn join(
    State(state): State<AppState>,
    Json(input): Json<Joined>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let text = |text: &Option<String>| {
        let text = text.as_deref().map(str::trim);
        text.filter(|text| !text.is_empty()).map(str::to_string)
    };
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let set_id = match text(&input.set_id) {
        Some(wanted) => wanted,
        None => new_id(&tx)?,
    };
    let new = !exists(&tx, &set_id)?;
    add_files(&tx, &set_id, &input.files, false)?;
    let held: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM set_file WHERE set_id = ?1)",
        [&set_id],
        |row| row.get(0),
    )?;
    if !held {
        return Err(ApiError::bad_request("a set is made of at least one file"));
    }
    if let Some(title) = text(&input.title) {
        fill(&tx, &set_id, "title", &title)?;
    }
    tx.commit()?;
    let status = if new { StatusCode::CREATED } else { StatusCode::OK };
    Ok((status, Json(json!({ "set_id": set_id }))))
}

async fn one(
    State(state): State<AppState>,
    Query(named_as): Query<Named>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    Ok(Json(describe(&conn, named(&named_as.set_id)?)?))
}

/// Gives a set another ID: its files, what is known of it and its tab all
/// go by the new one. One that another set has is refused.
fn rename(conn: &Connection, from: &str, to: &str) -> Result<(), ApiError> {
    if from == to {
        return Ok(());
    }
    if exists(conn, to)? {
        return Err(ApiError::BadRequest(format!(
            "another set already has the ID `{to}`"
        )));
    }
    conn.execute("UPDATE set_file SET set_id = ?2 WHERE set_id = ?1", [from, to])?;
    // What hangs off it follows.
    conn.execute("UPDATE set_info SET set_id = ?2 WHERE set_id = ?1", [from, to])?;
    conn.execute("UPDATE tab SET set_id = ?2 WHERE set_id = ?1", [from, to])?;
    Ok(())
}

/// Changes what a set says of itself, all or nothing. The first thing
/// said is what makes there be anything kept of it; with nothing left
/// known it is its ID again.
async fn change(
    State(state): State<AppState>,
    Query(named_as): Query<Named>,
    Json(input): Json<SetChanges>,
) -> Result<Json<Value>, ApiError> {
    let mut id = named(&named_as.set_id)?.to_string();
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    if !exists(&tx, &id)? {
        return Err(ApiError::NotFound);
    }
    know(&tx, &id)?;
    for (field, value) in &input.set {
        let value = match (field.as_str(), value) {
            ("set_id", Value::String(wanted)) => {
                let wanted = named(wanted)?.to_string();
                rename(&tx, &id, &wanted)?;
                id = wanted;
                continue;
            }
            ("set_id", _) => return Err(ApiError::bad_request("a set has a set ID")),
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
            &format!("UPDATE set_info SET {field} = ?2 WHERE set_id = ?1"),
            params![id, value],
        )?;
    }
    for url in &input.add_source_url {
        add_to_list(&tx, &id, SOURCE_URLS, &entities::source_url(url)?)?;
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
                value => add_to_list(&tx, &id, list, value)?,
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
                &format!("DELETE FROM {table} WHERE set_id = ?1 AND {column} = ?2"),
                params![id, value.trim()],
            )?;
        }
    }
    forget_if_empty(&tx, &id)?;
    let changed = describe(&tx, &id)?;
    tx.commit()?;
    Ok(Json(changed))
}

/// Takes the set apart: its files stay, no longer in it, and what was
/// known of it is forgotten.
async fn dissolve(
    State(state): State<AppState>,
    Query(named_as): Query<Named>,
) -> Result<StatusCode, ApiError> {
    let id = named(&named_as.set_id)?;
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    if !exists(&tx, id)? {
        return Err(ApiError::NotFound);
    }
    tx.execute("DELETE FROM set_file WHERE set_id = ?1", [id])?;
    tx.execute("DELETE FROM set_info WHERE set_id = ?1", [id])?;
    tx.execute("DELETE FROM tab WHERE set_id = ?1", [id])?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

/// Puts files in the set, or takes them out of it. What is known of a set
/// left with none stays for now, so that what was taken out by mistake
/// can be put back.
async fn change_files(
    State(state): State<AppState>,
    Query(named_as): Query<Named>,
    Json(input): Json<FileChanges>,
) -> Result<Json<Value>, ApiError> {
    let id = named(&named_as.set_id)?;
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM set_file
         WHERE set_id = ?1 AND file_id IN (SELECT value FROM json_each(?2))",
        params![id, ids_json(&input.remove)],
    )?;
    add_files(&tx, id, &input.add, false)?;
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM set_file WHERE set_id = ?1",
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
    Query(named_as): Query<Named>,
    Json(input): Json<Ids>,
) -> Result<StatusCode, ApiError> {
    let id = named(&named_as.set_id)?;
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let rest = {
        let mut stmt = tx.prepare(
            "SELECT file_id FROM set_file WHERE set_id = ?1
             ORDER BY set_index IS NULL, set_index, file_id",
        )?;
        stmt.query_map([id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if rest.is_empty() {
        return Err(ApiError::NotFound);
    }
    let listed: std::collections::HashSet<i64> = input.ids.iter().copied().collect();
    let order = input
        .ids
        .iter()
        .chain(rest.iter().filter(|file| !listed.contains(file)));
    for (index, file) in order.enumerate() {
        tx.execute(
            "UPDATE set_file SET set_index = ?1 WHERE set_id = ?2 AND file_id = ?3",
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
