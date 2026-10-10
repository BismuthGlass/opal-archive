//! Collections: what files and sets say they are part of where they came
//! from, a board or a thread. A collection is the name they give, and
//! needs nothing more to be one. What is known of the collection itself
//! (a title, a description, where it is) is kept by that name once there
//! is something to keep, and not before.

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{AppState, entities, error::ApiError};

/// A table of plain values per collection, and the column the value is in.
pub type List = (&'static str, &'static str);
pub const SOURCE_URLS: List = ("collection_source_url", "url");
pub const IDENTIFIERS: List = ("collection_identifier", "value");
pub const REFERENCES: List = ("collection_reference", "value");

/// The lists a collection has, by the field each is given as.
const LISTS: [(&str, List); 3] = [
    ("source_url", SOURCE_URLS),
    ("identifier", IDENTIFIERS),
    ("reference", REFERENCES),
];

#[derive(Deserialize)]
struct Named {
    /// The collection, as files and sets give it.
    name: String,
}

/// A change to what is known of a collection, written as an edit of
/// entities is.
#[derive(Deserialize)]
struct Changes {
    /// `title` or `description` to its new value.
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
}

pub fn router() -> Router<AppState> {
    Router::new().route("/collections", get(one).patch(change))
}

/// Makes sure there is somewhere to keep what is known of a collection.
pub fn know(conn: &Connection, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO collection_info (name) VALUES (?1)",
        [name],
    )?;
    Ok(())
}

/// Gives a collection a title or a description (`field`) if it has none.
pub fn fill(conn: &Connection, name: &str, field: &str, value: &str) -> rusqlite::Result<()> {
    know(conn, name)?;
    conn.execute(
        &format!("UPDATE collection_info SET {field} = ?2 WHERE name = ?1 AND {field} IS NULL"),
        params![name, value],
    )?;
    Ok(())
}

pub fn add_to_list(conn: &Connection, name: &str, list: List, value: &str) -> rusqlite::Result<()> {
    know(conn, name)?;
    let (table, column) = list;
    conn.execute(
        &format!("INSERT OR IGNORE INTO {table} (name, {column}) VALUES (?1, ?2)"),
        params![name, value],
    )?;
    Ok(())
}

/// Forgets a collection of which nothing is known any more.
fn forget_if_empty(conn: &Connection, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM collection_info
         WHERE name = ?1 AND title IS NULL AND description IS NULL
           AND NOT EXISTS (SELECT 1 FROM collection_source_url WHERE name = ?1)
           AND NOT EXISTS (SELECT 1 FROM collection_identifier WHERE name = ?1)
           AND NOT EXISTS (SELECT 1 FROM collection_reference WHERE name = ?1)",
        [name],
    )?;
    Ok(())
}

/// Whether anything is known of a collection beyond its name.
pub fn known(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM collection_info WHERE name = ?1)",
        [name],
        |row| row.get(0),
    )
}

/// What is known of a collection, which may be its name alone; `files`
/// counts those not in the trash that are part of it, themselves or
/// through a set.
pub fn describe(conn: &Connection, name: &str) -> rusqlite::Result<Value> {
    let info: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT title, description FROM collection_info WHERE name = ?1",
            [name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (title, description) = info.unwrap_or_default();
    let files: i64 = conn.query_row(
        "SELECT count(*) FROM entity e
         WHERE e.trashed = 0
           AND (EXISTS (SELECT 1 FROM collection l WHERE l.entity_id = e.id AND l.value = ?1)
                OR EXISTS (SELECT 1 FROM set_collection l JOIN set_file sf USING (set_key)
                           WHERE sf.file_id = e.id AND l.value = ?1))",
        [name],
        |row| row.get(0),
    )?;
    let mut found = json!({
        "name": name,
        "title": title,
        "description": description,
        "files": files,
    });
    for (field, (table, column)) in LISTS {
        let mut stmt = conn.prepare(&format!(
            "SELECT {column} FROM {table} WHERE name = ?1 ORDER BY {column}"
        ))?;
        let values = stmt
            .query_map([name], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        found[field] = json!(values);
    }
    Ok(found)
}

/// A collection's name as it is kept.
fn named(name: &str) -> Result<&str, ApiError> {
    match name.trim() {
        "" => Err(ApiError::bad_request("a collection has a name")),
        name => Ok(name),
    }
}

async fn one(
    State(state): State<AppState>,
    Query(named_as): Query<Named>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    Ok(Json(describe(&conn, named(&named_as.name)?)?))
}

/// Changes what is known of a collection, all or nothing. The first
/// change is what makes there be anything kept of it; one that leaves
/// nothing known has it forgotten again.
async fn change(
    State(state): State<AppState>,
    Query(named_as): Query<Named>,
    Json(input): Json<Changes>,
) -> Result<Json<Value>, ApiError> {
    let name = named(&named_as.name)?;
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    know(&tx, name)?;
    for (field, value) in &input.set {
        let value = match (field.as_str(), value) {
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
            &format!("UPDATE collection_info SET {field} = ?2 WHERE name = ?1"),
            params![name, value],
        )?;
    }
    for url in &input.add_source_url {
        add_to_list(&tx, name, SOURCE_URLS, &entities::source_url(url)?)?;
    }
    let plain = [
        (IDENTIFIERS, &input.add_identifier, "identifier"),
        (REFERENCES, &input.add_reference, "reference"),
    ];
    for (list, values, what) in plain {
        for value in values {
            match value.trim() {
                "" => return Err(ApiError::BadRequest(format!("empty {what}"))),
                value => add_to_list(&tx, name, list, value)?,
            }
        }
    }
    let removed = [
        (SOURCE_URLS, &input.remove_source_url),
        (IDENTIFIERS, &input.remove_identifier),
        (REFERENCES, &input.remove_reference),
    ];
    for ((table, column), values) in removed {
        for value in values {
            tx.execute(
                &format!("DELETE FROM {table} WHERE name = ?1 AND {column} = ?2"),
                params![name, value.trim()],
            )?;
        }
    }
    forget_if_empty(&tx, name)?;
    let changed = describe(&tx, name)?;
    tx.commit()?;
    Ok(Json(changed))
}
