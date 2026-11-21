//! Admin authentication and configuration REST handlers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use crate::config::{self, Bookmark, DongleConfig, DongleProfile, SourceConfig};

use super::system;
use super::AppState;

const COOKIE_NAME: &str = "sdr_session";
const MAX_AGE: u64 = 7 * 24 * 3600;

/// Cookie-based admin sessions plus Bearer-password fallback.
pub struct AdminAuth {
    password: Mutex<String>,
    sessions: Mutex<HashMap<String, Instant>>,
}

impl AdminAuth {
    pub fn new(password: impl Into<String>) -> Arc<Self> {
        Arc::new(Self {
            password: Mutex::new(password.into()),
            sessions: Mutex::new(HashMap::new()),
        })
    }

    /// Updates the password used by both session login and the Bearer fallback.
    pub fn set_password(&self, password: &str) {
        *self.password.lock() = password.to_string();
    }

    fn validate(&self, token: &str) -> bool {
        let password = self.password.lock();
        let a = token.as_bytes();
        let b = password.as_bytes();
        if b.is_empty() || a.len() != b.len() {
            return false;
        }
        a.ct_eq(b).into()
    }

    fn session_valid(&self, token: &str) -> bool {
        let mut sessions = self.sessions.lock();
        match sessions.get(token).copied() {
            Some(expiry) if Instant::now() < expiry => true,
            Some(_) => {
                sessions.remove(token);
                false
            }
            None => false,
        }
    }
}

pub async fn require_auth(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    // Cookie first.
    if let Some(token) = cookie_value(req.headers(), COOKIE_NAME) {
        if state.auth.session_valid(&token) {
            return next.run(req).await;
        }
    }

    // Authorization: Bearer <password>
    if let Some(auth) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            if state.auth.validate(token) {
                return next.run(req).await;
            }
        }
    }

    json_response(StatusCode::UNAUTHORIZED, json!({"error": "not authenticated"}), None)
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix(&format!("{name}=")) {
            return Some(value.to_string());
        }
    }
    None
}

pub async fn login(State(state): State<AppState>, body: Bytes) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    let password = parsed.get("password").and_then(|v| v.as_str()).unwrap_or("");
    if !state.auth.validate(password) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({"error": "invalid password"}),
            None,
        );
    }

    let token = uuid::Uuid::new_v4().simple().to_string();
    state
        .auth
        .sessions
        .lock()
        .insert(token.clone(), Instant::now() + Duration::from_secs(MAX_AGE));

    let mut resp = json_response(StatusCode::OK, json!({"status": "ok"}), None);
    let cookie = format!(
        "{COOKIE_NAME}={token}; Path=/; Max-Age={MAX_AGE}; HttpOnly; SameSite=Lax"
    );
    resp.headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    resp
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_value(&headers, COOKIE_NAME) {
        state.auth.sessions.lock().remove(&token);
    }
    let mut resp = json_response(StatusCode::OK, json!({"status": "ok"}), None);
    let cookie = format!(
        "{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
    );
    resp.headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    resp
}

pub async fn check_auth(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let authenticated = cookie_value(&headers, COOKIE_NAME)
        .map(|t| state.auth.session_valid(&t))
        .unwrap_or(false);
    if authenticated {
        json_response(
            StatusCode::OK,
            json!({"ok": true, "authenticated": true}),
            None,
        )
    } else {
        json_response(
            StatusCode::UNAUTHORIZED,
            json!({"ok": false, "authenticated": false}),
            None,
        )
    }
}

pub async fn system_info(State(state): State<AppState>) -> Response {
    json_response(StatusCode::OK, system::system_info(&state), None)
}

pub async fn clients(State(state): State<AppState>) -> Response {
    json_response(
        StatusCode::OK,
        Value::Array(system::clients(&state)),
        None,
    )
}

pub async fn local_devices(Query(q): Query<HashMap<String, String>>) -> Response {
    // Enumeration (and the vendor-library/service lookups) is blocking; keep
    // it off the async workers.
    let kind = q.get("type").cloned();
    let devices = tokio::task::spawn_blocking(move || {
        crate::dongle::scan_devices(kind.as_deref())
    })
    .await
    .unwrap_or_default();
    json_response(
        StatusCode::OK,
        serde_json::to_value(devices).unwrap_or_else(|_| json!([])),
        None,
    )
}

