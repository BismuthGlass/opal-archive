//! The metadata of a file or of a set as a JSON sidecar, in the format
//! `schema.md` describes: written beside each file of an export, and read
//! back from the sidecars of a zip that is uploaded.

use rusqlite::{Connection, params, types::Value as SqlValue};
use serde_json::{Map, Value, json};

use crate::{
    archive::reason,
    entities::{self, COLLECTIONS, IDENTIFIERS, REFERENCES, SCALARS, SOURCE_URLS},
    collections,
    query::TAG_FIELDS,
    sets, tags,
};

/// What a sidecar holds: field to value.
pub type Metadata = Map<String, Value>;

/// A field with nothing in it is left out.
fn filled(mut meta: Metadata) -> Metadata {
    meta.retain(|_, value| !value.is_null() && value.as_array().is_none_or(|list| !list.is_empty()));
    meta
}

/// The sidecar of a file.
pub fn write(conn: &Connection, id: i64) -> rusqlite::Result<Metadata> {
    let mut meta = conn.query_row(
        &format!(
            "SELECT date_added, {} FROM entity WHERE id = ?1",
            SCALARS.join(", ")
        ),
        [id],
        |row| {
            let mut meta = Map::new();
            meta.insert("metadata_type".into(), json!("file"));
            meta.insert("date_added".into(), json!(row.get::<_, String>(0)?));
            for (i, field) in SCALARS.iter().enumerate() {
                meta.insert(field.to_string(), entities::to_json(row.get(1 + i)?));
            }
            Ok(meta)
        },
    )?;
    for (field, values) in entities::tags_of(conn, id)? {
        meta.insert(field, json!(values));
    }
    for list in [SOURCE_URLS, IDENTIFIERS, REFERENCES, COLLECTIONS] {
        meta.insert(list.0.into(), json!(entities::list_of(conn, list, id)?));
    }
    let sets = entities::sets_of_file(conn, id)?.into_iter().map(|set| {
        let mut within = Map::new();
        within.insert("set_id".into(), set["set_id"].clone());
        if !set["index"].is_null() {
            within.insert("set_index".into(), set["index"].clone());
        }
        Value::Object(within)
    });
    meta.insert("set".into(), Value::Array(sets.collect()));
    // What it is as a file; the flags that are the library's own business
    // stay out.
    if let Some(Value::Object(detail)) = entities::file_details(conn, id)? {
        for (field, value) in detail {
            if field != "has_thumbnail" {
                meta.insert(field, value);
            }
        }
    }
    Ok(filled(meta))
}

/// The sidecar of a set, if anything is known of it but its ID: one that
/// is its ID alone has none, as its files say that ID themselves.
pub fn write_set(conn: &Connection, set: &str) -> rusqlite::Result<Option<Metadata>> {
    if !sets::known(conn, set)? {
        return Ok(None);
    }
    let Value::Object(mut meta) = sets::describe(conn, set)? else {
        return Ok(None);
    };
    // The library's own business, as above.
    meta.remove("files");
    let mut whole = Map::new();
    whole.insert("metadata_type".into(), json!("set"));
    whole.extend(filled(meta));
    Ok(Some(whole))
}

/// The sidecar of a collection, if anything is known of it but its name:
/// one that is its name alone has none, as the files that are part of it
/// say that name themselves.
pub fn write_collection(conn: &Connection, name: &str) -> rusqlite::Result<Option<Metadata>> {
    if !collections::known(conn, name)? {
        return Ok(None);
    }
    let Value::Object(mut meta) = collections::describe(conn, name)? else {
        return Ok(None);
    };
    // The library's own business, as above.
    meta.remove("files");
    let mut whole = Map::new();
    whole.insert("metadata_type".into(), json!("collection"));
    whole.extend(filled(meta));
    Ok(Some(whole))
}

/// The text values of a field that holds a list of them. One by itself is
/// taken as a list of one.
fn texts<'a>(meta: &'a Metadata, field: &str, problems: &mut Vec<String>) -> Vec<&'a str> {
    let all = |values: &'a Vec<Value>| values.iter().map(Value::as_str).collect::<Option<Vec<_>>>();
    match meta.get(field) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(value)) => vec![value],
        Some(Value::Array(values)) if all(values).is_some() => all(values).unwrap_or_default(),
        Some(_) => {
            problems.push(format!("`{field}` must be a list of text"));
            Vec::new()
        }
    }
}

