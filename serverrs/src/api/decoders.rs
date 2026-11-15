//! Public read-only access to persisted decoder results, plus admin CRUD for
//! the background decoder configuration and database maintenance.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};

use crate::config::DecoderConfig;

use super::admin::json_response;
use super::AppState;

/// One page of stored decodes.
///
/// `GET /api/decoder/history?mode=ft8&limit=200&offset=0`
pub async fn history(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let include_unconfigured = include_unconfigured(&q);
    let visibility = visibility(&state, include_unconfigured);
    let query = history_query(&q, 200, visibility);
    let (messages, total) = state.decoder_store.history(&query);
    Json(json!({
        "messages": messages,
        "total": total,
        "limit": query.limit,
        "offset": query.offset,
        "includeUnconfigured": include_unconfigured,
        "filters": {
            "mode": query.mode,
            "decoderId": query.decoder_id,
            "dongleId": query.dongle_id,
            "q": query.search,
            "since": query.since_ms,
            "until": query.until_ms,
        },
    }))
}

/// Aggregate counts used by the admin dashboard and the client history panel.
pub async fn summary(State(state): State<AppState>) -> Json<Value> {
    let mut summary = filter_summary(state.decoder_store.summary(), &state);
    if let Some(object) = summary.as_object_mut() {
        object.insert("stats".to_string(), state.decoder_store.stats());
        object.insert(
            "database".to_string(),
            database_config_json(&state.cfg.read().database),
        );
    }
    Json(summary)
}

/// Supported background decoder modes and their typical defaults.
pub async fn modes() -> Json<Value> {
    Json(Value::Array(crate::decoders::background_modes()))
}

pub async fn messages(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let include_unconfigured = include_unconfigured(&q);
    let visibility = visibility(&state, include_unconfigured);
    let query = history_query(&q, 200, visibility);
    Json(Value::Array(state.decoder_store.history(&query).0))
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
    let mut entities = state.decoder_store.entities("aircraft", limit);
    if !include_unconfigured(&q) {
        entities = filter_entities(entities, &state);
    }
    Json(Value::Array(entities))
}

pub async fn vessels(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let limit = q
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(500);
    let mut entities = state.decoder_store.entities("vessel", limit);
    if !include_unconfigured(&q) {
        entities = filter_entities(entities, &state);
    }
    Json(Value::Array(entities))
}

// ---------------------------------------------------------------------
// Admin configuration API
// ---------------------------------------------------------------------

pub async fn admin_list(State(state): State<AppState>) -> Response {
    let (decoders, database, version) = {
        let cfg = state.cfg.read();
        (
            cfg.decoders.clone(),
            database_config_json(&cfg.database),
            state.cfg_version.get(),
        )
    };
    let mut summary = state.decoder_store.summary();
    if let Some(object) = summary.as_object_mut() {
        object.insert("stats".to_string(), state.decoder_store.stats());
    }
    json_response(
        StatusCode::OK,
        json!({
            "decoders": decoders,
            "modes": crate::decoders::background_modes(),
            "database": database,
            "summary": summary,
            "version": version,
        }),
        Some(version),
    )
}

pub async fn admin_create(State(state): State<AppState>, body: Bytes) -> Response {
    let mut decoder: DecoderConfig = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid decoder config"}),
                None,
            )
        }
    };
    decoder.mode = decoder.mode.trim().to_ascii_lowercase();
    if decoder.id.trim().is_empty() {
        decoder.id = unique_decoder_id(&state, &decoder.mode, decoder.frequency_hz);
    }
    if let Err(error) = validate_decoder(&state.cfg.read(), &decoder, None) {
        return json_response(StatusCode::BAD_REQUEST, json!({"error": error}), None);
    }

    state.cfg.write().decoders.push(decoder.clone());
    let version = state.cfg_version.increment();
    state.mgr.reload_decoders();
    json_response(
        StatusCode::CREATED,
        serde_json::to_value(&decoder).unwrap_or(Value::Null),
        Some(version),
    )
}

