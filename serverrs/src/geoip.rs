//! Offline IP geolocation: DB-IP City Lite MMDB + monthly updater.
//!
//! The database is the free DB-IP City Lite release, licensed CC BY 4.0.
//! Attribution is rendered by the client when results are shown.

use std::fs;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use arc_swap::ArcSwapOption;
use chrono::{Datelike, TimeZone, Utc};
use maxminddb::geoip2;
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::config::GeoIpConfig;
use crate::geo::GeoInfo;

const DBIP_BASE: &str = "https://download.db-ip.com/free";
const DBIP_SOURCE: &str = "DB-IP City Lite";
/// Minimum check cadence; a monthly database does not need minute polling.
const MIN_CHECK_HOURS: u64 = 1;

/// Public status for the admin page.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoIpStatus {
    pub enabled: bool,
    pub loaded: bool,
    pub database_path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub database_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_epoch: Option<u64>,
    /// Release month derived from `build_epoch`, e.g. `2026-11`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Shared MMDB reader and its update task.
pub struct GeoIpService {
    cfg: GeoIpConfig,
    path: PathBuf,
    reader: ArcSwapOption<maxminddb::Reader<memmap2::Mmap>>,
    status: RwLock<GeoIpStatus>,
    http: reqwest::Client,
    update_lock: tokio::sync::Mutex<()>,
}

impl GeoIpService {
    pub fn new(cfg: &GeoIpConfig, config_path: &Path) -> Arc<Self> {
        let path = resolve_database_path(&cfg.database_path, config_path);
        Arc::new(Self {
            cfg: cfg.clone(),
            path: path.clone(),
            reader: ArcSwapOption::empty(),
            status: RwLock::new(GeoIpStatus {
                enabled: cfg.enabled,
                database_path: path.to_string_lossy().to_string(),
                source: Some(DBIP_SOURCE.to_string()),
                ..GeoIpStatus::default()
            }),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            update_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// Loads an existing database and, when configured, starts the monthly
    /// updater. The updater downloads asynchronously so startup is not blocked.
    pub fn start(self: &Arc<Self>) {
        if !self.cfg.enabled {
            return;
        }
        if self.path.exists() {
            if let Err(error) = self.load_existing() {
                warn!(
                    path = %self.path.display(),
                    error = %error,
                    "geoip database could not be loaded"
                );
                self.status.write().last_error = Some(error.to_string());
            }
        } else {
            info!(
                path = %self.path.display(),
                "geoip database not present; it will be downloaded"
            );
        }

        if self.cfg.auto_update {
            let service = self.clone();
            tokio::spawn(async move { service.update_loop().await });
        }
    }

    /// Look up one parsed address.
    pub fn lookup(&self, ip: IpAddr) -> Option<GeoInfo> {
        let guard = self.reader.load();
        let reader = guard.as_ref()?;
        let result = reader.lookup(ip).ok()?;
        let city = result.decode::<geoip2::City>().ok().flatten()?;
        city_to_geo(city)
    }

    /// Look up an address in either bare (`1.2.3.4`), host:port, or bracketed
    /// IPv6 form. Returns `None` for private/unparseable addresses.
    pub fn lookup_str(&self, raw: &str) -> Option<GeoInfo> {
        parse_ip(raw).and_then(|ip| self.lookup(ip))
    }

    pub fn status(&self) -> GeoIpStatus {
        self.status.read().clone()
    }

    /// Force a download now (admin action). Returns the updated status.
    pub async fn force_update(self: &Arc<Self>) -> Result<GeoIpStatus> {
        if !self.cfg.enabled {
            bail!("geoip is disabled");
        }
        let _guard = self.update_lock.lock().await;
        self.download_latest(true).await?;
        Ok(self.status())
    }

    fn load_existing(&self) -> Result<()> {
        // SAFETY: the database lives in our own data directory and is only
        // replaced by the atomic rename in `download_month`; this process
        // never truncates the active file. An external truncate could still
        // invalidate the mapping, which is why the read API is unsafe.
        let reader = unsafe {
            maxminddb::Reader::open_mmap(&self.path)
                .with_context(|| format!("opening {}", self.path.display()))?
        };
        self.apply_reader(reader);
        Ok(())
    }

    fn apply_reader(&self, reader: maxminddb::Reader<memmap2::Mmap>) {
        let metadata = reader.metadata();
        let build_epoch = Some(metadata.build_epoch);
        let release =
            month_key(metadata.build_epoch).map(|(year, month)| format!("{year:04}-{month:02}"));
        let updated_at = fs::metadata(&self.path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);

        {
            let mut status = self.status.write();
            status.loaded = true;
            status.database_type = metadata.database_type.clone();
            status.build_epoch = build_epoch;
            status.release = release;
            status.updated_at = updated_at;
            status.last_error = None;
            status.source = Some(DBIP_SOURCE.to_string());
        }
        self.reader.store(Some(Arc::new(reader)));
    }

    async fn update_loop(self: Arc<Self>) {
        let hours = self.cfg.update_interval_hours.max(MIN_CHECK_HOURS);
        let mut ticker = tokio::time::interval(Duration::from_secs(hours * 3_600));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = self.update_if_stale().await {
                debug!(error = %error, "geoip update check failed");
                self.status.write().last_error = Some(error.to_string());
            }
        }
    }

    async fn update_if_stale(self: &Arc<Self>) -> Result<()> {
        if !self.cfg.auto_update || !self.cfg.enabled {
            return Ok(());
        }
        let current = month_now();
        let loaded = self
            .status
            .read()
            .build_epoch
            .and_then(month_key)
            .is_some_and(|release| release >= current);
        if loaded {
            return Ok(());
        }
        let _guard = self.update_lock.lock().await;
        // Re-check after waiting for a concurrent force-update.
        let loaded = self
            .status
            .read()
            .build_epoch
            .and_then(month_key)
            .is_some_and(|release| release >= current);
        if loaded {
            return Ok(());
        }
        self.download_latest(false).await
    }

    async fn download_latest(self: &Arc<Self>, force: bool) -> Result<()> {
        let (year, month) = month_now();
        match self.download_month(year, month, force).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                // DB-IP publishes on the first of the month; on the 1st the
                // current-month file can still be a 404. Keep the old DB.
                debug!(year, month, error = %error, "current-month geoip download failed");
                let (prev_year, prev_month) = previous_month(year, month);
                self.download_month(prev_year, prev_month, force)
                    .await
                    .with_context(|| {
                        format!(
                            "DB-IP {year:04}-{month:02} and {prev_year:04}-{prev_month:02} both failed"
                        )
                    })
            }
        }
    }

