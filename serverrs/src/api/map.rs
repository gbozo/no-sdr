//! `/map` data feed: initial checkpoint plus a dedicated WebSocket stream.
//!
//! The map has its own socket so aircraft/vessel/grid updates never share the
//! audio/FFT WebSocket. The feed is built from the persisted decoder store, so
//! it works without touching the main client pipelines.
//!
//! Large frames are raw DEFLATE (`FRAME_DEFLATE`), so a populated checkpoint
//! costs a fraction of its JSON size. A reconnect that passes its last `at` as
//! `?since=` gets one delta frame instead of the checkpoint again.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

use super::AppState;

const SPOTTING_LOOKBACK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const ENTITY_ACTIVE_MS: i64 = 5 * 60 * 1000;
const CHECKPOINT_GRID_LIMIT: usize = 3_000;
const UPDATE_LIMIT: usize = 1_000;
/// One row per aircraft/vessel key, and the map only shows the 2,000 newest,
/// so this covers a full table in one delta.
const UPDATE_ENTITY_LIMIT: usize = 2_000;
const UPDATE_INTERVAL_MS: u64 = 750;

/// First byte of a compressed map frame: the rest is raw DEFLATE (no zlib
/// wrapper) of the UTF-8 JSON document.
const FRAME_DEFLATE: u8 = 0x01;
/// Below this size deflate costs more than it saves, so the frame stays text.
const COMPRESS_MIN_BYTES: usize = 1024;
/// JSON is far from the FFT's noise-like byte stream; level 6 is still cheap
/// here and saves roughly an order of magnitude on a populated checkpoint.
const COMPRESS_LEVEL: u32 = 6;

