//! Configuration loading, defaults and validation.
//!
//! Ported from the original Go backend.
//!
//! YAML files use the Go YAML key names (`defaultBandwidth`, `defaultMode`,
//! `defaultTuneOffset`) while the JSON API uses the Go JSON tags
//! (`bandwidth`, `mode`, `tuneOffset`). The structs use the JSON names as their
//! serde representation and the YAML boundary translates the three keys.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Demodulation modes accepted by the configuration.
pub const VALID_MODES: [&str; 9] = [
    "wfm",
    "nfm",
    "am",
    "am-stereo",
    "usb",
    "lsb",
    "cw",
    "raw",
    "sam",
];

pub const DEFAULT_FFT_CODECS: [&str; 4] = ["none", "adpcm", "deflate", "deflate-floor"];
pub const DEFAULT_IQ_CODECS: [&str; 5] = ["none", "adpcm", "opus-lo", "opus", "opus-hq"];

/// Tracks the in-memory config revision number for optimistic concurrency.
#[derive(Debug)]
pub struct ConfigVersion {
    v: AtomicU64,
}

impl ConfigVersion {
    pub fn new() -> Self {
        Self {
            v: AtomicU64::new(1),
        }
    }

    pub fn get(&self) -> u64 {
        self.v.load(Ordering::SeqCst)
    }

    pub fn increment(&self) -> u64 {
        self.v.fetch_add(1, Ordering::SeqCst) + 1
    }
}

impl Default for ConfigVersion {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub dongles: Vec<DongleConfig>,
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
}

/// User-defined frequency/mode preset.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub frequency: i64,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub bandwidth: i32,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(default)]
    pub port: i32,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub admin_password: String,
    #[serde(default)]
    pub callsign: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub demo_mode: bool,
    /// Tracing/log level: trace, debug, info, warn, error (or off).
    /// `LOG_LEVEL` in the environment overrides this.
    #[serde(default)]
    pub log_level: String,
    #[serde(default)]
    pub fft_history_fft_size: i32,
    #[serde(default)]
    pub fft_history_compression: String,
    #[serde(default)]
    pub allowed_fft_codecs: Vec<String>,
    #[serde(default)]
    pub allowed_iq_codecs: Vec<String>,
    #[serde(default)]
    pub opus_complexity: i32,
    #[serde(default, rename = "realIPHeader", alias = "realIpHeader")]
    pub real_ip_header: String,
    // Secrets: present in YAML, omitted from JSON by the Go implementation
    // (`json:"-"`). Our JSON handlers build explicit maps, never serialize this
    // struct directly.
    #[serde(default)]
    pub audd_api_key: String,
    #[serde(default)]
    pub acrcloud_host: String,
    #[serde(default)]
    pub acrcloud_access_key: String,
    #[serde(default)]
    pub acrcloud_access_secret: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 3000,
            host: "0.0.0.0".to_string(),
            admin_password: String::new(),
            callsign: String::new(),
            description: String::new(),
            location: String::new(),
            demo_mode: false,
            log_level: String::new(),
            fft_history_fft_size: 0,
            fft_history_compression: String::new(),
            allowed_fft_codecs: Vec::new(),
            allowed_iq_codecs: Vec::new(),
            opus_complexity: 0,
            real_ip_header: String::new(),
            audd_api_key: String::new(),
            acrcloud_host: String::new(),
            acrcloud_access_key: String::new(),
            acrcloud_access_secret: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DongleConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub source: SourceConfig,
    #[serde(default)]
    pub sample_rate: i32,
    #[serde(default)]
    pub gain: f64,
    #[serde(default, rename = "ppmCorrection")]
    pub ppm: i32,
    #[serde(default)]
    pub device_index: i32,
    #[serde(default)]
    pub direct_sampling: i32,
    #[serde(default)]
    pub bias_t: bool,
    #[serde(default)]
    pub digital_agc: bool,
    #[serde(default)]
    pub offset_tuning: bool,
    /// Front-end DC + I/Q imbalance correction (zero-IF receivers).
    #[serde(default)]
    pub iq_correction: bool,
    #[serde(default)]
    pub profiles: Vec<DongleProfile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfig {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: i32,
    #[serde(default)]
    pub device_index: i32,
    #[serde(default)]
    pub serial: String,
    #[serde(default)]
    pub binary: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub spawn_rtl_tcp: bool,
}

