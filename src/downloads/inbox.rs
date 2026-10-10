//! The inbox: downloads asked for from outside the interface, by a browser
//! extension for one, with nothing but an address.
//!
//! Each waits in a queue kept in the database, so that a restart loses
//! none, and they are run one at a time. The downloader is found from the
//! address, by the sites its manifest names, and is set as it is for
//! every tab; besides that, each downloader has tags of its own that it
//! gives here. What is fetched is listed under one tab, which holds it
//! until the user clears it.

use std::sync::atomic::Ordering;

use super::*;

/// The `downloader` of the inbox's tab: no folder can be called this.
pub const ANY: &str = "*";

/// Finished requests kept on show, besides those still waiting.
const KEPT: i64 = 100;

#[derive(Deserialize)]
struct Request {
    url: String,
    /// The downloader to use, by name; found from the address if left out.
    downloader: Option<String>,
    /// Tags for what this one request downloads, written as they are typed
    /// in the interface: `cat`, or with its type `@cr:someone`.
    #[serde(default)]
    tags: Vec<String>,
}

/// Tags as they are typed, by field: a plain one is of type `tags`, and one
/// that begins with an @ names its type, by its short name or its full one.
fn typed(tags: &[String]) -> Result<BaseTags, ApiError> {
    let mut by_field = BaseTags::new();
    for tag in tags.iter().map(|tag| tag.trim()).filter(|tag| !tag.is_empty()) {
        let (field, value) = match tag.strip_prefix('@') {
            Some(rest) => {
                let (name, value) = rest.split_once(':').unwrap_or((rest, ""));
                let name = name.trim();
                let field = tag_type(name)
                    .ok_or_else(|| ApiError::BadRequest(format!("`@{name}` is not a tag type")))?;
                (field, value)
            }
            None => ("tags", tag),
        };
        let value = tags::normalize(field, value)?;
        let values = by_field.entry(field.to_string()).or_default();
        if !values.contains(&value) {
            values.push(value);
        }
    }
    Ok(by_field)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/inbox", get(state_of).post(enqueue))
        .route("/inbox/clear", post(clear))
        .route("/inbox/queue/{id}", get(one).delete(remove))
        .route("/inbox/queue/{id}/retry", post(retry))
        .route("/inbox/sites", get(sites))
}

/// The inbox's tab, if there is one.
fn made(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM tab WHERE downloader = ?1", [ANY], |row| {
        row.get(0)
    })
    .optional()
}

/// The inbox's tab, made if there is none yet.
pub fn tab(conn: &Connection) -> rusqlite::Result<i64> {
    if let Some(tab) = made(conn)? {
        return Ok(tab);
    }
    conn.execute(
        "INSERT INTO tab (position, kind, downloader)
         VALUES ((SELECT coalesce(max(position), -1) + 1 FROM tab), 'download', ?1)",
        [ANY],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The inbox's tab, if it has one and it is not closed.
fn on_show(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT id FROM tab WHERE downloader = ?1 AND hidden = 0",
        [ANY],
        |row| row.get(0),
    )
    .optional()
}

/// Opens the inbox: its tab, made if there is none, and brought back, after
/// the other tabs, if it was closed.
pub fn open(conn: &Connection) -> rusqlite::Result<i64> {
    let tab = tab(conn)?;
    conn.execute(
        "UPDATE tab SET hidden = 0, position = (SELECT coalesce(max(position), -1) + 1 FROM tab)
         WHERE id = ?1 AND hidden = 1",
        [tab],
    )?;
    Ok(tab)
}

/// Closes a tab if it is the inbox, and says whether it was. Closed, it is
/// put out of sight and keeps what it lists: that is only ever cleared on
/// purpose.
pub fn close(conn: &Connection, tab: i64) -> rusqlite::Result<bool> {
    let closed = conn.execute(
        "UPDATE tab SET hidden = 1 WHERE id = ?1 AND downloader = ?2",
        params![tab, ANY],
    )?;
    Ok(closed > 0)
}

const SELECT: &str = "SELECT id, url, downloader, status, message, added, existing,
                             date_queued, date_finished, tags FROM inbox_queue";

fn request_from_row(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "url": row.get::<_, String>(1)?,
        "downloader": row.get::<_, String>(2)?,
        "status": row.get::<_, String>(3)?,
        "message": row.get::<_, String>(4)?,
        "added": row.get::<_, i64>(5)?,
        "existing": row.get::<_, i64>(6)?,
        "date_queued": row.get::<_, String>(7)?,
        "date_finished": row.get::<_, Option<String>>(8)?,
        // The table only accepts valid JSON.
        "tags": serde_json::from_str::<Value>(&row.get::<_, String>(9)?).unwrap_or_default(),
    }))
}

