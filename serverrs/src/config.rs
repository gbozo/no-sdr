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

pub const DEFAULT_FFT_CODECS: [&str; 4] = ["none", "adpcm", "deflate-smooth", "range"];
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
    /// Background digital-mode decoders. They run independently of connected
    /// clients and broadcast results to clients subscribed to their dongle.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decoders: Vec<DecoderConfig>,
    /// Decoder result persistence.
    #[serde(default)]
    pub database: DatabaseConfig,
    /// Optional Cloudflare Durable Object fan-out.
    #[serde(default)]
    pub edge: EdgeConfig,
    /// Offline IP geolocation. DB-IP City Lite MMDB is downloaded and
    /// refreshed in the background; lookups never leave the process.
    #[serde(default)]
    pub geoip: GeoIpConfig,
}

/// Offline IP geolocation settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoIpConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// MMDB path. Relative paths resolve against the config file's directory.
    #[serde(default = "default_geoip_database_path")]
    pub database_path: String,
    /// Download a new monthly DB-IP City Lite release automatically.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// How often the updater checks for a new monthly release.
    #[serde(default = "default_geoip_update_interval_hours")]
    pub update_interval_hours: u64,
}

impl Default for GeoIpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            database_path: default_geoip_database_path(),
            auto_update: true,
            update_interval_hours: default_geoip_update_interval_hours(),
        }
    }
}

fn default_geoip_database_path() -> String {
    "../data/dbip-city-lite.mmdb".to_string()
}

fn default_geoip_update_interval_hours() -> u64 {
    24
}

/// Decoder result database settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConfig {
    /// SQLite path. Empty means `decoders.sqlite` beside the config file.
    #[serde(default)]
    pub decoder_path: String,
    /// Delete decoder messages/entities older than this many days. 0 keeps
    /// everything (the default).
    #[serde(default)]
    pub retention_days: i64,
    /// How often the maintenance task applies `retentionDays` and
    /// `maxMessages`. 0 disables periodic purges, leaving only manual purges.
    #[serde(default = "default_purge_interval_minutes")]
    pub purge_interval_minutes: i64,
    /// Hard cap on stored messages. 0 means unlimited. When exceeded, the
    /// oldest rows are removed at the next purge.
    #[serde(default)]
    pub max_messages: i64,
    /// Delete closed user sessions older than this many days. 0 keeps them
    /// forever; the default is one quarter.
    #[serde(default = "default_user_retention_days")]
    pub user_retention_days: i64,
    /// How often the user-session maintenance purge runs. 0 disables it.
    #[serde(default = "default_user_purge_interval_minutes")]
    pub user_purge_interval_minutes: i64,
    /// How long disconnected users remain on the live admin map.
    #[serde(default = "default_user_map_recent_minutes")]
    pub user_map_recent_minutes: i64,
}

fn default_purge_interval_minutes() -> i64 {
    30
}

fn default_user_retention_days() -> i64 {
    90
}

fn default_user_purge_interval_minutes() -> i64 {
    360
}

fn default_user_map_recent_minutes() -> i64 {
    60
}

/// Cloudflare Durable Object fan-out settings.
///
/// The origin pushes one authenticated WebSocket per dongle to the Worker. The
/// DO fans FFT frames out to browsers and keeps a small history ring.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL, e.g. `wss://fft.example.com`. `ws://` is accepted only for
    /// local development.
    #[serde(default)]
    pub url: String,
    /// Stable instance name used in the edge topic path.
    #[serde(default)]
    pub instance_id: String,
    /// Bearer token for the ingest route. Secret: never serialized to public
    /// JSON.
    #[serde(default)]
    pub ingest_token: String,
    /// Canonical edge FFT codec. v1 supports `deflate-smooth` because the DO
    /// decodes it for history.
    #[serde(default)]
    pub codec: String,
    /// Dongles to publish. Empty means every configured dongle.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dongles: Vec<String>,
    /// Viewer cap per DO. Also sent to the DO in the `hello` message.
    #[serde(default)]
    pub max_viewers: i32,
    /// Client default when it has no local preference: auto|origin|edge.
    #[serde(default)]
    pub client_default_transport: String,
    #[serde(default)]
    pub fallback: EdgeFallbackConfig,
    #[serde(default)]
    pub history: EdgeHistoryConfig,
    #[serde(default)]
    pub reconnect: EdgeReconnectConfig,
}

