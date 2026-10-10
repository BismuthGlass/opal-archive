//! Bulk download: a zip of the selected files, streamed as it is built.
//!
//! An export is the same zip with the metadata in it too: beside each file
//! a sidecar, `<name>.json`, and one for each collection the files are in
//! or that was selected, in the format `schema.md` describes. Uploading
//! the zip to a library gives the files there what the sidecars say.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{self, Write},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use axum::{
    Form, Router,
    body::Body,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    routing::post,
};
use bytes::Bytes;
use futures_core::Stream;
use serde::Deserialize;
use tokio::sync::mpsc;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use rusqlite::Connection;

use crate::{
    AppState,
    entities::ids_json,
    error::ApiError,
    files::{Naming, download_name, safe_name, stored_name},
    sidecar,
};

/// Bytes gathered before a chunk is handed to the response.
const CHUNK: usize = 256 * 1024;

#[derive(Deserialize)]
struct ExportInput {
    /// Comma-separated entity IDs. A form field, so that a plain HTML form
    /// can start the download.
    ids: String,
    /// Present to export: to put a sidecar with its metadata beside each
    /// file, and one in for each collection.
    sidecars: Option<String>,
    /// What the files are called in the zip.
    #[serde(default)]
    names: Naming,
}

/// One thing to put in the zip, under a name.
enum Entry {
    /// A file from storage.
    File(PathBuf),
    /// The sidecar of an entity, written when its turn comes.
    Sidecar(i64),
}

/// What an export needs for writing its sidecars.
struct Sidecars {
    db: Arc<Mutex<Connection>>,
    /// What the export calls each of its collections.
    names: HashMap<i64, String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/export", post(export))
}

/// A `Write` that forwards what it is given to the response body.
struct ChannelWriter {
    sender: mpsc::Sender<io::Result<Bytes>>,
    buffer: Vec<u8>,
}

impl ChannelWriter {
    fn send(&mut self) -> io::Result<()> {
        let chunk = Bytes::from(std::mem::take(&mut self.buffer));
        // Fails once the client has gone away, which stops the export.
        self.sender
            .blocking_send(Ok(chunk))
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(data);
        if self.buffer.len() >= CHUNK {
            self.send()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            self.send()
        }
    }
}

struct ChannelStream(mpsc::Receiver<io::Result<Bytes>>);

impl Stream for ChannelStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(cx)
    }
}

/// Makes `name` unique within the archive by adding " (2)", " (3)", … before
/// the extension. Compared case-insensitively, for filesystems that are.
/// With `sidecar`, the name of its sidecar is taken along with it.
fn unique_name(name: &str, sidecar: bool, taken: &mut HashSet<String>) -> String {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let beside = |candidate: &str| format!("{}.json", candidate.to_lowercase());
    let mut candidate = name.to_string();
    let mut n = 2;
    while taken.contains(&candidate.to_lowercase())
        || (sidecar && taken.contains(&beside(&candidate)))
    {
        candidate = format!("{stem} ({n}){extension}");
        n += 1;
    }
    taken.insert(candidate.to_lowercase());
    if sidecar {
        taken.insert(beside(&candidate));
    }
    candidate
}

fn write_zip(
    entries: Vec<(String, Entry)>,
    sidecars: Option<Sidecars>,
    writer: ChannelWriter,
) -> io::Result<()> {
    let mut zip = ZipWriter::new_stream(writer);
    // Media is already compressed; storing it as is keeps the export fast.
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);
    let text = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, entry) in entries {
        match (entry, &sidecars) {
            (Entry::File(path), _) => {
                zip.start_file(name, stored).map_err(io::Error::other)?;
                io::copy(&mut File::open(path)?, &mut zip)?;
            }
            (Entry::Sidecar(id), Some(sidecars)) => {
                let written = sidecar::write(&sidecars.db.lock().unwrap(), id, &sidecars.names);
                let meta = match written {
                    Ok(meta) => meta,
                    // Deleted since the export began: it has no sidecar.
                    Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                    Err(err) => return Err(io::Error::other(err)),
                };
                zip.start_file(name, text).map_err(io::Error::other)?;
                serde_json::to_writer_pretty(&mut zip, &meta)?;
            }
            (Entry::Sidecar(_), None) => {}
        }
    }
    let mut writer = zip.finish().map_err(io::Error::other)?.into_inner();
    writer.flush()
}

