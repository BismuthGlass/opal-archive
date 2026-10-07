//! Unpacking an uploaded zip: each file in it is taken into the library as
//! if it had been uploaded by itself, and the archive is not kept.
//!
//! Its folders become collections: a folder is a set named for it, holding
//! its files in the order of their names, and a folder inside it is a set
//! inside that one. Files at the top of the archive go in no collection.
//! Only what the library can show is taken in, images, video, audio and
//! books; the rest is passed over, and the answer says of each what it was
//! and why.

use std::{
    cmp::Ordering,
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    path::Path,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Query, State},
    routing::post,
};
use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::{
    AppState, collections,
    error::ApiError,
    files::{self, TempFile, UploadParams},
    media,
};

/// Most that one archive is unpacked to, so that a hostile one, a few bytes
/// that unpack to everything, cannot fill the disk.
const MOST_BYTES: u64 = 100 << 30;
/// Most files one archive may hold.
const MOST_FILES: usize = 200_000;

/// What other systems leave in archives, which nobody put there on purpose.
const CLUTTER: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini"];

pub fn router() -> Router<AppState> {
    Router::new().route("/files/archive", post(upload))
}

/// A file of the archive that was not taken in.
#[derive(Serialize)]
struct Failure {
    /// Where it is in the archive.
    name: String,
    reason: String,
}

/// What came of unpacking an archive.
#[derive(Default, Serialize)]
struct Unpacked {
    /// Files that were new to the library, and ones it already had.
    added: u64,
    duplicates: u64,
    /// Collections made of its folders.
    collections: u64,
    failures: Vec<Failure>,
}

/// One file in the archive: which, and the folders it is in, then its name.
struct Entry {
    index: usize,
    parts: Vec<String>,
}

/// Compares names as a person would: by their numbers where they have
/// them, so that `page 2` comes before `page 10`, and without regard to case.
fn natural(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let number = |chars: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(digit) = chars.next_if(char::is_ascii_digit) {
                        digits.push(digit);
                    }
                    let digits = digits.trim_start_matches('0').to_string();
                    (digits.len(), digits)
                };
                // The longer number is the larger; of two as long, the one
                // that reads later.
                match number(&mut a).cmp(&number(&mut b)) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(x), Some(y)) if x == y => {
                a.next();
                b.next();
            }
            (Some(x), Some(y)) => return x.cmp(&y),
        }
    }
}

/// The files of an archive worth unpacking, in the order their folders and
/// names give, and those that cannot be, with why.
fn list(archive: &mut ZipArchive<File>) -> (Vec<Entry>, Vec<Failure>) {
    let (mut entries, mut failures) = (Vec::new(), Vec::new());
    for index in 0..archive.len() {
        // Read without unpacking it: only what it is called is wanted.
        let Ok(entry) = archive.by_index_raw(index) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        // A name that would lead out of the folder it is unpacked into is
        // not followed anywhere.
        let Some(path) = entry.enclosed_name() else {
            failures.push(Failure {
                name: entry.name().to_string(),
                reason: "its name leads outside the archive".to_string(),
            });
            continue;
        };
        let parts: Vec<String> = path
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect();
        let Some(name) = parts.last() else { continue };
        let clutter = parts.iter().any(|part| part == "__MACOSX")
            || name.starts_with("._")
            || CLUTTER.contains(&name.to_lowercase().as_str());
        if !clutter {
            entries.push(Entry { index, parts });
        }
    }
    // Folder by folder, a folder's own files before the folders inside it.
    entries.sort_by(|a, b| {
        let (a_folders, a_name) = a.parts.split_at(a.parts.len() - 1);
        let (b_folders, b_name) = b.parts.split_at(b.parts.len() - 1);
        let mut shared = a_folders.iter().zip(b_folders);
        shared
            .find_map(|(x, y)| Some(natural(x, y)).filter(|order| order.is_ne()))
            .unwrap_or_else(|| a_folders.len().cmp(&b_folders.len()))
            .then_with(|| natural(&a_name[0], &b_name[0]))
    });
    (entries, failures)
}

