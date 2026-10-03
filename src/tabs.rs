use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, put},
};
use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};

use crate::{AppState, error::ApiError};

#[derive(Serialize)]
struct Tab {
    id: i64,
    position: i64,
    /// `gallery`, a search of the library, or `upload`, the files uploaded
    /// through the tab.
    kind: String,
    /// What the tab searches for; in an upload tab, a filter on its files.
    query: String,
    /// Chosen by the user; empty if the tab goes by its query.
    name: String,
}

#[derive(Deserialize)]
struct NewTab {
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    query: String,
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

fn tab_from_row(row: &Row) -> rusqlite::Result<Tab> {
    Ok(Tab {
        id: row.get(0)?,
        position: row.get(1)?,
        kind: row.get(2)?,
        query: row.get(3)?,
        name: row.get(4)?,
    })
}

fn all(conn: &Connection) -> rusqlite::Result<Vec<Tab>> {
    let mut stmt =
        conn.prepare("SELECT id, position, kind, query, name FROM tab ORDER BY position, id")?;
    stmt.query_map([], tab_from_row)?.collect()
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
    let tab = conn.query_row(
        "INSERT INTO tab (position, kind, query)
         VALUES ((SELECT coalesce(max(position), -1) + 1 FROM tab), ?1, ?2)
         RETURNING id, position, kind, query, name",
        [&input.kind, &input.query],
        tab_from_row,
    )?;
    Ok((StatusCode::CREATED, Json(tab)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<TabInput>,
) -> Result<Json<Tab>, ApiError> {
    let conn = state.db.lock().unwrap();
    let tab = conn.query_row(
        "UPDATE tab SET query = coalesce(?1, query), name = coalesce(?2, name)
         WHERE id = ?3 RETURNING id, position, kind, query, name",
        (&input.query, input.name.as_deref().map(str::trim), id),
        tab_from_row,
    )?;
    Ok(Json(tab))
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
