//! Unpacking an uploaded zip: each file in it is taken into the library as
//! if it had been uploaded by itself, and the archive is not kept.
//!
//! Its folders become sets: a folder is a set named for it, holding the
//! files directly in it in the order of their names. Files at the top of
//! the archive go in no set. Only what the library can show is taken in,
//! images, video, audio and books; the rest is passed over, and the answer
//! says of each what it was and why.
//!
//! A sidecar in it, `<name>.json` beside a file, gives that file its
//! metadata, as `schema.md` describes and an export writes: the sets it
//! names are the file's sets, whatever folder the file is in. A `_set.json`
//! in a folder says which set the folder is and what is known of it, and
//! a sidecar that says it is of a set, wherever it is, does so for that
//! set: the one in the library that has its set ID, or a new one. One that
//! says it is of a collection gives what it knows of that collection. The
//! sidecars are not kept either.
//!
//! A file can be in several sets, and one the library already had is put
//! in the sets the archive names besides those it is in. Only a folder that
//! does not say which set it is takes none that is in a set already: sent
//! again, such an archive makes no second set of the same files.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
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
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::{
    AppState,
    error::ApiError,
    files::{self, TempFile, UploadParams},
    media, sets,
    sidecar::{self, Metadata},
};

/// Most that one archive is unpacked to, so that a hostile one, a few bytes
/// that unpack to everything, cannot fill the disk.
const MOST_BYTES: u64 = 100 << 30;
/// Most files one archive may hold.
const MOST_FILES: usize = 200_000;

/// Most of one sidecar that is read, and of all of an archive's together:
/// they are held in memory until the files they are of have been unpacked.
const MOST_SIDECAR: u64 = 4 << 20;
const MOST_SIDECARS: u64 = 512 << 20;
/// The sidecar of the set its folder becomes.
const FOLDER_SIDECAR: &str = "_set.json";

/// What other systems leave in archives, which nobody put there on purpose.
const CLUTTER: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini"];

pub fn router() -> Router<AppState> {
    Router::new().route("/files/archive", post(upload))
}

/// A file of the archive that was not taken in, or a sidecar some of which
/// could not be used.
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
    /// Sets made of its folders, and for its sidecars.
    sets: u64,
    failures: Vec<Failure>,
}

impl Unpacked {
    /// Says what in a sidecar could not be used, if anything.
    fn report(&mut self, name: &str, problems: Vec<String>) {
        if !problems.is_empty() {
            self.failures.push(Failure {
                name: name.to_string(),
                reason: problems.join("; "),
            });
        }
    }
}

/// The sidecars of an archive, read before anything is unpacked.
#[derive(Default)]
struct Sidecars {
    /// Those of files, by where in the archive the file is.
    files: HashMap<String, Metadata>,
    /// Those of folders, by the folder.
    folders: HashMap<String, Metadata>,
    /// Those of sets, with where each is.
    sets: Vec<(String, Metadata)>,
    /// Those of collections, likewise.
    collections: Vec<(String, Metadata)>,
}