pub async fn admin_dongles(State(state): State<AppState>) -> Response {
    let dongles = state.cfg.read().dongles.clone();
    let mut out = Vec::with_capacity(dongles.len());
    for d in &dongles {
        let active_profile = state.mgr.active_profile_id(&d.id).unwrap_or_default();
        let clients = state.ws.subscribed_clients(&d.id).len();
        let profiles: Vec<Value> = d
            .profiles
            .iter()
            .map(|p| {
                json!({
                    "id": p.id,
                    "name": p.name,
                    "centerFrequency": p.center_frequency,
                    "sampleRate": p.sample_rate,
                    "bandwidth": p.bandwidth,
                    "mode": p.mode,
                    "gain": p.gain,
                    "fftSize": p.fft_size,
                    "fftFps": p.fft_fps,
                    "tuneOffset": p.tune_offset,
                    "tuningStep": p.tuning_step,
                    "swapIQ": p.swap_iq,
                    "oscillatorOffset": p.oscillator_offset,
                    "directSampling": p.direct_sampling,
                    "description": p.description,
                    "preFilterNb": p.pre_filter_nb,
                    "preFilterNbThreshold": p.pre_filter_nb_threshold,
                    "dcOffsetRemoval": p.dc_offset_removal,
                })
            })
            .collect();
        out.push(json!({
            "id": d.id,
            "name": d.name,
            "running": state.mgr.is_dongle_running(&d.id),
            "enabled": d.enabled,
            "autoStart": d.auto_start,
            "activeProfileId": active_profile,
            "clientCount": clients,
            "source": d.source,
            "sampleRate": d.sample_rate,
            "gain": d.gain,
            "ppmCorrection": d.ppm,
            "deviceIndex": d.device_index,
            "directSampling": d.direct_sampling,
            "biasT": d.bias_t,
            "digitalAgc": d.digital_agc,
            "offsetTuning": d.offset_tuning,
            "iqCorrection": d.iq_correction,
            "profiles": profiles,
            "state": state.mgr.get_dongle_state(&d.id),
        }));
    }
    json_response(StatusCode::OK, Value::Array(out), None)
}

pub async fn create_dongle(State(state): State<AppState>, body: Bytes) -> Response {
    let d: DongleConfig = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    if d.id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "dongle id is required"}),
            None,
        );
    }
    {
        let cfg = state.cfg.read();
        if cfg.dongles.iter().any(|e| e.id == d.id) {
            return json_response(
                StatusCode::CONFLICT,
                json!({"error": "dongle with this id already exists"}),
                None,
            );
        }
    }
    state.cfg.write().dongles.push(d.clone());
    let version = bump_version(&state);
    state.mgr.notify_dongle_added(&d);
    json_response(StatusCode::CREATED, serde_json::to_value(&d).unwrap(), Some(version))
}

pub async fn update_dongle(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let patch: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    if !patch.is_object() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "invalid request body"}),
            None,
        );
    }

    let (old, new_cfg, version) = {
        let mut cfg = state.cfg.write();
        let Some(idx) = cfg.dongles.iter().position(|d| d.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "dongle not found"}),
                None,
            );
        };
        let old = cfg.dongles[idx].clone();
        let mut merged = serde_json::to_value(&old).unwrap_or_else(|_| json!({}));
        merge_json(&mut merged, &patch);
        let Some(obj) = merged.as_object_mut() else {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            );
        };
        obj.insert("id".to_string(), Value::String(id.clone()));
        // The admin edit form intentionally omits profiles (they are managed
        // separately); preserve the existing list in that case.
        let patch_has_profiles = patch
            .get("profiles")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if !patch_has_profiles {
            obj.insert(
                "profiles".to_string(),
                serde_json::to_value(&old.profiles).unwrap_or_else(|_| json!([])),
            );
        }
        let updated: DongleConfig = match serde_json::from_value(merged) {
            Ok(v) => v,
            Err(_) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "invalid request body"}),
                    None,
                )
            }
        };
        cfg.dongles[idx] = updated.clone();
        let version = bump_version_locked(&state);
        (old, updated, version)
    };

    let reinit = needs_reinit(&old, &new_cfg);
    let runtime_apply = needs_runtime_apply(&old, &new_cfg);
    tracing::info!(
        id = %id,
        old_source = %old.source.kind,
        new_source = %new_cfg.source.kind,
        old_host = %old.source.host,
        new_host = %new_cfg.source.host,
        old_device_index = old.source.device_index,
        new_device_index = new_cfg.source.device_index,
        reinit,
        runtime_apply,
        "dongle config updated"
    );

    state.mgr.notify_dongle_updated(&new_cfg);
    if reinit {
        let mgr = state.mgr.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            tracing::info!(id = %id2, "reinitialising dongle after config change");
            if let Err(e) = mgr.reinit_dongle(&id2).await {
                tracing::error!(id = %id2, error = %e, "dongle reinit failed");
            }
        });
    } else if runtime_apply {
        // Gain, PPM, direct sampling, bias-T, AGC and offset tuning can be
        // applied to a running source without dropping the USB handle.
        state.mgr.apply_runtime_settings(&new_cfg);
    }
    json_response(StatusCode::OK, serde_json::to_value(&new_cfg).unwrap(), Some(version))
}

pub async fn delete_dongle(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let version = {
        let mut cfg = state.cfg.write();
        let Some(idx) = cfg.dongles.iter().position(|d| d.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "dongle not found"}),
                None,
            );
        };
        cfg.dongles.remove(idx);
        bump_version_locked(&state)
    };

    let _ = state.mgr.stop_dongle_by_id(&id).await;
    state.mgr.notify_dongle_removed(&id);
    json_response(StatusCode::OK, json!({"status": "deleted"}), Some(version))
}

