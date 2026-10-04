#[cfg(test)]
mod api_tests;
mod book;
mod collections;
mod db;
mod downloads;
mod entities;
mod error;
mod export;
mod files;
mod media;
mod query;
mod search;
mod settings;
mod tabs;
mod tags;

use std::{
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{Json, Router, extract::State, routing::get};
use rusqlite::Connection;
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

use error::ApiError;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    /// Internal storage: one file per upload, named `<hash>.<extension>`.
    storage: PathBuf,
    /// One JPEG per file that has a thumbnail, named `<hash>.jpg`.
    thumbnails: PathBuf,
    /// Uploads in progress. On the same filesystem as `storage` so a
    /// finished upload can be renamed into place.
    tmp: PathBuf,
    /// The downloaders: one folder each, with a manifest and a script.
    downloaders: PathBuf,
    /// Logins saved for downloaders, one cookie file each.
    cookies: PathBuf,
    /// The downloads running, or last run, by tab.
    downloads: downloads::Jobs,
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Everything under `/api`.
fn api() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/stats", get(stats))
        .merge(settings::router())
        .merge(tabs::router())
        .merge(downloads::router())
        .merge(tags::router())
        .merge(files::router())
        .merge(search::router())
        .merge(entities::router())
        .merge(collections::router())
        .merge(export::router())
        .fallback(|| async { ApiError::NotFound })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Made absolute: downloaders are handed paths under the data directory,
    // and run from folders of their own.
    let data_dir = std::path::absolute(env_or("OPALARCHIVE_DATA", "data"))?;
    let web_dir = PathBuf::from(env_or("OPALARCHIVE_WEB", "web/dist"));
    let addr: SocketAddr = env_or("OPALARCHIVE_ADDR", "127.0.0.1:7878").parse()?;

    let storage = data_dir.join("storage");
    let tmp = data_dir.join("tmp");
    let thumbnails = data_dir.join("thumbnails");
    std::fs::create_dir_all(&storage)?;
    std::fs::create_dir_all(&thumbnails)?;
    // Anything left in tmp is an upload a previous run never finished.
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;

    let database = data_dir.join("opalarchive.db");
    // The database of a library begun under the program's earlier name
    // carries on under this one.
    let earlier = data_dir.join("tagutils.db");
    if !database.exists() && earlier.exists() {
        for end in ["", "-wal", "-shm"] {
            let from = data_dir.join(format!("tagutils.db{end}"));
            if from.exists() {
                std::fs::rename(from, data_dir.join(format!("opalarchive.db{end}")))?;
            }
        }
    }
    let conn = db::open(&database)?;
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        storage,
        thumbnails,
        tmp,
        downloaders: std::path::absolute(env_or("OPALARCHIVE_DOWNLOADERS", "downloaders"))?,
        cookies: data_dir.join("cookies"),
        downloads: Default::default(),
    };

    // Anything outside /api is the SPA; unknown paths get index.html so
    // client-side routes survive a reload.
    let spa = ServeDir::new(&web_dir).fallback(ServeFile::new(web_dir.join("index.html")));
    let app = Router::new()
        .nest("/api", api())
        .fallback_service(spa)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let version = db::schema_version(&conn)?;
    Ok(Json(json!({ "status": "ok", "schema_version": version })))
}

async fn stats(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let conn = state.db.lock().unwrap();
    let count = |condition: &str| {
        conn.query_row(
            &format!("SELECT count(*) FROM entity WHERE {condition}"),
            [],
            |row| row.get::<_, i64>(0),
        )
    };
    Ok(Json(json!({
        "files": count("kind = 'file' AND trashed = 0")?,
        "collections": count("kind = 'collection' AND trashed = 0")?,
        "trashed": count("trashed = 1")?,
    })))
}
