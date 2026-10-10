//! Bulk download: a zip of the selected files, streamed as it is built.
//!
//! An export is the same zip with the metadata in it too: beside each file
//! a sidecar, `<name>.json`, and one for each set the files are in that
//! says something of itself, in the format `schema.md` describes.
//! Uploading the zip to a library gives the files there what the sidecars
//! say.

use std::{
    collections::HashSet,
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
    /// Comma-separated file IDs. A form field, so that a plain HTML form
    /// can start the download.
    ids: String,
    /// Present to export: to put a sidecar with its metadata beside each
    /// file, and one in for each set.
    sidecars: Option<String>,
    /// What the files are called in the zip.
    #[serde(default)]
    names: Naming,
}

/// One thing to put in the zip, under a name.
enum Entry {
    /// A file from storage.
    File(PathBuf),
    /// The sidecar of a file, written when its turn comes.
    Sidecar(i64),
    /// The sidecar of a set.
    SetSidecar(i64),
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
    db: Arc<Mutex<Connection>>,
    writer: ChannelWriter,
) -> io::Result<()> {
    let mut zip = ZipWriter::new_stream(writer);
    // Media is already compressed; storing it as is keeps the export fast.
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);
    let text = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, entry) in entries {
        let meta = match entry {
            Entry::File(path) => {
                zip.start_file(name, stored).map_err(io::Error::other)?;
                io::copy(&mut File::open(path)?, &mut zip)?;
                continue;
            }
            Entry::Sidecar(id) => match sidecar::write(&db.lock().unwrap(), id) {
                Ok(meta) => Some(meta),
                // Deleted since the export began: it has no sidecar.
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(io::Error::other(err)),
            },
            Entry::SetSidecar(set) => sidecar::write_set(&db.lock().unwrap(), set)
                .map_err(io::Error::other)?
                .map(|(meta, _)| meta),
        };
        if let Some(meta) = meta {
            zip.start_file(name, text).map_err(io::Error::other)?;
            serde_json::to_writer_pretty(&mut zip, &meta)?;
        }
    }
    let mut writer = zip.finish().map_err(io::Error::other)?.into_inner();
    writer.flush()
}

/// The sidecars of the sets the files are in, each named for its set ID.
/// A set that says nothing of itself has none: its files say which it is.
fn set_sidecars(
    conn: &Connection,
    ids: &str,
    taken: &mut HashSet<String>,
) -> rusqlite::Result<Vec<(String, Entry)>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT s.id, s.set_id FROM set_file f JOIN file_set s ON s.id = f.set_key
         WHERE f.file_id IN (SELECT value FROM json_each(?1)) ORDER BY s.id",
    )?;
    let sets = stmt
        .query_map([ids], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
    let mut entries = Vec::new();
    for (set, set_id) in sets {
        if !sidecar::write_set(conn, set)?.is_some_and(|(_, says)| says) {
            continue;
        }
        let name = match safe_name(&set_id).as_str() {
            "" => "set".to_string(),
            name => name.to_string(),
        };
        let name = unique_name(&format!("{name}.json"), false, taken);
        entries.push((name, Entry::SetSidecar(set)));
    }
    Ok(entries)
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

    let ids = ids_json(&ids);
    let with_sidecars = input.sidecars.is_some();
    let mut taken = HashSet::new();
    let mut entries = Vec::new();
    {
        let conn = state.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT f.entity_id, f.hash, f.extension, f.original_name, e.title
             FROM file f JOIN entity e ON e.id = f.entity_id
             WHERE f.entity_id IN (SELECT value FROM json_each(?1)) ORDER BY f.entity_id",
        )?;
        let files = stmt
            .query_map([&ids], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<(i64, String, String, Option<String>, Option<String>)>>>()?;
        if files.is_empty() {
            return Err(ApiError::bad_request("nothing to export"));
        }
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
        if with_sidecars {
            entries.extend(set_sidecars(&conn, &ids, &mut taken)?);
        }
    }
    let db = state.db.clone();

    let (sender, receiver) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let failure = sender.clone();
        let writer = ChannelWriter {
            sender,
            buffer: Vec::with_capacity(CHUNK),
        };
        if let Err(err) = write_zip(entries, db, writer)
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
