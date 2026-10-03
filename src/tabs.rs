use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch},
};
use rusqlite::Row;
use serde::{Deserialize, Serialize};

use crate::{AppState, error::ApiError};

#[derive(Serialize)]
struct Tab {
    id: i64,
    position: i64,
    query: String,
}

#[derive(Deserialize)]
struct TabInput {
    #[serde(default)]
    query: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tabs", get(list).post(create))
        .route("/tabs/{id}", patch(update).delete(remove))
}

fn tab_from_row(row: &Row) -> rusqlite::Result<Tab> {
    Ok(Tab {
        id: row.get(0)?,
        position: row.get(1)?,
        query: row.get(2)?,
    })
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<Tab>>, ApiError> {
    let conn = state.db.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT id, position, query FROM search_tab ORDER BY position, id")?;
    let tabs = stmt
        .query_map([], tab_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(tabs))
}

/// New tabs go at the end.
async fn create(
    State(state): State<AppState>,
    Json(input): Json<TabInput>,
) -> Result<(StatusCode, Json<Tab>), ApiError> {
    let conn = state.db.lock().unwrap();
    let tab = conn.query_row(
        "INSERT INTO search_tab (position, query)
         VALUES ((SELECT coalesce(max(position), -1) + 1 FROM search_tab), ?1)
         RETURNING id, position, query",
        [&input.query],
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
        "UPDATE search_tab SET query = ?1 WHERE id = ?2 RETURNING id, position, query",
        (&input.query, id),
        tab_from_row,
    )?;
    Ok(Json(tab))
}

async fn remove(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let conn = state.db.lock().unwrap();
    match conn.execute("DELETE FROM search_tab WHERE id = ?1", [id])? {
        0 => Err(ApiError::NotFound),
        _ => Ok(StatusCode::NO_CONTENT),
    }
}
