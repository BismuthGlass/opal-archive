//! Downloaders: scripts that fetch files from a website into the library,
//! each driven from a download tab.
//!
//! A downloader is a folder holding a `manifest.json` and a script. The
//! script knows the website and nothing of the library; this module knows
//! the library and nothing of the website. They talk in JSON: the request
//! goes to the script's standard input, and the script answers with one
//! event per line on its standard output. See `downloaders/README.md`.

pub mod inbox;

use std::{
    collections::{BTreeMap, HashMap},
    path::{Component, PathBuf},
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
    entities::{self, SOURCE_URLS},
    error::ApiError,
    files,
    query::{COLLECTION_TYPES, tag_type},
    tags,
};

/// A tab's choice for each of its downloader's options.
type Options = BTreeMap<String, bool>;
/// The tags a tab gives to everything it downloads: tag field to values.
type BaseTags = BTreeMap<String, Vec<String>>;

/// How many of a download's problems are kept to show.
const MAX_ERRORS: usize = 50;

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
    /// Switches the user can set, per tab.
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
struct ForgetInput {
    /// The keys to forget; all of them if left out.
    keys: Option<Vec<String>>,
}

/// One thing a downloader fetched, and what it knows of it.
#[derive(Deserialize)]
struct Item {
    /// What tells it from everything else on the site.
    key: String,
    source_url: Option<String>,
    /// Its files, in order, in the folder the script was given.
    #[serde(default)]
    files: Vec<PathBuf>,
    /// Given to the files if they have none of their own.
    title: Option<String>,
    description: Option<String>,
    /// Tags of its own, by field, besides the source and the tab's.
    #[serde(default)]
    tags: BaseTags,
    /// The collection its files are to be put in.
    collection: Option<Whole>,
}