/// The collections an export has sidecars for: those among `ids` and
/// inside them, at any depth, and every collection that any of that is
/// in. With each, its collection ID if it has one.
fn collections(conn: &Connection, ids: &str) -> rusqlite::Result<Vec<(i64, Option<String>)>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE selected (id) AS (
             SELECT value FROM json_each(?1)
             UNION
             SELECT m.member_id FROM membership m JOIN selected s ON m.collection_id = s.id
         ),
         around (id) AS (
             SELECT id FROM selected
             UNION
             SELECT m.collection_id FROM membership m JOIN around a ON m.member_id = a.id
         )
         SELECT c.entity_id, c.collection_id
         FROM collection c JOIN around a ON a.id = c.entity_id ORDER BY c.entity_id",
    )?;
    stmt.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect()
}

/// Names the sidecar of each collection, and says what the export calls
/// the collection: its collection ID, or for one that has none the name of
/// its sidecar, which is then no collection's ID.
fn name_collections(
    collections: Vec<(i64, Option<String>)>,
    taken: &mut HashSet<String>,
) -> (Vec<(String, Entry)>, HashMap<i64, String>) {
    let (mut entries, mut names) = (Vec::new(), HashMap::new());
    let ids: HashSet<String> = collections
        .iter()
        .filter_map(|(_, id)| id.as_ref().map(|id| id.to_lowercase()))
        .collect();
    // Those with an ID first, so that each has its sidecar by that name
    // where it can.
    for (collection, id) in &collections {
        if let Some(id) = id {
            let name = match safe_name(id).as_str() {
                "" => "collection".to_string(),
                name => name.to_string(),
            };
            let name = unique_name(&format!("{name}.json"), false, taken);
            entries.push((name, Entry::Sidecar(*collection)));
            names.insert(*collection, id.clone());
        }
    }
    for (collection, id) in &collections {
        if id.is_none() {
            let mut stem = format!("collection-{collection}");
            while ids.contains(&stem) || taken.contains(&format!("{stem}.json")) {
                stem.push('_');
            }
            taken.insert(format!("{stem}.json"));
            entries.push((format!("{stem}.json"), Entry::Sidecar(*collection)));
            names.insert(*collection, stem);
        }
    }
    (entries, names)
}

async fn export(
    State(state): State<AppState>,
    Form(input): Form<ExportInput>,
) -> Result<Response, ApiError> {
    let ids = input
        .ids
        .split(',')
        .map(|id| id.trim().parse::<i64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ApiError::bad_request("`ids` must be comma-separated numbers"))?;

    // Collections stand for the files inside them, at any depth.
    let ids = ids_json(&ids);
    let with_sidecars = input.sidecars.is_some();
    let (files, collections) = {
        let conn = state.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "WITH RECURSIVE selected (id) AS (
                 SELECT value FROM json_each(?1)
                 UNION
                 SELECT m.member_id FROM membership m JOIN selected s ON m.collection_id = s.id
             )
             SELECT f.entity_id, f.hash, f.extension, f.original_name, e.title
             FROM file f JOIN selected s ON s.id = f.entity_id
             JOIN entity e ON e.id = f.entity_id ORDER BY f.entity_id",
        )?;
        let files = stmt
            .query_map([&ids], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<(i64, String, String, Option<String>, Option<String>)>>>()?;
        let collections = if with_sidecars {
            collections(&conn, &ids)?
        } else {
            Vec::new()
        };
        (files, collections)
    };
    // A collection with no files in it is still something to export.
    if files.is_empty() && collections.is_empty() {
        return Err(ApiError::bad_request("nothing to export"));
    }

    let mut taken = HashSet::new();
    let mut entries = Vec::new();
    for (id, hash, extension, original_name, title) in files {
        let stored = stored_name(&hash, &extension);
        let name = download_name(
            input.names,
            original_name.as_deref(),
            title.as_deref(),
            &hash,
            &extension,
        );
        let name = unique_name(&name, with_sidecars, &mut taken);
        if with_sidecars {
            entries.push((format!("{name}.json"), Entry::Sidecar(id)));
        }
        entries.push((name, Entry::File(state.storage.join(stored))));
    }
    let sidecars = with_sidecars.then(|| {
        let (sidecars, names) = name_collections(collections, &mut taken);
        entries.extend(sidecars);
        Sidecars {
            db: state.db.clone(),
            names,
        }
    });

    let (sender, receiver) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let failure = sender.clone();
        let writer = ChannelWriter {
            sender,
            buffer: Vec::with_capacity(CHUNK),
        };
        if let Err(err) = write_zip(entries, sidecars, writer)
            && err.kind() != io::ErrorKind::BrokenPipe
        {
            eprintln!("export failed: {err}");
            // Ends the response abruptly, so the download shows as failed
            // rather than as a complete but truncated archive.
            let _ = failure.blocking_send(Err(err));
        }
    });

    let headers = [
        (header::CONTENT_TYPE, "application/zip"),
        (
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"opalarchive-export.zip\"",
        ),
    ];
    Ok((headers, Body::from_stream(ChannelStream(receiver))).into_response())
}