/// Gives a file what a sidecar says of it. Tags, source URLs, identifiers,
/// references and collections are added to what it has; a field that holds one value
/// is only filled in where the file has none. What only the library
/// decides (when it was added, the name of the file) is taken from the
/// sidecar for a file that is `new`, and left alone otherwise. Which sets
/// it is in is for `wanted_sets`.
/// What the file itself says (its hash, its size, its dimensions) is never
/// read from a sidecar. Each thing in it that could not be used is added
/// to `problems`, and the rest still is.
pub fn apply(
    conn: &Connection,
    id: i64,
    meta: &Metadata,
    new: bool,
    problems: &mut Vec<String>,
) -> rusqlite::Result<()> {
    let scalar = |field: &str, problems: &mut Vec<String>| {
        let value = meta.get(field)?;
        match entities::scalar_value(field, value) {
            Ok(SqlValue::Null) => None,
            Ok(value) => Some(value),
            Err(err) => {
                problems.push(reason(err));
                None
            }
        }
    };
    for field in SCALARS {
        if let Some(value) = scalar(field, problems) {
            conn.execute(
                &format!("UPDATE entity SET {field} = ?2 WHERE id = ?1 AND {field} IS NULL"),
                params![id, value],
            )?;
        }
    }
    if let Some(group) = scalar("alt_group_id", problems) {
        conn.execute(
            "UPDATE file SET alt_group_id = ?2 WHERE entity_id = ?1 AND alt_group_id IS NULL",
            params![id, group],
        )?;
    }
    if new {
        if let Some(name) = scalar("original_name", problems) {
            conn.execute(
                "UPDATE file SET original_name = ?2 WHERE entity_id = ?1",
                params![id, name],
            )?;
        }
        match meta.get("looping") {
            None | Some(Value::Null) => {}
            Some(Value::Bool(looping)) => {
                conn.execute(
                    "UPDATE file SET looping = ?2 WHERE entity_id = ?1",
                    params![id, looping],
                )?;
            }
            Some(_) => problems.push("`looping` must be true or false".to_string()),
        }
        if let Some(added) = meta.get("date_added").filter(|added| !added.is_null()) {
            // Only as the library writes it: to the second, in UTC.
            let set = match added.as_str() {
                Some(added) => conn.execute(
                    "UPDATE entity SET date_added = ?2
                     WHERE id = ?1 AND strftime('%Y-%m-%dT%H:%M:%SZ', ?2) = ?2",
                    params![id, added],
                )?,
                None => 0,
            };
            if set == 0 {
                problems.push(
                    "`date_added` must be a date and time like 2026-10-03T12:20:37Z".to_string(),
                );
            }
        }
    }

    let ids = entities::ids_json(&[id]);
    for field in TAG_FIELDS {
        for value in texts(meta, field, problems) {
            match tags::normalize(field, value) {
                Ok(value) => {
                    // An alias stands for the tag it defers to.
                    let value = tags::resolve(conn, field, value)?;
                    entities::attach_tag(conn, &ids, field, &value)?;
                }
                Err(err) => problems.push(reason(err)),
            }
        }
    }
    for url in texts(meta, "source_url", problems) {
        match entities::source_url(url) {
            Ok(url) => entities::add_to_list(conn, &ids, SOURCE_URLS, &url)?,
            Err(err) => problems.push(reason(err)),
        }
    }
    for list in [IDENTIFIERS, REFERENCES, COLLECTIONS] {
        for value in texts(meta, list.0, problems) {
            match value.trim() {
                "" => problems.push(format!("empty {}", list.0)),
                value => entities::add_to_list(conn, &ids, list, value)?,
            }
        }
    }
    Ok(())
}

/// A set ID a sidecar gives, as it is kept. `within` is a set's sidecar, or
/// one of the sets a file's sidecar lists.
fn set_id(within: &Metadata, problems: &mut Vec<String>) -> Option<String> {
    match within.get("set_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.trim().to_string()).filter(|id| !id.is_empty()),
        Some(_) => {
            problems.push("`set_id` must be text".to_string());
            None
        }
    }
}