/// Frequency/mode preset for a dongle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DongleProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub center_frequency: i64,
    #[serde(default)]
    pub sample_rate: i32,
    #[serde(default, rename = "bandwidth")]
    pub bandwidth: i32,
    #[serde(default, rename = "mode")]
    pub mode: String,
    #[serde(default)]
    pub gain: f64,
    #[serde(default)]
    pub fft_size: i32,
    #[serde(default)]
    pub fft_fps: i32,
    #[serde(default, rename = "tuneOffset")]
    pub tune_offset: i32,
    #[serde(default)]
    pub tuning_step: i32,
    #[serde(default, rename = "swapIQ")]
    pub swap_iq: bool,
    #[serde(default)]
    pub oscillator_offset: i32,
    #[serde(default)]
    pub direct_sampling: i32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub dongle_id: String,
    #[serde(default, rename = "preFilterNb")]
    pub pre_filter_nb: bool,
    #[serde(default)]
    pub pre_filter_nb_threshold: i32,
    /// `None` until defaults are applied; then always `Some`.
    #[serde(default)]
    pub dc_offset_removal: Option<bool>,
}

impl Default for DongleProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            center_frequency: 0,
            sample_rate: 0,
            bandwidth: 0,
            mode: String::new(),
            gain: 0.0,
            fft_size: 0,
            fft_fps: 0,
            tune_offset: 0,
            tuning_step: 0,
            swap_iq: false,
            oscillator_offset: 0,
            direct_sampling: 0,
            description: String::new(),
            dongle_id: String::new(),
            pre_filter_nb: false,
            pre_filter_nb_threshold: 0,
            dc_offset_removal: None,
        }
    }
}

impl DongleProfile {
    /// Resolved DC-offset-removal flag (defaults to true, like Go).
    pub fn dc_offset_removal_enabled(&self) -> bool {
        self.dc_offset_removal.unwrap_or(true)
    }
}

/// Loads the config at `path`, creating a default file when missing.
pub fn load(path: &Path) -> Result<Config> {
    let mut cfg = Config::default();
    apply_defaults(&mut cfg);

    match std::fs::read(path) {
        Ok(data) => {
            let value: serde_yaml::Value = serde_yaml::from_slice(&data)
                .with_context(|| format!("config: parse yaml: {}", path.display()))?;
            let value = yaml_keys_to_json(value);
            let mut value = value;
            apply_dongle_presence_defaults(&mut value);
            let mut cfg: Config = serde_yaml::from_value(value)
                .with_context(|| format!("config: parse yaml: {}", path.display()))?;
            apply_defaults(&mut cfg);
            apply_profile_defaults(&mut cfg);
            validate(&cfg)?;
            Ok(cfg)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Err(err) = write_default_config(path, &mut cfg) {
                eprintln!(
                    "config: warning: could not write default config to {}: {err}",
                    path.display()
                );
            }
            Ok(cfg)
        }
        Err(e) => Err(e).with_context(|| format!("config: read file: {}", path.display())),
    }
}

fn write_default_config(path: &Path, cfg: &mut Config) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("create config dir")?;
    }
    if cfg.server.admin_password.is_empty() {
        cfg.server.admin_password = "admin".to_string();
    }
    let body = to_yaml_string(cfg).context("marshal default config")?;
    let header = "# node-sdr configuration (auto-generated on first boot)\n\
                  # See AGENTS.md for configuration reference.\n\n";
    std::fs::write(path, format!("{header}{body}")).context("write config file")?;
    Ok(())
}

/// Serializes a config to the Go-compatible YAML representation.
pub fn to_yaml_string(cfg: &Config) -> Result<String> {
    let value = serde_yaml::to_value(cfg).context("serialize config")?;
    let value = yaml_keys_to_go(value);
    serde_yaml::to_string(&value).context("serialize config yaml")
}

/// Applies runtime defaults (mirrors Go `applyDefaults`).
pub fn apply_defaults(cfg: &mut Config) {
    if cfg.server.port == 0 {
        cfg.server.port = 3000;
    }
    if cfg.server.host.is_empty() {
        cfg.server.host = "0.0.0.0".to_string();
    }
    if cfg.server.allowed_fft_codecs.is_empty() {
        cfg.server.allowed_fft_codecs = DEFAULT_FFT_CODECS.iter().map(|s| s.to_string()).collect();
    }
    if cfg.server.allowed_iq_codecs.is_empty() {
        cfg.server.allowed_iq_codecs = DEFAULT_IQ_CODECS.iter().map(|s| s.to_string()).collect();
    }
    if cfg.server.opus_complexity < 0 {
        cfg.server.opus_complexity = 5;
    }
    cfg.server.log_level = cfg.server.log_level.trim().to_ascii_lowercase();
    if cfg.server.log_level.is_empty() {
        cfg.server.log_level = "info".to_string();
    }
}

