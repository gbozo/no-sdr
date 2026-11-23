//! OurAirports aviation reference layers.
//!
//! The upstream CSVs are large (about 13 MB for airports, 1.5 MB for navaids),
//! so the server owns the download and keeps a compact JSON cache next to the
//! receiver config. Clients ask only for the current viewport and zoom level.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::Json;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{info, warn};

use super::AppState;

const AIRPORTS_URL: &str = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const NAVAIDS_URL: &str = "https://davidmegginson.github.io/ourairports-data/navaids.csv";
const CACHE_FILE: &str = "aviation.json";
const REFRESH_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_AIRPORTS: usize = 800;
const MAX_NAVAIDS: usize = 500;
const USER_AGENT: &str = "no-sdr aviation layers (https://github.com/gbozo/no-sdr)";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Airport {
    pub ident: String,
    pub name: String,
    pub kind: String,
    pub lat: f64,
    pub lon: f64,
    pub elevation_ft: Option<i32>,
    pub municipality: String,
    pub iso_country: String,
    pub iata: String,
    pub icao: String,
    pub scheduled_service: bool,
    pub home_link: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Navaid {
    pub ident: String,
    pub name: String,
    pub kind: String,
    pub frequency_khz: Option<u32>,
    pub lat: f64,
    pub lon: f64,
    pub elevation_ft: Option<i32>,
    pub iso_country: String,
    pub usage: String,
    pub associated_airport: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CachedAviation {
    fetched_at: i64,
    airports: Vec<Airport>,
    navaids: Vec<Navaid>,
}

pub struct AviationService {
    data_dir: PathBuf,
    client: reqwest::Client,
    data: RwLock<Arc<CachedAviation>>,
    refreshing: AtomicBool,
    last_error: RwLock<String>,
}

impl AviationService {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        let cached = load_cache(&data_dir).unwrap_or_else(|| {
            warn!(path = %data_dir.display(), "aviation cache not available yet");
            CachedAviation::default()
        });
        if !cached.airports.is_empty() {
            info!(
                airports = cached.airports.len(),
                navaids = cached.navaids.len(),
                "aviation reference data loaded"
            );
        }
        Arc::new(Self {
            data_dir,
            client: reqwest::Client::new(),
            data: RwLock::new(Arc::new(cached)),
            refreshing: AtomicBool::new(false),
            last_error: RwLock::new(String::new()),
        })
    }

    /// Refresh when the cache is missing or stale, then check again hourly.
    pub fn start_scheduler(self: &Arc<Self>) {
        let svc = Arc::clone(self);
        tokio::spawn(async move {
            svc.refresh_if_needed().await;
            loop {
                tokio::time::sleep(Duration::from_secs(60 * 60)).await;
                svc.refresh_if_needed().await;
            }
        });
    }

    fn snapshot(&self) -> Arc<CachedAviation> {
        Arc::clone(&self.data.read())
    }

    async fn refresh_if_needed(&self) {
        let fetched_at = self.data.read().fetched_at;
        if now_seconds() - fetched_at < REFRESH_SECONDS {
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
                warn!(error, "aviation reference data refresh failed - keeping current data");
            }
        }
    }

    async fn refresh_inner(&self) -> Result<(), String> {
        info!("aviation: downloading OurAirports CSVs");
        let (airports, navaids) = tokio::try_join!(
            fetch_bytes(&self.client, AIRPORTS_URL),
            fetch_bytes(&self.client, NAVAIDS_URL),
        )?;
        let (airports, navaids) =
            tokio::task::spawn_blocking(move || parse_csv(&airports, &navaids))
                .await
                .map_err(|e| format!("parse task failed: {e}"))??;
        let cached = CachedAviation {
            fetched_at: now_seconds(),
            airports,
            navaids,
        };
        let bytes = serde_json::to_vec(&cached).map_err(|e| format!("serialize failed: {e}"))?;
        let dir = self.data_dir.clone();
        tokio::task::spawn_blocking(move || save_cache(&dir, &bytes))
            .await
            .map_err(|e| format!("cache task failed: {e}"))??;
        info!(
            airports = cached.airports.len(),
            navaids = cached.navaids.len(),
            "aviation: reference data refreshed"
        );
        *self.data.write() = Arc::new(cached);
        Ok(())
    }
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(Duration::from_secs(90))
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

fn cache_path(dir: &Path) -> PathBuf {
    dir.join(CACHE_FILE)
}

fn load_cache(dir: &Path) -> Option<CachedAviation> {
    let bytes = std::fs::read(cache_path(dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn save_cache(dir: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = cache_path(dir);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("replace {}: {e}", path.display()))
}

fn parse_csv(airports: &[u8], navaids: &[u8]) -> Result<(Vec<Airport>, Vec<Navaid>), String> {
    Ok((parse_airports(airports)?, parse_navaids(navaids)?))
}

fn parse_airports(bytes: &[u8]) -> Result<Vec<Airport>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(bytes);
    let headers = reader
        .headers()
        .map_err(|e| format!("airport headers: {e}"))?
        .clone();
    let index = |name: &str| headers.iter().position(|h| h == name);
    let ident = index("ident").ok_or("airports.csv: missing ident")?;
    let name = index("name").ok_or("airports.csv: missing name")?;
    let kind = index("type").ok_or("airports.csv: missing type")?;
    let lat = index("latitude_deg").ok_or("airports.csv: missing latitude_deg")?;
    let lon = index("longitude_deg").ok_or("airports.csv: missing longitude_deg")?;
    let elevation = index("elevation_ft");
    let municipality = index("municipality");
    let country = index("iso_country");
    let iata = index("iata_code");
    let icao = index("icao_code");
    let scheduled = index("scheduled_service");
    let home = index("home_link");

    let mut result = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| format!("airport row: {e}"))?;
        let kind = field(&record, kind);
        if kind.is_empty() || kind == "closed" {
            continue;
        }
        let Some(lat) = number(&record, lat) else {
            continue;
        };
        let Some(lon) = number(&record, lon) else {
            continue;
        };
        let ident = field(&record, ident);
        if ident.is_empty() || !valid_coords(lat, lon) {
            continue;
        }
        result.push(Airport {
            ident: ident.to_string(),
            name: field(&record, name).to_string(),
            kind: kind.to_string(),
            lat,
            lon,
            elevation_ft: elevation.and_then(|i| integer(&record, i)),
            municipality: municipality.map(|i| field(&record, i)).unwrap_or("").to_string(),
            iso_country: country.map(|i| field(&record, i)).unwrap_or("").to_string(),
            iata: iata.map(|i| field(&record, i)).unwrap_or("").to_string(),
            icao: icao.map(|i| field(&record, i)).unwrap_or("").to_string(),
            scheduled_service: scheduled
                .map(|i| field(&record, i).eq_ignore_ascii_case("yes"))
                .unwrap_or(false),
            home_link: home.map(|i| field(&record, i)).unwrap_or("").to_string(),
        });
    }
    Ok(result)
}

