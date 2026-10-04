use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as UrlPath, Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use http_body_util::BodyExt;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncWriteExt, process::Command};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{
    AppState,
    entities::{self, SOURCE_URLS},
    error::ApiError,
    media,
};

#[derive(Serialize)]
pub struct FileEntity {
    pub id: i64,
    date_added: String,
    hash: String,
    extension: String,
    media_type: String,
    size: i64,
    original_name: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    page_count: Option<i64>,
    length: Option<f64>,
    has_thumbnail: bool,
}

#[derive(Deserialize)]
struct UploadParams {
    /// Filename on the uploader's side; gives the extension.
    name: Option<String>,
    /// Upload tab to list the file under.
    tab: Option<i64>,
}

#[derive(Deserialize)]
struct FetchInput {
    /// The address of the file itself.
    url: String,
    /// Upload tab to list the file under.
    tab: Option<i64>,
}

#[derive(Deserialize)]
struct ContentParams {
    /// Present to have the browser save the file instead of showing it.
    download: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/files", post(upload))
        .route("/files/fetch", post(fetch))
        .route("/files/{id}/content", get(content))
        .route("/files/{id}/thumbnail", get(thumbnail))
}

const SELECT_FILE: &str = "
    SELECT e.id, e.date_added, f.hash, f.extension, f.media_type, f.size,
           f.original_name, f.width, f.height, f.page_count, f.length, f.has_thumbnail
    FROM file f JOIN entity e ON e.id = f.entity_id";

fn file_from_row(row: &Row) -> rusqlite::Result<FileEntity> {
    Ok(FileEntity {
        id: row.get(0)?,
        date_added: row.get(1)?,
        hash: row.get(2)?,
        extension: row.get(3)?,
        media_type: row.get(4)?,
        size: row.get(5)?,
        original_name: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        page_count: row.get(9)?,
        length: row.get(10)?,
        has_thumbnail: row.get(11)?,
    })
}

fn file_by_hash(conn: &Connection, hash: &str) -> rusqlite::Result<Option<FileEntity>> {
    conn.query_row(
        &format!("{SELECT_FILE} WHERE f.hash = ?1"),
        [hash],
        file_from_row,
    )
    .optional()
}

fn file_by_id(conn: &Connection, id: i64) -> rusqlite::Result<FileEntity> {
    conn.query_row(
        &format!("{SELECT_FILE} WHERE e.id = ?1"),
        [id],
        file_from_row,
    )
}

/// Name of a file inside internal storage: its hash, extension intact.
pub fn stored_name(hash: &str, extension: &str) -> String {
    if extension.is_empty() {
        hash.to_string()
    } else {
        format!("{hash}.{extension}")
    }
}

/// Name of a file's thumbnail inside the thumbnail directory.
pub fn thumbnail_name(hash: &str) -> String {
    format!("{hash}.jpg")
}

/// The last path component of an uploaded name, if there is one.
fn base_name(name: &str) -> Option<&str> {
    name.rsplit(['/', '\\'])
        .next()
        .filter(|base| !base.is_empty())
}

/// Lowercased extension without the dot, or empty if the name has none worth
/// keeping (dotfiles, or something too odd to be an extension).
fn extension_of(base: &str) -> String {
    match base.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && (1..=10).contains(&ext.len())
                && ext.bytes().all(|b| b.is_ascii_alphanumeric()) =>
        {
            ext.to_ascii_lowercase()
        }
        _ => String::new(),
    }
}

/// A partially received upload, deleted on drop unless it was moved away.
struct TempFile(PathBuf);

impl TempFile {
    fn new(dir: &Path) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        TempFile(dir.join(format!("{}-{n}", std::process::id())))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Streams the request body to `path`, returning its SHA-256 and size.
async fn receive(mut body: Body, path: &Path) -> Result<(String, u64), ApiError> {
    let mut file = fs::File::create(path).await?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    while let Some(frame) = body.frame().await {
        let frame =
            frame.map_err(|err| ApiError::BadRequest(format!("upload interrupted: {err}")))?;
        if let Ok(data) = frame.into_data() {
            hasher.update(&data);
            size += data.len() as u64;
            file.write_all(&data).await?;
        }
    }
    file.flush().await?;
    let hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((hash, size))
}

struct NewFile<'a> {
    hash: &'a str,
    extension: &'a str,
    media_type: &'a str,
    size: u64,
    original_name: Option<&'a str>,
    attributes: media::Attributes,
    has_thumbnail: bool,
}

fn insert(conn: &mut Connection, new: &NewFile) -> rusqlite::Result<FileEntity> {
    let tx = conn.transaction()?;
    tx.execute("INSERT INTO entity (kind) VALUES ('file')", [])?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO file (entity_id, hash, extension, media_type, size, original_name,
                           width, height, page_count, length, has_thumbnail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            new.hash,
            new.extension,
            new.media_type,
            new.size as i64,
            new.original_name,
            new.attributes.width,
            new.attributes.height,
            new.attributes.page_count,
            new.attributes.length,
            new.has_thumbnail,
        ],
    )?;
    let file = file_by_id(&tx, id)?;
    tx.commit()?;
    Ok(file)
}

