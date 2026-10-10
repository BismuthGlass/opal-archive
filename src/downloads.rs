//! Downloaders: scripts that fetch files from a website into the library.
//! An upload tab gives an address to the downloader whose site it is of.
//!
//! A downloader is a folder holding a `manifest.json` and a script. The
//! script knows the website and nothing of the library; this module knows
//! the library and nothing of the website. They talk in JSON: the request
//! goes to the script's standard input, and the script answers with one
//! event per line on its standard output. See `downloaders/README.md`.

pub mod inbox;

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    path::{Component, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::Notify,
};

use crate::{
    AppState, collections,
    entities::{self, COLLECTIONS, SOURCE_URLS},
    error::ApiError,
    files,
    query::tag_type,
    sets, tags,
};

/// What each of a downloader's options is set to.
type Options = BTreeMap<String, bool>;
/// The tags given to everything a download fetches: tag field to values.
type BaseTags = BTreeMap<String, Vec<String>>;

/// How many of a download's problems are kept to show.
const MAX_ERRORS: usize = 50;

/// How many times over a downloader may hand what it found to another: a
/// post that links to a post that links to a video, and no further.
const MAX_HANDED_ON: u8 = 2;

/// What a downloader says of itself, in its `manifest.json`.
#[derive(Clone, Serialize, Deserialize)]
pub struct Manifest {
    /// The name of its folder; not written in the manifest.
    #[serde(default)]
    name: String,
    title: String,
    /// The `source` tag given to everything it downloads.
    source: String,
    /// The program to run, with its first arguments, from the folder.
    #[serde(skip_serializing)]
    command: Vec<String>,
    /// What can be pasted into its box.
    #[serde(default)]
    url_hint: String,
    /// The sites it downloads from, by which an address sent to the inbox
    /// finds it: a domain, standing for its subdomains too, or a name and
    /// `.*` for that name under any ending.
    #[serde(default)]
    sites: Vec<String>,
    /// Present if it can use a login taken from a browser.
    cookies: Option<CookieSpec>,
    /// Switches the user can set.
    #[serde(default)]
    options: Vec<OptionSpec>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CookieSpec {
    /// The browsers a login can be read from.
    browsers: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct OptionSpec {
    key: String,
    label: String,
    #[serde(default)]
    default: bool,
}

/// How a download is going, or went.
#[derive(Clone, Default, Serialize)]
pub struct Status {
    running: bool,
    url: String,
    /// Things found to download so far (for Pinterest, pins).
    found: u64,
    /// Of those: fetched, skipped as seen before, and failed.
    downloaded: u64,
    skipped: u64,
    failed: u64,
    /// Files that were new to the library, and ones it already had.
    added: u64,
    existing: u64,
    /// What the downloader is doing, in its own words.
    message: String,
    errors: Vec<String>,
    /// Once it has ended: `done`, `cancelled`, or what stopped it.
    outcome: Option<String>,
}

pub struct Job {
    status: Arc<Mutex<Status>>,
    cancel: Arc<Notify>,
}

pub type Jobs = Arc<Mutex<HashMap<i64, Job>>>;

#[derive(Deserialize)]
struct SettingsInput {
    options: Option<Options>,
    /// Tag field to the values given to every download.
    tags: Option<BaseTags>,
}

#[derive(Deserialize)]
struct StartInput {
    url: String,
}

#[derive(Deserialize)]
struct CookieInput {
    browser: String,
}

#[derive(Deserialize)]
struct CookieFile {
    /// The text of a cookie file, in the Netscape format.
    cookies: String,
}

#[derive(Deserialize)]
struct ForgetInput {
    /// The keys to forget; all of them if left out.
    keys: Option<Vec<String>>,
}

/// One thing a downloader fetched, and what it knows of it.
#[derive(Deserialize)]
struct Item {
    /// What tells it from everything else on the site.
    key: String,
    /// Where it is on the site: one address, or several where it is at
    /// more than one, as a file a post links to is at its own and the post's.
    #[serde(default)]
    source_url: Sources,
    /// What its files are part of on the site, as a thread: kept as a
    /// collection of theirs, where a set would group them too much.
    collection: Option<Part>,
    /// Its files, in order, in the folder the script was given.
    #[serde(default)]
    files: Vec<PathBuf>,
    /// Addresses of other sites that it shows, for their own downloaders
    /// to fetch: what they bring in is this thing's too, after its files.
    #[serde(default)]
    delegate: Vec<String>,
    /// Given to the files if they have none of their own.
    title: Option<String>,
    description: Option<String>,
    /// Tags of its own, by field, besides the source and the tab's.
    #[serde(default)]
    tags: BaseTags,
    /// The set its files are to be put in.
    set: Option<Whole>,
}

/// The addresses a downloader gives something: one, or a list of them.
#[derive(Deserialize, Default)]
#[serde(untagged)]
enum Sources {
    #[default]
    None,
    One(String),
    Many(Vec<String>),
}

impl Sources {
    fn each(&self) -> &[String] {
        match self {
            Sources::None => &[],
            Sources::One(url) => std::slice::from_ref(url),
            Sources::Many(urls) => urls,
        }
    }
}

/// What a downloader says something is part of: the collection's name, or
/// the name with what the site says of the collection itself.
#[derive(Deserialize)]
#[serde(untagged)]
enum Part {
    Name(String),
    Described {
        /// Its name, which is what tells it from every other.
        id: String,
        /// Its address on the site, kept as its source URL.
        url: Option<String>,
        /// Given to it if it has none.
        title: Option<String>,
        description: Option<String>,
    },
}

impl Part {
    /// The collection's name, and with it kept what the site says of the
    /// collection, where it says anything. Nothing the user wrote of it is
    /// written over.
    fn note(&self, conn: &Connection) -> rusqlite::Result<Option<String>> {
        let text = |text: &Option<String>| {
            let text = text.as_deref().map(str::trim);
            text.filter(|text| !text.is_empty()).map(str::to_string)
        };
        let (name, url, title, description) = match self {
            Part::Name(name) => (name, None, None, None),
            Part::Described {
                id,
                url,
                title,
                description,
            } => (id, text(url), text(title), text(description)),
        };
        let name = name.trim();
        if name.is_empty() {
            return Ok(None);
        }
        // An address that is not one is passed over, as a tag that is not.
        if let Some(url) = url.and_then(|url| entities::source_url(&url).ok()) {
            collections::add_to_list(conn, name, collections::SOURCE_URLS, &url)?;
        }
        if let Some(title) = title {
            collections::fill(conn, name, "title", &title)?;
        }
        if let Some(description) = description {
            collections::fill(conn, name, "description", &description)?;
        }
        Ok(Some(name.to_string()))
    }
}

/// A set a downloader asks for, to hold the files of one post.
#[derive(Deserialize)]
struct Whole {
    /// Its set ID, which is what tells it from every other: the set that
    /// has it is the one used, and no second is made.
    id: String,
    /// Its address on the site, kept as its source URL.
    url: Option<String>,
    /// What it is called when it is made; it has no title if not said.
    title: Option<String>,
    description: Option<String>,
    /// What it is part of on the site, kept as a collection of its own.
    collection: Option<Part>,
    /// Tags for its files, by field, besides the source and the tab's.
    #[serde(default)]
    tags: BaseTags,
}

/// One line of a downloader's output.
#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "lowercase")]
enum Event {
    /// More things to download have been found: the total so far.
    Found { total: u64 },
    /// One thing has been fetched.
    Item(Item),
    /// One thing was passed over, having been seen before.
    Skipped {},
    /// Something went wrong; with a key, with that one thing.
    Error { message: String },
    /// What the downloader is doing.
    Log { message: String },
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/downloaders", get(list))
        .route(
            "/downloaders/{name}/cookies",
            post(take_cookies).delete(forget_cookies),
        )
        .route("/downloaders/{name}/cookies/file", post(upload_cookies))
        .route("/downloaders/{name}", axum::routing::patch(configure))
        .route("/tabs/{id}/download", get(state_of))
        .route("/tabs/{id}/download/start", post(start))
        .route("/tabs/{id}/download/cancel", post(stop))
        .route("/tabs/{id}/download/seen", get(seen))
        .route("/tabs/{id}/download/seen/forget", post(forget))
        .merge(inbox::router())
}

/// The manifest of the downloader in the folder `name`.
pub fn manifest(state: &AppState, name: &str) -> Result<Manifest, ApiError> {
    let unknown = || ApiError::BadRequest(format!("there is no downloader `{name}`"));
    // The name becomes part of a path.
    let plain = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !plain {
        return Err(unknown());
    }
    let path = state.downloaders.join(name).join("manifest.json");
    let text = std::fs::read_to_string(path).map_err(|_| unknown())?;
    let mut manifest: Manifest = serde_json::from_str(&text)
        .map_err(|err| ApiError::Internal(format!("{name}/manifest.json: {err}")))?;
    if manifest.command.is_empty() {
        return Err(ApiError::Internal(format!(
            "{name}/manifest.json: no command"
        )));
    }
    manifest.name = name.to_string();
    Ok(manifest)
}

/// The downloader's script, ready to be given a subcommand.
fn command(state: &AppState, manifest: &Manifest) -> Command {
    let mut command = Command::new(&manifest.command[0]);
    command
        .args(&manifest.command[1..])
        .current_dir(state.downloaders.join(&manifest.name));
    command
}

fn cookie_file(state: &AppState, manifest: &Manifest) -> PathBuf {
    state.cookies.join(format!("{}.txt", manifest.name))
}

/// A downloader as the interface needs it: its manifest, when its login
/// was saved (seconds since 1970), if one is, and what its options are set
/// to. For a caller that holds the database already.
fn described_with(state: &AppState, conn: &Connection, manifest: &Manifest) -> Value {
    let saved = std::fs::metadata(cookie_file(state, manifest))
        .and_then(|file| file.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_secs());
    let mut described = json!(manifest);
    described["login_saved"] = json!(saved);
    let set = settings(conn, manifest).map(|(options, _)| options);
    described["settings"] = json!(set.unwrap_or_default());
    // Where there is no browser, a login is sent as a file.
    described["headless"] = json!(state.headless);
    described
}

fn described(state: &AppState, manifest: &Manifest) -> Value {
    described_with(state, &state.db.lock().unwrap(), manifest)
}

/// Every downloader there is, by title.
fn manifests(state: &AppState) -> Vec<Manifest> {
    let mut found: Vec<Manifest> = std::fs::read_dir(&state.downloaders)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| manifest(state, entry.file_name().to_str()?).ok())
        .collect();
    found.sort_by(|a, b| a.title.cmp(&b.title));
    found
}

async fn list(State(state): State<AppState>) -> Json<Vec<Value>> {
    let found = manifests(&state);
    Json(found.iter().map(|m| described(&state, m)).collect())
}

/// Has the downloader read its site's login from a browser, and keeps it
/// for later downloads, in a file only the user can read.
async fn take_cookies(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<CookieInput>,
) -> Result<Json<Value>, ApiError> {
    let manifest = manifest(&state, &name)?;
    if state.headless {
        return Err(ApiError::bad_request(
            "this server has no browser to read a login from: send it a cookie file",
        ));
    }
    let allowed = manifest
        .cookies
        .as_ref()
        .is_some_and(|spec| spec.browsers.contains(&input.browser));
    if !allowed {
        return Err(ApiError::BadRequest(format!(
            "{} cannot take a login from `{}`",
            manifest.title, input.browser
        )));
    }
    let missing = format!("No {} login was found in {}", manifest.title, input.browser);
    keep_login(&state, &manifest, &["--browser", &input.browser], &missing).await
}

/// Keeps a login sent as a cookie file, in the Netscape format browsers
/// export: for a server with no browser of its own to read one from. The
/// downloader takes its site's cookies out of the file, and nothing else
/// of it is kept.
async fn upload_cookies(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<CookieFile>,
) -> Result<Json<Value>, ApiError> {
    let manifest = manifest(&state, &name)?;
    if manifest.cookies.is_none() {
        return Err(ApiError::BadRequest(format!(
            "{} does not use a login",
            manifest.title
        )));
    }
    // Python reads such a file only if it begins as one.
    let mut text = input.cookies;
    if !(text.starts_with("# Netscape HTTP Cookie File") || text.starts_with("# HTTP Cookie File")) {
        text.insert_str(0, "# Netscape HTTP Cookie File\n");
    }
    // It holds logins: readable by the user alone, and gone once read.
    let sent = fresh_out(&state).with_extension("cookies");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options.open(&sent)?.write_all(text.as_bytes())?;
    }
    let missing = format!("That file holds no {} login", manifest.title);
    let file = sent.to_string_lossy().into_owned();
    let kept = keep_login(&state, &manifest, &["--file", &file], &missing).await;
    let _ = std::fs::remove_file(&sent);
    kept
}

