//! Tags: the values of the multi-value fields. A tag's type is its field,
//! and its value may sit in a namespace, written `namespace:tag`, nested to
//! any depth.

use std::collections::HashMap;

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{get, post},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppState,
    error::ApiError,
    query::{TAG_FIELDS, contains_pattern},
};

/// Tag fields whose values are not names, so a colon in them is not a
/// namespace separator.
const FLAT_FIELDS: &[&str] = &["source_url"];

const MAX_SUGGESTIONS: usize = 50;

#[derive(Deserialize)]
struct SuggestParams {
    field: String,
    #[serde(default)]
    q: String,
}

#[derive(Serialize)]
struct Suggestion {
    /// A tag, or a namespace with its trailing colon.
    value: String,
    /// Entities carrying the tag, or uses of every tag in the namespace.
    count: i64,
    namespace: bool,
}

#[derive(Deserialize)]
struct RenameInput {
    field: String,
    /// The namespace to rename, without a trailing colon.
    from: String,
    /// Its new name; empty moves its tags out of the namespace.
    #[serde(default)]
    to: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tags", get(suggest))
        .route("/tags/rename", post(rename))
}

pub fn check_field(field: &str) -> Result<(), ApiError> {
    if TAG_FIELDS.contains(&field) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!("`{field}` is not a tag field")))
    }
}

fn namespaced(field: &str) -> bool {
    !FLAT_FIELDS.contains(&field)
}

/// A tag value as it is stored: trimmed, and for namespaced fields with no
/// space around its colons. Empty values and empty parts are refused.
pub fn normalize(field: &str, value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ApiError::BadRequest(format!("empty value for `{field}`")));
    }
    if !namespaced(field) {
        return Ok(value.to_string());
    }
    let parts: Vec<&str> = value.split(':').map(str::trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(ApiError::BadRequest(format!(
            "`{value}` has an empty part: write `namespace:tag`"
        )));
    }
    Ok(parts.join(":"))
}

/// Completions for what has been typed into a tag field. For a namespaced
/// field they go one level at a time: the namespaces and tags directly under
/// the namespace typed so far.
async fn suggest(
    State(state): State<AppState>,
    Query(params): Query<SuggestParams>,
) -> Result<Json<Vec<Suggestion>>, ApiError> {
    check_field(&params.field)?;
    let typed = params.q.trim();
    // What is typed splits into the namespace being looked in, with its
    // colon, and the start of a name inside it.
    let (prefix, rest) = match typed.rfind(':') {
        Some(at) if namespaced(&params.field) => {
            let parts: Vec<&str> = typed[..at].split(':').map(str::trim).collect();
            (format!("{}:", parts.join(":")), typed[at + 1..].trim())
        }
        _ => (String::new(), typed),
    };
    let rest = rest.to_lowercase();

    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT t.value, count(*) FROM tag t JOIN entity_tag et ON et.tag_id = t.id
         WHERE t.field = ?1 AND t.value LIKE ?2 ESCAPE '\\'
         GROUP BY t.id",
    )?;
    // contains_pattern gives %text%; without the first % it is a prefix.
    let pattern = &contains_pattern(&prefix)[1..];
    let tags = stmt
        .query_map([params.field.as_str(), pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Best matches first: 0 starts with what was typed, 1 contains it, 2 is
    // a tag deeper down whose own name starts with it.
    let mut found: HashMap<String, (u8, Suggestion)> = HashMap::new();
    let rank = |name: &str| {
        let name = name.to_lowercase();
        match name.find(&rest) {
            Some(0) => Some(0),
            Some(_) => Some(1),
            None => None,
        }
    };
    for (value, uses) in tags {
        let Some(inside) = value.get(prefix.len()..) else {
            continue;
        };
        let below = inside.split_once(':').filter(|_| namespaced(&params.field));
        match below {
            Some((namespace, _)) => {
                if let Some(rank) = rank(namespace) {
                    let namespace = &value[..prefix.len() + namespace.len() + 1];
                    found
                        .entry(namespace.to_lowercase())
                        .or_insert_with(|| {
                            let value = namespace.to_string();
                            (rank, Suggestion { value, count: 0, namespace: true })
                        })
                        .1
                        .count += uses;
                }
                // Typing a bare name also finds it inside namespaces.
                let name = value.rsplit(':').next().unwrap_or("");
                if prefix.is_empty() && !rest.is_empty() && rank(name) == Some(0) {
                    let key = value.to_lowercase();
                    found.insert(key, (2, Suggestion { value, count: uses, namespace: false }));
                }
            }
            None => {
                if let Some(rank) = rank(inside) {
                    let key = value.to_lowercase();
                    found.insert(key, (rank, Suggestion { value, count: uses, namespace: false }));
                }
            }
        }
    }
    let mut found: Vec<_> = found.into_values().collect();
    found.sort_by(|(rank_a, a), (rank_b, b)| {
        rank_a
            .cmp(rank_b)
            .then(b.count.cmp(&a.count))
            .then_with(|| a.value.to_lowercase().cmp(&b.value.to_lowercase()))
    });
    found.truncate(MAX_SUGGESTIONS);
    Ok(Json(found.into_iter().map(|(_, suggestion)| suggestion).collect()))
}

/// Renames a namespace: every tag under it moves to the new one. Where a
/// tag of the new name already exists the two are merged.
async fn rename(
    State(state): State<AppState>,
    Json(input): Json<RenameInput>,
) -> Result<Json<Value>, ApiError> {
    check_field(&input.field)?;
    if !namespaced(&input.field) {
        return Err(ApiError::BadRequest(format!(
            "`{}` has no namespaces",
            input.field
        )));
    }
    let from = normalize(&input.field, &input.from)?;
    let to = match input.to.trim() {
        "" => String::new(),
        to => format!("{}:", normalize(&input.field, to)?),
    };

    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    let tags = {
        let mut stmt = tx.prepare(
            "SELECT id, value FROM tag WHERE field = ?1 AND value LIKE ?2 ESCAPE '\\'",
        )?;
        let pattern = &contains_pattern(&format!("{from}:"))[1..];
        stmt.query_map([input.field.as_str(), pattern], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    if tags.is_empty() {
        return Err(ApiError::NotFound);
    }
    for (id, value) in &tags {
        let renamed = format!("{to}{}", &value[from.len() + 1..]);
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM tag WHERE field = ?1 AND value = ?2 AND id <> ?3",
                params![input.field, renamed, id],
                |row| row.get(0),
            )
            .ok();
        match existing {
            Some(target) => {
                tx.execute(
                    "INSERT OR IGNORE INTO entity_tag (entity_id, tag_id)
                     SELECT entity_id, ?2 FROM entity_tag WHERE tag_id = ?1",
                    [id, &target],
                )?;
                tx.execute("DELETE FROM tag WHERE id = ?1", [id])?;
            }
            None => {
                tx.execute("UPDATE tag SET value = ?2 WHERE id = ?1", params![id, renamed])?;
            }
        }
    }
    tx.commit()?;
    Ok(Json(json!({ "renamed": tags.len() })))
}
