//! `/map` data feed: initial checkpoint plus a dedicated WebSocket stream.
//!
//! The map has its own socket so aircraft/vessel/grid updates never share the
//! audio/FFT WebSocket. The feed is built from the persisted decoder store, so
//! it works without touching the main client pipelines.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

use super::AppState;

const SPOTTING_LOOKBACK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const ENTITY_ACTIVE_MS: i64 = 5 * 60 * 1000;
const CHECKPOINT_GRID_LIMIT: usize = 3_000;
const UPDATE_LIMIT: usize = 1_000;
const UPDATE_INTERVAL_MS: u64 = 750;

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
    let (callsign, location, description, lat, lon) = {
        let cfg = state.cfg.read();
        let server = &cfg.server;
        (
            server.callsign.clone(),
            server.location.clone(),
            server.description.clone(),
            server.receiver_latitude,
            server.receiver_longitude,
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
            "enabled": true,
            "provider": "open-meteo",
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

fn update_json(state: &AppState, since: i64) -> Value {
    let now = now_ms();
    // Aircraft/vessel tables are small and change continuously. Sending the
    // current tables avoids any missed-delta edge cases while still keeping
    // map traffic off the main audio/FFT socket.
    let aircraft = fresh_entities(aircraft_entities(state), now);
    let vessels = fresh_entities(vessel_entities(state), now);
    let decodes = grid_messages(state, since, UPDATE_LIMIT);
    let positions = position_messages(state, since, UPDATE_LIMIT);
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

#[cfg(feature = "decoders")]
fn aircraft_entities(state: &AppState) -> Vec<Value> {
    state.decoder_store.entities("aircraft", 2_000)
}
#[cfg(not(feature = "decoders"))]
fn aircraft_entities(_state: &AppState) -> Vec<Value> {
    Vec::new()
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

pub async fn ws_map(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| map_socket(socket, state))
}

async fn map_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let checkpoint_value = checkpoint_json(&state);
    let mut cursor = checkpoint_value["at"].as_i64().unwrap_or_else(now_ms);
    let mut last_station = checkpoint_value["station"].clone();
    let checkpoint = checkpoint_value.to_string();
    if sender.send(Message::Text(checkpoint.into())).await.is_err() {
        return;
    }

    let mut ticker = tokio::time::interval(Duration::from_millis(UPDATE_INTERVAL_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let tick_cursor = now_ms();
                let update = update_json(&state, cursor);
                let station_changed = update["station"] != last_station;
                let has_data = update["aircraft"].as_array().is_some_and(|v| !v.is_empty())
                    || update["vessels"].as_array().is_some_and(|v| !v.is_empty())
                    || update["decodes"].as_array().is_some_and(|v| !v.is_empty())
                    || update["positions"].as_array().is_some_and(|v| !v.is_empty());
                cursor = tick_cursor;
                last_station = update["station"].clone();
                if (has_data || station_changed)
                    && sender.send(Message::Text(update.to_string().into())).await.is_err()
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

    #[test]
    fn maidenhead_matches_known_squares() {
        assert_eq!(grid_from_lat_lon(37.9838, 23.7275), "KM17UX");
        assert_eq!(grid_from_lat_lon(51.5074, -0.1278), "IO91WM");
        assert_eq!(grid_from_lat_lon(0.0, 0.0), "");
    }
}
