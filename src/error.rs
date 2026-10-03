use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

use crate::query::QueryError;

/// Error returned by API handlers, rendered as `{"error": "..."}`.
pub enum ApiError {
    NotFound,
    BadRequest(String),
    /// A search query that does not parse; also carries the character offset.
    Query(QueryError),
    Internal(String),
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::BadRequest(message.into())
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        match err {
            rusqlite::Error::QueryReturnedNoRows => ApiError::NotFound,
            // Input is validated before it reaches the database, so what is
            // left is mostly references to entities that do not exist.
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                ApiError::bad_request("refers to something that does not exist, or is not allowed")
            }
            other => ApiError::Internal(other.to_string()),
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        ApiError::Internal(err.to_string())
    }
}

impl From<QueryError> for ApiError {
    fn from(err: QueryError) -> Self {
        ApiError::Query(err)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, json!({ "error": "not found" })),
            ApiError::BadRequest(message) => (StatusCode::BAD_REQUEST, json!({ "error": message })),
            ApiError::Query(err) => (
                StatusCode::BAD_REQUEST,
                json!({ "error": err.message, "position": err.position }),
            ),
            ApiError::Internal(detail) => {
                eprintln!("internal error: {detail}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "internal error" }),
                )
            }
        };
        (status, Json(body)).into_response()
    }
}
