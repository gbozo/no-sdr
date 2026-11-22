//! Decoder calling-frequency catalogue.
//!
//! The catalogue is server-owned and read-only: admins and clients cannot edit
//! individual frequencies. It starts from an embedded snapshot, can refresh
//! periodically from a repo-hosted JSON file (with a config override), and
//! keeps the last good copy if an update fails.

use std::sync::Arc;
use std::time::Duration;

use axum::response::Json;
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{error, info};

use crate::config::Config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogFrequency {
    pub label: String,
    pub hz: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMode {
    pub mode: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub bandwidth: i32,
    #[serde(default)]
    pub frequencies: Vec<CatalogFrequency>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderCatalog {
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub modes: Vec<CatalogMode>,
}

pub struct DecoderCatalogService {
    cfg: Arc<RwLock<Config>>,
    catalog: RwLock<DecoderCatalog>,
    last_fetch: RwLock<DateTime<Utc>>,
    last_error: RwLock<String>,
    client: reqwest::Client,
}

impl DecoderCatalogService {
    pub fn new(cfg: Arc<RwLock<Config>>) -> Arc<Self> {
        let catalog = parse_catalog(
            include_str!("../../decoder-catalog.json").as_bytes(),
        )
        .unwrap_or_else(|e| panic!("decoder catalogue: embedded JSON is invalid: {e}"));
        Arc::new(Self {
            cfg,
            catalog: RwLock::new(catalog),
            last_fetch: RwLock::new(DateTime::<Utc>::MIN_UTC),
            last_error: RwLock::new(String::new()),
            client: reqwest::Client::new(),
        })
    }

    /// Initial refresh after startup, then once per configured interval.
    pub fn start_scheduler(self: &Arc<Self>) {
        let svc = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            svc.refresh_if_configured().await;
            loop {
                let hours = svc
                    .cfg
                    .read()
                    .server
                    .decoder_catalog_refresh_hours
                    .max(1) as u64;
                tokio::time::sleep(Duration::from_secs(hours * 3600)).await;
                svc.refresh_if_configured().await;
            }
        });
    }

    async fn refresh_if_configured(&self) {
        let url = self.cfg.read().server.decoder_catalog_url.trim().to_string();
        if url.is_empty() {
            return;
        }
        if let Err(e) = self.refresh().await {
            error!(url, error = %e, "decoder catalogue refresh failed - keeping current data");
        }
    }

    /// Fetches the configured catalogue URL and replaces the in-memory copy.
    pub async fn refresh(&self) -> Result<(), String> {
        let result = self.refresh_inner().await;
        match &result {
            Ok(()) => *self.last_error.write() = String::new(),
            Err(e) => *self.last_error.write() = e.clone(),
        }
        result
    }

    async fn refresh_inner(&self) -> Result<(), String> {
        let url = self.cfg.read().server.decoder_catalog_url.trim().to_string();
        if url.is_empty() {
            return Err("decoder catalogue URL is empty".to_string());
        }
        info!(url, "decoder catalogue: refreshing");
        let response = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("fetch failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("fetch failed: HTTP {}", response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("read failed: {e}"))?;
        if bytes.len() > 2 << 20 {
            return Err("response too large".to_string());
        }
        let catalog =
            parse_catalog(&bytes).map_err(|e| format!("invalid catalogue: {e}"))?;
        let entries: usize = catalog.modes.iter().map(|m| m.frequencies.len()).sum();
        let mode_count = catalog.modes.len();
        *self.catalog.write() = catalog;
        *self.last_fetch.write() = Utc::now();
        info!(
            modes = mode_count,
            entries,
            "decoder catalogue: refresh complete"
        );
        Ok(())
    }

    /// Converts the catalogue into read-only public bookmark entries.
    pub fn bookmarks(&self) -> Vec<super::bookmarks::PublicBookmark> {
        let catalog = self.catalog.read();
        catalog
            .modes
            .iter()
            .flat_map(|mode| {
                let mode_id = mode.mode.trim().to_ascii_lowercase();
                let name = if mode.name.is_empty() {
                    mode_id.to_ascii_uppercase()
                } else {
                    mode.name.clone()
                };
                let bandwidth = if mode.bandwidth > 0 { mode.bandwidth } else { 3_000 };
                mode.frequencies.iter().map(move |frequency| {
                    super::bookmarks::PublicBookmark {
                        id: format!("decoder-{mode_id}-{}", frequency.hz),
                        name: format!("{name} {}", frequency.label),
                        frequency: frequency.hz,
                        mode: mode_id.clone(),
                        bandwidth,
                        description: mode.description.clone(),
                        source: "decoder".to_string(),
                        implemented: super::bookmarks::implemented_mode(&mode_id),
                    }
                })
            })
            .collect()
    }

    pub fn status(&self) -> Value {
        let catalog = self.catalog.read();
        let source_url = self.cfg.read().server.decoder_catalog_url.clone();
        let last = *self.last_fetch.read();
        let updated = (last > DateTime::<Utc>::MIN_UTC).then_some(last);
        json!({
            "revision": catalog.revision.clone(),
            "modeCount": catalog.modes.len(),
            "frequencyCount": catalog.modes.iter().map(|m| m.frequencies.len()).sum::<usize>(),
            "lastUpdated": updated,
            "lastError": self.last_error.read().clone(),
            "sourceUrl": source_url,
            "modes": catalog.modes.clone(),
        })
    }

    /// Public catalogue used by the client for hints and quick-tune links.
    pub fn public_json(&self) -> Value {
        let catalog = self.catalog.read();
        let last = *self.last_fetch.read();
        let updated = (last > DateTime::<Utc>::MIN_UTC).then_some(last);
        json!({
            "revision": catalog.revision.clone(),
            "updated": updated,
            "modes": catalog.modes.clone(),
        })
    }
}

fn parse_catalog(bytes: &[u8]) -> Result<DecoderCatalog, String> {
    let catalog: DecoderCatalog =
        serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if catalog.modes.is_empty() {
        return Err("catalogue has no modes".to_string());
    }
    for mode in &catalog.modes {
        if mode.mode.trim().is_empty() {
            return Err("catalogue contains a mode without an id".to_string());
        }
    }
    Ok(catalog)
}

pub async fn catalog_json(
    axum::extract::State(state): axum::extract::State<super::AppState>,
) -> Json<Value> {
    Json(state.decoder_catalog.public_json())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_is_valid() {
        let catalog =
            parse_catalog(include_str!("../../decoder-catalog.json").as_bytes()).unwrap();
        assert!(!catalog.modes.is_empty());
        assert!(catalog.modes.iter().any(|m| m.mode == "ft8"));
        assert!(catalog
            .modes
            .iter()
            .filter(|m| m.mode == "ft8")
            .flat_map(|m| m.frequencies.iter())
            .any(|f| f.hz == 14_074_000));
    }
}