/// Has the downloader's script save its site's login, from the source the
/// arguments name, and keeps it in place of the one there was. `missing`
/// is what to say if the source holds no login.
async fn keep_login(
    state: &AppState,
    manifest: &Manifest,
    from: &[&str],
    missing: &str,
) -> Result<Json<Value>, ApiError> {
    std::fs::create_dir_all(&state.cookies)?;
    let file = cookie_file(state, manifest);
    // Written beside the real file, so a failed attempt leaves the login
    // that was there.
    let fresh = file.with_extension("new");
    let output = command(state, manifest)
        .arg("cookies")
        .args(from)
        .arg("--out")
        .arg(&fresh)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|err| ApiError::Internal(format!("{}: {err}", manifest.command[0])))?;
    let answer: Option<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .last()
        .and_then(|line| serde_json::from_str(line).ok());
    let logged_in = answer.as_ref().and_then(|a| a["logged_in"].as_bool()) == Some(true);
    if !output.status.success() || !logged_in || !fresh.exists() {
        let _ = std::fs::remove_file(&fresh);
        let reason = if output.status.success() {
            missing.to_string()
        } else {
            last_line(&String::from_utf8_lossy(&output.stderr))
        };
        return Err(ApiError::BadRequest(reason));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&fresh, &file)?;
    Ok(Json(described(state, manifest)))
}

