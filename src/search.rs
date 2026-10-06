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
    /// Tab to search within: an upload tab's files, or a collection tab's
    /// members.
    tab: Option<i64>,
    /// Collection to search within, in place of what `tab` holds: the
    /// collection a tab has gone into.
    collection: Option<i64>,
    /// Present to have trashed entities included without `@trashed`.
    trashed: Option<String>,
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
    /// What to ask for that thumbnail as (`?v=`), so that it can be kept:
    /// it tells this file from any other that has had its ID.
    thumbnail_version: Option<String>,
    /// Members not in the trash.
    member_count: Option<i64>,
    trashed: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/search", get(search))
        .route("/search/ids", get(search_ids))
}

/// Compiles `source`, narrowed to the members of `collection` if one is
/// given, and otherwise to what `tab` holds if it is an upload, a download
/// or a collection tab. An ordered collection is shown in its own order
/// unless the query asks for another. A collection in the trash is shown
/// with its trashed members too: they went there with it.
fn compile(
    conn: &Connection,
    source: &str,
    seed: i64,
    tab: Option<i64>,
    collection: Option<i64>,
    include_trashed: bool,
) -> Result<query::Compiled, ApiError> {
    // What to narrow to: a tab's own list, or a collection and whether it
    // is ordered. A collection that is gone has no members.
    let scope: Option<(String, Option<i64>, Option<bool>)> = match (collection, tab) {
        (Some(collection), _) => {
            let ordered = conn
                .query_row(
                    "SELECT ordered FROM collection WHERE entity_id = ?1",
                    [collection],
                    |row| row.get(0),
                )
                .optional()?;
            Some(("collection".to_string(), Some(collection), ordered))
        }
        (None, Some(tab)) => conn
            .query_row(
                "SELECT t.kind, t.collection_id, c.ordered FROM tab t
                 LEFT JOIN collection c ON c.entity_id = t.collection_id WHERE t.id = ?1",
                [tab],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?,
        (None, None) => None,
    };
    let in_trash = match &scope {
        Some((_, Some(collection), _)) => conn
            .query_row(
                "SELECT trashed FROM entity WHERE id = ?1",
                [collection],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false),
        _ => false,
    };
    let mut compiled = query::compile(
        source,
        seed,
        &tags::aliases(conn)?,
        include_trashed || in_trash,
    )?;
    match (scope, tab) {
        (Some((kind, _, _)), Some(tab)) if kind == "upload" || kind == "download" => {
            compiled.filter = format!(
                "({}) AND e0.id IN (SELECT entity_id FROM tab_upload WHERE tab_id = ?)",
                compiled.filter
            );
            compiled.filter_params.push(Value::Integer(tab));
        }
        (Some((_, Some(collection), ordered)), _) => {
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
    collection: Option<i64>,
    include_trashed: bool,
) -> Result<Vec<i64>, ApiError> {
    let compiled = compile(conn, source, seed, tab, collection, include_trashed)?;
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
    let include_trashed = params.trashed.is_some();
    let compiled = compile(
        &conn,
        &params.q,
        params.seed,
        params.tab,
        params.collection,
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
        "SELECT e0.id, e0.kind, e0.title, f0.media_type, f0.extension,
                f0.length, c0.collection_type,
                CASE
                    WHEN f0.has_thumbnail = 1 THEN e0.id
                    WHEN c0.entity_id IS NOT NULL THEN (
                        SELECT m.member_id FROM membership m
                        JOIN file mf ON mf.entity_id = m.member_id
                        JOIN entity me ON me.id = m.member_id
                        WHERE m.collection_id = e0.id AND mf.has_thumbnail = 1
                          AND (me.trashed = 0 OR e0.trashed = 1)
                        ORDER BY m.position IS NULL, m.position, m.member_id LIMIT 1)
                END,
                CASE WHEN c0.entity_id IS NOT NULL THEN
                    (SELECT count(*) FROM membership m
                     JOIN entity me ON me.id = m.member_id
                     WHERE m.collection_id = e0.id AND (me.trashed = 0 OR e0.trashed = 1))
                END,
                e0.trashed
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
                thumbnail_version: None,
                member_count: row.get(8)?,
                trashed: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut items = items;
    let mut version = conn.prepare("SELECT hash FROM file WHERE entity_id = ?1")?;
    for item in &mut items {
        if let Some(file) = item.thumbnail {
            let hash: String = version.query_row([file], |row| row.get(0))?;
            item.thumbnail_version = Some(files::thumbnail_version(&hash).to_string());
        }
    }

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
        params.collection,
        params.trashed.is_some(),
    )?;
    Ok(Json(json!({ "ids": ids })))
}