pub async fn switch_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "profileId required"}),
                None,
            )
        }
    };
    let profile_id = parsed
        .get("profileId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if profile_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "profileId required"}),
            None,
        );
    }
    match state.mgr.switch_profile(&id, &profile_id) {
        Ok(()) => json_response(
            StatusCode::OK,
            json!({"ok": true, "dongleId": id, "profileId": profile_id}),
            None,
        ),
        Err(e) => json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": e.to_string()}),
            None,
        ),
    }
}

pub async fn dongle_start(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.mgr.start_dongle_by_id_async(&id).await {
        Ok(()) => json_response(StatusCode::OK, json!({"ok": true, "dongleId": id}), None),
        Err(e) => json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": e.to_string()}),
            None,
        ),
    }
}

pub async fn dongle_stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.mgr.stop_dongle_by_id(&id).await {
        Ok(()) => json_response(StatusCode::OK, json!({"ok": true, "dongleId": id}), None),
        Err(e) => json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": e.to_string()}),
            None,
        ),
    }
}

pub async fn create_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let p: DongleProfile = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    if p.id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "profile id is required"}),
            None,
        );
    }

    let version = {
        let mut cfg = state.cfg.write();
        let Some(d) = cfg.dongles.iter_mut().find(|d| d.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "dongle not found"}),
                None,
            );
        };
        if d.profiles.iter().any(|e| e.id == p.id) {
            return json_response(
                StatusCode::CONFLICT,
                json!({"error": "profile with this id already exists"}),
                None,
            );
        }
        d.profiles.push(p.clone());
        bump_version_locked(&state)
    };

    state.mgr.notify_profile_added(&id, &p);
    json_response(StatusCode::CREATED, serde_json::to_value(&p).unwrap(), Some(version))
}

pub async fn update_profile(
    State(state): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let patch: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    if !patch.is_object() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "invalid request body"}),
            None,
        );
    }

    let (updated, version) = {
        let mut cfg = state.cfg.write();
        let Some(d) = cfg.dongles.iter_mut().find(|d| d.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "dongle not found"}),
                None,
            );
        };
        let Some(p) = d.profiles.iter_mut().find(|p| p.id == profile_id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "profile not found"}),
                None,
            );
        };
        let existing = p.clone();
        let mut merged = serde_json::to_value(&existing).unwrap_or_else(|_| json!({}));
        merge_json(&mut merged, &patch);
        let Some(obj) = merged.as_object_mut() else {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            );
        };
        obj.insert("id".to_string(), Value::String(profile_id.clone()));
        let updated: DongleProfile = match serde_json::from_value(merged) {
            Ok(v) => v,
            Err(_) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": "invalid request body"}),
                    None,
                )
            }
        };
        *p = updated.clone();
        let version = bump_version_locked(&state);
        (updated, version)
    };

    state.mgr.notify_profile_updated(&id, &updated);
    json_response(
        StatusCode::OK,
        serde_json::to_value(&updated).unwrap(),
        Some(version),
    )
}

pub async fn delete_profile(
    State(state): State<AppState>,
    Path((id, profile_id)): Path<(String, String)>,
) -> Response {
    let version = {
        let mut cfg = state.cfg.write();
        let Some(d) = cfg.dongles.iter_mut().find(|d| d.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "dongle not found"}),
                None,
            );
        };
        let Some(idx) = d.profiles.iter().position(|p| p.id == profile_id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "profile not found"}),
                None,
            );
        };
        d.profiles.remove(idx);
        bump_version_locked(&state)
    };

    state.mgr.notify_profile_removed(&id, &profile_id);
    let mgr = state.mgr.clone();
    let id2 = id.clone();
    let pid2 = profile_id.clone();
    tokio::spawn(async move {
        mgr.handle_profile_removed(&id2, &pid2).await;
    });
    json_response(StatusCode::OK, json!({"status": "deleted"}), Some(version))
}

pub async fn reorder_profiles(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    let order: Vec<String> = parsed
        .get("order")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let (reordered, version) = {
        let mut cfg = state.cfg.write();
        let Some(d) = cfg.dongles.iter_mut().find(|d| d.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "dongle not found"}),
                None,
            );
        };
        let mut map: HashMap<String, DongleProfile> = d
            .profiles
            .iter()
            .map(|p| (p.id.clone(), p.clone()))
            .collect();
        let mut result = Vec::with_capacity(d.profiles.len());
        for pid in &order {
            if let Some(p) = map.remove(pid) {
                result.push(p);
            }
        }
        let mut leftovers: Vec<_> = map.into_values().collect();
        leftovers.sort_by(|a, b| a.id.cmp(&b.id));
        result.extend(leftovers);
        d.profiles = result.clone();
        (result, bump_version_locked(&state))
    };

    state.mgr.notify_profiles_reordered(&id, reordered);
    json_response(StatusCode::OK, json!({"status": "ok"}), Some(version))
}