/// A collection a downloader asks for, to hold what it fetches: a set of
/// the files of one post, or what several posts are part of, as a thread.
#[derive(Deserialize)]
struct Whole {
    /// Its collection ID, which is what tells it from every other: the
    /// collection that has it is the one used, and no second is made.
    id: String,
    /// Its type; a `set` if not said.
    #[serde(rename = "type")]
    kind: Option<String>,
    /// Its address on the site, kept as its source URL.
    url: Option<String>,
    /// What it is called when it is made; it has no title if not said.
    title: Option<String>,
    description: Option<String>,
    /// Tags of its own, by field, besides the source and the tab's.
    #[serde(default)]
    tags: BaseTags,
    /// Whether it keeps what is put in it in order. It does if not said.
    ordered: Option<bool>,
    /// The collection it is itself to be put in: a board, for the set of
    /// one of its posts.
    collection: Option<Box<Whole>>,
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
        .route("/tabs/{id}/download", get(state_of).patch(configure))
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

/// A downloader as the interface needs it: its manifest, and when its
/// login was saved (seconds since 1970), if one is.
fn described(state: &AppState, manifest: &Manifest) -> Value {
    let saved = std::fs::metadata(cookie_file(state, manifest))
        .and_then(|file| file.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_secs());
    let mut described = json!(manifest);
    described["login_saved"] = json!(saved);
    described
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
    std::fs::create_dir_all(&state.cookies)?;
    let file = cookie_file(&state, &manifest);
    // Written beside the real file, so a failed attempt leaves the login
    // that was there.
    let fresh = file.with_extension("new");
    let output = command(&state, &manifest)
        .args(["cookies", "--browser", &input.browser, "--out"])
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
            format!("No {} login was found in {}", manifest.title, input.browser)
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
    Ok(Json(described(&state, &manifest)))
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

/// The downloader of a download tab; 404 if there is no such tab.
fn downloader_of(state: &AppState, tab: i64) -> Result<Manifest, ApiError> {
    let name: Option<String> = state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT downloader FROM tab WHERE id = ?1", [tab], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or(ApiError::NotFound)?;
    let name = name.ok_or_else(|| ApiError::bad_request("not a download tab"))?;
    manifest(state, &name)
}

/// What a tab is set to: its options, the manifest's defaults filled in,
/// and its base tags.
fn settings(
    conn: &Connection,
    manifest: &Manifest,
    tab: i64,
) -> rusqlite::Result<(Options, BaseTags)> {
    let saved: Option<(String, String)> = conn
        .query_row(
            "SELECT options, tags FROM tab_download WHERE tab_id = ?1",
            [tab],
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
        base.clear();
        for (field, values) in given {
            tags::check_field(&field)?;
            let mut normal = Vec::new();
            for value in values {
                let value = tags::normalize(&field, &value)?;
                if !normal.contains(&value) {
                    normal.push(value);
                }
            }
            if !normal.is_empty() {
                base.insert(field, normal);
            }
        }
    }
    Ok(())
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

/// Everything a download tab's panel shows.
async fn state_of(
    State(state): State<AppState>,
    Path(tab): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let manifest = downloader_of(&state, tab)?;
    let job = state
        .downloads
        .lock()
        .unwrap()
        .get(&tab)
        .map(|job| job.status.lock().unwrap().clone());
    let conn = state.db.lock().unwrap();
    let (options, tags) = settings(&conn, &manifest, tab)?;
    let seen: i64 = conn.query_row(
        "SELECT count(*) FROM tab_download_seen WHERE tab_id = ?1",
        [tab],
        |row| row.get(0),
    )?;
    Ok(Json(json!({
        "downloader": described(&state, &manifest),
        "options": options,
        "tags": tags,
        "seen": seen,
        "job": job,
    })))
}

/// Sets a tab's options, its base tags, or both.
async fn configure(
    State(state): State<AppState>,
    Path(tab): Path<i64>,
    Json(input): Json<SettingsInput>,
) -> Result<StatusCode, ApiError> {
    let manifest = downloader_of(&state, tab)?;
    let conn = state.db.lock().unwrap();
    let (mut options, mut base) = settings(&conn, &manifest, tab)?;
    change(&manifest, &mut options, &mut base, input)?;
    conn.execute(
        "INSERT INTO tab_download (tab_id, options, tags) VALUES (?1, ?2, ?3)
         ON CONFLICT (tab_id) DO UPDATE SET options = excluded.options, tags = excluded.tags",
        params![tab, json!(options).to_string(), json!(base).to_string()],
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

/// Starts downloading `url` into the tab. One download runs per tab.
async fn start(
    State(state): State<AppState>,
    Path(tab): Path<i64>,
    Json(input): Json<StartInput>,
) -> Result<StatusCode, ApiError> {
    let manifest = downloader_of(&state, tab)?;
    let url = input.url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ApiError::bad_request("that is not a web address"));
    }
    let (options, base, seen) = {
        let conn = state.db.lock().unwrap();
        let (options, base) = settings(&conn, &manifest, tab)?;
        let mut stmt = conn.prepare("SELECT key FROM tab_download_seen WHERE tab_id = ?1")?;
        let seen = stmt
            .query_map([tab], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (options, base, seen)
    };

    let out = fresh_out(&state);
    let cookies = Some(cookie_file(&state, &manifest)).filter(|file| file.exists());
    let request = json!({
        "url": url,
        "options": options,
        "cookies": cookies,
        "seen": seen,
        "out": out,
    });

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

    let download = Download {
        state,
        tab,
        manifest,
        base,
        out,
        status,
    };
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
    Ok(StatusCode::NO_CONTENT)
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
}

impl Download {
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
                    Some(line) => self.handle(&line).await,
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
    async fn handle(&self, line: &str) {
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
            Event::Item(item) => match self.take_in(&item).await {
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

    /// Takes one downloaded thing into the library: its files go in, are
    /// listed under the tab, and get the source URL, the tags, and the
    /// title and description where they have none; they are also put in
    /// the collection it asks for. Then the thing is remembered as seen. Returns how many
    /// files were new, and how many the library had.
    async fn take_in(&self, item: &Item) -> Result<(u64, u64), ApiError> {
        let source_url = item.source_url.as_deref();
        let text = |text: &Option<String>| {
            let text = text
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            text.map(str::to_string)
        };
        let (title, description) = (text(&item.title), text(&item.description));
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
            let tab = Some(self.tab);
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

        let mut conn = self.state.db.lock().unwrap();
        let tx = conn.transaction()?;
        let tagged = entities::ids_json(&ids);
        // The collection the downloader asks for holds the files, in order;
        // the one that collection is in holds it, and so on outwards.
        let mut wholes = Vec::new();
        let mut members = ids.clone();
        let mut next = item.collection.as_ref().filter(|_| !ids.is_empty());
        while let Some(whole) = next.filter(|whole| !whole.id.trim().is_empty()) {
            let kind = whole.kind.as_deref().unwrap_or("set");
            if !COLLECTION_TYPES.contains(&kind) {
                return Err(ApiError::BadRequest(format!(
                    "`{kind}` is not a type of collection"
                )));
            }
            let wanted = whole.id.trim();
            let title = text(&whole.title);
            let ordered = whole.ordered.unwrap_or(true);
            let id = collection_of(&tx, wanted, kind, title.as_deref(), ordered, &members)?;
            let json = entities::ids_json(&[id]);
            if let Some(url) = text(&whole.url) {
                entities::add_to_list(&tx, &json, SOURCE_URLS, &url)?;
            }
            // It is listed under the tab beside its files.
            tx.execute(
                "INSERT OR IGNORE INTO tab_upload (tab_id, entity_id)
                 SELECT id, ?2 FROM tab WHERE id = ?1",
                params![self.tab, id],
            )?;
            wholes.push((json, text(&whole.description), &whole.tags));
            members = vec![id];
            next = whole.collection.as_deref();
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
        for (whole, description, _) in &wholes {
            fill(whole, "description", description)?;
        }
        if let Some(url) = source_url {
            entities::add_to_list(&tx, &tagged, SOURCE_URLS, url)?;
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
        // The files and the collections all get the source and the tab's
        // tags; beyond those, each gets the tags the script gave it.
        let shared: Vec<_> = source.into_iter().chain(each(&self.base)).collect();
        let mut given: Vec<(&str, (String, String))> = Vec::new();
        given.extend(shared.iter().cloned().map(|tag| (tagged.as_str(), tag)));
        given.extend(checked(&item.tags).map(|tag| (tagged.as_str(), tag)));
        for (whole, _, tags) in &wholes {
            given.extend(shared.iter().cloned().map(|tag| (whole.as_str(), tag)));
            given.extend(checked(tags).map(|tag| (whole.as_str(), tag)));
        }
        for (ids, (field, value)) in given {
            // An alias stands for the tag it defers to.
            let value = tags::resolve(&tx, &field, value)?;
            entities::attach_tag(&tx, ids, &field, &value)?;
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

/// The collection with the given collection ID, with `files` put in it:
/// the one that has it, whatever it has been retitled or made into since,
/// or a new one of the type given, with the title given if any.
fn collection_of(
    conn: &Connection,
    collection_id: &str,
    collection_type: &str,
    title: Option<&str>,
    ordered: bool,
    files: &[i64],
) -> Result<i64, ApiError> {
    let made = conn
        .query_row(
            "SELECT entity_id FROM collection WHERE collection_id = ?1",
            [collection_id],
            |row| row.get(0),
        )
        .optional()?;
    let collection = match made {
        Some(collection) => {
            // Like a file that arrives again, it comes back out of the trash.
            conn.execute("UPDATE entity SET trashed = 0 WHERE id = ?1", [collection])?;
            collection
        }
        None => {
            conn.execute(
                "INSERT INTO entity (kind, title) VALUES ('collection', ?1)",
                [title],
            )?;
            let collection = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO collection (entity_id, collection_type, ordered, collection_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![collection, collection_type, ordered, collection_id],
            )?;
            collection
        }
    };
    collections::add_members(conn, collection, files)?;
    Ok(collection)
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