/// The sets a file's sidecar says it is in, under `set`, and where in
/// each. A set is given by its ID alone, as a collection is by its name,
/// or with the file's place in it.
pub fn wanted_sets(meta: &Metadata, problems: &mut Vec<String>) -> Vec<(String, Option<i64>)> {
    let listed = match meta.get("set") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(listed)) => listed.iter().collect(),
        Some(one) => vec![one],
    };
    let mut wanted: Vec<(String, Option<i64>)> = Vec::new();
    for within in listed {
        let (set, index) = match within {
            Value::String(id) => (Some(id.trim().to_string()).filter(|id| !id.is_empty()), None),
            Value::Object(within) => {
                let index = match within.get("set_index") {
                    None | Some(Value::Null) => None,
                    Some(index) if index.is_i64() => index.as_i64(),
                    Some(_) => {
                        problems.push("`set_index` must be a whole number".to_string());
                        None
                    }
                };
                (set_id(within, problems), index)
            }
            _ => (None, None),
        };
        match set {
            Some(set) if !wanted.iter().any(|(had, _)| *had == set) => wanted.push((set, index)),
            Some(_) => {}
            None => problems.push("each of `set` must have a `set_id`".to_string()),
        }
    }
    wanted
}

/// The set a set's sidecar is of: the one whose ID it gives, or else the
/// set `otherwise`.
pub fn set_of(meta: &Metadata, otherwise: &str, problems: &mut Vec<String>) -> String {
    set_id(meta, problems).unwrap_or_else(|| otherwise.to_string())
}

/// Gives a set what its sidecar says of it, as `apply` does a file: its
/// title and description where it has none, and the lists added to.
pub fn apply_set(
    conn: &Connection,
    set: &str,
    meta: &Metadata,
    problems: &mut Vec<String>,
) -> rusqlite::Result<()> {
    for field in ["title", "description"] {
        match meta.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) if text.trim().is_empty() => {}
            Some(Value::String(text)) => sets::fill(conn, set, field, text.trim())?,
            Some(_) => problems.push(format!("`{field}` must be text")),
        }
    }
    for url in texts(meta, "source_url", problems) {
        match entities::source_url(url) {
            Ok(url) => sets::add_to_list(conn, set, sets::SOURCE_URLS, &url)?,
            Err(err) => problems.push(reason(err)),
        }
    }
    let plain = [
        ("identifier", sets::IDENTIFIERS),
        ("reference", sets::REFERENCES),
        ("collection", sets::COLLECTIONS),
    ];
    for (field, list) in plain {
        for value in texts(meta, field, problems) {
            match value.trim() {
                "" => problems.push(format!("empty {field}")),
                value => sets::add_to_list(conn, set, list, value)?,
            }
        }
    }
    Ok(())
}

/// Keeps what a collection's sidecar says of it, as `apply_set` does for a
/// set: its title and description where it has none, and the lists added
/// to. A sidecar that gives no name is of the collection `otherwise`.
pub fn apply_collection(
    conn: &Connection,
    meta: &Metadata,
    otherwise: &str,
    problems: &mut Vec<String>,
) -> rusqlite::Result<()> {
    let name = match meta.get("name") {
        None | Some(Value::Null) => otherwise,
        Some(Value::String(name)) if !name.trim().is_empty() => name.trim(),
        Some(_) => {
            problems.push("`name` must be text".to_string());
            return Ok(());
        }
    };
    for field in ["title", "description"] {
        match meta.get(field) {
            None | Some(Value::Null) => {}
            Some(Value::String(text)) if text.trim().is_empty() => {}
            Some(Value::String(text)) => collections::fill(conn, name, field, text.trim())?,
            Some(_) => problems.push(format!("`{field}` must be text")),
        }
    }
    for url in texts(meta, "source_url", problems) {
        match entities::source_url(url) {
            Ok(url) => collections::add_to_list(conn, name, collections::SOURCE_URLS, &url)?,
            Err(err) => problems.push(reason(err)),
        }
    }
    let plain = [
        ("identifier", collections::IDENTIFIERS),
        ("reference", collections::REFERENCES),
    ];
    for (field, list) in plain {
        for value in texts(meta, field, problems) {
            match value.trim() {
                "" => problems.push(format!("empty {field}")),
                value => collections::add_to_list(conn, name, list, value)?,
            }
        }
    }
    Ok(())
}
