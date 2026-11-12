//! Public read-only access to persisted decoder results.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::Json;
use serde_json::Value;

use super::AppState;

pub async fn messages(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let mode = q.get("mode").map(String::as_str).filter(|m| !m.is_empty());
    let limit = q
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(200);
    let since_ms = q
        .get("since")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    Json(Value::Array(
        state.decoder_store.recent(mode, since_ms, limit),
    ))
}

pub async fn stats(State(state): State<AppState>) -> Json<Value> {
    Json(state.decoder_store.stats())
}

pub async fn aircraft(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let limit = q
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(500);
    Json(Value::Array(state.decoder_store.entities("aircraft", limit)))
}
