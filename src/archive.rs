//! Unpacking an uploaded zip: each file in it is taken into the library as
//! if it had been uploaded by itself, and the archive is not kept.
//!
//! Its folders become collections: a folder is a set named for it, holding
//! its files in the order of their names, and a folder inside it is a set
//! inside that one. Files at the top of the archive go in no collection.
//! Only what the library can show is taken in, images, video, audio and
//! books; the rest is passed over, and the answer says of each what it was
//! and why.
//!
//! A sidecar in it, `<name>.json` beside a file, gives that file its
//! metadata, as `schema.md` describes and an export writes. A
//! `_collection.json` in a folder does so for the folder's collection, and
//! a sidecar that says it is of a collection, wherever it is, for that
//! collection: the one in the library that has its collection ID, or a new
//! one. The sidecars are not kept either.

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
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::{
    AppState, collections,
    error::ApiError,
    files::{self, TempFile, UploadParams},
    media,
    sidecar::{self, Metadata, Wanted},
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
/// The sidecar of the collection its folder becomes.
const FOLDER_SIDECAR: &str = "_collection.json";

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
    /// Collections made of its folders, and for its sidecars.
    collections: u64,
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
    /// Those of collections, with where each is.
    collections: Vec<(String, Metadata)>,
    /// The collections that what has been taken in is to be put in, and
    /// the sidecar that asks for each.
    wanted: Vec<(String, Wanted)>,
}

impl Sidecars {
    /// Notes the collections a sidecar says its entity is in.
    fn want(&mut self, from: &str, meta: &Metadata, member: i64, problems: &mut Vec<String>) {
        let wanted = sidecar::memberships(meta, member, problems);
        self.wanted
            .extend(wanted.into_iter().map(|wanted| (from.to_string(), wanted)));
    }
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

/// Lists a collection under an upload tab, if there is one to list it under.
fn list_in_tab(conn: &Connection, tab: Option<i64>, collection: i64) -> rusqlite::Result<()> {
    if let Some(tab) = tab {
        conn.execute(
            "INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
             SELECT id, ?2 FROM tab
             WHERE id = ?1 AND kind IN ('upload', 'download') AND picked = 0",
            params![tab, collection],
        )?;
    }
    Ok(())
}

/// The collection for a folder of the archive, made if this is the first
/// file to need it, along with the folders it is in. The outermost is
/// listed under the tab; each other is put in the one around it. A folder
/// with a sidecar is what that says it is: the collection the library has
/// by its collection ID, if it has one.
fn folder(
    state: &AppState,
    made: &mut HashMap<String, i64>,
    sidecars: &mut Sidecars,
    unpacked: &mut Unpacked,
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
                let from = format!("{key}/{FOLDER_SIDECAR}");
                let meta = sidecars.folders.remove(&key);
                let mut problems = Vec::new();
                let said = meta
                    .as_ref()
                    .map(|meta| sidecar::described(meta, &mut problems))
                    .unwrap_or_default();
                // Ordered unless it says not: its files are put in by name,
                // and stay so.
                let (collection, new) = sidecar::find_or_make(
                    &conn,
                    said.collection_id.as_deref(),
                    said.collection_type.as_deref().unwrap_or("set"),
                    said.ordered.unwrap_or(true),
                )?;
                if let Some(meta) = &meta {
                    sidecar::apply(&conn, collection, meta, new, &mut problems)?;
                    sidecars.want(&from, meta, collection, &mut problems);
                }
                if new {
                    // Named for the folder, unless its sidecar had a title.
                    conn.execute(
                        "UPDATE entity SET title = ?2 WHERE id = ?1 AND title IS NULL",
                        params![collection, folders[depth - 1]],
                    )?;
                    unpacked.collections += 1;
                }
                match around {
                    Some(around) => {
                        // One the library had may not be able to go there.
                        match collections::add_members(&conn, around, &[collection]) {
                            Err(ApiError::BadRequest(why)) => problems.push(why),
                            other => other?,
                        }
                    }
                    None => list_in_tab(&conn, tab, collection)?,
                }
                // The tab's tags are for the folder as for its files.
                files::give_tab_tags(&conn, tab, &[collection])?;
                unpacked.report(&from, problems);
                made.insert(key, collection);
                collection
            }
        };
        around = Some(collection);
    }
    around.ok_or_else(|| ApiError::Internal("a file in no folder has no collection".to_string()))
}