pub async fn admin_update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let patch: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid decoder config"}),
                None,
            )
        }
    };

    let updated = {
        let mut cfg = state.cfg.write();
        let Some(index) = cfg.decoders.iter().position(|d| d.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "decoder not found"}),
                None,
            );
        };
        let mut merged = match serde_json::to_value(&cfg.decoders[index]) {
            Ok(value) => value,
            Err(_) => Value::Object(Default::default()),
        };
        super::admin::merge_json(&mut merged, &patch);
        if let Some(object) = merged.as_object_mut() {
            // The path is authoritative; a patch cannot rename the row.
            object.insert("id".to_string(), json!(id));
        }
        let mut decoder: DecoderConfig = match serde_json::from_value(merged) {
            Ok(value) => value,
            Err(_) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "invalid decoder config"}),
                    None,
                )
            }
        };
        decoder.mode = decoder.mode.trim().to_ascii_lowercase();
        if let Err(error) = validate_decoder(&cfg, &decoder, Some(&id)) {
            return json_response(StatusCode::BAD_REQUEST, json!({"error": error}), None);
        }
        cfg.decoders[index] = decoder.clone();
        decoder
    };

    let version = state.cfg_version.increment();
    state.mgr.reload_decoders();
    json_response(
        StatusCode::OK,
        serde_json::to_value(&updated).unwrap_or(Value::Null),
        Some(version),
    )
}

pub async fn admin_delete(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let removed = {
        let mut cfg = state.cfg.write();
        let before = cfg.decoders.len();
        cfg.decoders.retain(|decoder| decoder.id != id);
        before != cfg.decoders.len()
    };
    if !removed {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"error": "decoder not found"}),
            None,
        );
    }
    let version = state.cfg_version.increment();
    state.mgr.reload_decoders();
    json_response(
        StatusCode::OK,
        json!({"status": "deleted", "id": id}),
        Some(version),
    )
}

/// Rebuild decoder workers without changing the configuration. Useful after
/// editing the YAML file out of band.
pub async fn admin_reload(State(state): State<AppState>) -> Response {
    state.mgr.reload_decoders();
    let version = state.cfg_version.get();
    json_response(
        StatusCode::OK,
        json!({"status": "reloaded", "decoders": state.cfg.read().decoders.len()}),
        Some(version),
    )
}

/// Purge stored history.
///
/// Body variants:
/// - `{"all": true}` removes everything.
/// - `{"mode": "ft8"}` removes one mode.
/// - `{"olderThanDays": 7}` applies a one-off retention cut.
/// - `{}` applies the configured retention/capacity policy now.
pub async fn admin_purge(State(state): State<AppState>, body: Bytes) -> Response {
    let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let result = if request.get("all").and_then(Value::as_bool).unwrap_or(false) {
        state.decoder_store.clear(None)
    } else if let Some(mode) = request
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
    {
        state.decoder_store.clear(Some(mode))
    } else if let Some(days) = request.get("olderThanDays").and_then(Value::as_i64) {
        state.decoder_store.purge(days, 0)
    } else {
        state.mgr.purge_decoder_history()
    };
    json_response(
        StatusCode::OK,
        json!({
            "status": "purged",
            "messages": result.messages,
            "entities": result.entities,
            "stats": state.decoder_store.stats(),
        }),
        None,
    )
}