pub async fn admin_bookmarks(State(state): State<AppState>) -> Response {
    let cfg = state.cfg.read();
    json_response(
        StatusCode::OK,
        serde_json::to_value(&cfg.bookmarks).unwrap_or_else(|_| json!([])),
        None,
    )
}

/// Lists the available bookmark region/country folders and the current
/// selection, for the admin region picker.
pub async fn bookmark_regions(State(state): State<AppState>) -> Response {
    let (selected, bandplan_region) = {
        let cfg = state.cfg.read();
        (
            cfg.server.bookmark_regions.clone(),
            cfg.server.bandplan_region.clone(),
        )
    };
    let regions = if state.bookmarks_dir.is_empty() {
        Vec::new()
    } else {
        super::bookmarks::scan_regions(&state.bookmarks_dir)
    };
    json_response(
        StatusCode::OK,
        json!({
            "regions": regions,
            "selected": selected,
            "bandplanRegion": bandplan_region,
        }),
        None,
    )
}

pub async fn create_bookmark(State(state): State<AppState>, body: Bytes) -> Response {
    let bm: Bookmark = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    if bm.id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "bookmark id is required"}),
            None,
        );
    }
    if bm.name.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "bookmark name is required"}),
            None,
        );
    }
    if bm.frequency <= 0 {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "frequency must be > 0"}),
            None,
        );
    }

    let version = {
        let mut cfg = state.cfg.write();
        if cfg.bookmarks.iter().any(|b| b.id == bm.id) {
            return json_response(
                StatusCode::CONFLICT,
                json!({"error": "bookmark with this id already exists"}),
                None,
            );
        }
        cfg.bookmarks.push(bm.clone());
        bump_version_locked(&state)
    };
    json_response(
        StatusCode::CREATED,
        serde_json::to_value(&bm).unwrap(),
        Some(version),
    )
}

pub async fn update_bookmark(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let mut updated: Bookmark = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    let version = {
        let mut cfg = state.cfg.write();
        let Some(b) = cfg.bookmarks.iter_mut().find(|b| b.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "bookmark not found"}),
                None,
            );
        };
        updated.id = id.clone();
        *b = updated.clone();
        bump_version_locked(&state)
    };
    json_response(
        StatusCode::OK,
        serde_json::to_value(&updated).unwrap(),
        Some(version),
    )
}

pub async fn delete_bookmark(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let version = {
        let mut cfg = state.cfg.write();
        let Some(idx) = cfg.bookmarks.iter().position(|b| b.id == id) else {
            return json_response(
                StatusCode::NOT_FOUND,
                json!({"error": "bookmark not found"}),
                None,
            );
        };
        cfg.bookmarks.remove(idx);
        bump_version_locked(&state)
    };
    json_response(StatusCode::OK, json!({"status": "deleted"}), Some(version))
}

pub async fn save_config(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let current = state.cfg_version.get();
    let mut client_version = 0u64;

    if let Some(if_match) = headers.get("if-match").and_then(|v| v.to_str().ok()) {
        if let Ok(v) = if_match.trim_matches('"').parse::<u64>() {
            client_version = v;
        }
    }
    if client_version == 0 && !body.is_empty() {
        if let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&body) {
            if let Some(v) = map.get("version").and_then(|v| v.as_u64()) {
                client_version = v;
            }
        }
    }
    if client_version > 0 && client_version != current {
        return json_response(
            StatusCode::CONFLICT,
            json!({
                "error": "config has been modified by another session",
                "clientVersion": client_version,
                "currentVersion": current,
            }),
            None,
        );
    }

    let yaml = {
        let cfg = state.cfg.read();
        match config::to_yaml_string(&cfg) {
            Ok(y) => y,
            Err(_) => {
                return json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"error": "failed to marshal config"}),
                    None,
                )
            }
        }
    };
    if std::fs::write(&state.cfg_path, yaml).is_err() {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error": "failed to write config file"}),
            None,
        );
    }

    state.mgr.notify_config_saved();
    json_response(
        StatusCode::OK,
        json!({"status": "saved", "version": current}),
        Some(current),
    )
}