/// YAML `enabled`/`autoStart` default to true only when the keys are absent.
///
/// `apply_defaults` must not force them (that would make an explicit
/// `enabled: false` impossible, which was the old Go quirk).
fn apply_dongle_presence_defaults(value: &mut serde_yaml::Value) {
    let Some(root) = value.as_mapping_mut() else {
        return;
    };
    let dongles_key = serde_yaml::Value::String("dongles".to_string());
    let Some(seq) = root.get_mut(&dongles_key).and_then(|v| v.as_sequence_mut()) else {
        return;
    };
    for d in seq {
        let Some(map) = d.as_mapping_mut() else {
            continue;
        };
        for key in ["enabled", "autoStart"] {
            let k = serde_yaml::Value::String(key.to_string());
            if !map.contains_key(&k) {
                map.insert(k, serde_yaml::Value::Bool(true));
            }
        }
    }
}

/// Applies per-profile defaults (mirrors Go `applyProfileDefaults`).
pub fn apply_profile_defaults(cfg: &mut Config) {
    for d in &mut cfg.dongles {
        for p in &mut d.profiles {
            if p.fft_fps == 0 {
                p.fft_fps = 30;
            }
            if p.fft_size == 0 {
                p.fft_size = 4096;
            }
            if p.mode.is_empty() {
                p.mode = "wfm".to_string();
            }
            if p.dc_offset_removal.is_none() {
                p.dc_offset_removal = Some(true);
            }
        }
    }
}

pub fn validate(cfg: &Config) -> Result<()> {
    const LOG_LEVELS: [&str; 6] = ["trace", "debug", "info", "warn", "error", "off"];
    if !LOG_LEVELS.contains(&cfg.server.log_level.as_str()) {
        bail!(
            "config: server.logLevel must be one of {:?}, got {:?}",
            LOG_LEVELS,
            cfg.server.log_level
        );
    }
    for (i, d) in cfg.dongles.iter().enumerate() {
        for (j, p) in d.profiles.iter().enumerate() {
            if !is_power_of_two(p.fft_size) || p.fft_size < 256 || p.fft_size > 131072 {
                bail!(
                    "config: dongle[{i}].profiles[{j}] ({}): fftSize must be power of 2 in [256, 131072], got {}",
                    p.id,
                    p.fft_size
                );
            }
            if p.sample_rate <= 0 {
                bail!(
                    "config: dongle[{i}].profiles[{j}] ({}): sampleRate must be > 0, got {}",
                    p.id,
                    p.sample_rate
                );
            }
            if !VALID_MODES.contains(&p.mode.as_str()) {
                bail!(
                    "config: dongle[{i}].profiles[{j}] ({}): invalid mode {:?}",
                    p.id,
                    p.mode
                );
            }
        }
    }
    Ok(())
}

pub fn is_power_of_two(n: i32) -> bool {
    n > 0 && (n & (n - 1)) == 0
}

/// Default bookmarks directory: `<dir of config>/../bookmarks`.
pub fn bookmarks_dir(cfg_path: &Path) -> PathBuf {
    let dir = cfg_path.parent().unwrap_or_else(|| Path::new("."));
    dir.join("..").join("bookmarks")
}

// ---------------------------------------------------------------------------
// YAML key translation
// ---------------------------------------------------------------------------

fn rename_key(map: &mut serde_yaml::Mapping, from: &str, to: &str) {
    let key = serde_yaml::Value::String(from.to_string());
    if let Some(v) = map.remove(&key) {
        map.insert(serde_yaml::Value::String(to.to_string()), v);
    }
}

fn for_each_profile_value<F: FnMut(&mut serde_yaml::Mapping)>(value: &mut serde_yaml::Value, mut f: F) {
    let Some(root) = value.as_mapping_mut() else {
        return;
    };
    let key = serde_yaml::Value::String("dongles".to_string());
    let Some(dongles) = root.get_mut(&key).and_then(|v| v.as_sequence_mut()) else {
        return;
    };
    for dongle in dongles {
        let Some(dongle) = dongle.as_mapping_mut() else {
            continue;
        };
        let pkey = serde_yaml::Value::String("profiles".to_string());
        let Some(profiles) = dongle.get_mut(&pkey).and_then(|v| v.as_sequence_mut()) else {
            continue;
        };
        for p in profiles {
            if let Some(p) = p.as_mapping_mut() {
                f(p);
            }
        }
    }
}

