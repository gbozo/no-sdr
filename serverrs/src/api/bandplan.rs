//! Band plan service: embedded fallback data plus weekly upstream refresh.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::Query;
use axum::response::Json;
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{error, info};

const BANDS_URL: &str =
    "https://raw.githubusercontent.com/luarvique/openwebrx/refs/heads/master/bands.json";
const BANDS_R1_URL: &str =
    "https://raw.githubusercontent.com/luarvique/openwebrx/refs/heads/master/bands-r1.json";
const BANDS_R2_URL: &str =
    "https://raw.githubusercontent.com/luarvique/openwebrx/refs/heads/master/bands-r2.json";
const BANDS_R3_URL: &str =
    "https://raw.githubusercontent.com/luarvique/openwebrx/refs/heads/master/bands-r3.json";

/// A single frequency band allocation entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandEntry {
    pub name: String,
    pub lower_bound: i64,
    pub upper_bound: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequencies: Option<HashMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

pub struct BandPlanService {
    plans: RwLock<HashMap<String, Vec<BandEntry>>>,
    last_fetch: RwLock<DateTime<Utc>>,
    client: reqwest::Client,
}

impl BandPlanService {
    /// Creates a service pre-loaded with the embedded fallback data.
    pub fn new() -> Arc<Self> {
        let mut plans = HashMap::new();
        plans.insert(
            String::new(),
            parse_embedded(include_str!("../../bands/bands.json")),
        );
        plans.insert("r1".to_string(), parse_embedded(include_str!("../../bands/bands-r1.json")));
        plans.insert("r2".to_string(), parse_embedded(include_str!("../../bands/bands-r2.json")));
        plans.insert("r3".to_string(), parse_embedded(include_str!("../../bands/bands-r3.json")));

        Arc::new(Self {
            plans: RwLock::new(plans),
            last_fetch: RwLock::new(DateTime::<Utc>::MIN_UTC),
            client: reqwest::Client::new(),
        })
    }

    /// Weekly background refresh (first fetch after 30 s).
    pub fn start_scheduler(self: &Arc<Self>) {
        let svc = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            svc.refresh().await;
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(7 * 24 * 3600));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                svc.refresh().await;
            }
        });
    }

    async fn refresh(&self) {
        info!("bandplan: starting weekly refresh from upstream");
        let fetches = [
            ("", BANDS_URL),
            ("r1", BANDS_R1_URL),
            ("r2", BANDS_R2_URL),
            ("r3", BANDS_R3_URL),
        ];

        let mut new_plans = HashMap::new();
        for (key, url) in fetches {
            match self.fetch(url).await {
                Ok(entries) => {
                    new_plans.insert(key.to_string(), entries);
                }
                Err(e) => {
                    error!(key, url, error = %e, "bandplan: fetch failed - keeping existing data");
                    return;
                }
            }
        }

        let total: usize = new_plans.values().map(|v| v.len()).sum();
        *self.plans.write() = new_plans;
        *self.last_fetch.write() = Utc::now();
        info!(entries = total, "bandplan: refresh complete");
    }

    async fn fetch(&self, url: &str) -> anyhow::Result<Vec<BandEntry>> {
        let resp = self.client.get(url).timeout(std::time::Duration::from_secs(15)).send().await?;
        let bytes = resp.bytes().await?;
        if bytes.len() > 1 << 20 {
            anyhow::bail!("bandplan response too large");
        }
        parse_bands(&bytes)
    }

    /// `GET /api/bandplan?region=r1|r2|r3`
    pub fn handler(
        self: Arc<Self>,
        Query(q): Query<BandPlanQuery>,
    ) -> Json<Value> {
        let region = q.region.unwrap_or_default();
        let plans = self.plans.read();
        let entries = plans
            .get(&region)
            .or_else(|| plans.get(""))
            .cloned()
            .unwrap_or_default();
        let updated = *self.last_fetch.read();
        Json(json!({
            "region": region,
            "bands": entries,
            "updated": updated,
        }))
    }
}

#[derive(Debug, Deserialize)]
pub struct BandPlanQuery {
    #[serde(default)]
    pub region: Option<String>,
}

fn parse_embedded(data: &str) -> Vec<BandEntry> {
    parse_bands(data.as_bytes())
        .unwrap_or_else(|e| panic!("bandplan: failed to parse embedded JSON: {e}"))
}

/// Parses a band list. Uses `serde_json::Value` so duplicate keys in upstream
/// data (Go accepts them, serde does not) do not fail the whole refresh.
fn parse_bands(bytes: &[u8]) -> anyhow::Result<Vec<BandEntry>> {
    let raw: Vec<Value> = serde_json::from_slice(bytes)?;
    Ok(raw
        .into_iter()
        .filter_map(|v| {
            let obj = v.as_object()?;
            Some(BandEntry {
                name: obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                lower_bound: obj.get("lower_bound").and_then(|v| v.as_i64()).unwrap_or(0),
                upper_bound: obj.get("upper_bound").and_then(|v| v.as_i64()).unwrap_or(0),
                frequencies: obj
                    .get("frequencies")
                    .and_then(|v| serde_json::from_value(v.clone()).ok()),
                tags: obj
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|t| t.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}
