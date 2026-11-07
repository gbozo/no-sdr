//! System info and connected-client admin views.

use std::time::Instant;

use serde_json::{json, Value};

use crate::codec::OPUS_AVAILABLE;
use crate::config::{Config, DEFAULT_FFT_CODECS, DEFAULT_IQ_CODECS};
use crate::ws::WsManager;

use super::AppState;

pub fn system_info(state: &AppState) -> Value {
    let cfg = state.cfg.read();
    let info = state.ws.get_all_clients();
    let mem_mb = process_rss_mb();
    let uptime = state.start_time.elapsed().as_secs();
    let running_dongles = state
        .mgr
        .get_all_dongle_states()
        .values()
        .filter(|s| s.status == crate::dongle::STATUS_RUNNING)
        .count();
    let tasks = info.len() + running_dongles + 2;

    let mut resp = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "goVersion": format!("rustc {}", rustc_version()),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "goamd64": "",
        "uptime": uptime,
        "memory": {
            "allocMB": mem_mb,
            "sysMB": mem_mb,
            "numGC": 0,
            "goroutines": tasks,
        },
        "features": {
            "opusSupport": OPUS_AVAILABLE,
            "rtlsdrNative": cfg!(feature = "rtlsdr"),
            "allowedFftCodecs": cfg.server.allowed_fft_codecs,
            "allowedIqCodecs": cfg.server.allowed_iq_codecs,
            "supportedSources": ["demo", "rtl_tcp", "airspy_tcp", "hfp_tcp", "rsp_tcp", "local"],
            "supportedModes": ["wfm", "nfm", "am", "am-stereo", "usb", "lsb", "cw", "raw", "sam"],
            "supportedFftCodecs": DEFAULT_FFT_CODECS,
            "supportedIqCodecs": DEFAULT_IQ_CODECS,
        },
        "dongles": {
            "configured": cfg.dongles.len(),
            "clients": state.ws.client_count(),
        },
    });

    let states = state.mgr.get_all_dongle_states();
    if !states.is_empty() {
        resp["dongleStates"] = serde_json::to_value(states).unwrap_or(Value::Null);
    }
    resp
}

fn rustc_version() -> &'static str {
    option_env!("RUSTC_VERSION").unwrap_or("stable")
}

fn process_rss_mb() -> f64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(pages) = statm.split_whitespace().nth(1) {
                if let Ok(pages) = pages.parse::<u64>() {
                    return pages as f64 * 4096.0 / 1_048_576.0;
                }
            }
        }
        0.0
    }
    #[cfg(not(target_os = "linux"))]
    {
        0.0
    }
}

pub fn clients(state: &AppState) -> Vec<Value> {
    let cfg = state.cfg.read();
    let infos = state.ws.get_all_clients();
    let mut out = Vec::with_capacity(infos.len());

    for info in infos {
        let display_ip = match info.ip.rsplit_once(':') {
            Some((host, _)) if !host.contains(':') => host.to_string(),
            _ => info.ip.clone(),
        };

        let mut entry = json!({
            "id": info.id,
            "persistentId": info.persistent_id,
            "connIndex": info.conn_index,
            "ip": display_ip,
            "dongleId": info.dongle_id,
            "profileId": info.profile_id,
            "fftCodec": info.fft_codec,
            "iqCodec": info.iq_codec,
            "mode": info.mode,
            "tuneOffset": info.tune_offset,
            "bandwidth": info.bandwidth,
            "audioEnabled": info.audio_enabled,
            "stereoEnabled": info.stereo_enabled,
            "connectedAt": info.connected_at,
        });

        if !info.real_ip.is_empty() {
            entry["realIp"] = json!(info.real_ip);
        }

        if !info.dongle_id.is_empty() {
            if let Some(d) = cfg.dongles.iter().find(|d| d.id == info.dongle_id) {
                entry["dongleName"] = json!(d.name);
                if !info.profile_id.is_empty() {
                    if let Some(p) = d.profiles.iter().find(|p| p.id == info.profile_id) {
                        entry["profileName"] = json!(p.name);
                        entry["centerFrequency"] = json!(p.center_frequency);
                    }
                }
            }
        }

        out.push(entry);
    }
    out
}

/// Keeps imports used when only the admin module needs them.
#[allow(dead_code)]
fn _state_types(_: &Config, _: &WsManager, _: Instant) {}