/// Lists a file under an upload or download tab. Does nothing if the tab is
/// gone (it may have been closed meanwhile) or is of another kind.
fn record(conn: &Connection, tab: Option<i64>, file: &FileEntity) -> rusqlite::Result<()> {
    if let Some(tab) = tab {
        conn.execute(
            "INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
             SELECT id, ?2 FROM tab WHERE id = ?1 AND kind IN ('upload', 'download')",
            (tab, file.id),
        )?;
    }
    Ok(())
}

/// The SHA-256 and size of a file on disk.
pub async fn hash_file(path: &Path) -> Result<(String, u64), ApiError> {
    let path = path.to_path_buf();
    let hashed = tokio::task::spawn_blocking(move || -> std::io::Result<(String, u64)> {
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 1 << 16];
        let mut size = 0;
        loop {
            let read = std::io::Read::read(&mut file, &mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            size += read as u64;
        }
        let hash = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok((hash, size))
    })
    .await
    .map_err(|err| ApiError::Internal(err.to_string()))?;
    Ok(hashed?)
}

/// Takes the file as the raw request body. Answers 201 with the new file, or
/// 200 with the existing one if the same content is already in the library.
async fn upload(
    State(state): State<AppState>,
    Query(params): Query<UploadParams>,
    body: Body,
) -> Result<(StatusCode, Json<FileEntity>), ApiError> {
    let temp = TempFile::new(&state.tmp);
    let (hash, size) = receive(body, &temp.0).await?;
    let name = params.name.as_deref();
    let (file, created) = ingest(&state, &temp.0, &hash, size, name, params.tab).await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(file)))
}

/// What a browser says it is. Some sites refuse anything else.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
    (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/// The extension of a content type, for a file whose address has none.
fn extension_for(content_type: &str) -> Option<&'static str> {
    let kind = content_type.split(';').next().unwrap_or("").trim();
    Some(match kind.to_ascii_lowercase().as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "application/pdf" => "pdf",
        "application/epub+zip" => "epub",
        _ => return None,
    })
}

/// Undoes the percent-encoding of an address's path.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok());
        match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
            Some(byte) if bytes[i] == b'%' => {
                decoded.push(byte);
                i += 3;
            }
            _ => {
                decoded.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The name of the file at an address: the last part of its path, with the
/// extension its content type gives if it has none.
fn name_at(url: &str, content_type: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let path = path.split_once("://").map_or(path, |(_, rest)| rest);
    let last = path.split_once('/').map_or("", |(_, path)| path);
    let name = percent_decode(last.rsplit('/').next().unwrap_or(""));
    let name = base_name(&name).unwrap_or("").trim().to_string();
    match extension_for(content_type) {
        Some(extension) if extension_of(&name).is_empty() => {
            let stem = if name.is_empty() { "file" } else { &name };
            Some(format!("{stem}.{extension}"))
        }
        _ => Some(name).filter(|name| !name.is_empty()),
    }
}

/// Takes in the file at a web address, as an upload of it would be, with
/// the address as its source URL. The address has to be of the file
/// itself: a page is refused. Fetched with `curl`. Answers as `upload`
/// does.
async fn fetch(
    State(state): State<AppState>,
    Json(input): Json<FetchInput>,
) -> Result<(StatusCode, Json<FileEntity>), ApiError> {
    let url = entities::source_url(&input.url)?;
    let temp = TempFile::new(&state.tmp);
    let output = Command::new("curl")
        .args(["--silent", "--show-error", "--fail", "--location"])
        .args(["--proto", "=http,https", "--proto-redir", "=http,https"])
        .args(["--connect-timeout", "20", "--max-time", "1800"])
        .args(["--user-agent", USER_AGENT])
        // The type it was served as, then where redirects led.
        .args(["--write-out", "%{content_type}\n%{url_effective}"])
        .arg("--output")
        .arg(&temp.0)
        .args(["--", &url])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|err| ApiError::BadRequest(format!("curl is needed to fetch a file: {err}")))?;
    if !output.status.success() {
        // curl says what went wrong as `curl: (22) The requested URL…`.
        let said = String::from_utf8_lossy(&output.stderr);
        let said = said.trim().trim_start_matches("curl: ");
        return Err(ApiError::BadRequest(format!("could not fetch it: {said}")));
    }
    let written = String::from_utf8_lossy(&output.stdout).into_owned();
    let (content_type, landed) = written.split_once('\n').unwrap_or((&written, &url));
    if content_type
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("text/html")
    {
        return Err(ApiError::bad_request(
            "that address is a page, not a file: give the address of the file itself",
        ));
    }
    let name = name_at(landed, content_type);
    let (hash, size) = hash_file(&temp.0).await?;
    let (file, created) = ingest(&state, &temp.0, &hash, size, name.as_deref(), input.tab).await?;
    {
        let conn = state.db.lock().unwrap();
        entities::add_to_list(&conn, &entities::ids_json(&[file.id]), SOURCE_URLS, &url)?;
    }
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(file)))
}