/// Rewrites Go YAML profile keys to the JSON representation used by serde.
fn yaml_keys_to_json(mut value: serde_yaml::Value) -> serde_yaml::Value {
    for_each_profile_value(&mut value, |p| {
        rename_key(p, "defaultBandwidth", "bandwidth");
        rename_key(p, "defaultMode", "mode");
        rename_key(p, "defaultTuneOffset", "tuneOffset");
    });
    value
}

/// Rewrites JSON profile keys back to the Go YAML representation.
fn yaml_keys_to_go(mut value: serde_yaml::Value) -> serde_yaml::Value {
    for_each_profile_value(&mut value, |p| {
        rename_key(p, "bandwidth", "defaultBandwidth");
        rename_key(p, "mode", "defaultMode");
        rename_key(p, "tuneOffset", "defaultTuneOffset");
    });
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Config {
        let value: serde_yaml::Value = serde_yaml::from_str(text).unwrap();
        let mut value = yaml_keys_to_json(value);
        apply_dongle_presence_defaults(&mut value);
        let mut cfg: Config = serde_yaml::from_value(value).unwrap();
        apply_defaults(&mut cfg);
        apply_profile_defaults(&mut cfg);
        validate(&cfg).unwrap();
        cfg
    }

    #[test]
    fn defaults_applied() {
        let cfg = parse(
            "server:\n  port: 1234\ndongles:\n  - id: d1\n    sampleRate: 2400000\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultBandwidth: 200000\n        defaultMode: wfm\n",
        );
        assert_eq!(cfg.server.port, 1234);
        assert_eq!(cfg.server.host, "0.0.0.0");
        assert_eq!(cfg.server.allowed_fft_codecs, DEFAULT_FFT_CODECS);
        let p = &cfg.dongles[0].profiles[0];
        assert_eq!(p.fft_size, 4096);
        assert_eq!(p.fft_fps, 30);
        assert_eq!(p.bandwidth, 200000);
        assert_eq!(p.mode, "wfm");
        assert!(p.dc_offset_removal_enabled());
        assert!(cfg.dongles[0].enabled);
        assert!(cfg.dongles[0].auto_start);
    }

    #[test]
    fn explicit_disabled_is_preserved() {
        let cfg = parse(
            "dongles:\n  - id: d1\n    enabled: false\n    autoStart: false\n    sampleRate: 2400000\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultMode: nfm\n",
        );
        assert!(!cfg.dongles[0].enabled);
        assert!(!cfg.dongles[0].auto_start);
    }

    #[test]
    fn yaml_round_trip_uses_go_keys() {
        let cfg = parse(
            "dongles:\n  - id: d1\n    sampleRate: 2400000\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultBandwidth: 200000\n        defaultMode: am\n        defaultTuneOffset: 500\n",
        );
        let y = to_yaml_string(&cfg).unwrap();
        assert!(y.contains("defaultBandwidth: 200000"), "{y}");
        assert!(y.contains("defaultMode: am"), "{y}");
        assert!(y.contains("defaultTuneOffset: 500"), "{y}");
        assert!(y.contains("realIPHeader:"), "{y}");
        assert!(!y.contains("realIpHeader:"), "{y}");
        let reparsed = parse(&y);
        assert_eq!(reparsed.dongles[0].profiles[0].tune_offset, 500);
    }

    #[test]
    fn rejects_bad_fft_size() {
        let value: serde_yaml::Value = serde_yaml::from_str(
            "dongles:\n  - id: d1\n    profiles:\n      - id: p1\n        sampleRate: 1000\n        fftSize: 1000\n",
        )
        .unwrap();
        let mut cfg: Config = serde_yaml::from_value(yaml_keys_to_json(value)).unwrap();
        apply_profile_defaults(&mut cfg);
        assert!(validate(&cfg).is_err());
    }

    #[test]
    fn profile_modes_validated() {
        let value: serde_yaml::Value = serde_yaml::from_str(
            "dongles:\n  - id: d1\n    profiles:\n      - id: p1\n        sampleRate: 1000\n        defaultMode: nope\n",
        )
        .unwrap();
        let mut cfg: Config = serde_yaml::from_value(yaml_keys_to_json(value)).unwrap();
        apply_profile_defaults(&mut cfg);
        assert!(validate(&cfg).is_err());
    }
}
