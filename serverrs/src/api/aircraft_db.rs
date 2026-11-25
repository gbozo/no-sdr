//! Aircraft metadata (ICAO address → registration, type, operator).
//!
//! The map already keys aircraft by ICAO address. Two derived lookups make the
//! same rows much more useful: `icao → registration/type` from Mictronics'
//! readsb database (about 14 MB of JSON), and `callsign prefix → operator`
//! from their operator table. The registration is also the key that lets ACARS
//! (whose address is a tail number) join an ADS-B aircraft.
//!
//! Files are cached next to the receiver config and refreshed weekly, like the
//! OurAirports layers.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::RwLock;
use serde::{Deserialize, Deserializer, Serialize};
use tracing::{info, warn};

const AIRCRAFTS_URL: &str =
    "https://raw.githubusercontent.com/Mictronics/readsb-protobuf/dev/webapp/src/db/aircrafts.json";
const TYPES_URL: &str =
    "https://raw.githubusercontent.com/Mictronics/readsb-protobuf/dev/webapp/src/db/types.json";
const OPERATORS_URL: &str =
    "https://raw.githubusercontent.com/Mictronics/readsb-protobuf/dev/webapp/src/db/operators.json";
const AIRCRAFTS_FILE: &str = "aircrafts.json";
const TYPES_FILE: &str = "types.json";
const OPERATORS_FILE: &str = "operators.json";
const VERSION_FILE: &str = "version.json";
const REFRESH_SECONDS: i64 = 7 * 24 * 60 * 60;
const USER_AGENT: &str = "no-sdr aircraft metadata (https://github.com/gbozo/no-sdr)";

#[derive(Debug, Clone, Default)]
pub struct AircraftMeta {
    /// Boxed so 443k rows do not each carry a growable String capacity.
    pub registration: Box<str>,
    pub type_code: Box<str>,
}

#[derive(Debug, Clone, Default)]
pub struct OperatorMeta {
    pub name: String,
    pub country: String,
    pub callsign: String,
}

#[derive(Debug, Default)]
pub struct AircraftIndex {
    aircraft: HashMap<u32, AircraftMeta>,
    types: HashMap<String, String>,
    operators: HashMap<String, OperatorMeta>,
}

impl AircraftIndex {
    pub fn len(&self) -> usize {
        self.aircraft.len()
    }

    pub fn is_empty(&self) -> bool {
        self.aircraft.is_empty()
    }

    pub fn aircraft(&self, icao: u32) -> Option<&AircraftMeta> {
        self.aircraft.get(&icao)
    }

    pub fn type_name(&self, type_code: &str) -> Option<&str> {
        self.types.get(&type_code.to_ascii_uppercase()).map(String::as_str)
    }

    /// Airlines put their ICAO code in the first three characters of the
    /// callsign, followed by the flight number (`DLH586`). Only accept that
    /// shape, as readsb does, so a tail number is not mistaken for an airline.
    pub fn operator_for_callsign(&self, callsign: &str) -> Option<&OperatorMeta> {
        let callsign = callsign.trim().to_ascii_uppercase();
        let bytes = callsign.as_bytes();
        if bytes.len() < 4
            || !bytes[..3].iter().all(u8::is_ascii_alphabetic)
            || !bytes[3].is_ascii_digit()
        {
            return None;
        }
        self.operators.get(&callsign[..3])
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
struct CachedVersion {
    #[serde(default)]
    fetched_at: i64,
}

pub struct AircraftDb {
    data_dir: PathBuf,
    client: reqwest::Client,
    index: RwLock<Arc<AircraftIndex>>,
    fetched_at: RwLock<i64>,
    refreshing: AtomicBool,
    last_error: RwLock<String>,
}

impl AircraftDb {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        let (index, fetched_at) = load(&data_dir).unwrap_or_default();
        if !index.is_empty() {
            info!(
                aircraft = index.len(),
                "aircraft metadata loaded"
            );
        }
        Arc::new(Self {
            data_dir,
            client: reqwest::Client::new(),
            index: RwLock::new(Arc::new(index)),
            fetched_at: RwLock::new(fetched_at),
            refreshing: AtomicBool::new(false),
            last_error: RwLock::new(String::new()),
        })
    }

    pub fn index(&self) -> Arc<AircraftIndex> {
        Arc::clone(&self.index.read())
    }

    pub fn start_scheduler(self: &Arc<Self>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service.refresh_if_needed().await;
            loop {
                tokio::time::sleep(Duration::from_secs(60 * 60)).await;
                service.refresh_if_needed().await;
            }
        });
    }

    async fn refresh_if_needed(&self) {
        let fetched_at = *self.fetched_at.read();
        if now_seconds() - fetched_at < REFRESH_SECONDS && !self.index.read().is_empty() {
            return;
        }
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return;
        }
        let result = self.refresh_inner().await;
        self.refreshing.store(false, Ordering::Release);
        match result {
            Ok(()) => *self.last_error.write() = String::new(),
            Err(error) => {
                *self.last_error.write() = error.clone();
                warn!(error, "aircraft metadata refresh failed - keeping current data");
            }
        }
    }

    async fn refresh_inner(&self) -> Result<(), String> {
        info!("aircraft metadata: downloading Mictronics database");
        let (aircrafts, types, operators) = tokio::try_join!(
            fetch_bytes(&self.client, AIRCRAFTS_URL),
            fetch_bytes(&self.client, TYPES_URL),
            fetch_bytes(&self.client, OPERATORS_URL),
        )?;
        let fetched_at = now_seconds();
        let dir = self.data_dir.clone();
        let index = tokio::task::spawn_blocking(move || {
            let files = [
                (AIRCRAFTS_FILE, aircrafts),
                (TYPES_FILE, types),
                (OPERATORS_FILE, operators),
            ];
            save(&dir, &files, fetched_at)?;
            parse_index(&files[0].1, &files[1].1, &files[2].1)
        })
        .await
        .map_err(|e| format!("aircraft cache task failed: {e}"))??;
        info!(aircraft = index.len(), "aircraft metadata refreshed");
        *self.index.write() = Arc::new(index);
        *self.fetched_at.write() = fetched_at;
        Ok(())
    }
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status()));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|e| format!("{url}: {e}"))
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Stream the top-level map straight into the final index. Deserialising the
/// whole 14 MB document into `HashMap<String, Vec<String>>` first doubled the
/// resident set at startup.
struct AircraftVisitor;

