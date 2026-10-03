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
    /// Whether members keep a chosen order. Defaults to yes for a sequence.
    ordered: Option<bool>,
    /// A collection to put the new one into.
    parent: Option<i64>,
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

/// Whether the collection keeps its members in order; 404 if there is no
/// such collection.
fn is_ordered(conn: &Connection, id: i64) -> Result<bool, ApiError> {
    conn.query_row(
        "SELECT ordered FROM collection WHERE entity_id = ?1",
        [id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or(ApiError::NotFound)
}

/// Adds members in the order given, skipping ones already present. In an
/// ordered collection they are appended after the current last position.
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

    let ordered = is_ordered(conn, collection)?;
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

/// The title a collection gets when it is given none: what kind it is.
/// Titles need not be unique; the ID is what tells collections apart.
fn default_title(collection_type: &str) -> &'static str {
    match collection_type {
        "variant" => "Variant",
        "set" => "Set",
        "sourceset" => "Source Set",
        "sequence" => "Sequence",
        _ => "User Collection",
    }
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
        [title.unwrap_or(default_title(&input.collection_type))],
    )?;
    let id = tx.last_insert_rowid();
    let ordered = input.ordered.unwrap_or(input.collection_type == "sequence");
    tx.execute(
        "INSERT INTO collection (entity_id, collection_type, ordered) VALUES (?1, ?2, ?3)",
        params![id, input.collection_type, ordered],
    )?;
    add_members(&tx, id, &input.members)?;
    if let Some(parent) = input.parent {
        add_members(&tx, parent, &[id])?;
    }
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
    is_ordered(&tx, id)?;
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

/// Sets member positions to the order of `ids`. Members left out follow
/// them, in the order they had.
async fn set_order(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<Order>,
) -> Result<StatusCode, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    is_ordered(&tx, id)?;
    let rest = {
        let mut stmt = tx.prepare(
            "SELECT member_id FROM membership WHERE collection_id = ?1
             ORDER BY position IS NULL, position, member_id",
        )?;
        stmt.query_map([id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let listed: std::collections::HashSet<i64> = input.ids.iter().copied().collect();
    let order = input
        .ids
        .iter()
        .chain(rest.iter().filter(|member| !listed.contains(member)));
    for (position, member) in order.enumerate() {
        tx.execute(
            "UPDATE membership SET position = ?1 WHERE collection_id = ?2 AND member_id = ?3",
            params![position as i64, id, member],
        )?;
    }
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}
