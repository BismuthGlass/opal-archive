use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, put},
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{AppState, downloads, error::ApiError, sets};

#[derive(Serialize)]
struct Tab {
    id: i64,
    position: i64,
    /// `gallery`, a search of the library; `upload`, the files uploaded
    /// or downloaded through the tab; `inbox`, what was sent to be
    /// downloaded from outside; `selection`, the entities it was given; or
    /// `set`, the files of one set.
    kind: String,
    /// What the tab searches for; in an upload or set tab, a filter on what
    /// it holds.
    query: String,
    /// Chosen by the user; empty if the tab goes by its query.
    name: String,
    /// The set a set tab shows.
    set: Option<TabSet>,
}

#[derive(Serialize)]
struct TabSet {
    /// Which set, and what it is called by when it has no title.
    set_id: String,
    title: Option<String>,
}

#[derive(Deserialize)]
struct NewTab {
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    query: String,
    /// For a set tab, the set, by its ID.
    set: Option<String>,
    /// For a selection tab, the entities it is to hold.
    #[serde(default)]
    ids: Vec<i64>,
}

fn default_kind() -> String {
    "gallery".to_string()
}

/// The snapshot of its search that a tab shows.
#[derive(Serialize, Deserialize)]
struct View {
    /// The query the snapshot is of.
    query: String,
    /// The results, in the order on show.
    ids: Vec<i64>,
    /// Whether that order is the user's own.
    #[serde(default)]
    custom: bool,
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
        .route("/tabs/{id}/view", get(view).put(save_view))
}

const SELECT_TAB: &str = "
    SELECT t.id, t.position, t.kind, t.query, t.name, t.set_id, s.title,
           t.downloader, t.picked
    FROM tab t
    LEFT JOIN set_info s ON s.set_id = t.set_id";

fn tab_from_row(row: &Row) -> rusqlite::Result<Tab> {
    let set = match row.get::<_, Option<String>>(5)? {
        Some(set_id) => Some(TabSet {
            set_id,
            title: row.get(6)?,
        }),
        None => None,
    };
    // The inbox is kept as a tab of the kind `download`, the only one.
    let downloader: Option<String> = row.get(7)?;
    let inbox = downloader.as_deref() == Some(downloads::inbox::ANY);
    Ok(Tab {
        id: row.get(0)?,
        position: row.get(1)?,
        kind: if inbox {
            "inbox".to_string()
        } else if row.get(8)? {
            // Kept as an upload tab that was given what it holds.
            "selection".to_string()
        } else {
            row.get(2)?
        },
        query: row.get(3)?,
        name: row.get(4)?,
        set,
    })
}

fn all(conn: &Connection) -> rusqlite::Result<Vec<Tab>> {
    // A closed inbox is kept, out of sight.
    let mut stmt = conn.prepare(&format!(
        "{SELECT_TAB} WHERE t.hidden = 0 ORDER BY t.position, t.id"
    ))?;
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
    if input.kind == "inbox" {
        // There is one inbox: asked for again, it is the one there is.
        let tab = one(&conn, downloads::inbox::open(&conn)?)?;
        return Ok((StatusCode::OK, Json(tab)));
    }
    if input.kind == "selection" {
        // It holds the entities given, those of them there are, as an upload
        // tab holds its uploads.
        conn.execute(
            "INSERT INTO tab (position, kind, query, picked)
             VALUES ((SELECT coalesce(max(position), -1) + 1 FROM tab), 'upload', ?1, 1)",
            [&input.query],
        )?;
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
             SELECT ?1, e.id FROM entity e
             WHERE e.id IN (SELECT value FROM json_each(?2))",
            params![id, serde_json::to_string(&input.ids).expect("integers serialize")],
        )?;
        return Ok((StatusCode::CREATED, Json(one(&conn, id)?)));
    }
    if let Some(set) = &input.set
        && !sets::exists(&conn, set)?
    {
        return Err(ApiError::bad_request("no such set"));
    }
    // A downloader has no tab of its own: an upload tab takes its addresses.
    if !["gallery", "upload", "set"].contains(&input.kind.as_str())
        || (input.kind == "set") != input.set.is_some()
    {
        return Err(ApiError::BadRequest(format!(
            "`{}` is not a kind of tab",
            input.kind
        )));
    }
    conn.execute(
        "INSERT INTO tab (position, kind, query, set_id)
         VALUES ((SELECT coalesce(max(position), -1) + 1 FROM tab), ?1, ?2, ?3)",
        params![input.kind, input.query, input.set],
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
    // A download still running for the tab has nowhere to put its files.
    let conn = state.db.lock().unwrap();
    // The inbox is only put out of sight: it keeps what it lists, and its
    // queue goes on being worked through.
    if downloads::inbox::close(&conn, id)? {
        return Ok(StatusCode::NO_CONTENT);
    }
    downloads::cancel(&state, id);
    match conn.execute("DELETE FROM tab WHERE id = ?1", [id])? {
        0 => Err(ApiError::NotFound),
        _ => Ok(StatusCode::NO_CONTENT),
    }
}

/// The view a tab was last left with; `null` if it has none saved.
async fn view(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Option<View>>, ApiError> {
    let conn = state.db.lock().unwrap();
    let saved = conn
        .query_row(
            "SELECT query, ids, custom FROM tab_view WHERE tab_id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .optional()?;
    Ok(Json(saved.map(|(query, ids, custom)| View {
        query,
        // The table only accepts valid JSON.
        ids: serde_json::from_str(&ids).unwrap_or_default(),
        custom,
    })))
}

async fn save_view(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<View>,
) -> Result<StatusCode, ApiError> {
    let conn = state.db.lock().unwrap();
    let ids = serde_json::to_string(&input.ids).expect("integers serialize");
    let saved = conn.execute(
        "INSERT INTO tab_view (tab_id, query, ids, custom)
         SELECT id, ?2, ?3, ?4 FROM tab WHERE id = ?1
         ON CONFLICT (tab_id) DO UPDATE
         SET query = excluded.query, ids = excluded.ids, custom = excluded.custom",
        params![id, input.query, ids, input.custom],
    )?;
    match saved {
        0 => Err(ApiError::NotFound),
        _ => Ok(StatusCode::NO_CONTENT),
    }
}
