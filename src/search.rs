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
    set: Option<String>,
    /// A group of variants to search within, as `set` is a set: the files
    /// that share this `alt_group_id`.
    variants: Option<String>,
    /// A collection to search within, in place of what `tab` holds: the
    /// files that are part of it, or in a set that is.
    collection: Option<String>,
    /// Present to have trashed entities included without `@trashed`.
    trashed: Option<String>,
    /// Present to have a set listed once, by the first of its files that
    /// the search finds. It does nothing to a search within a set or a
    /// group of variants.
    collapse: Option<String>,
}

/// A set a result is in.
#[derive(Serialize)]
struct ItemSet {
    set_id: String,
    title: Option<String>,
    /// How many files not in the trash it holds.
    files: i64,
}

impl SearchParams {
    fn scope(&self) -> Scope<'_> {
        Scope {
            tab: self.tab,
            set: self.set.as_deref(),
            variants: self.variants.as_deref(),
            collection: self.collection.as_deref(),
        }
    }
}

/// What the results grid needs to draw one file.
#[derive(Serialize)]
struct Item {
    id: i64,
    title: Option<String>,
    media_type: String,
    extension: String,
    length: Option<f64>,
    /// The sets it is in.
    set: Vec<ItemSet>,
    /// The group of variants it is one of, and how many files not in the
    /// trash are in it, this one included.
    alt_group_id: Option<String>,
    variants: Option<i64>,
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

/// What a search is kept to, besides what its query says.
#[derive(Default)]
pub struct Scope<'a> {
    /// A tab: what it holds, if it is an upload, a download or a set tab.
    pub tab: Option<i64>,
    /// A set, in place of what the tab holds.
    pub set: Option<&'a str>,
    /// A group of variants, in place of either.
    pub variants: Option<&'a str>,
    /// A collection, in place of any of those: what is part of it.
    pub collection: Option<&'a str>,
}

/// Compiles `source`, narrowed to its scope: what is part of a collection,
/// or the variants of a group, or the files of a set, or what a tab holds. A set is shown in its own
/// order unless the query asks for another. Returns whether it was
/// narrowed to a set or a group, too.
fn compile(
    conn: &Connection,
    source: &str,
    seed: i64,
    scope: &Scope,
    include_trashed: bool,
) -> Result<(query::Compiled, bool), ApiError> {
    let mut compiled = query::compile(source, seed, &tags::aliases(conn)?, include_trashed)?;
    if let Some(collection) = scope.collection {
        // As `collection=` finds them, but by the name exactly as it is.
        compiled.filter = format!(
            "({}) AND (EXISTS (SELECT 1 FROM collection l
                               WHERE l.entity_id = e0.id AND l.value = ?)
                       OR EXISTS (SELECT 1 FROM set_collection l JOIN set_file sf USING (set_id)
                                  WHERE sf.file_id = e0.id AND l.value = ?))",
            compiled.filter
        );
        let name = Value::Text(collection.to_string());
        compiled.filter_params.extend([name.clone(), name]);
        return Ok((compiled, false));
    }
    if let Some(group) = scope.variants {
        compiled.filter = format!("({}) AND f0.alt_group_id = ?", compiled.filter);
        compiled.filter_params.push(Value::Text(group.to_string()));
        return Ok((compiled, true));
    }
    let (tab, set) = (scope.tab, scope.set);
    // What to narrow to: a tab's own list, or a set.
    let scope: Option<(String, Option<String>)> = match (set, tab) {
        (Some(set), _) => Some(("set".to_string(), Some(set.to_string()))),
        (None, Some(tab)) => conn
            .query_row("SELECT kind, set_id FROM tab WHERE id = ?1", [tab], |row| {
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
            compiled.filter = format!(
                "({}) AND e0.id IN (SELECT file_id FROM set_file WHERE set_id = ?)",
                compiled.filter
            );
            compiled.filter_params.push(Value::Text(set.clone()));
            if !compiled.sorted {
                let index = "(SELECT set_index FROM set_file WHERE set_id = ? AND file_id = e0.id)";
                compiled.order = format!("{index} IS NULL, {index}, e0.id");
                compiled.order_params = vec![Value::Text(set); 2];
            }
        }
        _ => {}
    }
    Ok((compiled, in_set))
}

/// IDs of everything matching `source`, in the query's order. With
/// `collapse`, a set is listed once, as the first of its files found: a
/// file is passed over if a set it is in has been listed already.
pub fn matching_ids(
    conn: &Connection,
    source: &str,
    seed: i64,
    scope: &Scope,
    include_trashed: bool,
    collapse: bool,
) -> Result<Vec<i64>, ApiError> {
    let (compiled, in_set) = compile(conn, source, seed, scope, include_trashed)?;
    let sql = format!(
        "SELECT e0.id, (SELECT json_group_array(set_id) FROM set_file WHERE file_id = e0.id)
         FROM {} WHERE {} ORDER BY {}",
        query::FROM,
        compiled.filter,
        compiled.order
    );
    let params = compiled.filter_params.iter().chain(&compiled.order_params);
    let mut stmt = conn.prepare(&sql)?;
    let found = stmt
        .query_map(params_from_iter(params), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
    if !collapse || in_set {
        return Ok(found.into_iter().map(|(id, _)| id).collect());
    }
    let mut listed: HashSet<String> = HashSet::new();
    let ids = found.into_iter().filter_map(|(id, sets)| {
        let sets: Vec<String> = serde_json::from_str(&sets).unwrap_or_default();
        let again = sets.iter().any(|set| listed.contains(set));
        listed.extend(sets);
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
    let (compiled, _) = compile(&conn, &params.q, params.seed, &params.scope(), include_trashed)?;

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
        "SELECT e0.id, e0.title, f0.media_type, f0.extension, f0.length,
                f0.has_thumbnail, f0.hash, e0.trashed, f0.alt_group_id,
                (SELECT count(*) FROM file vf JOIN entity ve ON ve.id = vf.entity_id
                 WHERE vf.alt_group_id = f0.alt_group_id AND ve.trashed = 0)
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
            let has_thumbnail: bool = row.get(5)?;
            let hash: String = row.get(6)?;
            let alt_group_id: Option<String> = row.get(8)?;
            Ok(Item {
                id: row.get(0)?,
                title: row.get(1)?,
                media_type: row.get(2)?,
                extension: row.get(3)?,
                length: row.get(4)?,
                set: Vec::new(),
                variants: alt_group_id.as_ref().and(row.get(9)?),
                alt_group_id,
                has_thumbnail,
                thumbnail_version: has_thumbnail
                    .then(|| files::thumbnail_version(&hash).to_string()),
                trashed: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut items = items;
    let mut sets = conn.prepare(
        "SELECT f.set_id, i.title,
                (SELECT count(*) FROM set_file o JOIN entity oe ON oe.id = o.file_id
                 WHERE o.set_id = f.set_id AND oe.trashed = 0)
         FROM set_file f LEFT JOIN set_info i USING (set_id)
         WHERE f.file_id = ?1 ORDER BY f.set_id",
    )?;
    for item in &mut items {
        let found = sets.query_map([item.id], |row| {
            Ok(ItemSet {
                set_id: row.get(0)?,
                title: row.get(1)?,
                files: row.get(2)?,
            })
        })?;
        item.set = found.collect::<rusqlite::Result<_>>()?;
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
        &params.scope(),
        params.trashed.is_some(),
        params.collapse.is_some(),
    )?;
    Ok(Json(json!({ "ids": ids })))
}