fn request(conn: &Connection, id: i64) -> Result<Value, ApiError> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], request_from_row)
        .optional()?
        .ok_or(ApiError::NotFound)
}

/// Asks for an address to be downloaded. It is done when its turn comes.
async fn enqueue(
    State(state): State<AppState>,
    Json(input): Json<Request>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let url = input.url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ApiError::bad_request("that is not a web address"));
    }
    let manifest = match input.downloader.as_deref() {
        Some(name) => manifest(&state, name)?,
        None => for_url(&state, &url)?.ok_or_else(|| {
            let host = host_of(&url).unwrap_or_default();
            ApiError::BadRequest(format!("no downloader takes addresses of {host}"))
        })?,
    };
    let tags = typed(&input.tags)?;
    let queued = {
        let conn = state.db.lock().unwrap();
        // There from the first request on, to list what comes of it. If it
        // was closed it stays closed, and lists it all the same.
        tab(&conn)?;
        conn.execute(
            "INSERT INTO inbox_queue (url, downloader, tags) VALUES (?1, ?2, ?3)",
            params![url, manifest.name, json!(tags).to_string()],
        )?;
        request(&conn, conn.last_insert_rowid())?
    };
    work(&state);
    Ok((StatusCode::CREATED, Json(queued)))
}

/// What became of one request.
async fn one(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    Ok(Json(request(&state.db.lock().unwrap(), id)?))
}

/// The sites there is a downloader for, for a sender to know what it can
/// send.
async fn sites(State(state): State<AppState>) -> Json<Value> {
    let found: Vec<Value> = manifests(&state)
        .iter()
        .filter(|manifest| !manifest.sites.is_empty())
        .map(|m| json!({ "downloader": m.name, "title": m.title, "sites": m.sites }))
        .collect();
    Json(json!(found))
}

/// Everything the inbox's panel shows: its tab, if it has one and it is
/// open, the queue, how the request being run is going, and every
/// downloader as it is set here.
async fn state_of(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let found = manifests(&state);
    let conn = state.db.lock().unwrap();
    // Asking makes no tab: it comes with the first request, or when opened.
    let tab = made(&conn)?;
    let job = tab
        .and_then(|tab| {
            let jobs = state.downloads.lock().unwrap();
            jobs.get(&tab).map(|job| job.status.lock().unwrap().clone())
        })
        .filter(|status| status.running);
    // Those not yet done, all of them, and the latest of the rest.
    let mut stmt = conn.prepare(&format!(
        "SELECT * FROM ({SELECT} WHERE status IN ('queued', 'running'))
         UNION ALL
         SELECT * FROM ({SELECT} WHERE status NOT IN ('queued', 'running')
                        ORDER BY id DESC LIMIT {KEPT})
         ORDER BY id"
    ))?;
    let queue = stmt
        .query_map([], request_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let listed: i64 = conn.query_row(
        "SELECT count(*) FROM tab_upload WHERE tab_id = ?1",
        [tab],
        |row| row.get(0),
    )?;
    // Closed, it is no tab to the interface, whatever it lists.
    let tab = on_show(&conn)?;
    let mut downloaders = Vec::new();
    for manifest in &found {
        let (options, tags) = settings(&conn, manifest)?;
        downloaders.push(json!({
            "downloader": described_with(&state, &conn, manifest),
            "options": options,
            "tags": tags,
        }));
    }
    Ok(Json(json!({
        "tab": tab,
        "queue": queue,
        "job": job,
        "listed": listed,
        "downloaders": downloaders,
    })))
}

/// Empties the inbox: what it lists, and the requests that are finished.
/// Nothing leaves the library, and what is still waiting stays.
async fn clear(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction()?;
    if let Some(tab) = made(&tx)? {
        tx.execute("DELETE FROM tab_upload WHERE tab_id = ?1", [tab])?;
        tx.execute("DELETE FROM tab_view WHERE tab_id = ?1", [tab])?;
        tx.execute("DELETE FROM tab_download_seen WHERE tab_id = ?1", [tab])?;
    }
    tx.execute(
        "DELETE FROM inbox_queue WHERE status NOT IN ('queued', 'running')",
        [],
    )?;
    tx.commit()?;
    Ok(StatusCode::NO_CONTENT)
}

/// Takes a request off the queue. The one being run is stopped, and stays
/// to say so.
async fn remove(State(state): State<AppState>, Path(id): Path<i64>) -> Result<StatusCode, ApiError> {
    let running = {
        let conn = state.db.lock().unwrap();
        let removed = conn.execute(
            "DELETE FROM inbox_queue WHERE id = ?1 AND status <> 'running'",
            [id],
        )?;
        if removed > 0 {
            return Ok(StatusCode::NO_CONTENT);
        }
        request(&conn, id)?;
        tab(&conn)?
    };
    cancel(&state, running);
    Ok(StatusCode::NO_CONTENT)
}

/// Puts a request that failed, or was stopped, back in the queue.
async fn retry(State(state): State<AppState>, Path(id): Path<i64>) -> Result<Json<Value>, ApiError> {
    let again = {
        let conn = state.db.lock().unwrap();
        conn.execute(
            "UPDATE inbox_queue
             SET status = 'queued', message = '', added = 0, existing = 0, date_finished = NULL
             WHERE id = ?1 AND status IN ('failed', 'cancelled')",
            [id],
        )?;
        request(&conn, id)?
    };
    work(&state);
    Ok(Json(again))
}

/// Takes up what a previous run of the server left in the queue. A request
/// it was in the middle of is begun again.
pub fn resume(state: &AppState) -> rusqlite::Result<()> {
    state.db.lock().unwrap().execute(
        "UPDATE inbox_queue SET status = 'queued' WHERE status = 'running'",
        [],
    )?;
    work(state);
    Ok(())
}

/// Sees that the queue is being worked through: by the worker there is, or
/// by a new one. A worker ends when the queue is empty.
fn work(state: &AppState) {
    if state.inbox_busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            let next = {
                let conn = state.db.lock().unwrap();
                let next = conn
                    .query_row(
                        "UPDATE inbox_queue SET status = 'running'
                         WHERE id = (SELECT min(id) FROM inbox_queue WHERE status = 'queued')
                         RETURNING id, url, downloader, tags",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()
                    .unwrap_or(None);
                if next.is_none() {
                    // Said with the database still held: a request put in
                    // the queue from now on finds no worker, and starts one.
                    state.inbox_busy.store(false, Ordering::SeqCst);
                }
                next
            };
            let Some((id, url, downloader, tags)): Option<(i64, String, String, String)> = next
            else {
                return;
            };
            let own: BaseTags = serde_json::from_str(&tags).unwrap_or_default();
            let (status, message, added, existing) = run(&state, &url, &downloader, own).await;
            let _ = state.db.lock().unwrap().execute(
                "UPDATE inbox_queue
                 SET status = ?2, message = ?3, added = ?4, existing = ?5,
                     date_finished = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                 WHERE id = ?1",
                params![id, status, message, added, existing],
            );
        }
    });
}