pub async fn get_server_config(State(state): State<AppState>) -> Response {
    let cfg = state.cfg.read();
    let version = state.cfg_version.get();
    json_response(
        StatusCode::OK,
        json!({
            "port": cfg.server.port,
            "host": cfg.server.host,
            "callsign": cfg.server.callsign,
            "description": cfg.server.description,
            "location": cfg.server.location,
            "receiverLatitude": cfg.server.receiver_latitude,
            "receiverLongitude": cfg.server.receiver_longitude,
            "adminPassword": cfg.server.admin_password,
            "demoMode": cfg.server.demo_mode,
            "identifyEnabled": cfg.server.identify_enabled,
            "usersRibbon": cfg.server.users_ribbon,
            "bookmarkRegions": cfg.server.bookmark_regions,
            "bandplanRegion": cfg.server.bandplan_region,
            "fftHistoryFftSize": cfg.server.fft_history_fft_size,
            "fftHistoryCompression": cfg.server.fft_history_compression,
            "fftHistorySmoothMarginDb": cfg.server.fft_history_smooth_margin_db,
            "fftDeflateLevel": cfg.server.fft_deflate_level,
            "fftSmoothMarginDb": cfg.server.fft_smooth_margin_db,
            "allowedFftCodecs": cfg.server.allowed_fft_codecs,
            "allowedIqCodecs": cfg.server.allowed_iq_codecs,
            "opusComplexity": cfg.server.opus_complexity,
            "realIPHeader": cfg.server.real_ip_header,
            "decoderPath": cfg.database.decoder_path,
            "retentionDays": cfg.database.retention_days,
            "purgeIntervalMinutes": cfg.database.purge_interval_minutes,
            "maxMessages": cfg.database.max_messages,
            "auddApiKey": cfg.server.audd_api_key,
            "acrcloudHost": cfg.server.acrcloud_host,
            "acrcloudAccessKey": cfg.server.acrcloud_access_key,
            "acrcloudAccessSecret": cfg.server.acrcloud_access_secret,
            "openWeatherMapApiKey": cfg.server.open_weather_map_api_key,
            "version": version,
        }),
        Some(version),
    )
}

pub async fn update_server_config(State(state): State<AppState>, body: Bytes) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    let Some(map) = parsed.as_object() else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "invalid request body"}),
            None,
        );
    };

    let mut codecs_changed = false;
    let mut real_ip_changed = false;
    let mut deflate_changed = false;

    {
        let mut cfg = state.cfg.write();
        let s = &mut cfg.server;

        macro_rules! set_string {
            ($key:literal, $field:ident) => {
                if let Some(v) = map.get($key).and_then(|v| v.as_str()) {
                    s.$field = v.to_string();
                }
            };
        }
        macro_rules! set_i32 {
            ($key:literal, $field:ident) => {
                if let Some(v) = map.get($key).and_then(|v| v.as_i64()) {
                    s.$field = v as i32;
                }
            };
        }
        macro_rules! set_bool {
            ($key:literal, $field:ident) => {
                if let Some(v) = map.get($key).and_then(|v| v.as_bool()) {
                    s.$field = v;
                }
            };
        }

        set_string!("callsign", callsign);
        set_string!("description", description);
        set_string!("location", location);
        if let Some(v) = map.get("receiverLatitude").and_then(|v| v.as_f64()) {
            s.receiver_latitude = v.clamp(-90.0, 90.0);
        }
        if let Some(v) = map.get("receiverLongitude").and_then(|v| v.as_f64()) {
            s.receiver_longitude = v.clamp(-180.0, 180.0);
        }
        set_string!("host", host);
        set_string!("adminPassword", admin_password);
        set_string!("fftHistoryCompression", fft_history_compression);
        if let Some(v) = map.get("fftHistorySmoothMarginDb").and_then(|v| v.as_f64()) {
            s.fft_history_smooth_margin_db = (v as f32).clamp(0.0, 20.0);
        }
        set_string!("auddApiKey", audd_api_key);
        set_string!("acrcloudHost", acrcloud_host);
        set_string!("acrcloudAccessKey", acrcloud_access_key);
        set_string!("acrcloudAccessSecret", acrcloud_access_secret);
        set_string!("openWeatherMapApiKey", open_weather_map_api_key);
        set_i32!("port", port);
        set_i32!("fftHistoryFftSize", fft_history_fft_size);
        if let Some(v) = map.get("fftDeflateLevel").and_then(|v| v.as_i64()) {
            s.fft_deflate_level = (v as i32).clamp(1, 9);
            deflate_changed = true;
        }
        if let Some(v) = map.get("fftSmoothMarginDb").and_then(|v| v.as_f64()) {
            s.fft_smooth_margin_db = (v as f32).clamp(0.0, 20.0);
            deflate_changed = true;
        }
        set_bool!("demoMode", demo_mode);
        set_bool!("identifyEnabled", identify_enabled);
        set_string!("usersRibbon", users_ribbon);
        s.users_ribbon = s.users_ribbon.trim().to_ascii_lowercase();

        // Bookmark region/country selection. `null` means "all regions".
        if let Some(v) = map.get("bookmarkRegions") {
            if v.is_null() {
                s.bookmark_regions = None;
            } else if let Some(arr) = v.as_array() {
                let selected: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(|v| v.trim().to_string())
                    .filter(|v| {
                        !v.is_empty()
                            && v != "."
                            && v != ".."
                            && !v.contains('/')
                            && !v.contains('\\')
                    })
                    .collect();
                s.bookmark_regions = Some(selected);
            }
        }
        if let Some(v) = map.get("bandplanRegion").and_then(|v| v.as_str()) {
            s.bandplan_region = match v.trim().to_ascii_lowercase().as_str() {
                "r1" => "r1".to_string(),
                "r2" => "r2".to_string(),
                "r3" => "r3".to_string(),
                _ => String::new(),
            };
        }

        if let Some(v) = map.get("opusComplexity").and_then(|v| v.as_i64()) {
            s.opus_complexity = v.clamp(0, 10) as i32;
        }
        if let Some(arr) = map.get("allowedFftCodecs").and_then(|v| v.as_array()) {
            s.allowed_fft_codecs = arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            codecs_changed = true;
        }
        if let Some(arr) = map.get("allowedIqCodecs").and_then(|v| v.as_array()) {
            s.allowed_iq_codecs = arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            codecs_changed = true;
        }
        if let Some(v) = map.get("realIPHeader").and_then(|v| v.as_str()) {
            s.real_ip_header = v.to_string();
            real_ip_changed = true;
        }

        // Decoder database maintenance settings. These live in the top-level
        // `database` block rather than `server`, but the admin page saves them
        // through the same endpoint so one Save Config persists everything.
        let db = &mut cfg.database;
        if let Some(v) = map.get("decoderPath").and_then(|v| v.as_str()) {
            db.decoder_path = v.trim().to_string();
        }
        if let Some(v) = map.get("retentionDays").and_then(|v| v.as_i64()) {
            db.retention_days = v.max(0);
        }
        if let Some(v) = map.get("purgeIntervalMinutes").and_then(|v| v.as_i64()) {
            db.purge_interval_minutes = v.max(0);
        }
        if let Some(v) = map.get("maxMessages").and_then(|v| v.as_i64()) {
            db.max_messages = v.max(0);
        }
    }

    if codecs_changed {
        let cfg = state.cfg.read();
        state
            .ws
            .set_allowed_codecs(&cfg.server.allowed_fft_codecs, &cfg.server.allowed_iq_codecs);
    }
    if real_ip_changed {
        let header = state.cfg.read().server.real_ip_header.clone();
        state.ws.set_real_ip_header(&header);
    }
    if deflate_changed {
        let cfg = state.cfg.read();
        crate::codec::deflate::set_deflate_level(cfg.server.fft_deflate_level);
        crate::codec::deflate::set_smooth_margin_db(cfg.server.fft_smooth_margin_db);
    }
    {
        let password = state.cfg.read().server.admin_password.clone();
        state.auth.set_password(&password);
    }

    let version = bump_version(&state);
    state.mgr.notify_server_config_updated();
    json_response(
        StatusCode::OK,
        json!({"status": "ok", "version": version}),
        Some(version),
    )
}