fn parse_navaids(bytes: &[u8]) -> Result<Vec<Navaid>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(bytes);
    let headers = reader
        .headers()
        .map_err(|e| format!("navaid headers: {e}"))?
        .clone();
    let index = |name: &str| headers.iter().position(|h| h == name);
    let ident = index("ident").ok_or("navaids.csv: missing ident")?;
    let name = index("name").ok_or("navaids.csv: missing name")?;
    let kind = index("type").ok_or("navaids.csv: missing type")?;
    let frequency = index("frequency_khz");
    let lat = index("latitude_deg").ok_or("navaids.csv: missing latitude_deg")?;
    let lon = index("longitude_deg").ok_or("navaids.csv: missing longitude_deg")?;
    let elevation = index("elevation_ft");
    let country = index("iso_country");
    let usage = index("usageType");
    let associated = index("associated_airport");

    let mut result = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| format!("navaid row: {e}"))?;
        let ident = field(&record, ident);
        if ident.is_empty() {
            continue;
        }
        let Some(lat) = number(&record, lat) else {
            continue;
        };
        let Some(lon) = number(&record, lon) else {
            continue;
        };
        if !valid_coords(lat, lon) {
            continue;
        }
        result.push(Navaid {
            ident: ident.to_string(),
            name: field(&record, name).to_string(),
            kind: field(&record, kind).to_string(),
            frequency_khz: frequency.and_then(|i| integer(&record, i)).and_then(|v| u32::try_from(v).ok()),
            lat,
            lon,
            elevation_ft: elevation.and_then(|i| integer(&record, i)),
            iso_country: country.map(|i| field(&record, i)).unwrap_or("").to_string(),
            usage: usage.map(|i| field(&record, i)).unwrap_or("").to_string(),
            associated_airport: associated.map(|i| field(&record, i)).unwrap_or("").to_string(),
        });
    }
    Ok(result)
}

