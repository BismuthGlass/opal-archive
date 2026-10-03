use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{post, put},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{AppState, error::ApiError, query::COLLECTION_TYPES};

#[derive(Deserialize)]
struct NewCollection {
    collection_type: String,
    title: Option<String>,
    #[serde(default)]
    members: Vec<i64>,
}

#[derive(Deserialize)]
struct MemberChanges {
    #[serde(default)]
    add: Vec<i64>,
    #[serde(default)]
    remove: Vec<i64>,
}

#[derive(Deserialize)]
struct Order {
    ids: Vec<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/collections", post(create))
        .route("/collections/{id}/members", post(change_members))
        .route("/collections/{id}/order", put(set_order))
}

fn collection_type(conn: &Connection, id: i64) -> Result<String, ApiError> {
    conn.query_row(
        "SELECT collection_type FROM collection WHERE entity_id = ?1",
        [id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or(ApiError::NotFound)
}

/// Adds members in the order given, skipping ones already present. In a
/// sequence they are appended after the current last position.
fn add_members(conn: &Connection, collection: i64, members: &[i64]) -> Result<(), ApiError> {
    // A collection may not contain itself, directly or through any chain of
    // collections: reject if it is among the new members or their descendants.
    let ids = serde_json::to_string(members).expect("integers serialize");
    let cycle: bool = conn.query_row(
        "WITH RECURSIVE descendant (id) AS (
             SELECT value FROM json_each(?1)
             UNION
             SELECT m.member_id FROM membership m JOIN descendant d ON m.collection_id = d.id
         )
         SELECT EXISTS (SELECT 1 FROM descendant WHERE id = ?2)",
        params![ids, collection],
        |row| row.get(0),
    )?;
    if cycle {
        return Err(ApiError::bad_request(
            "a collection cannot contain itself, directly or through other collections",
        ));
    }

    let ordered = collection_type(conn, collection)? == "sequence";
    let mut next: i64 = conn.query_row(
        "SELECT coalesce(max(position), -1) + 1 FROM membership WHERE collection_id = ?1",
        [collection],
        |row| row.get(0),
    )?;
    let mut insert = conn.prepare(
        "INSERT OR IGNORE INTO membership (collection_id, member_id, position)
         VALUES (?1, ?2, ?3)",
    )?;
    for member in members {
        let position = ordered.then_some(next);
        if insert.execute(params![collection, member, position])? == 1 {
            next += 1;
        }
    }
    Ok(())
}

async fn create(
    State(state): State<AppState>,
    Json(input): Json<NewCollection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !COLLECTION_TYPES.contains(&input.collection_type.as_str()) {
        return Err(ApiError::BadRequest(format!(
            "`collection_type` must be one of {}",
            COLLECTION_TYPES.join(", ")
        )));
    }
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty());

    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO entity (kind, title) VALUES ('collection', ?1)",
        [title],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO collection (entity_id, collection_type) VALUES (?1, ?2)",
        params![id, input.collection_type],
    )?;
    add_members(&tx, id, &input.members)?;
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

async fn change_members(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<MemberChanges>,
) -> Result<Json<Value>, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    collection_type(&tx, id)?;
    for member in &input.remove {
        tx.execute(
            "DELETE FROM membership WHERE collection_id = ?1 AND member_id = ?2",
            [id, *member],
        )?;
    }
    add_members(&tx, id, &input.add)?;
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM membership WHERE collection_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    tx.commit()?;
    Ok(Json(json!({ "member_count": count })))
}

/// Sets member positions to the order of `ids`. Members left out keep the
/// position they had.
async fn set_order(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<Order>,
) -> Result<StatusCode, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    collection_type(&tx, id)?;
    for (position, member) in input.ids.iter().enumerate() {
        tx.execute(
            "UPDATE membership SET position = ?1 WHERE collection_id = ?2 AND member_id = ?3",
            params![position as i64, id, member],
        )?;
    }
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}