/// Where the files taken in are to go, once they all are.
#[derive(Default)]
struct Placing {
    /// The set of each folder that has been met.
    folders: HashMap<String, i64>,
    /// Files to put in the set with a set ID, at an index if they say one.
    wanted: Vec<(String, Option<i64>, i64)>,
    /// Files to put in a set the library has.
    placed: Vec<(i64, Option<i64>, i64)>,
    /// The sets of folders that did not say which set they are: they take
    /// only files that are in no set.
    unnamed: HashSet<i64>,
    /// The sets made for this archive.
    made: Vec<i64>,
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

/// Reads one sidecar, of no more than `most` bytes, and returns its size
/// with it.
fn read_sidecar(
    archive: &mut ZipArchive<File>,
    index: usize,
    most: u64,
) -> Result<(Metadata, u64), String> {
    let entry = archive.by_index(index).map_err(|err| err.to_string())?;
    let mut text = Vec::new();
    entry
        .take(most + 1)
        .read_to_end(&mut text)
        .map_err(|err| err.to_string())?;
    if text.len() as u64 > most {
        return Err("a sidecar larger than is read".to_string());
    }
    match serde_json::from_slice(&text) {
        Ok(Value::Object(meta)) => Ok((meta, text.len() as u64)),
        Ok(_) => Err("not a sidecar: it does not hold a JSON object".to_string()),
        Err(err) => Err(format!("not a sidecar that can be read: {err}")),
    }
}

/// Takes the sidecars out of the files of an archive and reads them.
/// Returns the files that are left, to be unpacked.
fn read_sidecars(
    archive: &mut ZipArchive<File>,
    entries: Vec<Entry>,
    failures: &mut Vec<Failure>,
) -> (Vec<Entry>, Sidecars) {
    let paths: HashSet<String> = entries.iter().map(|entry| entry.parts.join("/")).collect();
    let mut sidecars = Sidecars::default();
    let mut left = MOST_SIDECARS;
    let mut files = Vec::new();
    for entry in entries {
        let path = entry.parts.join("/");
        let Some(of) = path.strip_suffix(".json") else {
            files.push(entry);
            continue;
        };
        let mut fail = |reason: &str| {
            failures.push(Failure {
                name: path.clone(),
                reason: reason.to_string(),
            });
        };
        let meta = match read_sidecar(archive, entry.index, left.min(MOST_SIDECAR)) {
            Ok((meta, size)) => {
                left -= size;
                meta
            }
            Err(why) => {
                fail(&why);
                continue;
            }
        };
        let (folders, name) = entry.parts.split_at(entry.parts.len() - 1);
        if name[0] == FOLDER_SIDECAR {
            if folders.is_empty() {
                fail("at the top of the archive there is no folder for it to describe");
            } else {
                sidecars.folders.insert(folders.join("/"), meta);
            }
        } else if paths.contains(of) {
            sidecars.files.insert(of.to_string(), meta);
        } else if meta.get("metadata_type").and_then(Value::as_str) == Some("set") {
            sidecars.sets.push((path, meta));
        } else if meta.get("metadata_type").and_then(Value::as_str) == Some("collection") {
            sidecars.collections.push((path, meta));
        } else {
            fail("a sidecar of no file in the archive");
        }
    }
    (files, sidecars)
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
pub fn reason(err: ApiError) -> String {
    match err {
        ApiError::NotFound => "not found".to_string(),
        ApiError::BadRequest(message) | ApiError::Internal(message) => message,
        ApiError::Query(err) => err.message,
    }
}

/// The set for a folder of the archive, made if this is the first file to
/// need it. A folder with a sidecar is the set that says it is: the one
/// the library has by its set ID, if it has one.
fn folder(
    state: &AppState,
    placing: &mut Placing,
    sidecars: &mut Sidecars,
    unpacked: &mut Unpacked,
    folders: &[String],
) -> Result<i64, ApiError> {
    let key = folders.join("/");
    if let Some(set) = placing.folders.get(&key) {
        return Ok(*set);
    }
    let conn = state.db.lock().unwrap();
    let meta = sidecars.folders.remove(&key);
    let mut problems = Vec::new();
    let fresh = sets::new_id(&conn)?;
    let (set, new) = match &meta {
        Some(meta) => sidecar::set_of(&conn, meta, &fresh, &mut problems)?,
        None => sets::find_or_make(&conn, &fresh)?,
    };
    if let Some(meta) = &meta {
        sidecar::apply_set(&conn, set, meta, &mut problems)?;
    }
    if !meta.as_ref().is_some_and(|meta| meta.contains_key("set_id")) {
        placing.unnamed.insert(set);
    }
    if new {
        // Named for the folder, unless its sidecar had a title.
        conn.execute(
            "UPDATE file_set SET title = ?2 WHERE id = ?1 AND title IS NULL",
            params![set, folders.last()],
        )?;
        placing.made.push(set);
    }
    unpacked.report(&format!("{key}/{FOLDER_SIDECAR}"), problems);
    placing.folders.insert(key, set);
    Ok(set)
}

/// What is left to do once the files are in: the sets that have sidecars
/// of their own are found or made, and every file is put in its set, in
/// the order the sidecars give.
fn gather(
    state: &AppState,
    sidecars: Sidecars,
    mut placing: Placing,
    unpacked: &mut Unpacked,
) -> Result<(), ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    for (path, meta) in sidecars.sets {
        let mut problems = Vec::new();
        // One that does not say which set it is of is of the one named as
        // it is.
        let name = path.rsplit('/').next().unwrap_or(&path);
        let name = name.strip_suffix(".json").unwrap_or(name);
        let (set, new) = sidecar::set_of(&tx, &meta, name, &mut problems)?;
        sidecar::apply_set(&tx, set, &meta, &mut problems)?;
        if new {
            placing.made.push(set);
        }
        unpacked.report(&path, problems);
    }
    // What is known of a collection is kept whether or not anything here is
    // part of it: it is a name, and has nothing to be put in.
    for (path, meta) in sidecars.collections {
        let mut problems = Vec::new();
        let name = path.rsplit('/').next().unwrap_or(&path);
        let name = name.strip_suffix(".json").unwrap_or(name);
        sidecar::apply_collection(&tx, &meta, name, &mut problems)?;
        unpacked.report(&path, problems);
    }
    for folder in sidecars.folders.into_keys() {
        unpacked.report(
            &format!("{folder}/{FOLDER_SIDECAR}"),
            vec!["its folder holds no file that was taken in".to_string()],
        );
    }
    // A set with no sidecar here is the one that has the ID, in the
    // library or from now on.
    for (set_id, index, file) in placing.wanted {
        let (set, new) = sets::find_or_make(&tx, &set_id)?;
        if new {
            placing.made.push(set);
        }
        placing.placed.push((set, index, file));
    }
    // Each set's files in the order they say they come in; those that do
    // not say follow, as the archive has them.
    placing
        .placed
        .sort_by_key(|(set, index, _)| (*set, index.is_none(), *index));
    // The named sets first: what they take is then in a set, and not for a
    // folder that names none.
    let (unnamed, named): (Vec<_>, Vec<_>) = placing
        .placed
        .into_iter()
        .partition(|(set, ..)| placing.unnamed.contains(set));
    for (set, _, file) in named {
        sets::add_files(&tx, set, &[file], false)?;
    }
    for (set, _, file) in unnamed {
        sets::add_files(&tx, set, &[file], true)?;
    }
    // One that nothing could be put in is not kept.
    sets::prune(&tx)?;
    for set in placing.made {
        let kept: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM file_set WHERE id = ?1)",
            [set],
            |row| row.get(0),
        )?;
        unpacked.sets += kept as u64;
    }
    tx.commit()?;
    Ok(())
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
        let (entries, mut failures) = list(&mut archive);
        if entries.len() > MOST_FILES {
            return Err(ApiError::BadRequest(format!(
                "the archive holds more than {MOST_FILES} files"
            )));
        }
        let (entries, sidecars) = read_sidecars(&mut archive, entries, &mut failures);
        Ok::<_, ApiError>((archive, entries, sidecars, failures))
    });
    let (mut archive, entries, mut sidecars, failures) = opened.await.map_err(blocking)??;

    let mut unpacked = Unpacked {
        failures,
        ..Unpacked::default()
    };
    let mut placing = Placing::default();
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
        let ingested = files::ingest(&state, &out.0, &hash, size, Some(name), params.tab).await;
        let (file, new) = match ingested {
            Ok(ingested) => ingested,
            Err(err) => {
                fail(&mut unpacked, reason(err));
                continue;
            }
        };
        if new {
            unpacked.added += 1;
        } else {
            unpacked.duplicates += 1;
        }
        let path = parts.join("/");
        // The sets its sidecar names, or else its folder's.
        let mut named = Vec::new();
        if let Some(meta) = sidecars.files.remove(&path) {
            let mut problems = Vec::new();
            {
                let mut conn = state.db.lock().unwrap();
                let tx = conn.transaction()?;
                sidecar::apply(&tx, file.id, &meta, new, &mut problems)?;
                tx.commit()?;
            }
            named = sidecar::wanted_sets(&meta, &mut problems);
            unpacked.report(&format!("{path}.json"), problems);
        }
        if named.is_empty() && !folders.is_empty() {
            let set = folder(&state, &mut placing, &mut sidecars, &mut unpacked, folders)?;
            placing.placed.push((set, None, file.id));
        }
        for (set_id, index) in named {
            placing.wanted.push((set_id, index, file.id));
        }
    }
    gather(&state, sidecars, placing, &mut unpacked)?;
    Ok(Json(unpacked))
}
