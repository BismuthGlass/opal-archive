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
    /// `search`, or `upload`: the files uploaded through the tab.
    kind: String,
    /// What the tab searches for; in an upload tab, a filter on its files.
    query: String,
}

#[derive(Deserialize)]
struct NewTab {
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    query: String,
}

fn default_kind() -> String {
    "search".to_string()
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
        kind: row.get(2)?,
        query: row.get(3)?,
    })
}

async fn list(State(state): State<AppState>) -> Result<Json<Vec<Tab>>, ApiError> {
    let conn = state.db.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT id, position, kind, query FROM tab ORDER BY position, id")?;
    let tabs = stmt
        .query_map([], tab_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
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
         RETURNING id, position, kind, query",
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
        "UPDATE tab SET query = ?1 WHERE id = ?2 RETURNING id, position, kind, query",
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
    match conn.execute("DELETE FROM tab WHERE id = ?1", [id])? {
        0 => Err(ApiError::NotFound),
        _ => Ok(StatusCode::NO_CONTENT),
    }
}