async fn forget_cookies(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let manifest = manifest(&state, &name)?;
    let _ = std::fs::remove_file(cookie_file(&state, &manifest));
    Ok(Json(described(&state, &manifest)))
}

/// The last line of a program's complaints that says anything.
fn last_line(text: &str) -> String {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("the downloader failed without saying why")
        .to_string()
}

/// The host an address names, in lower case.
fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether a host is of a site as a manifest names it.
fn of_site(host: &str, site: &str) -> bool {
    let site = site.to_ascii_lowercase();
    match site.strip_suffix(".*") {
        // A name under any ending: pinterest.com, pinterest.co.uk.
        Some(name) => host.split('.').any(|label| label == name),
        None => host == site || host.ends_with(&format!(".{site}")),
    }
}

/// The downloader an address belongs to, if there is one for its site.
fn for_url(state: &AppState, url: &str) -> Result<Option<Manifest>, ApiError> {
    let host = host_of(url).ok_or_else(|| ApiError::bad_request("that is not a web address"))?;
    let found = manifests(state);
    let mut of_host = found
        .into_iter()
        .filter(|manifest| manifest.sites.iter().any(|site| of_site(&host, site)));
    Ok(of_host.next())
}

/// What a downloader is set to: its options, the manifest's defaults
/// filled in, which every tab and the inbox use; and the tags the inbox
/// has it give.
fn settings(conn: &Connection, manifest: &Manifest) -> rusqlite::Result<(Options, BaseTags)> {
    let saved: Option<(String, String)> = conn
        .query_row(
            "SELECT options, tags FROM downloader_settings WHERE downloader = ?1",
            [&manifest.name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(filled(manifest, saved))
}

/// Settings as they were saved, as JSON, with the manifest's defaults for
/// the options that were not.
fn filled(manifest: &Manifest, saved: Option<(String, String)>) -> (Options, BaseTags) {
    let (options, tags) = saved.unwrap_or_default();
    // The tables only accept valid JSON.
    let chosen: Options = serde_json::from_str(&options).unwrap_or_default();
    let options = manifest
        .options
        .iter()
        .map(|spec| {
            let value = chosen.get(&spec.key).copied().unwrap_or(spec.default);
            (spec.key.clone(), value)
        })
        .collect();
    (options, serde_json::from_str(&tags).unwrap_or_default())
}

/// Makes the changes asked for to settings: to the options, the base tags,
/// or both.
fn change(
    manifest: &Manifest,
    options: &mut Options,
    base: &mut BaseTags,
    input: SettingsInput,
) -> Result<(), ApiError> {
    for (key, value) in input.options.unwrap_or_default() {
        match options.get_mut(&key) {
            Some(option) => *option = value,
            None => {
                return Err(ApiError::BadRequest(format!(
                    "{} has no option `{key}`",
                    manifest.title
                )));
            }
        }
    }
    if let Some(given) = input.tags {
        *base = tags::checked(given)?;
    }
    Ok(())
}

/// The sites every other downloader takes addresses of: what this one may
/// hand over, when what it finds is shown from one of them.
fn sites_besides(state: &AppState, manifest: &Manifest) -> Vec<String> {
    let others = manifests(state)
        .into_iter()
        .filter(|other| other.name != manifest.name);
    others.flat_map(|other| other.sites).collect()
}

/// What a downloader's script is asked: the address, as the downloader is
/// set, with its login if one is saved, what to pass over as seen, and
/// where to put the files.
fn request_for(
    state: &AppState,
    manifest: &Manifest,
    url: &str,
    options: &Options,
    seen: &[String],
    out: &std::path::Path,
) -> Value {
    let cookies = Some(cookie_file(state, manifest)).filter(|file| file.exists());
    json!({
        "url": url,
        "options": options,
        "cookies": cookies,
        "seen": seen,
        "out": out,
        "delegates": sites_besides(state, manifest),
    })
}

/// A folder of its own for a download's files, under the server's
/// temporary directory. It is not made yet.
fn fresh_out(state: &AppState) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    state.tmp.join(format!(
        "download-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

/// How a tab's download is going, or how its last one went, and how many
/// things it has downloaded before.
async fn state_of(
    State(state): State<AppState>,
    Path(tab): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let job = state
        .downloads
        .lock()
        .unwrap()
        .get(&tab)
        .map(|job| job.status.lock().unwrap().clone());
    let conn = state.db.lock().unwrap();
    let there: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM tab WHERE id = ?1)",
        [tab],
        |row| row.get(0),
    )?;
    if !there {
        return Err(ApiError::NotFound);
    }
    let seen: i64 = conn.query_row(
        "SELECT count(*) FROM tab_download_seen WHERE tab_id = ?1",
        [tab],
        |row| row.get(0),
    )?;
    Ok(Json(json!({ "seen": seen, "job": job })))
}

/// Sets a downloader's options, for every tab and for the inbox, or the
/// tags the inbox has it give, or both.
async fn configure(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(input): Json<SettingsInput>,
) -> Result<StatusCode, ApiError> {
    let manifest = manifest(&state, &name)?;
    let conn = state.db.lock().unwrap();
    let (mut options, mut base) = settings(&conn, &manifest)?;
    change(&manifest, &mut options, &mut base, input)?;
    conn.execute(
        "INSERT INTO downloader_settings (downloader, options, tags) VALUES (?1, ?2, ?3)
         ON CONFLICT (downloader) DO UPDATE
         SET options = excluded.options, tags = excluded.tags",
        params![manifest.name, json!(options).to_string(), json!(base).to_string()],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

/// What the tab has downloaded before, newest first.
async fn seen(
    State(state): State<AppState>,
    Path(tab): Path<i64>,
) -> Result<Json<Vec<Value>>, ApiError> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT key, date_seen FROM tab_download_seen WHERE tab_id = ?1
         ORDER BY date_seen DESC, key",
    )?;
    let keys = stmt
        .query_map([tab], |row| {
            Ok(json!({ "key": row.get::<_, String>(0)?, "date": row.get::<_, String>(1)? }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Json(keys))
}

/// Forgets some or all of what the tab has seen, so that it is downloaded
/// again when next met.
async fn forget(
    State(state): State<AppState>,
    Path(tab): Path<i64>,
    Json(input): Json<ForgetInput>,
) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let forgotten = match input.keys {
        Some(keys) => conn.execute(
            "DELETE FROM tab_download_seen
             WHERE tab_id = ?1 AND key IN (SELECT value FROM json_each(?2))",
            params![tab, json!(keys).to_string()],
        )?,
        None => conn.execute("DELETE FROM tab_download_seen WHERE tab_id = ?1", [tab])?,
    };
    Ok(Json(json!({ "forgotten": forgotten })))
}

/// Starts downloading `url` into an upload tab, with the downloader whose
/// site the address is of, and answers with its name. Where there is no
/// downloader for it, nothing is started and the name is `null`: the
/// address may still be that of a file, to fetch as one. One download runs
/// per tab.
async fn start(
    State(state): State<AppState>,
    Path(tab): Path<i64>,
    Json(input): Json<StartInput>,
) -> Result<Json<Value>, ApiError> {
    let url = input.url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ApiError::bad_request("that is not a web address"));
    }
    let Some(manifest) = for_url(&state, &url)? else {
        return Ok(Json(json!({ "downloader": null })));
    };
    let (options, base, seen) = {
        let conn = state.db.lock().unwrap();
        let uploads: Option<bool> = conn
            .query_row(
                "SELECT kind = 'upload' AND picked = 0 FROM tab WHERE id = ?1",
                [tab],
                |row| row.get(0),
            )
            .optional()?;
        if !uploads.ok_or(ApiError::NotFound)? {
            return Err(ApiError::bad_request("not an upload tab"));
        }
        let (options, _) = settings(&conn, &manifest)?;
        // What is downloaded gets the tags the tab gives what is uploaded.
        let base = files::tab_tags(&conn, tab)?;
        let mut stmt = conn.prepare("SELECT key FROM tab_download_seen WHERE tab_id = ?1")?;
        let seen = stmt
            .query_map([tab], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (options, base, seen)
    };

    let out = fresh_out(&state);
    let request = request_for(&state, &manifest, &url, &options, &seen, &out);

    let status = Arc::new(Mutex::new(Status {
        running: true,
        url,
        ..Status::default()
    }));
    let cancel = Arc::new(Notify::new());
    {
        let mut jobs = state.downloads.lock().unwrap();
        let busy = jobs
            .get(&tab)
            .is_some_and(|job| job.status.lock().unwrap().running);
        if busy {
            return Err(ApiError::bad_request(
                "this tab is already downloading something",
            ));
        }
        jobs.insert(
            tab,
            Job {
                status: status.clone(),
                cancel: cancel.clone(),
            },
        );
    }

    let name = manifest.name.clone();
    let download = Download::new(state, tab, manifest, base, out, status);
    tokio::spawn(async move {
        let outcome = match download.run(request, cancel).await {
            Ok(outcome) => outcome,
            Err(reason) => reason,
        };
        let _ = tokio::fs::remove_dir_all(&download.out).await;
        let mut status = download.status.lock().unwrap();
        status.running = false;
        status.outcome = Some(outcome);
    });
    Ok(Json(json!({ "downloader": name })))
}

async fn stop(State(state): State<AppState>, Path(tab): Path<i64>) -> StatusCode {
    cancel(&state, tab);
    StatusCode::NO_CONTENT
}

/// Asks the download running for a tab, if there is one, to stop.
pub fn cancel(state: &AppState, tab: i64) {
    if let Some(job) = state.downloads.lock().unwrap().get(&tab)
        && job.status.lock().unwrap().running
    {
        // Kept until the download next looks, however busy it is meanwhile.
        job.cancel.notify_one();
    }
}

/// One run of a downloader for a tab.
struct Download {
    state: AppState,
    tab: i64,
    manifest: Manifest,
    /// The tags given to everything downloaded, besides the source.
    base: BaseTags,
    /// Where the script puts its files, under the server's temporary
    /// directory.
    out: PathBuf,
    status: Arc<Mutex<Status>>,
    /// How many downloaders handed this on before it came here.
    handed_on: u8,
    /// The files it has taken in, in order, for whoever handed it over.
    taken: Mutex<Vec<i64>>,
}

impl Download {
    fn new(
        state: AppState,
        tab: i64,
        manifest: Manifest,
        base: BaseTags,
        out: PathBuf,
        status: Arc<Mutex<Status>>,
    ) -> Self {
        Download {
            state,
            tab,
            manifest,
            base,
            out,
            status,
            handed_on: 0,
            taken: Mutex::new(Vec::new()),
        }
    }

    /// Runs the script to its end, taking in what it fetches as it goes.
    /// Returns how it ended, as `Status::outcome` has it.
    async fn run(&self, request: Value, cancel: Arc<Notify>) -> Result<String, String> {
        let failed = |err: std::io::Error| err.to_string();
        tokio::fs::create_dir_all(&self.out).await.map_err(failed)?;
        let mut child = command(&self.state, &self.manifest)
            .arg("download")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| format!("{}: {err}", self.manifest.command[0]))?;

        let mut stdin = child.stdin.take().expect("stdin is piped");
        let request = request.to_string();
        // Written apart from the reading below, in case the script says
        // something before it has read the whole request.
        tokio::spawn(async move {
            let _ = stdin.write_all(request.as_bytes()).await;
        });
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let complaints = tokio::spawn(async move {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text).await;
            text
        });

        let mut lines = BufReader::new(child.stdout.take().expect("stdout is piped")).lines();
        loop {
            tokio::select! {
                line = lines.next_line() => match line.map_err(failed)? {
                    Some(line) => self.handle(&line, &cancel).await,
                    None => break,
                },
                _ = cancel.notified() => {
                    end(&mut child).await;
                    return Ok("cancelled".to_string());
                }
            }
        }
        let exit = child.wait().await.map_err(failed)?;
        if exit.success() {
            Ok("done".to_string())
        } else {
            Err(last_line(&complaints.await.unwrap_or_default()))
        }
    }

    /// Acts on one line of the script's output.
    async fn handle(&self, line: &str, cancel: &Arc<Notify>) {
        let event = match serde_json::from_str::<Event>(line) {
            Ok(event) => event,
            // Anything else the script prints is not for us.
            Err(_) => return,
        };
        match event {
            Event::Found { total } => self.status.lock().unwrap().found = total,
            Event::Log { message } => self.status.lock().unwrap().message = message,
            Event::Skipped {} => self.status.lock().unwrap().skipped += 1,
            Event::Error { message } => self.problem(message),
            Event::Item(item) => match self.take_in(&item, cancel).await {
                Ok((added, existing)) => {
                    let mut status = self.status.lock().unwrap();
                    status.downloaded += 1;
                    status.added += added;
                    status.existing += existing;
                }
                Err(err) => self.problem(format!("{}: {}", item.key, reason(err))),
            },
        }
    }

    fn problem(&self, message: String) {
        let mut status = self.status.lock().unwrap();
        status.failed += 1;
        if status.errors.len() < MAX_ERRORS {
            status.errors.push(message);
        }
    }

    /// Has the downloader for another site fetch an address that this one
    /// found, into the same tab: what it brings in gets everything that
    /// downloader gives, as if the address had been asked for by itself.
    /// Returns the files it took in, and how many were new and old. Boxed,
    /// since that download may hand something on in its turn.
    fn hand_over<'a>(
        &'a self,
        url: &'a str,
        cancel: &'a Arc<Notify>,
    ) -> Pin<Box<dyn Future<Output = Result<(Vec<i64>, u64, u64), ApiError>> + Send + 'a>> {
        Box::pin(async move {
            if self.handed_on >= MAX_HANDED_ON {
                return Err(ApiError::bad_request("handed from one downloader to another too many times"));
            }
            let manifest = for_url(&self.state, url)?
                .filter(|other| other.name != self.manifest.name)
                .ok_or_else(|| ApiError::BadRequest(format!("no other downloader takes {url}")))?;
            let (options, _) = settings(&self.state.db.lock().unwrap(), &manifest)?;
            let out = fresh_out(&self.state);
            // Nothing is passed over as seen: it is wanted as part of this.
            let request = request_for(&self.state, &manifest, url, &options, &[], &out);
            let title = manifest.title.clone();
            let other = Download {
                handed_on: self.handed_on + 1,
                ..Download::new(
                    self.state.clone(),
                    self.tab,
                    manifest,
                    self.base.clone(),
                    out,
                    Arc::new(Mutex::new(Status::default())),
                )
            };
            let outcome = other.run(request, cancel.clone()).await;
            let _ = tokio::fs::remove_dir_all(&other.out).await;
            let status = other.status.lock().unwrap().clone();
            let taken = other.taken.lock().unwrap().clone();
            match outcome {
                Ok(how) if how == "cancelled" => {
                    // The download that handed it over is to stop as well.
                    cancel.notify_one();
                    Err(ApiError::bad_request("cancelled"))
                }
                Err(why) => Err(ApiError::BadRequest(format!("{title}: {why}"))),
                Ok(_) if taken.is_empty() => {
                    let why = status.errors.into_iter().next();
                    let why = why.unwrap_or_else(|| "there was nothing to download".to_string());
                    Err(ApiError::BadRequest(format!("{title}: {why}")))
                }
                Ok(_) => Ok((taken, status.added, status.existing)),
            }
        })
    }

    /// Takes one downloaded thing into the library: its files go in and get
    /// the source URL, the collection, the tags, and the title and
    /// description where they have none. They are listed under the tab,
    /// and if the thing asks for a set those of them in no set are put in
    /// it. What it hands over to other
    /// downloaders is fetched by them, and is its files too. Then the
    /// thing is remembered as seen. Returns how many files were new, and
    /// how many the library had.
    async fn take_in(
        &self,
        item: &Item,
        cancel: &Arc<Notify>,
    ) -> Result<(u64, u64), ApiError> {
        let text = |text: &Option<String>| {
            let text = text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            text.map(str::to_string)
        };
        let (title, description) = (text(&item.title), text(&item.description));
        let whole = item.set.as_ref();
        let whole = whole.filter(|whole| !whole.id.trim().is_empty());
        let tab = Some(self.tab);
        let mut ids = Vec::new();
        let (mut added, mut existing) = (0, 0);
        for path in &item.files {
            // Only what is in the folder it was given; a script has no
            // business handing over anything else.
            let inside = path.starts_with(&self.out)
                && !path.components().any(|part| part == Component::ParentDir);
            if !inside {
                return Err(ApiError::bad_request("a file outside the download folder"));
            }
            let (hash, size) = files::hash_file(path).await?;
            let name = path.file_name().and_then(|name| name.to_str());
            let (file, created) = files::ingest(&self.state, path, &hash, size, name, tab).await?;
            let _ = tokio::fs::remove_file(path).await;
            if created {
                added += 1;
            } else {
                existing += 1;
            }
            if !ids.contains(&file.id) {
                ids.push(file.id);
            }
        }
        for url in &item.delegate {
            let (theirs, new, old) = self.hand_over(url.trim(), cancel).await?;
            added += new;
            existing += old;
            for id in theirs {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        self.taken.lock().unwrap().extend(&ids);

        let mut conn = self.state.db.lock().unwrap();
        let tx = conn.transaction()?;
        let tagged = entities::ids_json(&ids);
        // The set the downloader asks for holds the files, in order. One
        // that is in a set already, as the same picture posted twice, stays
        // in the set it is in.
        if let Some(whole) = whole.filter(|_| !ids.is_empty()) {
            let set = whole.id.trim();
            // Titled when it is made, and not again: a title the user took
            // off stays off.
            if !sets::exists(&tx, set)?
                && let Some(title) = text(&whole.title)
            {
                sets::fill(&tx, set, "title", &title)?;
            }
            if let Some(description) = text(&whole.description) {
                sets::fill(&tx, set, "description", &description)?;
            }
            sets::add_files(&tx, set, &ids, false)?;
            if let Some(url) = text(&whole.url) {
                sets::add_to_list(&tx, set, sets::SOURCE_URLS, &url)?;
            }
            if let Some(part) = &whole.collection
                && let Some(collection) = part.note(&tx)?
            {
                sets::add_to_list(&tx, set, sets::COLLECTIONS, &collection)?;
            }
            // None of them may have been free to go in it.
            sets::prune(&tx)?;
        }
        // What the user has written is never written over.
        let fill = |ids: &str, column: &str, value: &Option<String>| {
            let Some(value) = value else { return Ok(0) };
            tx.execute(
                &format!(
                    "UPDATE entity SET {column} = ?2 WHERE {column} IS NULL
                     AND id IN (SELECT value FROM json_each(?1))"
                ),
                params![ids, value],
            )
        };
        fill(&tagged, "title", &title)?;
        fill(&tagged, "description", &description)?;
        for url in item.source_url.each() {
            entities::add_to_list(&tx, &tagged, SOURCE_URLS, url)?;
        }
        if let Some(part) = &item.collection
            && let Some(collection) = part.note(&tx)?
        {
            entities::add_to_list(&tx, &tagged, COLLECTIONS, &collection)?;
        }
        let source = [("source".to_string(), self.manifest.source.clone())];
        let each = |tags: &BaseTags| {
            let tags = tags.clone().into_iter();
            tags.flat_map(|(field, values)| {
                values.into_iter().map(move |value| (field.clone(), value))
            })
        };
        // The tab's tags were checked when they were set. The script's own
        // are checked here, and one that is not a tag is passed over.
        let checked = |tags: &BaseTags| {
            each(tags).filter_map(|(field, value)| {
                tags::check_field(&field).ok()?;
                Some((field.clone(), tags::normalize(&field, &value).ok()?))
            })
        };
        // The files get the source and the tab's tags, and beyond those
        // the tags the script gave the thing and its set.
        let mut given: Vec<(String, String)> = source.into_iter().chain(each(&self.base)).collect();
        given.extend(checked(&item.tags));
        if let Some(whole) = whole {
            given.extend(checked(&whole.tags));
        }
        for (field, value) in given {
            // An alias stands for the tag it defers to.
            let value = tags::resolve(&tx, &field, value)?;
            entities::attach_tag(&tx, &tagged, &field, &value)?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO tab_download_seen (tab_id, key)
             SELECT id, ?2 FROM tab WHERE id = ?1",
            params![self.tab, item.key],
        )?;
        if !ids.is_empty() {
            // The view saved for the tab is of what it held before; without
            // it, the tab shows what it holds now when next opened.
            tx.execute("DELETE FROM tab_view WHERE tab_id = ?1", [self.tab])?;
        }
        tx.commit()?;
        Ok((added, existing))
    }
}

/// An error in the words shown to the user.
fn reason(err: ApiError) -> String {
    match err {
        ApiError::NotFound => "not found".to_string(),
        ApiError::BadRequest(message) | ApiError::Internal(message) => message,
        ApiError::Query(err) => err.message,
    }
}

/// Stops a script: asked first, so that it can stop what it started in
/// turn, then killed if it has not gone.
async fn end(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .await;
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_ok()
        {
            return;
        }
    }
    let _ = child.kill().await;
}