fn field(record: &csv::StringRecord, index: usize) -> &str {
    record.get(index).unwrap_or("").trim()
}

fn number(record: &csv::StringRecord, index: usize) -> Option<f64> {
    field(record, index).parse::<f64>().ok().filter(|v| v.is_finite())
}

fn integer(record: &csv::StringRecord, index: usize) -> Option<i32> {
    let value = field(record, index);
    value
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .map(|v| v.round() as i32)
}

fn valid_coords(lat: f64, lon: f64) -> bool {
    (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AviationQuery {
    pub kind: String,
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
    pub zoom: u8,
}

pub async fn aviation(
    State(state): State<AppState>,
    Query(query): Query<AviationQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if ![
        query.min_lat,
        query.max_lat,
        query.min_lon,
        query.max_lon,
    ]
    .iter()
    .all(|v| v.is_finite())
        || query.min_lat >= query.max_lat
        || query.zoom > 22
    {
        return Err(bad_request("invalid viewport"));
    }

    let (receiver_lat, receiver_lon, airport_range_km, navaid_range_km) = {
        let cfg = state.cfg.read();
        (
            cfg.server.receiver_latitude,
            cfg.server.receiver_longitude,
            cfg.server.airport_range_km,
            cfg.server.navaid_range_km,
        )
    };
    let data = state.aviation.snapshot();
    if data.fetched_at == 0 {
        return Ok(Json(json!({
            "ready": false,
            "kind": query.kind,
            "total": 0,
            "truncated": false,
            "items": [],
        })));
    }

    match query.kind.as_str() {
        "airports" => {
            let mut rows: Vec<&Airport> = data
                .airports
                .iter()
                .filter(|airport| {
                    query.zoom >= airport_min_zoom(&airport.kind)
                        && in_bbox(&query, airport.lat, airport.lon)
                        && within_range_km(
                            receiver_lat,
                            receiver_lon,
                            airport.lat,
                            airport.lon,
                            airport_range_km,
                        )
                })
                .collect();
            rows.sort_by_key(|airport| airport_priority(&airport.kind));
            let total = rows.len();
            rows.truncate(MAX_AIRPORTS);
            Ok(Json(json!({
                "ready": true,
                "kind": "airports",
                "total": total,
                "truncated": total > rows.len(),
                "items": rows,
            })))
        }
        "navaids" => {
            let mut rows: Vec<&Navaid> = data
                .navaids
                .iter()
                .filter(|navaid| {
                    query.zoom >= navaid_min_zoom(&navaid.kind)
                        && in_bbox(&query, navaid.lat, navaid.lon)
                        && within_range_km(
                            receiver_lat,
                            receiver_lon,
                            navaid.lat,
                            navaid.lon,
                            navaid_range_km,
                        )
                })
                .collect();
            rows.sort_by_key(|navaid| navaid_priority(&navaid.kind));
            let total = rows.len();
            rows.truncate(MAX_NAVAIDS);
            Ok(Json(json!({
                "ready": true,
                "kind": "navaids",
                "total": total,
                "truncated": total > rows.len(),
                "items": rows,
            })))
        }
        _ => Err(bad_request("kind must be airports or navaids")),
    }
}

fn bad_request(message: &str) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message })))
}

