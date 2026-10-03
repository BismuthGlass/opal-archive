//! Application settings, kept on the server so that every browser sees the
//! same ones. The server stores them without interpreting them: each is a
//! JSON value under a key the frontend chooses.

use axum::{Json, Router, extract::State, routing::get};
use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::{AppState, error::ApiError};

pub fn router() -> Router<AppState> {
    Router::new().route("/settings", get(read).patch(change))
}

fn all(conn: &Connection) -> Result<Map<String, Value>, ApiError> {
    let mut stmt = conn.prepare("SELECT key, value FROM setting")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut settings = Map::new();
    for row in rows {
        let (key, value) = row?;
        // The table only accepts valid JSON.
        settings.insert(key, serde_json::from_str(&value).unwrap_or(Value::Null));
    }
    Ok(settings)
}

async fn read(State(state): State<AppState>) -> Result<Json<Map<String, Value>>, ApiError> {
    Ok(Json(all(&state.db.lock().unwrap())?))
}

/// Sets the given settings, leaving the others alone. `null` removes one.
/// Answers with every setting.
async fn change(
    State(state): State<AppState>,
    Json(input): Json<Map<String, Value>>,
) -> Result<Json<Map<String, Value>>, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    for (key, value) in &input {
        if value.is_null() {
            tx.execute("DELETE FROM setting WHERE key = ?1", [key])?;
        } else {
            tx.execute(
                "INSERT INTO setting (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [key, &value.to_string()],
            )?;
        }
    }
    let settings = all(&tx)?;
    tx.commit()?;
    Ok(Json(settings))
}