/// Runs one request to its end. Returns how it ended, as the queue has it:
/// the status, what there is to say, and the files that were new and old.
async fn run(
    state: &AppState,
    url: &str,
    downloader: &str,
    // The tags the request brought, given besides the downloader's.
    own: BaseTags,
) -> (&'static str, String, i64, i64) {
    let failed = |message: String| ("failed", message, 0, 0);
    let manifest = match manifest(state, downloader) {
        Ok(manifest) => manifest,
        Err(err) => return failed(reason(err)),
    };
    let ready = {
        let conn = state.db.lock().unwrap();
        tab(&conn).and_then(|tab| Ok((tab, settings(&conn, &manifest)?)))
    };
    let (tab, (options, mut base)) = match ready {
        Ok(ready) => ready,
        Err(err) => return failed(err.to_string()),
    };
    for (field, values) in own {
        let had = base.entry(field).or_default();
        for value in values {
            if !had.contains(&value) {
                had.push(value);
            }
        }
    }
    let out = fresh_out(state);
    // Nothing is passed over as seen before: what is asked for one thing at
    // a time is wanted, and a file the library has is only listed again.
    let request = request_for(state, &manifest, url, &options, &[], &out);
    let status = Arc::new(Mutex::new(Status {
        running: true,
        url: url.to_string(),
        ..Status::default()
    }));
    let stop = Arc::new(Notify::new());
    state.downloads.lock().unwrap().insert(
        tab,
        Job {
            status: status.clone(),
            cancel: stop.clone(),
        },
    );
    let download = Download::new(state.clone(), tab, manifest, base, out, status);
    let outcome = download.run(request, stop).await;
    let _ = tokio::fs::remove_dir_all(&download.out).await;
    let mut status = download.status.lock().unwrap();
    status.running = false;
    status.outcome = Some(match &outcome {
        Ok(outcome) | Err(outcome) => outcome.clone(),
    });
    let (added, existing) = (status.added as i64, status.existing as i64);
    let problems = status.errors.join("; ");
    match outcome {
        Err(why) => ("failed", why, added, existing),
        Ok(how) if how == "cancelled" => ("cancelled", String::new(), added, existing),
        // Done, though perhaps not all of it.
        Ok(_) if status.downloaded > 0 => ("done", problems, added, existing),
        Ok(_) if problems.is_empty() => failed("there was nothing to download".to_string()),
        Ok(_) => failed(problems),
    }
}