/// Takes a file into the library: `temp`, somewhere under the server's own
/// temporary directory, with the hash and size it was found to have. If
/// the same content is already in the library the file there is kept and
/// `temp` is left for the caller to delete. Either way the file is listed
/// under `tab`. Returns the file, and whether it is new.
pub async fn ingest(
    state: &AppState,
    temp: &Path,
    hash: &str,
    size: u64,
    name: Option<&str>,
    tab: Option<i64>,
) -> Result<(FileEntity, bool), ApiError> {
    if size == 0 {
        return Err(ApiError::bad_request("empty file"));
    }
    {
        let conn = state.db.lock().unwrap();
        if let Some(existing) = file_by_hash(&conn, hash)? {
            // A file that arrives again comes back out of the trash. Nothing
            // else about the existing file changes.
            conn.execute("UPDATE entity SET trashed = 0 WHERE id = ?1", [existing.id])?;
            record(&conn, tab, &existing)?;
            return Ok((existing, false));
        }
    }

    let original_name = name.and_then(base_name);
    let extension = original_name.map(extension_of).unwrap_or_default();
    let stored = state.storage.join(stored_name(hash, &extension));
    fs::rename(temp, &stored).await?;

    let media_type = media::media_type(&stored, &extension).await;
    let attributes = media::probe(&stored, media_type, &extension).await;
    let thumbnail = state.thumbnails.join(thumbnail_name(hash));
    let has_thumbnail = media::thumbnail(
        &stored,
        media_type,
        &extension,
        attributes.length,
        &thumbnail,
    )
    .await;

    let new = NewFile {
        hash,
        extension: &extension,
        media_type,
        size,
        original_name,
        attributes,
        has_thumbnail,
    };
    let mut conn = state.db.lock().unwrap();
    match insert(&mut conn, &new) {
        Ok(file) => {
            record(&conn, tab, &file)?;
            Ok((file, true))
        }
        Err(err) => {
            // The same content may have arrived concurrently; if so the
            // other one won and ours is the duplicate.
            let winner = file_by_hash(&conn, hash)?;
            let kept = winner
                .as_ref()
                .map(|file| state.storage.join(stored_name(&file.hash, &file.extension)));
            if kept.as_ref() != Some(&stored) {
                let _ = std::fs::remove_file(&stored);
            }
            match winner {
                Some(file) => {
                    record(&conn, tab, &file)?;
                    Ok((file, false))
                }
                None => {
                    let _ = std::fs::remove_file(&thumbnail);
                    Err(err.into())
                }
            }
        }
    }
}

/// Percent-encodes a filename for `Content-Disposition: filename*=`.
fn encode_filename(name: &str) -> String {
    name.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// Serves a file from disk, with range requests and conditional gets.
async fn serve(path: &Path, request: Request) -> Result<Response, ApiError> {
    match ServeFile::new(path).oneshot(request).await {
        Ok(response) => Ok(response.map(Body::new)),
        Err(err) => Err(ApiError::Internal(err.to_string())),
    }
}

async fn content(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<i64>,
    Query(params): Query<ContentParams>,
    request: Request,
) -> Result<Response, ApiError> {
    let file = file_by_id(&state.db.lock().unwrap(), id)?;
    let stored = stored_name(&file.hash, &file.extension);
    let mut response = serve(&state.storage.join(&stored), request).await?;

    let headers = response.headers_mut();
    let disposition = if params.download.is_some() {
        "attachment"
    } else {
        "inline"
    };
    let name = encode_filename(file.original_name.as_deref().unwrap_or(&stored));
    if let Ok(value) = HeaderValue::from_str(&format!("{disposition}; filename*=UTF-8''{name}")) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    // Uploaded files are untrusted content served from the app's own origin:
    // keep browsers from guessing a type or running scripts in them. PDFs
    // are exempt because browsers refuse to display a sandboxed PDF.
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if file.extension != "pdf" {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("sandbox"),
        );
    }
    Ok(response)
}

async fn thumbnail(
    State(state): State<AppState>,
    UrlPath(id): UrlPath<i64>,
    request: Request,
) -> Result<Response, ApiError> {
    let file = file_by_id(&state.db.lock().unwrap(), id)?;
    if !file.has_thumbnail {
        return Err(ApiError::NotFound);
    }
    let path = state.thumbnails.join(thumbnail_name(&file.hash));
    let mut response = serve(&path, request).await?;
    // A file's content never changes, so neither does its thumbnail.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Ok(response)
}
