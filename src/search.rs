use std::collections::HashSet;

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use rusqlite::{Connection, OptionalExtension, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{AppState, error::ApiError, files, query, tags};

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
    /// Tab to search within: an upload tab's files, or a set tab's set.
    tab: Option<i64>,
    /// Set to search within, in place of what `tab` holds: the set a tab
    /// has gone into.
    set: Option<i64>,
    /// Present to have trashed entities included without `@trashed`.
    trashed: Option<String>,
    /// Present to have a set listed once, by the first of its files that
    /// the search finds. It does nothing to a search within a set.
    collapse: Option<String>,
}

/// What the results grid needs to draw one file.
#[derive(Serialize)]
struct Item {
    id: i64,
    title: Option<String>,
    media_type: String,
    extension: String,
    length: Option<f64>,
    /// The set it is in, and how many files not in the trash that holds.
    set: Option<i64>,
    set_files: Option<i64>,
    has_thumbnail: bool,
    /// What to ask for its thumbnail as (`?v=`), so that it can be kept:
    /// it tells this file from any other that has had its ID.
    thumbnail_version: Option<String>,
    trashed: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/search", get(search))
        .route("/search/ids", get(search_ids))
}

/// Compiles `source`, narrowed to the files of `set` if one is given, and
/// otherwise to what `tab` holds if it is an upload, a download or a set
/// tab. A set is shown in its own order unless the query asks for another.
/// Returns whether it was narrowed to a set, too.
fn compile(
    conn: &Connection,
    source: &str,
    seed: i64,
    tab: Option<i64>,
    set: Option<i64>,
    include_trashed: bool,
) -> Result<(query::Compiled, bool), ApiError> {
    let mut compiled = query::compile(source, seed, &tags::aliases(conn)?, include_trashed)?;
    // What to narrow to: a tab's own list, or a set.
    let scope: Option<(String, Option<i64>)> = match (set, tab) {
        (Some(set), _) => Some(("set".to_string(), Some(set))),
        (None, Some(tab)) => conn
            .query_row("SELECT kind, set_key FROM tab WHERE id = ?1", [tab], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?,
        (None, None) => None,
    };
    let mut in_set = false;
    match (scope, tab) {
        (Some((kind, _)), Some(tab)) if kind == "upload" || kind == "download" => {
            compiled.filter = format!(
                "({}) AND e0.id IN (SELECT entity_id FROM tab_upload WHERE tab_id = ?)",
                compiled.filter
            );
            compiled.filter_params.push(Value::Integer(tab));
        }
        (Some((_, Some(set))), _) => {
            in_set = true;
            compiled.filter = format!("({}) AND f0.set_key = ?", compiled.filter);
            compiled.filter_params.push(Value::Integer(set));
            if !compiled.sorted {
                compiled.order = "f0.set_index IS NULL, f0.set_index, e0.id".to_string();
                compiled.order_params = Vec::new();
            }
        }
        _ => {}
    }
    Ok((compiled, in_set))
}

/// IDs of everything matching `source`, in the query's order. With
/// `collapse`, a set is listed once, as the first of its files found.
pub fn matching_ids(
    conn: &Connection,
    source: &str,
    seed: i64,
    tab: Option<i64>,
    set: Option<i64>,
    include_trashed: bool,
    collapse: bool,
) -> Result<Vec<i64>, ApiError> {
    let (compiled, in_set) = compile(conn, source, seed, tab, set, include_trashed)?;
    let sql = format!(
        "SELECT e0.id, f0.set_key FROM {} WHERE {} ORDER BY {}",
        query::FROM,
        compiled.filter,
        compiled.order
    );
    let params = compiled.filter_params.iter().chain(&compiled.order_params);
    let mut stmt = conn.prepare(&sql)?;
    let found = stmt
        .query_map(params_from_iter(params), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<(i64, Option<i64>)>>>()?;
    let mut listed = HashSet::new();
    let ids = found.into_iter().filter_map(|(id, set)| {
        let again = collapse && !in_set && set.is_some_and(|set| !listed.insert(set));
        (!again).then_some(id)
    });
    Ok(ids.collect())
}

async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = params.offset.max(0);
    let conn = state.db.lock().unwrap();
    let include_trashed = params.trashed.is_some();
    let (compiled, _) = compile(
        &conn,
        &params.q,
        params.seed,
        params.tab,
        params.set,
        include_trashed,
    )?;

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
        "SELECT e0.id, e0.title, f0.media_type, f0.extension, f0.length, f0.set_key,
                (SELECT count(*) FROM file sf JOIN entity se ON se.id = sf.entity_id
                 WHERE sf.set_key = f0.set_key AND se.trashed = 0),
                f0.has_thumbnail, f0.hash, e0.trashed
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
            let set: Option<i64> = row.get(5)?;
            let has_thumbnail: bool = row.get(7)?;
            let hash: String = row.get(8)?;
            Ok(Item {
                id: row.get(0)?,
                title: row.get(1)?,
                media_type: row.get(2)?,
                extension: row.get(3)?,
                length: row.get(4)?,
                set,
                set_files: set.and(row.get(6)?),
                has_thumbnail,
                thumbnail_version: has_thumbnail
                    .then(|| files::thumbnail_version(&hash).to_string()),
                trashed: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Json(
        json!({ "total": total, "offset": offset, "items": items }),
    ))
}

async fn search_ids(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let ids = matching_ids(
        &conn,
        &params.q,
        params.seed,
        params.tab,
        params.set,
        params.trashed.is_some(),
        params.collapse.is_some(),
    )?;
    Ok(Json(json!({ "ids": ids })))
}
