use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, put},
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{AppState, error::ApiError};

#[derive(Serialize)]
struct Tab {
    id: i64,
    position: i64,
    /// `gallery`, a search of the library; `upload`, the files uploaded
    /// through the tab; or `collection`, the members of one collection.
    kind: String,
    /// What the tab searches for; in an upload or collection tab, a filter
    /// on what it holds.
    query: String,
    /// Chosen by the user; empty if the tab goes by its query.
    name: String,
    /// The collection a collection tab shows.
    collection: Option<TabCollection>,
}

#[derive(Serialize)]
struct TabCollection {
    id: i64,
    title: Option<String>,
    ordered: bool,
}

#[derive(Deserialize)]
struct NewTab {
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    query: String,
    /// For a collection tab, the collection.
    collection: Option<i64>,
}

fn default_kind() -> String {
    "gallery".to_string()
}

#[derive(Deserialize)]
struct OrderInput {
    ids: Vec<i64>,
}

/// A change to a tab; what is left out stays as it is.
#[derive(Deserialize)]
struct TabInput {
    query: Option<String>,
    name: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tabs", get(list).post(create))
        .route("/tabs/order", put(reorder))
        .route("/tabs/{id}", patch(update).delete(remove))
}

const SELECT_TAB: &str = "
    SELECT t.id, t.position, t.kind, t.query, t.name, t.collection_id, e.title, c.ordered
    FROM tab t
    LEFT JOIN entity e ON e.id = t.collection_id
    LEFT JOIN collection c ON c.entity_id = t.collection_id";

fn tab_from_row(row: &Row) -> rusqlite::Result<Tab> {
    let collection = match row.get::<_, Option<i64>>(5)? {
        Some(id) => Some(TabCollection {
            id,
            title: row.get(6)?,
            ordered: row.get(7)?,
        }),
        None => None,
    };
    Ok(Tab {
        id: row.get(0)?,
        position: row.get(1)?,
        kind: row.get(2)?,
        query: row.get(3)?,
        name: row.get(4)?,
        collection,
    })
}

fn all(conn: &Connection) -> rusqlite::Result<Vec<Tab>> {
    let mut stmt = conn.prepare(&format!("{SELECT_TAB} ORDER BY t.position, t.id"))?;
    stmt.query_map([], tab_from_row)?.collect()
}

fn one(conn: &Connection, id: i64) -> Result<Tab, ApiError> {
    conn.query_row(&format!("{SELECT_TAB} WHERE t.id = ?1"), [id], tab_from_row)
        .optional()?
        .ok_or(ApiError::NotFound)
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<Tab>>, ApiError> {
    Ok(Json(all(&state.db.lock().unwrap())?))
}

/// Puts the tabs in the order of `ids`. Tabs left out go after them, in
/// the order they had.
async fn reorder(
    State(state): State<AppState>,
    Json(input): Json<OrderInput>,
) -> Result<Json<Vec<Tab>>, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let mut ids = input.ids;
    for tab in all(&tx)? {
        if !ids.contains(&tab.id) {
            ids.push(tab.id);
        }
    }
    for (position, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE tab SET position = ?1 WHERE id = ?2",
            (position as i64, id),
        )?;
    }
    let tabs = all(&tx)?;
    tx.commit()?;
    Ok(Json(tabs))
}

/// New tabs go at the end.
async fn create(
    State(state): State<AppState>,
    Json(input): Json<NewTab>,
) -> Result<(StatusCode, Json<Tab>), ApiError> {
    let conn = state.db.lock().unwrap();
    if let Some(collection) = input.collection {
        let exists: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM collection WHERE entity_id = ?1)",
            [collection],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(ApiError::bad_request("no such collection"));
        }
    }
    conn.execute(
        "INSERT INTO tab (position, kind, query, collection_id)
         VALUES ((SELECT coalesce(max(position), -1) + 1 FROM tab), ?1, ?2, ?3)",
        params![input.kind, input.query, input.collection],
    )?;
    let tab = one(&conn, conn.last_insert_rowid())?;
    Ok((StatusCode::CREATED, Json(tab)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<TabInput>,
) -> Result<Json<Tab>, ApiError> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "UPDATE tab SET query = coalesce(?1, query), name = coalesce(?2, name) WHERE id = ?3",
        params![input.query, input.name.as_deref().map(str::trim), id],
    )?;
    Ok(Json(one(&conn, id)?))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let conn = state.db.lock().unwrap();
    match conn.execute("DELETE FROM tab WHERE id = ?1", [id])? {
        0 => Err(ApiError::NotFound),
        _ => Ok(StatusCode::NO_CONTENT),
    }
}