impl<'de> serde::de::Visitor<'de> for AircraftVisitor {
    type Value = HashMap<u32, AircraftMeta>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("an aircraft metadata map")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut aircraft = HashMap::with_capacity(map.size_hint().unwrap_or(0));
        while let Some((hex, row)) = map.next_entry::<String, Vec<String>>()? {
            let Ok(icao) = u32::from_str_radix(hex.trim_start_matches("0x"), 16) else {
                continue;
            };
            let registration = row.first().map(|s| s.trim()).unwrap_or("");
            let type_code = row.get(1).map(|s| s.trim()).unwrap_or("");
            if registration.is_empty() && type_code.is_empty() {
                continue;
            }
            aircraft.insert(
                icao,
                AircraftMeta {
                    registration: registration.into(),
                    type_code: type_code.into(),
                },
            );
        }
        Ok(aircraft)
    }
}

fn parse_index(
    aircrafts: &[u8],
    types: &[u8],
    operators: &[u8],
) -> Result<AircraftIndex, String> {
    let mut deserializer = serde_json::Deserializer::from_slice(aircrafts);
    let aircraft = deserializer
        .deserialize_map(AircraftVisitor)
        .map_err(|e| format!("aircrafts.json: {e}"))?;
    deserializer
        .end()
        .map_err(|e| format!("aircrafts.json: {e}"))?;
    let types: HashMap<String, Vec<String>> =
        serde_json::from_slice(types).map_err(|e| format!("types.json: {e}"))?;
    let operators: HashMap<String, Vec<String>> =
        serde_json::from_slice(operators).map_err(|e| format!("operators.json: {e}"))?;

    let types: HashMap<String, String> = types
        .into_iter()
        .map(|(code, row)| {
            (
                code.to_ascii_uppercase(),
                row.first().cloned().unwrap_or_default(),
            )
        })
        .collect();
    let operators: HashMap<String, OperatorMeta> = operators
        .into_iter()
        .map(|(code, row)| {
            (
                code.to_ascii_uppercase(),
                OperatorMeta {
                    name: row.first().cloned().unwrap_or_default(),
                    country: row.get(1).cloned().unwrap_or_default(),
                    callsign: row.get(2).cloned().unwrap_or_default(),
                },
            )
        })
        .collect();

    Ok(AircraftIndex {
        aircraft,
        types,
        operators,
    })
}

fn load(dir: &Path) -> Option<(AircraftIndex, i64)> {
    let version: CachedVersion = serde_json::from_slice(&std::fs::read(dir.join(VERSION_FILE)).ok()?).ok()?;
    let aircrafts = std::fs::read(dir.join(AIRCRAFTS_FILE)).ok()?;
    let types = std::fs::read(dir.join(TYPES_FILE)).ok()?;
    let operators = std::fs::read(dir.join(OPERATORS_FILE)).ok()?;
    let index = parse_index(&aircrafts, &types, &operators).ok()?;
    Some((index, version.fetched_at))
}

fn save(dir: &Path, files: &[(&str, Vec<u8>)], fetched_at: i64) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    for (name, bytes) in files {
        let path = dir.join(name);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("replace {}: {e}", path.display()))?;
    }
    let version = serde_json::to_vec(&CachedVersion { fetched_at })
        .map_err(|e| format!("serialize version: {e}"))?;
    let path = dir.join(VERSION_FILE);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, version).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("replace {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_resolves_registration_type_and_operator() {
        let aircrafts = br#"{
            "3C65D2": ["D-AINR", "A20N", "00"],
            "ADCE29": ["N989SF", "C172", "00"]
        }"#;
        let types = br#"{"A20N": ["AIRBUS A-320neo", "L2J", "L"], "C172": ["CESSNA 172", "L1P", "L"]}"#;
        let operators = br#"{"DLH": ["Lufthansa", "Germany", "LUFTHANSA"]}"#;
        let index = parse_index(aircrafts, types, operators).expect("index");

        let meta = index.aircraft(0x3C65D2).expect("aircraft");
        assert_eq!(&*meta.registration, "D-AINR");
        assert_eq!(&*meta.type_code, "A20N");
        assert_eq!(index.type_name("A20N"), Some("AIRBUS A-320neo"));
        assert_eq!(
            index.operator_for_callsign("DLH586").map(|o| o.name.as_str()),
            Some("Lufthansa")
        );
        assert!(index.operator_for_callsign("N989SF").is_none());
    }
}