fn in_bbox(query: &AviationQuery, lat: f64, lon: f64) -> bool {
    if lat < query.min_lat || lat > query.max_lat {
        return false;
    }
    if query.min_lon <= query.max_lon {
        lon >= query.min_lon && lon <= query.max_lon
    } else {
        // Leaflet can report a viewport crossing the antimeridian.
        lon >= query.min_lon || lon <= query.max_lon
    }
}

fn within_range_km(
    center_lat: f64,
    center_lon: f64,
    lat: f64,
    lon: f64,
    range_km: i32,
) -> bool {
    if range_km <= 0 || (center_lat == 0.0 && center_lon == 0.0) {
        return true;
    }
    distance_km(center_lat, center_lon, lat, lon) <= range_km as f64
}

fn distance_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let radius_km = 6371.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    2.0 * radius_km * a.sqrt().asin()
}

fn airport_min_zoom(kind: &str) -> u8 {
    match kind {
        "large_airport" => 3,
        "medium_airport" => 5,
        "small_airport" => 8,
        "heliport" | "seaplane_base" | "balloonport" => 10,
        _ => 12,
    }
}

fn airport_priority(kind: &str) -> u8 {
    match kind {
        "large_airport" => 0,
        "medium_airport" => 1,
        "small_airport" => 2,
        _ => 3,
    }
}

fn navaid_min_zoom(kind: &str) -> u8 {
    let upper = kind.to_ascii_uppercase();
    if upper.starts_with("VOR") || upper == "TACAN" {
        4
    } else if upper.starts_with("NDB") {
        6
    } else {
        8
    }
}

fn navaid_priority(kind: &str) -> u8 {
    let upper = kind.to_ascii_uppercase();
    if upper == "VORTAC" {
        0
    } else if upper.starts_with("VOR") {
        1
    } else if upper == "TACAN" {
        2
    } else if upper.starts_with("NDB") {
        3
    } else {
        4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_airports_and_navaids() {
        let airports = br#"id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,iso_country,municipality,iata_code,icao_code,scheduled_service,home_link
1,LGAV,large_airport,Athens,37.9364,23.9445,308,GR,Spata,ATH,LGAV,yes,https://example.org
2,CLOSED,closed,Old,0,0,,GR,,,,no,"#;
        let navaids = br#"id,ident,type,name,frequency_khz,latitude_deg,longitude_deg,elevation_ft,iso_country,usageType,associated_airport
1,ATV,VOR-DME,Athens,113900,37.9364,23.9445,308,GR,LO,LGAV
"#;
        let (airports, navaids) = parse_csv(airports, navaids).unwrap();
        assert_eq!(airports.len(), 1);
        assert_eq!(airports[0].ident, "LGAV");
        assert_eq!(airports[0].elevation_ft, Some(308));
        assert!(airports[0].scheduled_service);
        assert_eq!(navaids.len(), 1);
        assert_eq!(navaids[0].frequency_khz, Some(113_900));
    }

    #[test]
    fn filters_by_zoom_and_viewport() {
        let query = AviationQuery {
            kind: "airports".into(),
            min_lat: 37.0,
            max_lat: 38.0,
            min_lon: 23.0,
            max_lon: 24.0,
            zoom: 8,
        };
        assert!(in_bbox(&query, 37.5, 23.5));
        assert!(!in_bbox(&query, 39.0, 23.5));
        assert_eq!(airport_min_zoom("large_airport"), 3);
        assert_eq!(airport_min_zoom("small_airport"), 8);
        assert_eq!(navaid_min_zoom("VOR-DME"), 4);
        assert_eq!(navaid_min_zoom("NDB"), 6);
    }

    #[test]
    fn range_filter_is_optional_and_uses_kilometres() {
        // Athens to Spata is well inside 250 km, while London is outside.
        assert!(within_range_km(37.98, 23.73, 37.94, 23.94, 250));
        assert!(!within_range_km(37.98, 23.73, 51.47, -0.45, 250));
        assert!(within_range_km(37.98, 23.73, 51.47, -0.45, 0));
        // Unset receiver position disables the radius filter.
        assert!(within_range_km(0.0, 0.0, 51.47, -0.45, 1));
    }
}
