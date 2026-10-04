//! Bulk download: a zip of the selected files, streamed as it is built.

use std::{
    collections::HashSet,
    fs::File,
    io::{self, Write},
    path::PathBuf,
    pin::Pin,
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

use crate::{AppState, error::ApiError, files::stored_name};

/// Bytes gathered before a chunk is handed to the response.
const CHUNK: usize = 256 * 1024;

#[derive(Deserialize)]
struct ExportInput {
    /// Comma-separated entity IDs. A form field, so that a plain HTML form
    /// can start the download.
    ids: String,
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
fn unique_name(name: &str, taken: &mut HashSet<String>) -> String {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let mut candidate = name.to_string();
    let mut n = 2;
    while !taken.insert(candidate.to_lowercase()) {
        candidate = format!("{stem} ({n}){extension}");
        n += 1;
    }
    candidate
}

fn write_zip(entries: Vec<(String, PathBuf)>, writer: ChannelWriter) -> io::Result<()> {
    let mut zip = ZipWriter::new_stream(writer);
    // Media is already compressed; storing it as is keeps the export fast.
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);
    for (name, path) in entries {
        zip.start_file(name, options).map_err(io::Error::other)?;
        io::copy(&mut File::open(path)?, &mut zip)?;
    }
    let mut writer = zip.finish().map_err(io::Error::other)?.into_inner();
    writer.flush()
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
    let files = {
        let conn = state.db.lock().unwrap();
        let mut stmt = conn.prepare(
            "WITH RECURSIVE selected (id) AS (
                 SELECT value FROM json_each(?1)
                 UNION
                 SELECT m.member_id FROM membership m JOIN selected s ON m.collection_id = s.id
             )
             SELECT f.hash, f.extension, f.original_name
             FROM file f JOIN selected s ON s.id = f.entity_id ORDER BY f.entity_id",
        )?;
        let ids = serde_json::to_string(&ids).expect("integers serialize");
        stmt.query_map([ids], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<(String, String, Option<String>)>>>()?
    };
    if files.is_empty() {
        return Err(ApiError::bad_request("nothing to export"));
    }

    let mut taken = HashSet::new();
    let entries = files
        .into_iter()
        .map(|(hash, extension, original_name)| {
            let stored = stored_name(&hash, &extension);
            let name = unique_name(original_name.as_deref().unwrap_or(&stored), &mut taken);
            (name, state.storage.join(stored))
        })
        .collect();

    let (sender, receiver) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let failure = sender.clone();
        let writer = ChannelWriter {
            sender,
            buffer: Vec::with_capacity(CHUNK),
        };
        if let Err(err) = write_zip(entries, writer)
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