pub async fn recordings(State(state): State<AppState>) -> Response {
    json_response(
        StatusCode::OK,
        serde_json::to_value(state.mgr.recording_status()).unwrap_or_else(|_| json!([])),
        None,
    )
}

// ------------------------------------------------------------------
// Cloudflare edge
// ------------------------------------------------------------------

pub async fn get_edge_config(State(state): State<AppState>) -> Response {
    let (edge, version) = {
        let cfg = state.cfg.read();
        (cfg.edge.clone(), state.cfg_version.get())
    };

    json_response(
        StatusCode::OK,
        json!({
            "enabled": edge.enabled,
            "url": edge.url,
            "instanceId": edge.instance_id,
            "hasIngestToken": !edge.ingest_token.is_empty(),
            "codec": edge.codec,
            "dongles": edge.dongles,
            "maxViewers": edge.max_viewers,
            "clientDefaultTransport": edge.client_default_transport,
            "fallback": {
                "connectTimeoutMs": edge.fallback.connect_timeout_ms,
                "firstFrameTimeoutMs": edge.fallback.first_frame_timeout_ms,
                "staleTimeoutMs": edge.fallback.stale_timeout_ms,
                "retryMs": edge.fallback.retry_ms,
            },
            "history": {
                "mode": edge.history.mode,
                "bins": edge.history.bins,
                "frames": edge.history.frames,
            },
            "reconnect": {
                "minMs": edge.reconnect.min_ms,
                "maxMs": edge.reconnect.max_ms,
            },
            "status": state.mgr.edge_status(),
            "version": version,
        }),
        Some(version),
    )
}