fn include_unconfigured(q: &HashMap<String, String>) -> bool {
    q.get("includeUnconfigured")
        .or_else(|| q.get("include_unconfigured"))
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn effective_retention(own_days: i64, global_days: i64) -> i64 {
    if own_days > 0 {
        own_days
    } else {
        global_days
    }
}

/// Public API visibility: only decoders present in the configuration, each
/// limited to its own retention window. Foreground `client-*` decoders use the
/// global retention setting.
fn visibility(
    state: &AppState,
    include_unconfigured: bool,
) -> Option<crate::decoders::store::HistoryVisibility> {
    if include_unconfigured {
        return None;
    }
    let cfg = state.cfg.read();
    let global = cfg.database.retention_days;
    Some(crate::decoders::store::HistoryVisibility {
        decoders: cfg
            .decoders
            .iter()
            .map(|decoder| {
                (
                    decoder.id.clone(),
                    effective_retention(decoder.retention_days, global),
                )
            })
            .collect(),
        global_retention_days: global,
    })
}

fn filter_summary(mut summary: Value, state: &AppState) -> Value {
    let cfg = state.cfg.read();
    let now = crate::decoders::store::now_ms();
    let global = cfg.database.retention_days;
    let configured: HashMap<&str, i64> = cfg
        .decoders
        .iter()
        .map(|decoder| {
            (
                decoder.id.as_str(),
                effective_retention(decoder.retention_days, global),
            )
        })
        .collect();
    let allowed = |decoder_id: &str| -> Option<i64> {
        if decoder_id.starts_with("client-") {
            Some(global)
        } else {
            configured.get(decoder_id).copied()
        }
    };

    let raw_decoders = summary
        .get("decoders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut decoders = Vec::with_capacity(raw_decoders.len());
    for mut entry in raw_decoders {
        let decoder_id = entry["decoderId"].as_str().unwrap_or_default().to_string();
        let Some(days) = allowed(&decoder_id) else {
            continue;
        };
        if days > 0 {
            // The raw summary counts every row still in SQLite. Re-count within
            // this decoder's own visible window so the summary agrees with the
            // history endpoint even between maintenance purges.
            let cutoff = now.saturating_sub(days.saturating_mul(86_400_000));
            let (rows, total) = state.decoder_store.history(&crate::decoders::store::HistoryQuery {
                decoder_id: Some(decoder_id),
                since_ms: Some(cutoff),
                limit: 1,
                now_ms: now,
                ..Default::default()
            });
            if total <= 0 {
                continue;
            }
            entry["count"] = json!(total);
            if let Some(latest) = rows.first().and_then(|row| row["receivedMs"].as_i64()) {
                entry["latestMs"] = json!(latest);
            }
            let raw_oldest = entry["oldestMs"].as_i64().unwrap_or(cutoff);
            entry["oldestMs"] = json!(raw_oldest.max(cutoff));
        }
        decoders.push(entry);
    }

    // Rebuild the per-mode aggregate from the surviving decoder rows.
    let mut modes: HashMap<String, (i64, i64, i64, i64)> = HashMap::new();
    for entry in &decoders {
        let mode = entry["mode"].as_str().unwrap_or_default().to_string();
        let count = entry["count"].as_i64().unwrap_or(0);
        let latest = entry["latestMs"].as_i64().unwrap_or(0);
        let oldest = entry["oldestMs"].as_i64().unwrap_or(0);
        let slot = modes.entry(mode).or_insert((0, 0, i64::MAX, 0));
        slot.0 += count;
        slot.1 += 1;
        slot.2 = slot.2.min(oldest);
        slot.3 = slot.3.max(latest);
    }
    let mut mode_rows: Vec<Value> = modes
        .into_iter()
        .map(|(mode, (count, decoders, oldest, latest))| {
            json!({
                "mode": mode,
                "count": count,
                "decoders": decoders,
                "oldestMs": oldest,
                "latestMs": latest,
            })
        })
        .collect();
    mode_rows.sort_by(|a, b| {
        b["count"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["count"].as_i64().unwrap_or(0))
    });
    let total: i64 = decoders
        .iter()
        .map(|entry| entry["count"].as_i64().unwrap_or(0))
        .sum();

    // Entity counts are grouped by kind. Recount from the keyed tables so a
    // removed ADS-B/AIS decoder also disappears from the public summary.
    let mut entities = summary
        .get("entities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for entry in &mut entities {
        let kind = entry["kind"].as_str().unwrap_or_default();
        let rows = state.decoder_store.entities(kind, 5_000);
        let count = rows
            .iter()
            .filter(|row| entity_visible(row, &configured, global, now))
            .count();
        let latest = rows
            .iter()
            .filter(|row| entity_visible(row, &configured, global, now))
            .filter_map(|row| row["lastSeenMs"].as_i64())
            .max()
            .unwrap_or(0);
        entry["count"] = json!(count);
        entry["latestMs"] = json!(latest);
    }
    entities.retain(|entry| entry["count"].as_i64().unwrap_or(0) > 0);

    if let Some(object) = summary.as_object_mut() {
        object.insert("modes".to_string(), Value::Array(mode_rows));
        object.insert("decoders".to_string(), Value::Array(decoders));
        object.insert("entities".to_string(), Value::Array(entities));
        object.insert("total".to_string(), json!(total));
    }
    summary
}

fn entity_visible(
    entry: &Value,
    configured: &HashMap<&str, i64>,
    global: i64,
    now: i64,
) -> bool {
    let decoder_id = entry["payload"]["decoderId"]
        .as_str()
        .unwrap_or_default();
    let days = if decoder_id.starts_with("client-") {
        global
    } else {
        match configured.get(decoder_id) {
            Some(days) => *days,
            None => return false,
        }
    };
    if days <= 0 {
        return true;
    }
    let last_seen = entry["lastSeenMs"].as_i64().unwrap_or(0);
    last_seen >= now.saturating_sub(days.saturating_mul(86_400_000))
}

fn filter_entities(mut entities: Vec<Value>, state: &AppState) -> Vec<Value> {
    let cfg = state.cfg.read();
    let now = crate::decoders::store::now_ms();
    let global = cfg.database.retention_days;
    let configured: HashMap<&str, i64> = cfg
        .decoders
        .iter()
        .map(|decoder| {
            (
                decoder.id.as_str(),
                effective_retention(decoder.retention_days, global),
            )
        })
        .collect();
    entities.retain(|entry| entity_visible(entry, &configured, global, now));
    entities
}

fn history_query(
    q: &HashMap<String, String>,
    default_limit: usize,
    visibility: Option<crate::decoders::store::HistoryVisibility>,
) -> crate::decoders::store::HistoryQuery {
    let get = |key: &str| {
        q.get(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    crate::decoders::store::HistoryQuery {
        mode: get("mode"),
        decoder_id: get("decoderId").or_else(|| get("decoder_id")),
        dongle_id: get("dongleId").or_else(|| get("dongle_id")),
        search: get("q").or_else(|| get("search")),
        since_ms: q.get("since").and_then(|value| value.parse::<i64>().ok()),
        until_ms: q.get("until").and_then(|value| value.parse::<i64>().ok()),
        limit: q
            .get("limit")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(default_limit)
            .clamp(1, 5_000),
        offset: q
            .get("offset")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0),
        visibility,
        now_ms: crate::decoders::store::now_ms(),
    }
}

fn database_config_json(database: &crate::config::DatabaseConfig) -> Value {
    json!({
        "decoderPath": database.decoder_path,
        "retentionDays": database.retention_days,
        "purgeIntervalMinutes": database.purge_interval_minutes,
        "maxMessages": database.max_messages,
    })
}

fn validate_decoder(
    cfg: &crate::config::Config,
    decoder: &DecoderConfig,
    existing_id: Option<&str>,
) -> Result<(), String> {
    if decoder.id.trim().is_empty() {
        return Err("decoder id is required".to_string());
    }
    if decoder.mode.trim().is_empty() {
        return Err("decoder mode is required".to_string());
    }
    if !crate::decoders::supported_mode(&decoder.mode) {
        return Err(format!("unsupported decoder mode {:?}", decoder.mode));
    }
    if decoder.frequency_hz <= 0 {
        return Err("frequencyHz must be > 0".to_string());
    }
    if decoder.retention_days < 0 {
        return Err("retentionDays must be >= 0".to_string());
    }
    if decoder.dongle_id.trim().is_empty() {
        return Err("dongleId is required".to_string());
    }
    if !cfg
        .dongles
        .iter()
        .any(|dongle| dongle.id == decoder.dongle_id)
    {
        return Err(format!("unknown dongleId {:?}", decoder.dongle_id));
    }
    if cfg
        .decoders
        .iter()
        .any(|other| other.id == decoder.id && existing_id != Some(other.id.as_str()))
    {
        return Err(format!("decoder id {:?} already exists", decoder.id));
    }
    Ok(())
}

/// Build a stable, readable id (`ft8-14074000`) and avoid collisions.
fn unique_decoder_id(state: &AppState, mode: &str, frequency_hz: i64) -> String {
    let mode = mode.trim().to_ascii_lowercase();
    let mode: String = mode
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let base = if mode.is_empty() {
        format!("decoder-{frequency_hz}")
    } else {
        format!("{mode}-{frequency_hz}")
    };
    let existing: Vec<String> = state
        .cfg
        .read()
        .decoders
        .iter()
        .map(|decoder| decoder.id.clone())
        .collect();
    if !existing.contains(&base) {
        return base;
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base}-{suffix}");
        if !existing.contains(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}
