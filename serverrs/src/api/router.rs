//! HTTP router: public API, admin API, WebSocket and SPA static files.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderName, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};


use crate::ws::UpgradeQuery;

use super::admin;
use super::bandplan::BandPlanQuery;
use super::bookmarks::{self as bookmark_loader, PublicBookmark};
use super::identify::IdentifyService;
use super::recognizer::{self, RecognizerConfig};
use super::AppState;

pub fn build_router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/system-info", get(admin::system_info))
        .route("/clients", get(admin::clients))
        .route("/devices", get(admin::local_devices))
        .route("/dongles", get(admin::admin_dongles).post(admin::create_dongle))
        .route(
            "/dongles/{id}",
            put(admin::update_dongle).delete(admin::delete_dongle),
        )
        .route("/dongles/{id}/profile", post(admin::switch_profile))
        .route("/dongles/{id}/start", post(admin::dongle_start))
        .route("/dongles/{id}/stop", post(admin::dongle_stop))
        .route("/dongles/{id}/profiles", post(admin::create_profile))
        .route(
            "/dongles/{id}/profiles/{profileId}",
            put(admin::update_profile).delete(admin::delete_profile),
        )
        .route("/dongles/{id}/profiles-order", put(admin::reorder_profiles))
        .route("/bookmarks", get(admin::admin_bookmarks).post(admin::create_bookmark))
        .route(
            "/bookmarks/{id}",
            put(admin::update_bookmark).delete(admin::delete_bookmark),
        )
        .route("/save-config", post(admin::save_config))
        .route(
            "/server/config",
            get(admin::get_server_config).put(admin::update_server_config),
        )
        .route("/recordings", get(admin::recordings))
        .route(
            "/dongles/{id}/record",
            post(admin::record_start).delete(admin::record_stop),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            admin::require_auth,
        ));

    let admin_router = Router::new()
        .route("/login", post(admin::login))
        .route("/logout", post(admin::logout))
        .route("/check", get(admin::check_auth))
        .route("/session", get(admin::check_auth))
        .merge(protected);

    let api_router = Router::new()
        .route("/status", get(status))
        .route("/dongles", get(public_dongles))
        .route("/dongles/{id}/profiles", get(public_profiles))
        .route("/capabilities", get(capabilities))
        .route("/bookmarks", get(public_bookmarks))
        .route("/bandplan", get(bandplan))
        .route("/identify", get(identify).post(identify))
        .route("/identify/status", get(identify_status))
        .nest("/admin", admin_router);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([header::ETAG, HeaderName::from_static("x-config-version")]);

    Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(health))
        .nest("/api", api_router)
        .fallback(spa_handler)
        .layer(cors)
        .with_state(state)
}

async fn ws_handler(
    State(state): State<AppState>,
    ws: axum::extract::WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<UpgradeQuery>,
) -> Response {
    crate::ws::WsManager::handle_upgrade(
        State(state.ws.clone()),
        ws,
        ConnectInfo(addr),
        headers,
        Query(q),
    )
    .await
}

async fn health() -> Response {
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        r#"{"status":"ok"}"#,
    )
        .into_response()
}

async fn status(State(state): State<AppState>) -> Response {
    admin::json_response(
        StatusCode::OK,
        json!({
            "status": "ok",
            "clients": state.ws.client_count(),
            "uptime": state.start_time.elapsed().as_secs(),
        }),
        None,
    )
}

async fn public_dongles(State(state): State<AppState>) -> Response {
    let dongles = state.cfg.read().dongles.clone();
    let out: Vec<_> = dongles
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "deviceIndex": d.device_index,
                "name": d.name,
                "serial": "",
                "source": d.source.kind,
                "activeProfileId": state.mgr.active_profile_id(&d.id).unwrap_or_default(),
                "ppmCorrection": d.ppm,
                "running": state.mgr.is_dongle_running(&d.id),
                "clientCount": state.ws.subscribed_clients(&d.id).len(),
            })
        })
        .collect();
    admin::json_response(StatusCode::OK, json!(out), None)
}

async fn public_profiles(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let cfg = state.cfg.read();
    let Some(d) = cfg.dongles.iter().find(|d| d.id == id) else {
        return admin::json_response(
            StatusCode::NOT_FOUND,
            json!({"error": "dongle not found"}),
            None,
        );
    };
    let profiles: Vec<_> = d
        .profiles
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "centerFrequency": p.center_frequency,
                "sampleRate": p.sample_rate,
                "fftSize": p.fft_size,
                "fftFps": p.fft_fps,
                "defaultMode": p.mode,
                "defaultTuneOffset": p.tune_offset,
                "defaultBandwidth": p.bandwidth,
                "tuningStep": p.tuning_step,
                "gain": p.gain,
                "description": p.description,
                "directSampling": p.direct_sampling,
                "preFilterNb": p.pre_filter_nb,
                "preFilterNbThreshold": p.pre_filter_nb_threshold,
                "decoders": [],
                "dongleId": id,
            })
        })
        .collect();
    admin::json_response(StatusCode::OK, json!(profiles), None)
}