pub async fn update_edge_config(State(state): State<AppState>, body: Bytes) -> Response {
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": "invalid request body"}),
                None,
            )
        }
    };
    let Some(map) = parsed.as_object() else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "invalid request body"}),
            None,
        );
    };

    let version = {
        let mut cfg = state.cfg.write();
        let old = cfg.edge.clone();
        let e = &mut cfg.edge;

        if let Some(v) = map.get("enabled").and_then(|v| v.as_bool()) {
            e.enabled = v;
        }
        if let Some(v) = map.get("url").and_then(|v| v.as_str()) {
            e.url = v.trim().to_string();
        }
        if let Some(v) = map.get("instanceId").and_then(|v| v.as_str()) {
            e.instance_id = v.trim().to_string();
        }
        if let Some(v) = map.get("codec").and_then(|v| v.as_str()) {
            e.codec = v.trim().to_string();
        }
        if let Some(v) = map.get("clientDefaultTransport").and_then(|v| v.as_str()) {
            e.client_default_transport = v.trim().to_string();
        }
        if let Some(v) = map.get("maxViewers").and_then(|v| v.as_i64()) {
            e.max_viewers = v as i32;
        }
        if let Some(arr) = map.get("dongles").and_then(|v| v.as_array()) {
            e.dongles = arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect();
        }
        // Empty/missing token keeps the existing secret. Use an explicit
        // clearIngestToken flag to remove it.
        if let Some(v) = map.get("ingestToken").and_then(|v| v.as_str()) {
            if !v.trim().is_empty() {
                e.ingest_token = v.trim().to_string();
            }
        }
        if map
            .get("clearIngestToken")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            e.ingest_token.clear();
        }

        if let Some(f) = map.get("fallback").and_then(|v| v.as_object()) {
            if let Some(v) = f.get("connectTimeoutMs").and_then(|v| v.as_i64()) {
                e.fallback.connect_timeout_ms = v;
            }
            if let Some(v) = f.get("firstFrameTimeoutMs").and_then(|v| v.as_i64()) {
                e.fallback.first_frame_timeout_ms = v;
            }
            if let Some(v) = f.get("staleTimeoutMs").and_then(|v| v.as_i64()) {
                e.fallback.stale_timeout_ms = v;
            }
            if let Some(v) = f.get("retryMs").and_then(|v| v.as_i64()) {
                e.fallback.retry_ms = v;
            }
        }
        if let Some(h) = map.get("history").and_then(|v| v.as_object()) {
            if let Some(v) = h.get("mode").and_then(|v| v.as_str()) {
                e.history.mode = v.trim().to_string();
            }
            if let Some(v) = h.get("bins").and_then(|v| v.as_i64()) {
                e.history.bins = v as i32;
            }
            if let Some(v) = h.get("frames").and_then(|v| v.as_i64()) {
                e.history.frames = v as i32;
            }
        }
        if let Some(r) = map.get("reconnect").and_then(|v| v.as_object()) {
            if let Some(v) = r.get("minMs").and_then(|v| v.as_i64()) {
                e.reconnect.min_ms = v;
            }
            if let Some(v) = r.get("maxMs").and_then(|v| v.as_i64()) {
                e.reconnect.max_ms = v;
            }
        }

        config::apply_defaults(&mut cfg);
        if let Err(err) = config::validate(&cfg) {
            cfg.edge = old;
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"error": err.to_string()}),
                None,
            );
        }

        bump_version_locked(&state)
    };

    state.mgr.reload_edge();
    json_response(
        StatusCode::OK,
        json!({"status": "ok", "version": version}),
        Some(version),
    )
}

pub async fn edge_status(State(state): State<AppState>) -> Response {
    let version = state.cfg_version.get();
    json_response(
        StatusCode::OK,
        json!({
            "status": state.mgr.edge_status(),
            "version": version,
        }),
        Some(version),
    )
}

pub async fn test_edge(State(state): State<AppState>) -> Response {
    let (url, enabled, token_present) = {
        let cfg = state.cfg.read();
        (
            cfg.edge.url.clone(),
            cfg.edge.enabled,
            !cfg.edge.ingest_token.is_empty(),
        )
    };

    if url.trim().is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "edge.url is empty"}),
            None,
        );
    }
    if !enabled {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "edge is disabled"}),
            None,
        );
    }
    if !token_present {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": "edge.ingestToken is empty"}),
            None,
        );
    }

    let base = url
        .trim()
        .trim_end_matches('/')
        .replace("wss://", "https://")
        .replace("ws://", "http://");
    let health = format!("{base}/health");

    let started = Instant::now();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": err.to_string()}),
                None,
            )
        }
    };

    match client.get(&health).send().await {
        Ok(resp) => {
            let status = resp.status();
            let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
            json_response(
                StatusCode::OK,
                json!({
                    "ok": status.is_success(),
                    "status": status.as_u16(),
                    "latencyMs": started.elapsed().as_millis() as u64,
                    "worker": body,
                }),
                None,
            )
        }
        Err(err) => json_response(
            StatusCode::BAD_GATEWAY,
            json!({"ok": false, "error": err.to_string()}),
            None,
        ),
    }
}

pub async fn record_start(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.mgr.start_recording(&id) {
        Ok(()) => json_response(
            StatusCode::OK,
            json!({"status": "recording", "dongleId": id}),
            None,
        ),
        Err(e) => json_response(
            StatusCode::CONFLICT,
            json!({"error": e.to_string()}),
            None,
        ),
    }
}

pub async fn record_stop(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.mgr.stop_recording(&id) {
        Ok(path) => json_response(
            StatusCode::OK,
            json!({"status": "stopped", "file": path}),
            None,
        ),
        Err(e) => json_response(
            StatusCode::CONFLICT,
            json!({"error": e.to_string()}),
            None,
        ),
    }
}