    async fn download_month(self: &Arc<Self>, year: i32, month: u32, force: bool) -> Result<()> {
        let release = format!("{year:04}-{month:02}");
        if !force {
            if let Some(current) = self.status.read().release.clone() {
                if current == release {
                    return Ok(());
                }
            }
        }

        let url = format!("{DBIP_BASE}/dbip-city-lite-{release}.mmdb.gz");
        info!(url = %url, "downloading geoip database");
        let response = self.http.get(&url).send().await?;
        if !response.status().is_success() {
            bail!("HTTP {} for {url}", response.status());
        }
        let bytes = response.bytes().await?;
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut decompressed = Vec::with_capacity(bytes.len() * 3);
        decoder
            .read_to_end(&mut decompressed)
            .context("decompressing DB-IP MMDB")?;
        drop(bytes);

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
        }
        let tmp = self.path.with_extension("mmdb.tmp");
        fs::write(&tmp, &decompressed).with_context(|| format!("writing {}", tmp.display()))?;
        drop(decompressed);

        // Validate before replacing the live file: a truncated gzip or an
        // HTML error page must never become the active database.
        // SAFETY: `tmp` is a file this function just wrote and still owns; it
        // is renamed into place only after the reader opens successfully.
        let reader = unsafe {
            maxminddb::Reader::open_mmap(&tmp)
                .with_context(|| format!("validating {}", tmp.display()))?
        };
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("installing {}", self.path.display()))?;

        self.apply_reader(reader);
        info!(release = %release, "geoip database updated");
        Ok(())
    }
}