/// Unpacks one file of the archive to `out`, and returns its SHA-256 and
/// size. It is given up on if it grows past `most`.
fn extract(
    archive: &mut ZipArchive<File>,
    index: usize,
    out: &Path,
    most: u64,
) -> Result<(String, u64), String> {
    // Fails for one that is encrypted, or packed in a way not read here.
    let mut entry = archive.by_index(index).map_err(|err| err.to_string())?;
    let failed = |err: std::io::Error| err.to_string();
    let mut file = File::create(out).map_err(failed)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    let mut size = 0u64;
    loop {
        let read = entry.read(&mut buffer).map_err(failed)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > most {
            return Err("the archive unpacks to more than is allowed".to_string());
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(failed)?;
    }
    file.flush().map_err(failed)?;
    let hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((hash, size))
}

/// An error in the words shown to the user.
fn reason(err: ApiError) -> String {
    match err {
        ApiError::NotFound => "not found".to_string(),
        ApiError::BadRequest(message) | ApiError::Internal(message) => message,
        ApiError::Query(err) => err.message,
    }
}

/// The collection for a folder of the archive, made if this is the first
/// file to need it, along with the folders it is in. The outermost is
/// listed under the tab; each other is put in the one around it.
fn folder(
    state: &AppState,
    made: &mut HashMap<String, i64>,
    folders: &[String],
    tab: Option<i64>,
) -> Result<i64, ApiError> {
    let conn = state.db.lock().unwrap();
    let mut around = None;
    for depth in 1..=folders.len() {
        let key = folders[..depth].join("/");
        let collection = match made.get(&key) {
            Some(collection) => *collection,
            None => {
                conn.execute(
                    "INSERT INTO entity (kind, title) VALUES ('collection', ?1)",
                    [&folders[depth - 1]],
                )?;
                let collection = conn.last_insert_rowid();
                // Ordered: its files are put in by name, and stay so.
                conn.execute(
                    "INSERT INTO collection (entity_id, collection_type, ordered)
                     VALUES (?1, 'set', 1)",
                    [collection],
                )?;
                match (around, tab) {
                    (Some(around), _) => collections::add_members(&conn, around, &[collection])?,
                    (None, Some(tab)) => {
                        conn.execute(
                            "INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
                             SELECT id, ?2 FROM tab
                             WHERE id = ?1 AND kind IN ('upload', 'download') AND picked = 0",
                            params![tab, collection],
                        )?;
                    }
                    (None, None) => {}
                }
                // The tab's tags are for the folder as for its files.
                files::give_tab_tags(&conn, tab, &[collection])?;
                made.insert(key, collection);
                collection
            }
        };
        around = Some(collection);
    }
    around.ok_or_else(|| ApiError::Internal("a file in no folder has no collection".to_string()))
}

/// Takes a zip as the raw request body and unpacks it into the library.
/// The archive itself is not kept.
async fn upload(
    State(state): State<AppState>,
    Query(params): Query<UploadParams>,
    body: Body,
) -> Result<Json<Unpacked>, ApiError> {
    let temp = TempFile::new(&state.tmp);
    files::receive(body, &temp.0).await?;

    // Reading a zip blocks, so it is done off the threads that serve
    // requests; the archive is handed there and back for each file.
    let blocking = |err: tokio::task::JoinError| ApiError::Internal(err.to_string());
    let path = temp.0.clone();
    let opened = tokio::task::spawn_blocking(move || {
        let mut archive = ZipArchive::new(File::open(path)?)
            .map_err(|err| ApiError::BadRequest(format!("that is not a zip that can be read: {err}")))?;
        let (entries, failures) = list(&mut archive);
        Ok::<_, ApiError>((archive, entries, failures))
    });
    let (mut archive, entries, failures) = opened.await.map_err(blocking)??;
    if entries.len() > MOST_FILES {
        return Err(ApiError::BadRequest(format!(
            "the archive holds more than {MOST_FILES} files"
        )));
    }

    let mut unpacked = Unpacked {
        failures,
        ..Unpacked::default()
    };
    let mut made = HashMap::new();
    let mut left = MOST_BYTES;
    for Entry { index, parts } in entries {
        let fail = |unpacked: &mut Unpacked, reason: String| {
            unpacked.failures.push(Failure {
                name: parts.join("/"),
                reason,
            });
        };
        let out = TempFile::new(&state.tmp);
        let to = out.0.clone();
        let (back, extracted) = tokio::task::spawn_blocking(move || {
            let extracted = extract(&mut archive, index, &to, left);
            (archive, extracted)
        })
        .await
        .map_err(blocking)?;
        archive = back;
        let (hash, size) = match extracted {
            Ok(extracted) => extracted,
            Err(why) => {
                fail(&mut unpacked, why);
                continue;
            }
        };
        left -= size;

        let (folders, name) = parts.split_at(parts.len() - 1);
        let name = &name[0];
        let extension = files::extension_of(name);
        if extension == "zip" {
            fail(&mut unpacked, "an archive inside the archive is not unpacked".to_string());
            continue;
        }
        if size == 0 {
            fail(&mut unpacked, "an empty file".to_string());
            continue;
        }
        // Looked at before it is kept: what the library cannot show stays out.
        if media::media_type(&out.0, &extension).await == "other" {
            fail(&mut unpacked, "not an image, a video, audio or a book".to_string());
            continue;
        }
        // Only what is at the top of the archive is listed under the tab:
        // the rest is in its folders' collections.
        let listed = params.tab.filter(|_| folders.is_empty());
        let file = match files::ingest(&state, &out.0, &hash, size, Some(name), listed).await {
            Ok((file, true)) => {
                unpacked.added += 1;
                file
            }
            Ok((file, false)) => {
                unpacked.duplicates += 1;
                file
            }
            Err(err) => {
                fail(&mut unpacked, reason(err));
                continue;
            }
        };
        if !folders.is_empty() {
            // Not listed under the tab, it has not been given its tags.
            files::give_tab_tags(&state.db.lock().unwrap(), params.tab, &[file.id])?;
            let before = made.len();
            let collection = folder(&state, &mut made, folders, params.tab)?;
            unpacked.collections += (made.len() - before) as u64;
            collections::add_members(&state.db.lock().unwrap(), collection, &[file.id])?;
        }
    }
    Ok(Json(unpacked))
}