async fn capabilities(State(state): State<AppState>) -> Response {
    let cfg = state.cfg.read();
    admin::json_response(
        StatusCode::OK,
        json!({
            "allowedFftCodecs": cfg.server.allowed_fft_codecs,
            "allowedIqCodecs": cfg.server.allowed_iq_codecs,
        }),
        None,
    )
}

async fn public_bookmarks(State(state): State<AppState>) -> Response {
    let mut result: Vec<PublicBookmark> = {
        let cfg = state.cfg.read();
        bookmark_loader::from_config(&cfg.bookmarks)
    };
    if !state.bookmarks_dir.is_empty() {
        result.extend(bookmark_loader::load_file_bookmarks(&state.bookmarks_dir));
    }
    admin::json_response(
        StatusCode::OK,
        serde_json::to_value(result).unwrap_or_else(|_| json!([])),
        None,
    )
}

async fn bandplan(
    State(state): State<AppState>,
    Query(q): Query<BandPlanQuery>,
) -> Json<serde_json::Value> {
    state.bandplan.clone().handler(Query(q))
}

async fn identify_status(State(state): State<AppState>) -> Response {
    let cfg = state.cfg.read();
    let available = !cfg.server.audd_api_key.is_empty()
        || !cfg.server.acrcloud_access_key.is_empty();
    admin::json_response(StatusCode::OK, json!({"available": available}), None)
}

async fn identify(State(state): State<AppState>, mut multipart: Multipart) -> Response {
    let mut token = String::new();
    let mut uploaded: Option<Vec<u8>> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "token" => {
                token = field.text().await.unwrap_or_default();
            }
            "file" => {
                if let Ok(bytes) = field.bytes().await {
                    uploaded = Some(bytes.to_vec());
                }
            }
            _ => {}
        }
    }

    if token.is_empty() {
        return admin::json_response(
            StatusCode::UNAUTHORIZED,
            json!({"error": "token required"}),
            None,
        );
    }

    let (_conn_id, pcm_snapshot) = match state.identify.consume(&token) {
        Ok(v) => v,
        Err(e) => {
            return admin::json_response(
                StatusCode::UNAUTHORIZED,
                json!({"error": e}),
                None,
            )
        }
    };

    let wav = match uploaded {
        Some(wav) => {
            const MIN_WAV_BYTES: usize = 3 * 22050 * 2;
            if wav.len() < 44 {
                return admin::json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "invalid WAV audio"}),
                    None,
                );
            }
            if wav.len() < MIN_WAV_BYTES {
                return admin::json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error": format!(
                        "audio too short ({}s) — need at least 3s for recognition",
                        wav.len() / 44100
                    )}),
                    None,
                );
            }
            wav
        }
        None => {
            if pcm_snapshot.is_empty() {
                return admin::json_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    json!({"error": "no audio buffered — ensure Opus codec is active and audio has been playing"}),
                    None,
                );
            }
            recognizer::encode_wav(&pcm_snapshot, 1, 48000)
        }
    };

    let rcfg = {
        let cfg = state.cfg.read();
        RecognizerConfig {
            audd_api_key: cfg.server.audd_api_key.clone(),
            acrcloud_host: cfg.server.acrcloud_host.clone(),
            acrcloud_access_key: cfg.server.acrcloud_access_key.clone(),
            acrcloud_access_secret: cfg.server.acrcloud_access_secret.clone(),
        }
    };

    match recognizer::recognize_wav(&rcfg, &wav).await {
        Ok(Some(result)) => admin::json_response(
            StatusCode::OK,
            json!({"match": true, "result": result}),
            None,
        ),
        Ok(None) => admin::json_response(StatusCode::OK, json!({"match": false}), None),
        Err(e) => admin::json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": e.to_string()}),
            None,
        ),
    }
}

/// Creates the identification service used by `AppState`.
pub fn new_identify_service() -> Arc<IdentifyService> {
    Arc::new(IdentifyService::new())
}


async fn spa_handler(State(state): State<AppState>, uri: Uri) -> Response {
    let rel = uri.path().trim_start_matches('/');
    let safe = std::path::Path::new(rel)
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir));
    let candidate = state.static_dir.join(rel);
    let path = if safe && candidate.is_file() {
        candidate
    } else {
        state.static_dir.join("index.html")
    };
    serve_file(&path).await
}

async fn serve_file(path: &std::path::Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mime = mime_for(path);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime)],
                bytes,
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain")],
            "not found",
        )
            .into_response(),
    }
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