fn city_to_geo(city: geoip2::City<'_>) -> Option<GeoInfo> {
    let (region, region_code) = city
        .subdivisions
        .first()
        .map(|subdivision| {
            (
                subdivision.names.english.unwrap_or_default().to_string(),
                subdivision.iso_code.unwrap_or_default().to_string(),
            )
        })
        .unwrap_or_default();
    let info = GeoInfo {
        country_code: city.country.iso_code.unwrap_or_default().to_string(),
        country: city.country.names.english.unwrap_or_default().to_string(),
        region,
        region_code,
        city: city.city.names.english.unwrap_or_default().to_string(),
        latitude: city.location.latitude,
        longitude: city.location.longitude,
        continent: city.continent.names.english.unwrap_or_default().to_string(),
        continent_code: city.continent.code.unwrap_or_default().to_string(),
    };
    (!info.is_empty()).then_some(info)
}

fn resolve_database_path(configured: &str, config_path: &Path) -> PathBuf {
    let path = PathBuf::from(configured);
    if path.is_absolute() {
        return path;
    }
    normalize_path(
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(path),
    )
}

fn normalize_path(path: PathBuf) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn parse_ip(raw: &str) -> Option<IpAddr> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(ip) = raw.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Ok(addr) = raw.parse::<SocketAddr>() {
        return Some(addr.ip());
    }
    let bare = raw.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<IpAddr>().ok()
}

fn month_now() -> (i32, u32) {
    let now = Utc::now();
    (now.year(), now.month())
}

fn previous_month(year: i32, month: u32) -> (i32, u32) {
    if month <= 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    }
}

fn month_key(epoch: u64) -> Option<(i32, u32)> {
    let seconds = i64::try_from(epoch).ok()?;
    let time = Utc.timestamp_opt(seconds, 0).single()?;
    Some((time.year(), time.month()))
}

/// JSON status for the admin API.
pub fn status_json(status: &GeoIpStatus) -> Value {
    json!(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_client_addresses() {
        assert_eq!(parse_ip("1.2.3.4"), Some("1.2.3.4".parse().unwrap()));
        assert_eq!(parse_ip("1.2.3.4:5678"), Some("1.2.3.4".parse().unwrap()));
        assert_eq!(
            parse_ip("[2001:db8::1]:443"),
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(
            parse_ip("2001:db8::1"),
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(parse_ip(""), None);
        assert_eq!(parse_ip("not-an-ip"), None);
    }

    #[test]
    fn month_rollover_and_keys() {
        assert_eq!(previous_month(2026, 1), (2025, 12));
        assert_eq!(previous_month(2026, 11), (2026, 10));
        let epoch = Utc
            .with_ymd_and_hms(2026, 11, 15, 0, 0, 0)
            .unwrap()
            .timestamp() as u64;
        assert_eq!(month_key(epoch), Some((2026, 11)));
    }

    #[test]
    fn relative_path_resolves_against_config_dir() {
        let path = resolve_database_path(
            "../data/dbip-city-lite.mmdb",
            Path::new("/srv/no-sdr/config/config.yaml"),
        );
        assert_eq!(path, PathBuf::from("/srv/no-sdr/data/dbip-city-lite.mmdb"));
    }

    #[test]
    #[ignore = "requires a downloaded DB-IP City Lite MMDB; set GEOIP_TEST_DB"]
    fn decodes_a_public_ip_from_the_downloaded_mmdb() {
        let path = std::env::var("GEOIP_TEST_DB").expect("GEOIP_TEST_DB");
        // SAFETY: the test owns the file and never truncates it while the
        // mapping is alive.
        let reader = unsafe { maxminddb::Reader::open_mmap(path) }.unwrap();
        let ip: IpAddr = "8.8.8.8".parse().unwrap();
        let city = reader
            .lookup(ip)
            .unwrap()
            .decode::<maxminddb::geoip2::City>()
            .unwrap()
            .expect("8.8.8.8 record");
        assert_eq!(city.country.iso_code, Some("US"));
        assert!(city.city.names.english.is_some());
        assert!(city.subdivisions.first().is_some());
        assert!(city.location.latitude.is_some());

        let geo = city_to_geo(city).expect("mapped GeoInfo");
        assert_eq!(geo.country_code, "US");
        assert!(!geo.city.is_empty());
        assert!(!geo.region.is_empty());
        assert!(geo.latitude.is_some());
    }
}