/// What is left to do once the files are in: the collections that have
/// sidecars of their own are found or made, and everything is put in the
/// collections its sidecar says it is in, in the order the sidecars give.
/// All of them are listed under the tab.
fn gather(
    state: &AppState,
    sidecars: Sidecars,
    unpacked: &mut Unpacked,
    tab: Option<i64>,
) -> Result<(), ApiError> {
    let Sidecars {
        collections,
        mut wanted,
        ..
    } = sidecars;
    // What the files call each collection says what type it is, for a
    // sidecar that does not.
    let types: HashMap<String, String> = wanted
        .iter()
        .rev()
        .filter_map(|(_, wanted)| Some((wanted.id.clone(), wanted.collection_type.clone()?)))
        .collect();

    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    // The collections of the archive: by collection ID, and those that
    // have none by the names of their sidecars.
    let (mut by_id, mut by_name) = (HashMap::new(), HashMap::new());
    for (path, meta) in collections {
        let mut problems = Vec::new();
        let said = sidecar::described(&meta, &mut problems);
        let name = path.rsplit('/').next().unwrap_or(&path);
        let name = name.strip_suffix(".json").unwrap_or(name);
        let called = said.collection_id.as_deref().unwrap_or(name);
        let collection_type = said
            .collection_type
            .as_deref()
            .or(types.get(called).map(String::as_str))
            .unwrap_or("set");
        let (collection, new) = sidecar::find_or_make(
            &tx,
            said.collection_id.as_deref(),
            collection_type,
            said.ordered.unwrap_or(collection_type == "sequence"),
        )?;
        sidecar::apply(&tx, collection, &meta, new, &mut problems)?;
        for wanted_of in sidecar::memberships(&meta, collection, &mut problems) {
            wanted.push((path.clone(), wanted_of));
        }
        if new {
            unpacked.collections += 1;
            files::give_tab_tags(&tx, tab, &[collection])?;
        }
        list_in_tab(&tx, tab, collection)?;
        match said.collection_id {
            Some(id) => by_id.insert(id, collection),
            None => by_name.insert(name.to_string(), collection),
        };
        unpacked.report(&path, problems);
    }

    let mut placed = Vec::new();
    for (from, wanted) in wanted {
        let known = by_id.get(&wanted.id).or_else(|| by_name.get(&wanted.id));
        let collection = match known {
            Some(collection) => *collection,
            // One with no sidecar here is the collection that has the ID,
            // in the library or from now on.
            None => {
                let collection_type = wanted.collection_type.as_deref().unwrap_or("set");
                let (collection, new) = sidecar::find_or_make(
                    &tx,
                    Some(&wanted.id),
                    collection_type,
                    collection_type == "sequence",
                )?;
                if new {
                    unpacked.collections += 1;
                    files::give_tab_tags(&tx, tab, &[collection])?;
                }
                list_in_tab(&tx, tab, collection)?;
                by_id.insert(wanted.id.clone(), collection);
                collection
            }
        };
        placed.push((collection, wanted.index, wanted.member, from));
    }
    // Each collection's members in the order they say they come in; those
    // that do not say follow, as the archive has them.
    placed.sort_by_key(|(collection, index, ..)| (*collection, index.is_none(), *index));
    for (collection, _, member, from) in placed {
        match collections::add_members(&tx, collection, &[member]) {
            Err(ApiError::BadRequest(why)) => unpacked.report(&from, vec![why]),
            other => other?,
        }
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
        let (file, new) = match files::ingest(&state, &out.0, &hash, size, Some(name), listed).await
        {
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
        if let Some(meta) = sidecars.files.remove(&path) {
            let from = format!("{path}.json");
            let mut problems = Vec::new();
            {
                let mut conn = state.db.lock().unwrap();
                let tx = conn.transaction()?;
                sidecar::apply(&tx, file.id, &meta, new, &mut problems)?;
                tx.commit()?;
            }
            sidecars.want(&from, &meta, file.id, &mut problems);
            unpacked.report(&from, problems);
        }
        if !folders.is_empty() {
            // Not listed under the tab, it has not been given its tags.
            files::give_tab_tags(&state.db.lock().unwrap(), params.tab, &[file.id])?;
            let collection = folder(&state, &mut made, &mut sidecars, &mut unpacked, folders, params.tab)?;
            collections::add_members(&state.db.lock().unwrap(), collection, &[file.id])?;
        }
    }
    gather(&state, sidecars, &mut unpacked, params.tab)?;
    Ok(Json(unpacked))
}
