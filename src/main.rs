mod book;
mod collections;
mod db;
mod entities;
mod error;
mod export;
mod files;
mod media;
mod query;
mod search;
mod tabs;

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
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = PathBuf::from(env_or("TAGUTILS_DATA", "data"));
    let web_dir = PathBuf::from(env_or("TAGUTILS_WEB", "web/dist"));
    let addr: SocketAddr = env_or("TAGUTILS_ADDR", "127.0.0.1:7878").parse()?;

    let storage = data_dir.join("storage");
    let tmp = data_dir.join("tmp");
    let thumbnails = data_dir.join("thumbnails");
    std::fs::create_dir_all(&storage)?;
    std::fs::create_dir_all(&thumbnails)?;
    // Anything left in tmp is an upload a previous run never finished.
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;

    let conn = db::open(&data_dir.join("tagutils.db"))?;
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        storage,
        thumbnails,
        tmp,
    };

    let api = Router::new()
        .route("/health", get(health))
        .route("/stats", get(stats))
        .merge(tabs::router())
        .merge(files::router())
        .merge(search::router())
        .merge(entities::router())
        .merge(collections::router())
        .merge(export::router())
        .fallback(|| async { ApiError::NotFound });
    // Anything outside /api is the SPA; unknown paths get index.html so
    // client-side routes survive a reload.
    let spa = ServeDir::new(&web_dir).fallback(ServeFile::new(web_dir.join("index.html")));
    let app = Router::new()
        .nest("/api", api)
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
    let count = |kind: &str| {
        conn.query_row("SELECT count(*) FROM entity WHERE kind = ?1", [kind], |row| {
            row.get::<_, i64>(0)
        })
    };
    Ok(Json(json!({ "files": count("file")?, "collections": count("collection")? })))
}