impl Default for EdgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            instance_id: String::new(),
            ingest_token: String::new(),
            codec: "range".to_string(),
            dongles: Vec::new(),
            max_viewers: 200,
            client_default_transport: "auto".to_string(),
            fallback: EdgeFallbackConfig::default(),
            history: EdgeHistoryConfig::default(),
            reconnect: EdgeReconnectConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeFallbackConfig {
    #[serde(default)]
    pub connect_timeout_ms: i64,
    #[serde(default)]
    pub first_frame_timeout_ms: i64,
    #[serde(default)]
    pub stale_timeout_ms: i64,
    #[serde(default)]
    pub retry_ms: i64,
}

impl Default for EdgeFallbackConfig {
    fn default() -> Self {
        Self {
            connect_timeout_ms: 2500,
            first_frame_timeout_ms: 3000,
            stale_timeout_ms: 5000,
            retry_ms: 30_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeHistoryConfig {
    /// do-ring | origin-snapshot | off
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub bins: i32,
    #[serde(default)]
    pub frames: i32,
}

impl Default for EdgeHistoryConfig {
    fn default() -> Self {
        Self {
            mode: "do-ring".to_string(),
            bins: 2048,
            frames: 512,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeReconnectConfig {
    #[serde(default)]
    pub min_ms: i64,
    #[serde(default)]
    pub max_ms: i64,
}

impl Default for EdgeReconnectConfig {
    fn default() -> Self {
        Self {
            min_ms: 500,
            max_ms: 30_000,
        }
    }
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            decoder_path: String::new(),
            retention_days: 0,
            purge_interval_minutes: default_purge_interval_minutes(),
            max_messages: 0,
            user_retention_days: default_user_retention_days(),
            user_purge_interval_minutes: default_user_purge_interval_minutes(),
            user_map_recent_minutes: default_user_map_recent_minutes(),
        }
    }
}

/// One background decoder task.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    /// Dongle whose raw IQ stream feeds this decoder. Empty matches no dongle.
    #[serde(default)]
    pub dongle_id: String,
    /// Decoder family: `ft8`, `ft4`, `ft2` or `adsb`.
    ///
    /// FT8/FT4/FT2 are slotted audio modes (12 kHz channel). ADS-B is a raw-IQ
    /// mode: it needs a window at 1090 MHz that is at least 2 MSPS wide.
    #[serde(default)]
    pub mode: String,
    /// Absolute RF frequency to decode.
    #[serde(default)]
    pub frequency_hz: i64,
    /// Requested audio passband, informational for the FT8/FT4 channelizer.
    #[serde(default)]
    pub bandwidth_hz: i32,
    /// Per-decoder history retention in days. 0 inherits
    /// `database.retentionDays`. The API hides older rows immediately; the
    /// maintenance loop deletes them at the next purge.
    #[serde(default)]
    pub retention_days: i64,
    /// Decoder-specific options reserved for later modes.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub settings: serde_json::Map<String, serde_json::Value>,
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
    /// Receiver latitude for map-based features (0,0 = unset). This is
    /// deliberately separate from `location`, which is the public display text.
    #[serde(default)]
    pub receiver_latitude: f64,
    /// Receiver longitude for map-based features (0,0 = unset).
    #[serde(default)]
    pub receiver_longitude: f64,
    #[serde(default)]
    pub demo_mode: bool,
    /// Allow clients to run the client-side signal identifier. Disabled hides
    /// the Identify controls and closes any open identifier panel.
    #[serde(default = "default_true")]
    pub identify_enabled: bool,
    /// Users ribbon visibility: `off`, `users` (frequency only) or `ip`
    /// (frequency and resolved client IP).
    #[serde(default = "default_users_ribbon")]
    pub users_ribbon: String,
    /// Bookmark region/country folders served to clients. `None` means every
    /// folder in the bookmarks directory; `Some([])` serves only the shared
    /// root-level files; `Some(["r1", "se"])` serves those folders plus the
    /// root-level files when `"global"` is also selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookmark_regions: Option<Vec<String>>,
    /// Default band plan region served by `GET /api/bandplan`: empty (world),
    /// `r1`, `r2` or `r3`.
    #[serde(default)]
    pub bandplan_region: String,
    /// Tracing/log level: trace, debug, info, warn, error (or off).
    /// `LOG_LEVEL` in the environment overrides this.
    #[serde(default)]
    pub log_level: String,
    #[serde(default)]
    pub fft_history_fft_size: i32,
    #[serde(default)]
    pub fft_history_compression: String,
    /// `deflate-smooth` clamp margin for the FFT history burst, independent of
    /// the live waterfall codec's margin.
    #[serde(default = "default_fft_smooth_margin_db")]
    pub fft_history_smooth_margin_db: f32,
    /// Deflate level for FFT frames (1-9). Benchmarks: levels 2-8 are within
    /// 0.5 % of each other; level 2 is the fastest.
    #[serde(default = "default_fft_deflate_level")]
    pub fft_deflate_level: i32,
    /// `deflate-smooth` clamp margin above the frame median, in dB.
    #[serde(default = "default_fft_smooth_margin_db")]
    pub fft_smooth_margin_db: f32,
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
    /// OpenWeatherMap API key for the map weather/cloud overlay. Admin-only:
    /// intentionally not part of the public server metadata.
    #[serde(default)]
    pub open_weather_map_api_key: String,
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
            receiver_latitude: 0.0,
            receiver_longitude: 0.0,
            demo_mode: false,
            identify_enabled: true,
            users_ribbon: default_users_ribbon(),
            bookmark_regions: None,
            bandplan_region: String::new(),
            log_level: String::new(),
            fft_history_fft_size: 0,
            fft_history_compression: String::new(),
            fft_history_smooth_margin_db: default_fft_smooth_margin_db(),
            fft_deflate_level: default_fft_deflate_level(),
            fft_smooth_margin_db: default_fft_smooth_margin_db(),
            allowed_fft_codecs: Vec::new(),
            allowed_iq_codecs: Vec::new(),
            opus_complexity: 0,
            real_ip_header: String::new(),
            audd_api_key: String::new(),
            acrcloud_host: String::new(),
            acrcloud_access_key: String::new(),
            acrcloud_access_secret: String::new(),
            open_weather_map_api_key: String::new(),
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
    /// Per-source hardware settings. Keys are defined by the source driver
    /// (for example `lnaDb`, `vgaDb`, `amp`, `filterBwHz` for HackRF).
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub settings: serde_json::Map<String, serde_json::Value>,
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
    // Retired live codecs must not be exposed by an old config.
    cfg.server
        .allowed_fft_codecs
        .retain(|c| DEFAULT_FFT_CODECS.contains(&c.as_str()));
    if cfg.server.allowed_fft_codecs.is_empty() {
        cfg.server.allowed_fft_codecs = DEFAULT_FFT_CODECS.iter().map(|s| s.to_string()).collect();
    }
    // Only the embedded band plan regions are valid; anything else falls back
    // to the worldwide plan.
    let bandplan_region = cfg.server.bandplan_region.trim().to_ascii_lowercase();
    cfg.server.bandplan_region = match bandplan_region.as_str() {
        "r1" | "r2" | "r3" => bandplan_region,
        _ => String::new(),
    };
    // Retired history codecs migrate to the current default.
    let history_compression = cfg.server.fft_history_compression.trim().to_string();
    cfg.server.fft_history_compression = match history_compression.as_str() {
        "none" | "adpcm" | "deflate-smooth" | "range" => history_compression,
        _ => "deflate-smooth".to_string(),
    };
    if cfg.server.allowed_iq_codecs.is_empty() {
        cfg.server.allowed_iq_codecs = DEFAULT_IQ_CODECS.iter().map(|s| s.to_string()).collect();
    }
    cfg.server.fft_deflate_level = if (1..=9).contains(&cfg.server.fft_deflate_level) {
        cfg.server.fft_deflate_level
    } else {
        default_fft_deflate_level()
    };
    if !(0.0..=20.0).contains(&cfg.server.fft_smooth_margin_db) {
        cfg.server.fft_smooth_margin_db = default_fft_smooth_margin_db();
    }
    if !(0.0..=20.0).contains(&cfg.server.fft_history_smooth_margin_db) {
        cfg.server.fft_history_smooth_margin_db = default_fft_smooth_margin_db();
    }
    if cfg.server.opus_complexity < 0 {
        cfg.server.opus_complexity = 5;
    }
    cfg.server.log_level = cfg.server.log_level.trim().to_ascii_lowercase();
    if cfg.server.log_level.is_empty() {
        cfg.server.log_level = "info".to_string();
    }
    cfg.server.users_ribbon = cfg.server.users_ribbon.trim().to_ascii_lowercase();
    if cfg.server.users_ribbon.is_empty() {
        cfg.server.users_ribbon = default_users_ribbon();
    }

    // Cloudflare DO fan-out defaults.
    if cfg.edge.codec.trim().is_empty() {
        cfg.edge.codec = "range".to_string();
    }
    if cfg.edge.max_viewers <= 0 {
        cfg.edge.max_viewers = 200;
    }
    if cfg.edge.client_default_transport.trim().is_empty() {
        cfg.edge.client_default_transport = "auto".to_string();
    }
    if cfg.edge.history.mode.trim().is_empty() {
        cfg.edge.history.mode = "do-ring".to_string();
    }
    if cfg.edge.history.bins <= 0 {
        cfg.edge.history.bins = 2048;
    }
    if cfg.edge.history.frames <= 0 {
        cfg.edge.history.frames = 512;
    }
    if cfg.edge.fallback.connect_timeout_ms <= 0 {
        cfg.edge.fallback.connect_timeout_ms = 2500;
    }
    if cfg.edge.fallback.first_frame_timeout_ms <= 0 {
        cfg.edge.fallback.first_frame_timeout_ms = 3000;
    }
    if cfg.edge.fallback.stale_timeout_ms <= 0 {
        cfg.edge.fallback.stale_timeout_ms = 5000;
    }
    if cfg.edge.fallback.retry_ms <= 0 {
        cfg.edge.fallback.retry_ms = 30_000;
    }
    if cfg.edge.reconnect.min_ms <= 0 {
        cfg.edge.reconnect.min_ms = 500;
    }
    if cfg.edge.reconnect.max_ms <= 0 {
        cfg.edge.reconnect.max_ms = 30_000;
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
    // Mode ids are protocol names, not user labels. Normalising them keeps
    // SQLite history queries, the admin picker and live decoderType values in
    // agreement even when a hand-written config uses `FT8` or `FST4-60A`.
    for decoder in &mut cfg.decoders {
        decoder.mode = decoder.mode.trim().to_ascii_lowercase();
    }
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
    if !["off", "users", "ip"].contains(&cfg.server.users_ribbon.as_str()) {
        bail!(
            "config: server.usersRibbon must be one of [\"off\", \"users\", \"ip\"], got {:?}",
            cfg.server.users_ribbon
        );
    }
    if cfg.geoip.enabled && cfg.geoip.database_path.trim().is_empty() {
        bail!("config: geoip.databasePath cannot be empty when geoip.enabled is true");
    }
    if cfg.geoip.auto_update && cfg.geoip.update_interval_hours == 0 {
        bail!("config: geoip.updateIntervalHours must be at least 1");
    }
    if cfg.database.user_retention_days < 0 {
        bail!("config: database.userRetentionDays cannot be negative");
    }
    if cfg.database.user_purge_interval_minutes < 0 {
        bail!("config: database.userPurgeIntervalMinutes cannot be negative");
    }
    if cfg.database.user_map_recent_minutes < 0 {
        bail!("config: database.userMapRecentMinutes cannot be negative");
    }
    if !cfg.server.receiver_latitude.is_finite()
        || !(-90.0..=90.0).contains(&cfg.server.receiver_latitude)
    {
        bail!(
            "config: server.receiverLatitude must be finite and between -90 and 90, got {}",
            cfg.server.receiver_latitude
        );
    }
    if !cfg.server.receiver_longitude.is_finite()
        || !(-180.0..=180.0).contains(&cfg.server.receiver_longitude)
    {
        bail!(
            "config: server.receiverLongitude must be finite and between -180 and 180, got {}",
            cfg.server.receiver_longitude
        );
    }
    if cfg.database.retention_days < 0 {
        bail!("config: database.retentionDays must be >= 0");
    }
    if cfg.database.purge_interval_minutes < 0 {
        bail!("config: database.purgeIntervalMinutes must be >= 0");
    }
    if cfg.database.max_messages < 0 {
        bail!("config: database.maxMessages must be >= 0");
    }

    if cfg.edge.enabled {
        let url = cfg.edge.url.trim();
        let local_ws = url.starts_with("ws://")
            && (url.contains("127.0.0.1") || url.contains("localhost"));
        if !url.starts_with("wss://") && !local_ws {
            bail!("config: edge.url must use wss:// (ws:// is allowed only for localhost)");
        }
        if !valid_edge_name(&cfg.edge.instance_id) {
            bail!(
                "config: edge.instanceId must match [A-Za-z0-9_-]{{1,64}}, got {:?}",
                cfg.edge.instance_id
            );
        }
        if cfg.edge.ingest_token.trim().is_empty() {
            bail!("config: edge.ingestToken is required when edge is enabled");
        }
        if !["range", "deflate-smooth"].contains(&cfg.edge.codec.as_str()) {
            bail!(
                "config: edge.codec must be \"range\" or \"deflate-smooth\" (got {:?})",
                cfg.edge.codec
            );
        }
        if !(1..=1000).contains(&cfg.edge.max_viewers) {
            bail!(
                "config: edge.maxViewers must be between 1 and 1000, got {}",
                cfg.edge.max_viewers
            );
        }
        if !["auto", "origin", "edge"].contains(&cfg.edge.client_default_transport.as_str()) {
            bail!(
                "config: edge.clientDefaultTransport must be auto|origin|edge, got {:?}",
                cfg.edge.client_default_transport
            );
        }
        if !["do-ring", "off"].contains(&cfg.edge.history.mode.as_str()) {
            bail!(
                "config: edge.history.mode must be do-ring|off (origin-snapshot is not implemented in v1), got {:?}",
                cfg.edge.history.mode
            );
        }
        if !is_power_of_two(cfg.edge.history.bins)
            || !(256..=8192).contains(&cfg.edge.history.bins)
        {
            bail!(
                "config: edge.history.bins must be a power of two in [256, 8192], got {}",
                cfg.edge.history.bins
            );
        }
        if !(32..=2048).contains(&cfg.edge.history.frames) {
            bail!(
                "config: edge.history.frames must be in [32, 2048], got {}",
                cfg.edge.history.frames
            );
        }
        if cfg.edge.reconnect.max_ms < cfg.edge.reconnect.min_ms {
            bail!("config: edge.reconnect.maxMs must be >= minMs");
        }
    }

    for (i, d) in cfg.decoders.iter().enumerate() {
        if d.id.trim().is_empty() {
            bail!("config: decoders[{i}]: id is required");
        }
        if d.mode.trim().is_empty() {
            bail!("config: decoders[{i}] ({}): mode is required", d.id);
        }
        if d.frequency_hz <= 0 {
            bail!(
                "config: decoders[{i}] ({}): frequencyHz must be > 0, got {}",
                d.id,
                d.frequency_hz
            );
        }
        if d.retention_days < 0 {
            bail!(
                "config: decoders[{i}] ({}): retentionDays must be >= 0",
                d.id
            );
        }
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

fn valid_edge_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn default_true() -> bool {
    true
}

fn default_users_ribbon() -> String {
    "users".to_string()
}

fn default_fft_deflate_level() -> i32 {
    2
}

fn default_fft_smooth_margin_db() -> f32 {
    2.0
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

fn for_each_profile_value<F: FnMut(&mut serde_yaml::Mapping)>(
    value: &mut serde_yaml::Value,
    mut f: F,
) {
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
        assert!(cfg.server.identify_enabled);
        assert_eq!(cfg.server.users_ribbon, "users");
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
    fn bookmark_regions_and_bandplan_region_parse() {
        let cfg = parse(
            "server:\n  bookmarkRegions: [r1, se, global]\n  bandplanRegion: R2\n",
        );
        assert_eq!(
            cfg.server.bookmark_regions,
            Some(vec!["r1".to_string(), "se".to_string(), "global".to_string()])
        );
        assert_eq!(cfg.server.bandplan_region, "r2");

        // Unknown band plan regions fall back to worldwide.
        let cfg = parse("server:\n  bandplanRegion: r9\n");
        assert_eq!(cfg.server.bandplan_region, "");
        assert_eq!(cfg.server.bookmark_regions, None);
    }

    #[test]
    fn geoip_defaults_and_parse() {
        let cfg = parse("");
        assert!(cfg.geoip.enabled);
        assert_eq!(cfg.geoip.database_path, "../data/dbip-city-lite.mmdb");
        assert!(cfg.geoip.auto_update);
        assert_eq!(cfg.geoip.update_interval_hours, 24);

        let cfg = parse(
            "geoip:\n  enabled: false\n  databasePath: /tmp/test.mmdb\n  autoUpdate: false\n  updateIntervalHours: 6\n",
        );
        assert!(!cfg.geoip.enabled);
        assert_eq!(cfg.geoip.database_path, "/tmp/test.mmdb");
        assert!(!cfg.geoip.auto_update);
        assert_eq!(cfg.geoip.update_interval_hours, 6);
        assert_eq!(cfg.database.user_retention_days, 90);
        assert_eq!(cfg.database.user_purge_interval_minutes, 360);
        assert_eq!(cfg.database.user_map_recent_minutes, 60);
    }

    #[test]
    fn accepts_2096k_rtl_sample_rate() {
        let cfg = parse(
            "dongles:\n  - id: d1\n    sampleRate: 2096000\n    profiles:\n      - id: p1\n        sampleRate: 2096000\n        defaultBandwidth: 200000\n        defaultMode: wfm\n",
        );
        assert_eq!(cfg.dongles[0].sample_rate, 2_096_000);
        assert_eq!(cfg.dongles[0].profiles[0].sample_rate, 2_096_000);
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
    fn hackrf_source_settings_round_trip() {
        let cfg = parse(
            "dongles:\n  - id: d1\n    sampleRate: 2000000\n    source:\n      type: hackrf\n      serial: abc123\n      settings:\n        lnaDb: 24\n        vgaDb: 30\n        amp: true\n    profiles:\n      - id: p1\n        sampleRate: 2000000\n        defaultMode: nfm\n",
        );
        let d = &cfg.dongles[0];
        assert_eq!(d.source.kind, "hackrf");
        assert_eq!(d.source.serial, "abc123");
        assert_eq!(
            d.source.settings.get("lnaDb").and_then(|v| v.as_f64()),
            Some(24.0)
        );
        assert_eq!(
            d.source.settings.get("vgaDb").and_then(|v| v.as_f64()),
            Some(30.0)
        );
        assert_eq!(
            d.source.settings.get("amp").and_then(|v| v.as_bool()),
            Some(true)
        );

        let y = to_yaml_string(&cfg).unwrap();
        assert!(y.contains("lnaDb: 24"), "{y}");
        assert!(y.contains("vgaDb: 30"), "{y}");
        let reparsed = parse(&y);
        assert_eq!(
            reparsed.dongles[0]
                .source
                .settings
                .get("lnaDb")
                .and_then(|v| v.as_f64()),
            Some(24.0)
        );
    }

    #[test]
    fn background_decoders_round_trip() {
        let cfg = parse(
            "dongles:\n  - id: d1\n    sampleRate: 2400000\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultMode: usb\ndecoders:\n  - id: ft8-20m\n    enabled: true\n    dongleId: d1\n    mode: ft8\n    frequencyHz: 14074000\n    bandwidthHz: 3000\n",
        );
        assert_eq!(cfg.decoders.len(), 1);
        let d = &cfg.decoders[0];
        assert_eq!(d.id, "ft8-20m");
        assert!(d.enabled);
        assert_eq!(d.dongle_id, "d1");
        assert_eq!(d.mode, "ft8");
        assert_eq!(d.frequency_hz, 14_074_000);
        assert_eq!(d.bandwidth_hz, 3000);
    }

    #[test]
    fn decoder_database_settings_round_trip() {
        let cfg = parse(
            "dongles:\n  - id: d1\n    sampleRate: 2400000\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultMode: usb\ndecoders:\n  - id: ft8-20m\n    enabled: true\n    dongleId: d1\n    mode: ft8\n    frequencyHz: 14074000\n    bandwidthHz: 3000\n    retentionDays: 3\ndatabase:\n  retentionDays: 7\n  purgeIntervalMinutes: 15\n  maxMessages: 1000\n",
        );
        assert_eq!(cfg.database.retention_days, 7);
        assert_eq!(cfg.database.purge_interval_minutes, 15);
        assert_eq!(cfg.database.max_messages, 1000);
        assert_eq!(cfg.decoders[0].retention_days, 3);

        let yaml = to_yaml_string(&cfg).unwrap();
        assert!(yaml.contains("purgeIntervalMinutes: 15"), "{yaml}");
        assert!(yaml.contains("maxMessages: 1000"), "{yaml}");

        // Missing fields fall back to hourly purges and unlimited storage.
        let defaults = parse(
            "dongles:\n  - id: d1\n    sampleRate: 2400000\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultMode: usb\n",
        );
        assert_eq!(defaults.database.retention_days, 0);
        assert_eq!(defaults.database.purge_interval_minutes, 30);
        assert_eq!(defaults.database.max_messages, 0);
    }

    #[test]
    fn receiver_location_round_trip_and_validation() {
        let cfg = parse(
            "server:\n  receiverLatitude: 37.975565\n  receiverLongitude: 23.734832\ndongles:\n  - id: d1\n    sampleRate: 2400000\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultMode: usb\n",
        );
        assert_eq!(cfg.server.receiver_latitude, 37.975565);
        assert_eq!(cfg.server.receiver_longitude, 23.734832);
        // The display-only location text is a separate field.
        assert_eq!(cfg.server.location, "");

        let yaml = to_yaml_string(&cfg).unwrap();
        assert!(yaml.contains("receiverLatitude: 37.975565"), "{yaml}");
        assert!(yaml.contains("receiverLongitude: 23.734832"), "{yaml}");

        let value: serde_yaml::Value = serde_yaml::from_str(
            "server:\n  receiverLatitude: 100\ndongles:\n  - id: d1\n    profiles:\n      - id: p1\n        sampleRate: 2400000\n        defaultMode: usb\n",
        )
        .unwrap();
        let mut bad: Config = serde_yaml::from_value(yaml_keys_to_json(value)).unwrap();
        apply_defaults(&mut bad);
        apply_profile_defaults(&mut bad);
        assert!(validate(&bad).is_err());
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

    #[test]
    fn edge_config_defaults_and_round_trip() {
        let cfg = parse(
            "edge:\n  enabled: true\n  url: wss://fft.example.com\n  instanceId: home-berlin\n  ingestToken: secret\n",
        );
        assert!(cfg.edge.enabled);
        assert_eq!(cfg.edge.codec, "range");
        assert_eq!(cfg.edge.max_viewers, 200);
        assert_eq!(cfg.edge.history.mode, "do-ring");
        assert_eq!(cfg.edge.history.bins, 2048);
        assert_eq!(cfg.edge.history.frames, 512);
        assert_eq!(cfg.edge.client_default_transport, "auto");

        let yaml = to_yaml_string(&cfg).unwrap();
        assert!(yaml.contains("instanceId: home-berlin"));
        assert!(yaml.contains("ingestToken: secret"));
    }

    #[test]
    fn edge_rejects_insecure_url_when_enabled() {
        let value: serde_yaml::Value = serde_yaml::from_str(
            "edge:\n  enabled: true\n  url: ws://example.com\n  instanceId: x\n  ingestToken: t\n",
        )
        .unwrap();
        let mut cfg: Config = serde_yaml::from_value(yaml_keys_to_json(value)).unwrap();
        apply_defaults(&mut cfg);
        assert!(validate(&cfg).is_err());
    }

    #[test]
    fn edge_accepts_range_codec() {
        let cfg = parse(
            "edge:\n  enabled: true\n  url: wss://example.com\n  instanceId: x\n  ingestToken: t\n  codec: range\n",
        );
        assert_eq!(cfg.edge.codec, "range");
    }

    #[test]
    fn edge_rejects_unsupported_codec() {
        let value: serde_yaml::Value = serde_yaml::from_str(
            "edge:\n  enabled: true\n  url: wss://example.com\n  instanceId: x\n  ingestToken: t\n  codec: adpcm\n",
        )
        .unwrap();
        let mut cfg: Config = serde_yaml::from_value(yaml_keys_to_json(value)).unwrap();
        apply_defaults(&mut cfg);
        assert!(validate(&cfg).is_err());
    }
}
