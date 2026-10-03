use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{AppState, error::ApiError, query, tags};

const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 1000;

#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: i64,
    limit: Option<i64>,
    /// Fixes the order of `sort=random` across pages.
    #[serde(default)]
    seed: i64,
    /// Tab to search within: an upload tab's files, or a collection tab's
    /// members.
    tab: Option<i64>,
}

/// What the results grid needs to draw one entity.
#[derive(Serialize)]
struct Item {
    id: i64,
    kind: String,
    title: Option<String>,
    media_type: Option<String>,
    extension: Option<String>,
    length: Option<f64>,
    collection_type: Option<String>,
    /// ID of the file whose thumbnail represents this entity: the file
    /// itself, or a collection's first member that has one.
    thumbnail: Option<i64>,
    member_count: Option<i64>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/search", get(search))
        .route("/search/ids", get(search_ids))
}

/// Compiles `source`, narrowed to what `tab` holds if it is an upload or a
/// collection tab. An ordered collection is shown in its own order unless
/// the query asks for another.
fn compile(
    conn: &Connection,
    source: &str,
    seed: i64,
    tab: Option<i64>,
) -> Result<query::Compiled, ApiError> {
    let mut compiled = query::compile(source, seed, &tags::aliases(conn)?)?;
    let Some(tab) = tab else {
        return Ok(compiled);
    };
    let scope: Option<(String, Option<i64>, Option<bool>)> = conn
        .query_row(
            "SELECT t.kind, t.collection_id, c.ordered FROM tab t
             LEFT JOIN collection c ON c.entity_id = t.collection_id WHERE t.id = ?1",
            [tab],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match scope {
        Some((kind, _, _)) if kind == "upload" => {
            compiled.filter = format!(
                "({}) AND e0.id IN (SELECT entity_id FROM tab_upload WHERE tab_id = ?)",
                compiled.filter
            );
            compiled.filter_params.push(Value::Integer(tab));
        }
        Some((_, Some(collection), ordered)) => {
            compiled.filter = format!(
                "({}) AND e0.id IN (SELECT member_id FROM membership WHERE collection_id = ?)",
                compiled.filter
            );
            compiled.filter_params.push(Value::Integer(collection));
            if ordered == Some(true) && !compiled.sorted {
                let position = "(SELECT position FROM membership
                                 WHERE collection_id = ? AND member_id = e0.id)";
                compiled.order = format!("{position} IS NULL, {position}, e0.id");
                compiled.order_params = vec![Value::Integer(collection); 2];
            }
        }
        _ => {}
    }
    Ok(compiled)
}

/// IDs of everything matching `source`, in the query's order.
pub fn matching_ids(
    conn: &Connection,
    source: &str,
    seed: i64,
    tab: Option<i64>,
) -> Result<Vec<i64>, ApiError> {
    let compiled = compile(conn, source, seed, tab)?;
    let sql = format!(
        "SELECT e0.id FROM {} WHERE {} ORDER BY {}",
        query::FROM,
        compiled.filter,
        compiled.order
    );
    let params = compiled.filter_params.iter().chain(&compiled.order_params);
    let mut stmt = conn.prepare(&sql)?;
    let ids = stmt
        .query_map(params_from_iter(params), |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = params.offset.max(0);
    let conn = state.db.lock().unwrap();
    let compiled = compile(&conn, &params.q, params.seed, params.tab)?;

    let total: i64 = conn.query_row(
        &format!(
            "SELECT count(*) FROM {} WHERE {}",
            query::FROM,
            compiled.filter
        ),
        params_from_iter(&compiled.filter_params),
        |row| row.get(0),
    )?;

    let sql = format!(
        "SELECT e0.id, e0.kind, e0.title, f0.media_type, f0.extension,
                f0.length, c0.collection_type,
                CASE
                    WHEN f0.has_thumbnail = 1 THEN e0.id
                    WHEN c0.entity_id IS NOT NULL THEN (
                        SELECT m.member_id FROM membership m
                        JOIN file mf ON mf.entity_id = m.member_id
                        WHERE m.collection_id = e0.id AND mf.has_thumbnail = 1
                        ORDER BY m.position IS NULL, m.position, m.member_id LIMIT 1)
                END,
                CASE WHEN c0.entity_id IS NOT NULL THEN
                    (SELECT count(*) FROM membership m WHERE m.collection_id = e0.id)
                END
         FROM {} WHERE {} ORDER BY {} LIMIT ? OFFSET ?",
        query::FROM,
        compiled.filter,
        compiled.order
    );
    let paging = [Value::Integer(limit), Value::Integer(offset)];
    let sql_params = compiled
        .filter_params
        .iter()
        .chain(&compiled.order_params)
        .chain(&paging);
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(params_from_iter(sql_params), |row| {
            Ok(Item {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                media_type: row.get(3)?,
                extension: row.get(4)?,
                length: row.get(5)?,
                collection_type: row.get(6)?,
                thumbnail: row.get(7)?,
                member_count: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Json(json!({ "total": total, "offset": offset, "items": items })))
}

async fn search_ids(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let ids = matching_ids(&conn, &params.q, params.seed, params.tab)?;
    Ok(Json(json!({ "ids": ids })))
}
