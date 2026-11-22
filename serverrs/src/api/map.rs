//! `/map` data feed: initial checkpoint plus a dedicated WebSocket stream.
//!
//! The map has its own socket so aircraft/vessel/grid updates never share the
//! audio/FFT WebSocket. The feed is built from the persisted decoder store, so
//! it works without touching the main client pipelines.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::AppState;

const SPOTTING_LOOKBACK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const ENTITY_ACTIVE_MS: i64 = 5 * 60 * 1000;
const CHECKPOINT_GRID_LIMIT: usize = 3_000;
const UPDATE_LIMIT: usize = 1_000;
const UPDATE_INTERVAL_MS: u64 = 750;
const WEATHER_CACHE_TTL: Duration = Duration::from_secs(600);
const WEATHER_CACHE_MAX: usize = 512;

struct CachedTile {
    at: Instant,
    bytes: Vec<u8>,
    webp: bool,
}

static WEATHER_CACHE: OnceLock<Mutex<HashMap<(u32, u32, u32), CachedTile>>> = OnceLock::new();

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
    let (callsign, location, description, lat, lon, weather_enabled) = {
        let cfg = state.cfg.read();
        let server = &cfg.server;
        (
            server.callsign.clone(),
            server.location.clone(),
            server.description.clone(),
            server.receiver_latitude,
            server.receiver_longitude,
            !server.open_weather_map_api_key.trim().is_empty(),
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
            "enabled": weather_enabled,
            "provider": "openweathermap",
            "layer": "clouds_new",
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

fn weather_cache() -> &'static Mutex<HashMap<(u32, u32, u32), CachedTile>> {
    WEATHER_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_weather(z: u32, x: u32, y: u32) -> Option<(Vec<u8>, bool)> {
    let mut cache = weather_cache().lock();
    let now = Instant::now();
    if cache
        .get(&(z, x, y))
        .is_some_and(|entry| now.duration_since(entry.at) >= WEATHER_CACHE_TTL)
    {
        cache.remove(&(z, x, y));
        return None;
    }
    cache
        .get(&(z, x, y))
        .map(|entry| (entry.bytes.clone(), entry.webp))
}

fn store_weather(z: u32, x: u32, y: u32, bytes: Vec<u8>, webp: bool) {
    let mut cache = weather_cache().lock();
    let now = Instant::now();
    cache.retain(|_, entry| now.duration_since(entry.at) < WEATHER_CACHE_TTL);
    if cache.len() >= WEATHER_CACHE_MAX {
        cache.clear();
    }
    cache.insert(
        (z, x, y),
        CachedTile {
            at: now,
            bytes,
            webp,
        },
    );
}

/// Lossless WebP is about one third the size of the OWM PNG tiles while
/// preserving the alpha mask, so map clients fetch far fewer bytes.
fn encode_cloud_webp(png: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(png).ok()?.to_rgba8();
    let encoder = webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height());
    let mut config = webp::WebPConfig::new().ok()?;
    config.lossless = 1;
    config.alpha_compression = 0;
    config.quality = 100.0;
    config.method = 6;
    encoder
        .encode_advanced(&config)
        .ok()
        .map(|encoded| encoded.to_vec())
}

/// Proxy OpenWeatherMap cloud tiles so the API key stays server-side.
pub async fn weather_tile(
    State(state): State<AppState>,
    Path((z, x, y)): Path<(u32, u32, u32)>,
) -> Response {
    if z > 19 {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some((bytes, webp)) = cached_weather(z, x, y) {
        return weather_response(bytes, webp);
    }
    let key = state
        .cfg
        .read()
        .server
        .open_weather_map_api_key
        .trim()
        .to_string();
    if key.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let url = format!("https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid={key}");
    let response = match state
        .weather_client
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let (payload, webp) = match encode_cloud_webp(&bytes) {
        Some(webp_bytes) => (webp_bytes, true),
        None => (bytes.to_vec(), false),
    };
    store_weather(z, x, y, payload.clone(), webp);
    weather_response(payload, webp)
}

fn weather_response(bytes: Vec<u8>, webp: bool) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            if webp { "image/webp" } else { "image/png" },
        )
        .header(header::CACHE_CONTROL, "public, max-age=600")
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
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

    #[test]
    fn cloud_tiles_encode_to_webp() {
        let image = image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 255, 255, 128]));
        let mut png = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let encoded = encode_cloud_webp(&png).expect("webp encoding");
        assert_eq!(&encoded[..4], b"RIFF");
        assert_eq!(&encoded[8..12], b"WEBP");
    }
}