/// Encode one map document for the wire.
///
/// Small frames stay `Text` so the client can keep a plain `JSON.parse` path;
/// anything large is `Binary` with the `FRAME_DEFLATE` marker. The browser
/// already ships `fflate` for FFT deflate, so decoding costs no new dependency.
fn map_frame(value: &Value) -> Message {
    let text = value.to_string();
    if text.len() < COMPRESS_MIN_BYTES {
        return Message::Text(text.into());
    }
    match crate::codec::deflate::deflate_bytes(text.as_bytes(), COMPRESS_LEVEL) {
        Ok(body) => {
            let mut frame = Vec::with_capacity(1 + body.len());
            frame.push(FRAME_DEFLATE);
            frame.extend_from_slice(&body);
            Message::Binary(frame.into())
        }
        // Compression is an optimisation; never fail the map feed over it.
        Err(_) => Message::Text(text.into()),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Six-character Maidenhead locator. Kept server-side so the checkpoint is
/// self-contained for non-browser map consumers too.
fn grid_from_lat_lon(latitude: f64, longitude: f64) -> String {
    if !latitude.is_finite()
        || !longitude.is_finite()
        || latitude < -90.0
        || latitude > 90.0
        || longitude < -180.0
        || longitude > 180.0
        || (latitude == 0.0 && longitude == 0.0)
    {
        return String::new();
    }
    let lon = longitude.min(179.999999) + 180.0;
    let lat = latitude.min(89.999999) + 90.0;
    let field_lon = (lon / 20.0).floor() as u8;
    let field_lat = (lat / 10.0).floor() as u8;
    let square_lon = ((lon % 20.0) / 2.0).floor() as u8;
    let square_lat = (lat % 10.0).floor() as u8;
    let sub_lon = (((lon % 2.0) / 2.0) * 24.0).floor() as u8;
    let sub_lat = ((lat % 1.0) * 24.0).floor() as u8;
    let mut grid = String::with_capacity(6);
    grid.push((b'A' + field_lon) as char);
    grid.push((b'A' + field_lat) as char);
    grid.push((b'0' + square_lon) as char);
    grid.push((b'0' + square_lat) as char);
    grid.push((b'A' + sub_lon) as char);
    grid.push((b'A' + sub_lat) as char);
    grid
}

fn station_json(state: &AppState) -> Value {
    let (callsign, location, description, lat, lon, weather_api_key) = {
        let cfg = state.cfg.read();
        let server = &cfg.server;
        (
            server.callsign.clone(),
            server.location.clone(),
            server.description.clone(),
            server.receiver_latitude,
            server.receiver_longitude,
            server.open_weather_map_api_key.trim().to_string(),
        )
    };
    let grid = grid_from_lat_lon(lat, lon);
    #[cfg(feature = "decoders")]
    let decoder_modes = crate::decoders::background_modes();
    #[cfg(not(feature = "decoders"))]
    let decoder_modes: Vec<Value> = Vec::new();
    json!({
        "callsign": callsign,
        "location": location,
        "description": description,
        "lat": lat,
        "lon": lon,
        "grid": grid,
        "version": env!("CARGO_PKG_VERSION"),
        "clients": state.ws.client_count(),
        "decoders": decoder_modes,
        "weather": {
            "enabled": !weather_api_key.is_empty(),
            "provider": "openweathermap",
            "layer": "clouds_new",
            // Sent to browsers so they can fetch tiles directly. Do not add a
            // proxy: the point is to keep cloud image traffic off this server.
            "apiKey": weather_api_key,
        },
    })
}

fn checkpoint_json(state: &AppState) -> Value {
    let now = now_ms();
    let aircraft = fresh_entities(aircraft_entities(state), now);
    let vessels = fresh_entities(vessel_entities(state), now);
    let decodes = grid_messages(state, now - SPOTTING_LOOKBACK_MS, CHECKPOINT_GRID_LIMIT);
    let positions = position_messages(state, now - SPOTTING_LOOKBACK_MS, CHECKPOINT_GRID_LIMIT);
    json!({
        "type": "checkpoint",
        "at": now,
        "station": station_json(state),
        "aircraft": aircraft,
        "vessels": vessels,
        "decodes": decodes,
        "positions": positions,
    })
}

fn update_json(state: &AppState, since: i64, max_rows: usize) -> Value {
    let now = now_ms();
    // Aircraft and vessels are sent as deltas: only rows whose lastSeen moved
    // past the cursor. The client merges by key and hides rows older than
    // ENTITY_ACTIVE_MS itself, so resending both full tables every tick only
    // burned bandwidth.
    let aircraft = fresh_entities(aircraft_entities_since(state, since), now);
    let vessels = fresh_entities(vessel_entities_since(state, since), now);
    let decodes = grid_messages(state, since, max_rows);
    let positions = position_messages(state, since, max_rows);
    json!({
        "type": "update",
        "at": now,
        "station": station_json(state),
        "aircraft": aircraft,
        "vessels": vessels,
        "decodes": decodes,
        "positions": positions,
    })
}

/// A reconnect may name the last `at` it applied, in which case the full
/// checkpoint is skipped and one delta is sent instead. Reject cursors that
/// are in the future (clock skew) or older than the history the checkpoint
/// itself would cover.
fn resume_cursor(since: Option<i64>, now: i64) -> Option<i64> {
    since.filter(|s| *s > 0 && *s <= now && *s >= now - SPOTTING_LOOKBACK_MS)
}

#[cfg(feature = "decoders")]
fn aircraft_entities(state: &AppState) -> Vec<Value> {
    let mut rows = state.decoder_store.entities("aircraft", 2_000);
    enrich_aircraft(state, &mut rows);
    rows
}
#[cfg(not(feature = "decoders"))]
fn aircraft_entities(_state: &AppState) -> Vec<Value> {
    Vec::new()
}
#[cfg(feature = "decoders")]
fn aircraft_entities_since(state: &AppState, since: i64) -> Vec<Value> {
    let mut rows = state
        .decoder_store
        .entities_since("aircraft", since, UPDATE_ENTITY_LIMIT);
    enrich_aircraft(state, &mut rows);
    rows
}
#[cfg(not(feature = "decoders"))]
fn aircraft_entities_since(_state: &AppState, _since: i64) -> Vec<Value> {
    Vec::new()
}
/// Aircraft metadata from the local index: registration and type by ICAO
/// address, operator by callsign prefix, and the latest ACARS block for the
/// same registration. Everything is merged into the entity payload the map
/// already receives, so the client needs no separate lookups.
fn enrich_aircraft(state: &AppState, rows: &mut [Value]) {
    if rows.is_empty() {
        return;
    }
    let db = state.aircraft_db.index();
    let acars = acars_entities(state);
    for row in rows.iter_mut() {
        let Some(payload) = row.get_mut("payload").and_then(Value::as_object_mut) else {
            continue;
        };
        let icao = payload.get("icao").and_then(Value::as_u64).map(|v| v as u32);
        let callsign = payload
            .get("callsign")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let mut registration = String::new();
        if let Some(icao) = icao {
            if let Some(meta) = db.aircraft(icao) {
                if !meta.registration.is_empty() {
                    registration = meta.registration.to_ascii_uppercase();
                    payload.insert("registration".to_string(), json!(meta.registration.as_ref()));
                }
                if !meta.type_code.is_empty() {
                    payload.insert("typeCode".to_string(), json!(meta.type_code.as_ref()));
                    if let Some(name) = db.type_name(&meta.type_code) {
                        payload.insert("typeName".to_string(), json!(name));
                    }
                }
            }
        }
        // Many GA aircraft transmit their registration as the callsign. Only
        // adopt it when ACARS has heard that address, so an airline callsign
        // is never mistaken for a tail number.
        if registration.is_empty()
            && !callsign.is_empty()
            && acars.contains_key(&callsign.to_ascii_uppercase())
        {
            registration = callsign.to_ascii_uppercase();
            payload.insert("registration".to_string(), json!(registration));
        }
        if let Some(operator) = db.operator_for_callsign(&callsign) {
            if !operator.name.is_empty() {
                payload.insert("operator".to_string(), json!(operator.name));
            }
            if !operator.country.is_empty() {
                payload.insert("operatorCountry".to_string(), json!(operator.country));
            }
        }
        let matched = if registration.is_empty() {
            None
        } else {
            acars.get(&registration).cloned()
        }
        .or_else(|| acars.get(&callsign.to_ascii_uppercase()).cloned())
        .or_else(|| {
            acars.values().find(|entry| {
                entry
                    .get("flight")
                    .and_then(Value::as_str)
                    .is_some_and(|flight| flight.eq_ignore_ascii_case(&callsign))
            }).cloned()
        });
        if let Some(entry) = matched {
            if let Some(flight) = entry.get("flight").and_then(Value::as_str) {
                payload
                    .entry("flight".to_string())
                    .or_insert_with(|| json!(flight));
            }
            payload.insert("acars".to_string(), entry);
        }
    }
}

/// Latest ACARS entity per registration, keyed upper-case, ignoring rows that
/// have not been heard for 30 minutes.
#[cfg(feature = "decoders")]
fn acars_entities(state: &AppState) -> HashMap<String, Value> {
    let mut map = HashMap::new();
    let cutoff = now_ms() - 30 * 60 * 1000;
    for row in state.decoder_store.entities("acars", 2_000) {
        if row.get("lastSeenMs").and_then(Value::as_i64).unwrap_or(0) < cutoff {
            continue;
        }
        let Some(payload) = row.get("payload") else {
            continue;
        };
        let Some(address) = payload.get("address").and_then(Value::as_str) else {
            continue;
        };
        let key = address.trim().trim_matches('.').trim().to_ascii_uppercase();
        if !key.is_empty() {
            map.insert(key, payload.clone());
        }
    }
    map
}
#[cfg(not(feature = "decoders"))]
fn acars_entities(_state: &AppState) -> HashMap<String, Value> {
    HashMap::new()
}

fn fresh_entities(mut rows: Vec<Value>, now: i64) -> Vec<Value> {
    let cutoff = now - ENTITY_ACTIVE_MS;
    rows.retain(|row| row["lastSeenMs"].as_i64().unwrap_or(0) >= cutoff);
    rows
}
#[cfg(feature = "decoders")]
fn vessel_entities(state: &AppState) -> Vec<Value> {
    state.decoder_store.entities("vessel", 2_000)
}
#[cfg(not(feature = "decoders"))]
fn vessel_entities(_state: &AppState) -> Vec<Value> {
    Vec::new()
}
#[cfg(feature = "decoders")]
fn vessel_entities_since(state: &AppState, since: i64) -> Vec<Value> {
    state
        .decoder_store
        .entities_since("vessel", since, UPDATE_ENTITY_LIMIT)
}
#[cfg(not(feature = "decoders"))]
fn vessel_entities_since(_state: &AppState, _since: i64) -> Vec<Value> {
    Vec::new()
}
#[cfg(feature = "decoders")]
fn grid_messages(state: &AppState, since: i64, limit: usize) -> Vec<Value> {
    state.decoder_store.grid_messages(since, limit)
}
#[cfg(not(feature = "decoders"))]
fn grid_messages(_state: &AppState, _since: i64, _limit: usize) -> Vec<Value> {
    Vec::new()
}
#[cfg(feature = "decoders")]
fn position_messages(state: &AppState, since: i64, limit: usize) -> Vec<Value> {
    state.decoder_store.position_messages(since, limit)
}
#[cfg(not(feature = "decoders"))]
fn position_messages(_state: &AppState, _since: i64, _limit: usize) -> Vec<Value> {
    Vec::new()
}

pub async fn checkpoint(State(state): State<AppState>) -> Json<Value> {
    Json(checkpoint_json(&state))
}

pub async fn ws_map(
    State(state): State<AppState>,
    Query(query): Query<MapQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| map_socket(socket, state, query.since))
}

/// Query string on `/ws/map`.
#[derive(Debug, Default, serde::Deserialize)]
pub struct MapQuery {
    /// Last `at` the client applied; when present a delta is sent instead of
    /// the full checkpoint.
    #[serde(default)]
    pub since: Option<i64>,
}

async fn map_socket(socket: WebSocket, state: AppState, resume_since: Option<i64>) {
    let (mut sender, mut receiver) = socket.split();
    let now = now_ms();

    let (mut cursor, mut last_station) = if let Some(since) = resume_cursor(resume_since, now) {
        // Reconnect: one delta frame, no multi-megabyte checkpoint.
        let update = update_json(&state, since, CHECKPOINT_GRID_LIMIT);
        let cursor = update["at"].as_i64().unwrap_or_else(now_ms);
        let station = update["station"].clone();
        if sender.send(map_frame(&update)).await.is_err() {
            return;
        }
        (cursor, station)
    } else {
        let checkpoint_value = checkpoint_json(&state);
        let cursor = checkpoint_value["at"].as_i64().unwrap_or_else(now_ms);
        let station = checkpoint_value["station"].clone();
        // Serialising and compressing a multi-megabyte checkpoint is CPU work;
        // keep it off the async worker so audio/FFT tasks are not stalled.
        let checkpoint =
            match tokio::task::spawn_blocking(move || map_frame(&checkpoint_value)).await {
                Ok(frame) => frame,
                Err(_) => return,
            };
        if sender.send(checkpoint).await.is_err() {
            return;
        }
        (cursor, station)
    };

    let mut ticker = tokio::time::interval(Duration::from_millis(UPDATE_INTERVAL_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let tick_cursor = now_ms();
                let update = update_json(&state, cursor, UPDATE_LIMIT);
                let station_changed = update["station"] != last_station;
                let has_data = update["aircraft"].as_array().is_some_and(|v| !v.is_empty())
                    || update["vessels"].as_array().is_some_and(|v| !v.is_empty())
                    || update["decodes"].as_array().is_some_and(|v| !v.is_empty())
                    || update["positions"].as_array().is_some_and(|v| !v.is_empty());
                cursor = tick_cursor;
                last_station = update["station"].clone();
                if (has_data || station_changed)
                    && sender.send(map_frame(&update)).await.is_err()
                {
                    break;
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    None => break,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn maidenhead_matches_known_squares() {
        assert_eq!(grid_from_lat_lon(37.9838, 23.7275), "KM17UX");
        assert_eq!(grid_from_lat_lon(51.5074, -0.1278), "IO91WM");
        assert_eq!(grid_from_lat_lon(0.0, 0.0), "");
    }

    #[test]
    fn resume_cursor_accepts_recent_past_only() {
        let now = 1_795_500_000_000;
        assert_eq!(resume_cursor(None, now), None);
        assert_eq!(resume_cursor(Some(0), now), None);
        assert_eq!(resume_cursor(Some(now + 1), now), None, "future cursor");
        assert_eq!(
            resume_cursor(Some(now - SPOTTING_LOOKBACK_MS - 1), now),
            None,
            "older than the checkpoint lookback"
        );
        assert_eq!(resume_cursor(Some(now), now), Some(now));
        assert_eq!(
            resume_cursor(Some(now - 1_000), now),
            Some(now - 1_000)
        );
    }

    #[test]
    fn small_map_frames_stay_text() {
        let value = json!({"type": "update", "at": 1, "decodes": []});
        match map_frame(&value) {
            Message::Text(text) => {
                assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), value);
            }
            _ => panic!("a small document must stay a text frame"),
        }
    }

    #[test]
    fn large_map_frames_are_deflated_and_round_trip() {
        let rows: Vec<Value> = (0..200)
            .map(|id| json!({"id": id, "text": "CQ DE N0CALL FN42 ".repeat(4)}))
            .collect();
        let value = json!({"type": "checkpoint", "at": 1, "decodes": rows});
        let raw_len = value.to_string().len();
        assert!(raw_len >= COMPRESS_MIN_BYTES);

        match map_frame(&value) {
            Message::Binary(frame) => {
                assert_eq!(frame[0], FRAME_DEFLATE);
                let mut plain = Vec::new();
                flate2::read::DeflateDecoder::new(&frame[1..])
                    .read_to_end(&mut plain)
                    .expect("deflate stream");
                let back: Value = serde_json::from_slice(&plain).expect("json");
                assert_eq!(back, value);
                assert!(
                    frame.len() < raw_len / 2,
                    "compressed {} vs raw {}",
                    frame.len(),
                    raw_len
                );
            }
            _ => panic!("a large document must be a deflated binary frame"),
        }
    }
}