fn bump_version(state: &AppState) -> u64 {
    state.cfg_version.increment()
}

fn bump_version_locked(state: &AppState) -> u64 {
    state.cfg_version.increment()
}

pub fn json_response(status: StatusCode, body: Value, version: Option<u64>) -> Response {
    let mut resp = (status, Json(body)).into_response();
    if let Some(v) = version.filter(|v| *v > 0) {
        if let Ok(value) = HeaderValue::from_str(&v.to_string()) {
            resp.headers_mut().insert("X-Config-Version", value);
            if let Ok(etag) = HeaderValue::from_str(&format!("\"{v}\"")) {
                resp.headers_mut().insert(header::ETAG, etag);
            }
        }
    }
    resp
}

/// Recursively merges `patch` into `base`. Objects are merged key-by-key;
/// everything else (arrays, scalars, null) replaces the base value.
pub(crate) fn merge_json(base: &mut Value, patch: &Value) {
    let (Some(base_map), Some(patch_map)) = (base.as_object_mut(), patch.as_object()) else {
        *base = patch.clone();
        return;
    };
    for (key, value) in patch_map {
        match (base_map.get_mut(key), value) {
            (Some(existing), Value::Object(_)) if existing.is_object() => {
                merge_json(existing, value);
            }
            _ => {
                base_map.insert(key.clone(), value.clone());
            }
        }
    }
}

pub fn needs_reinit(old: &DongleConfig, new: &DongleConfig) -> bool {
    let o: &SourceConfig = &old.source;
    let n: &SourceConfig = &new.source;
    o.kind != n.kind
        || o.host != n.host
        || o.port != n.port
        || o.device_index != n.device_index
        || o.serial != n.serial
        || o.binary != n.binary
        || o.spawn_rtl_tcp != n.spawn_rtl_tcp
        || old.sample_rate != new.sample_rate
        || old.iq_correction != new.iq_correction
        || open_time_settings_changed(&o.kind, &o.settings, &n.settings)
}

/// Settings the driver only reads while opening the device. Changing one of
/// these while a source is running has to reopen it; the runtime command path
/// cannot apply them.
fn open_time_settings_changed(
    kind: &str,
    old: &serde_json::Map<String, serde_json::Value>,
    new: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    let keys: &[&str] = match kind {
        "hackrf" => &["transfers", "transferKib"],
        "airspy" => &["packing", "transfers", "transferKib"],
        "airspyhf" => &["libDsp", "calibrationPpb"],
        "hydrasdr" => &["packing"],
        "rx888" => &["adcRateHz", "ddcBins"],
        "pluto" => &["rfBandwidthHz", "rxPort", "bufferSamples"],
        "sdrplay" => &["bwKhz", "antenna", "duoTuner"],
        "lime" => &[
            "channel",
            "oversample",
            "antennaRx",
            "lpfRxHz",
            "fifoKsamples",
            "throughputVsLatency",
            "calibrate",
        ],
        "fobos" => &["port"],
        // RTL-SDR, HF+ and ELAD apply every exposed setting at runtime, and
        // their rate change is already covered by `sample_rate`.
        _ => &[],
    };
    keys.iter()
        .any(|key| old.get(*key) != new.get(*key))
}

/// Hardware settings that can be pushed to a running source through the
/// command channel without closing/reopening the device.
pub fn needs_runtime_apply(old: &DongleConfig, new: &DongleConfig) -> bool {
    old.gain != new.gain
        || old.ppm != new.ppm
        || old.direct_sampling != new.direct_sampling
        || old.bias_t != new.bias_t
        || old.digital_agc != new.digital_agc
        || old.offset_tuning != new.offset_tuning
        || old.source.settings != new.source.settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn open_time_source_settings_trigger_reinit() {
        let mut old = DongleConfig::default();
        old.source.kind = "sdrplay".into();
        old.source.settings.insert("bwKhz".into(), json!(1536));
        let mut new = old.clone();
        new.source.settings.insert("bwKhz".into(), json!(600));
        assert!(needs_reinit(&old, &new));

        // A runtime-applicable setting must not force a reopen.
        new.source.settings.insert("ifGrDb".into(), json!(30));
        old.source.settings.remove("bwKhz");
        new.source.settings.remove("bwKhz");
        assert!(!needs_reinit(&old, &new));
    }

    #[test]
    fn merge_json_preserves_omitted_fields() {
        let mut merged = json!({
            "name": "A",
            "sampleRate": 2400000,
            "source": { "type": "demo", "host": "old" },
            "profiles": [{ "id": "p1" }]
        });
        merge_json(
            &mut merged,
            &json!({ "name": "B", "source": { "host": "new" } }),
        );
        assert_eq!(merged["name"], "B");
        assert_eq!(merged["sampleRate"], 2400000);
        assert_eq!(merged["source"]["type"], "demo");
        assert_eq!(merged["source"]["host"], "new");
        assert_eq!(merged["profiles"][0]["id"], "p1");
    }
}
