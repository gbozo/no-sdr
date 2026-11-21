//! User presence and session analytics.
//!
//! Every WebSocket connection is one row in `user_sessions`. The live admin
//! map reads current sessions plus those that disconnected in the last hour;
//! the analytics view aggregates the same rows by country, region, city,
//! frequency and demod mode. A maintenance task deletes closed sessions older
//! than the configured retention (90 days by default).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::geo::GeoInfo;
use crate::ws::ClientInfo;

/// One connection's immutable start fields.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub persistent_id: String,
    pub conn_index: i64,
    pub connected_at_ms: i64,
    pub ip: String,
    pub real_ip: String,
    pub geo: Option<GeoInfo>,
    pub dongle_id: String,
    pub profile_id: String,
    pub frequency_hz: i64,
    pub mode: String,
    pub bandwidth: i64,
}

impl SessionInfo {
    pub fn from_client(info: &ClientInfo) -> Self {
        let geo = info.geo.clone();
        Self {
            id: info.id.clone(),
            persistent_id: info.persistent_id.clone(),
            conn_index: info.conn_index,
            connected_at_ms: info.connected_at.timestamp_millis(),
            ip: info.ip.clone(),
            real_ip: info.real_ip.clone(),
            geo,
            dongle_id: info.dongle_id.clone(),
            profile_id: info.profile_id.clone(),
            // The absolute tuned frequency is filled in by `touch` when the
            // client subscribes; at connect only the offset is known.
            frequency_hz: 0,
            mode: info.mode.clone(),
            bandwidth: info.bandwidth,
        }
    }
}

/// One user-session database shared with the decoder history.
pub struct UserStore {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl UserStore {
    pub fn open(path: impl AsRef<Path>) -> Arc<Self> {
        let path = path.as_ref().to_path_buf();
        let conn = match open_connection(&path) {
            Ok(conn) => {
                if let Err(error) = migrate(&conn) {
                    warn!(path = %path.display(), error = %error, "user analytics migration failed");
                    return Arc::new(Self {
                        conn: Mutex::new(conn),
                        path,
                    });
                }
                // A previous process may have exited without disconnect
                // handlers. Treat every leftover open session as closed at its
                // last seen time so the live map cannot show ghosts.
                let _ = conn.execute(
                    "UPDATE user_sessions
                     SET disconnected_at_ms = last_seen_ms
                     WHERE disconnected_at_ms IS NULL",
                    [],
                );
                info!(path = %path.display(), "user analytics database ready");
                conn
            }
            Err(error) => {
                warn!(path = %path.display(), error = %error, "user analytics database unavailable");
                return Arc::new(Self {
                    conn: Mutex::new(Connection::open_in_memory().expect("in-memory SQLite")),
                    path,
                });
            }
        };
        Arc::new(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn start_session(&self, session: &SessionInfo) {
        let conn = self.conn.lock();
        let geo = session.geo.clone().unwrap_or_default();
        let result = conn.execute(
            "INSERT INTO user_sessions (
                id, persistent_id, conn_index, connected_at_ms, last_seen_ms,
                disconnected_at_ms, ip, real_ip, country_code, country, region,
                region_code, city, latitude, longitude, continent, continent_code,
                dongle_id, profile_id, frequency_hz, mode, bandwidth
             ) VALUES (
                ?1, ?2, ?3, ?4, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
             )
             ON CONFLICT(id) DO UPDATE SET
                persistent_id = excluded.persistent_id,
                conn_index = excluded.conn_index,
                last_seen_ms = excluded.last_seen_ms,
                disconnected_at_ms = NULL,
                ip = excluded.ip,
                real_ip = excluded.real_ip,
                country_code = excluded.country_code,
                country = excluded.country,
                region = excluded.region,
                region_code = excluded.region_code,
                city = excluded.city,
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                continent = excluded.continent,
                continent_code = excluded.continent_code,
                dongle_id = excluded.dongle_id,
                profile_id = excluded.profile_id,
                frequency_hz = excluded.frequency_hz,
                mode = excluded.mode,
                bandwidth = excluded.bandwidth",
            params![
                session.id,
                session.persistent_id,
                session.conn_index,
                session.connected_at_ms,
                session.ip,
                session.real_ip,
                geo.country_code,
                geo.country,
                geo.region,
                geo.region_code,
                geo.city,
                geo.latitude,
                geo.longitude,
                geo.continent,
                geo.continent_code,
                session.dongle_id,
                session.profile_id,
                session.frequency_hz,
                session.mode,
                session.bandwidth,
            ],
        );
        if let Err(error) = result {
            warn!(error = %error, "user session insert failed");
        }
    }

    /// Refresh the tuning fields when a client changes band/mode/profile.
    pub fn touch_session(
        &self,
        id: &str,
        dongle_id: &str,
        profile_id: &str,
        frequency_hz: i64,
        mode: &str,
        bandwidth: i64,
    ) {
        let conn = self.conn.lock();
        let result = conn.execute(
            "UPDATE user_sessions
             SET last_seen_ms = ?2, dongle_id = ?3, profile_id = ?4,
                 frequency_hz = ?5, mode = ?6, bandwidth = ?7
             WHERE id = ?1 AND disconnected_at_ms IS NULL",
            params![
                id,
                now_ms(),
                dongle_id,
                profile_id,
                frequency_hz,
                mode,
                bandwidth,
            ],
        );
        if let Err(error) = result {
            warn!(error = %error, "user session touch failed");
        }
    }

    pub fn close_session(&self, id: &str) {
        let conn = self.conn.lock();
        let now = now_ms();
        let _ = conn.execute(
            "UPDATE user_sessions
             SET disconnected_at_ms = ?2, last_seen_ms = ?2
             WHERE id = ?1 AND disconnected_at_ms IS NULL",
            params![id, now],
        );
    }

    /// Current sessions plus those that disconnected within `recent_minutes`.
    pub fn live_map(&self, recent_minutes: i64) -> Vec<Value> {
        let conn = self.conn.lock();
        let cutoff = now_ms() - recent_minutes.max(0).saturating_mul(60_000);
        let mut stmt = match conn.prepare(
            "SELECT id, persistent_id, conn_index, connected_at_ms, last_seen_ms,
                    disconnected_at_ms, ip, real_ip, country_code, country, region,
                    region_code, city, latitude, longitude, continent, continent_code,
                    dongle_id, profile_id, frequency_hz, mode, bandwidth
             FROM user_sessions
             WHERE disconnected_at_ms IS NULL OR last_seen_ms >= ?1
             ORDER BY (disconnected_at_ms IS NOT NULL), last_seen_ms DESC
             LIMIT 500",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![cutoff], |row| {
            let disconnected: Option<i64> = row.get(5)?;
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "persistentId": row.get::<_, String>(1)?,
                "connIndex": row.get::<_, i64>(2)?,
                "connectedAtMs": row.get::<_, i64>(3)?,
                "lastSeenMs": row.get::<_, i64>(4)?,
                "disconnectedAtMs": disconnected,
                "active": disconnected.is_none(),
                "ip": row.get::<_, String>(6)?,
                "realIp": row.get::<_, String>(7)?,
                "countryCode": row.get::<_, String>(8)?,
                "country": row.get::<_, String>(9)?,
                "region": row.get::<_, String>(10)?,
                "regionCode": row.get::<_, String>(11)?,
                "city": row.get::<_, String>(12)?,
                "latitude": row.get::<_, Option<f64>>(13)?,
                "longitude": row.get::<_, Option<f64>>(14)?,
                "continent": row.get::<_, String>(15)?,
                "continentCode": row.get::<_, String>(16)?,
                "dongleId": row.get::<_, String>(17)?,
                "profileId": row.get::<_, String>(18)?,
                "frequencyHz": row.get::<_, i64>(19)?,
                "mode": row.get::<_, String>(20)?,
                "bandwidth": row.get::<_, i64>(21)?,
            }))
        });
        rows.map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// Aggregate sessions overlapping `[since_ms, until_ms]`.
    pub fn analytics(&self, since_ms: i64, until_ms: i64) -> Value {
        // Read the rows under the connection lock, then aggregate them without
        // holding it. A 90-day report must not block a live session touch or a
        // disconnect timestamp.
        let rows: Vec<_> = {
            let conn = self.conn.lock();
            let mut stmt = match conn.prepare(
                "SELECT persistent_id, connected_at_ms, disconnected_at_ms, country_code,
                        country, region, region_code, city, latitude, longitude, continent,
                        mode, frequency_hz
                 FROM user_sessions
                 WHERE connected_at_ms <= ?2
                   AND (disconnected_at_ms IS NULL OR disconnected_at_ms >= ?1)
                 LIMIT 200000",
            ) {
                Ok(stmt) => stmt,
                Err(_) => return json!({"sessions": 0, "uniqueUsers": 0}),
            };
            let rows = stmt.query_map(params![since_ms, until_ms], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<f64>>(8)?,
                    row.get::<_, Option<f64>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, i64>(12)?,
                ))
            });
            match rows {
                Ok(rows) => rows.flatten().collect(),
                Err(_) => return json!({"sessions": 0, "uniqueUsers": 0}),
            }
        };
        let now = now_ms();
        let mut sessions = 0i64;
        let mut unique_users = HashSet::new();
        let mut countries: HashMap<String, Aggregate> = HashMap::new();
        let mut regions: HashMap<String, Aggregate> = HashMap::new();
        let mut modes: HashMap<String, i64> = HashMap::new();
        let mut frequencies: HashMap<i64, i64> = HashMap::new();
        let mut durations: Vec<i64> = Vec::new();
        let mut events: Vec<(i64, i32)> = Vec::new();

        for row in rows {
            let (
                persistent_id,
                connected,
                disconnected,
                country_code,
                country,
                region,
                region_code,
                city,
                latitude,
                longitude,
                continent,
                mode,
                frequency_hz,
            ) = row;
            sessions += 1;
            unique_users.insert(persistent_id);
            if !mode.is_empty() {
                modes
                    .entry(mode.clone())
                    .and_modify(|v| *v += 1)
                    .or_insert(1);
            }
            if frequency_hz > 0 {
                let bucket = frequency_bucket(frequency_hz);
                frequencies
                    .entry(bucket)
                    .and_modify(|v| *v += 1)
                    .or_insert(1);
            }

            let start = connected.max(since_ms);
            let end = disconnected.unwrap_or(now).min(until_ms);
            if end > start {
                durations.push(end - start);
                events.push((start, 1));
                events.push((end, -1));
            }

            if country_code.is_empty() {
                continue;
            }

            let key = if region.is_empty() {
                format!("{country_code}|{country}")
            } else {
                format!("{country_code}|{region_code}|{region}")
            };
            let aggregate = regions.entry(key).or_insert_with(|| Aggregate {
                country_code: country_code.clone(),
                country: country.clone(),
                region: region.clone(),
                region_code: region_code.clone(),
                city: city.clone(),
                latitude,
                longitude,
                continent: continent.clone(),
                count: 0,
                modes: HashMap::new(),
                frequencies: HashMap::new(),
            });
            aggregate.add(&mode, frequency_hz, latitude, longitude, &city);

            if let Some(entry) = countries.get_mut(&country_code) {
                entry.add(&mode, frequency_hz, latitude, longitude, &city);
            } else {
                let mut entry = Aggregate {
                    country_code: country_code.clone(),
                    country: country.clone(),
                    region: String::new(),
                    region_code: String::new(),
                    city: city.clone(),
                    latitude,
                    longitude,
                    continent: continent.clone(),
                    count: 0,
                    modes: HashMap::new(),
                    frequencies: HashMap::new(),
                };
                entry.add(&mode, frequency_hz, latitude, longitude, &city);
                countries.insert(country_code, entry);
            }
        }

        events.sort_unstable_by_key(|(time, delta)| (*time, *delta));
        let peak_concurrent = peak_concurrent(&events);
        let concurrency = concurrency_peaks(&events, since_ms, until_ms);
        let avg_session_secs = if durations.is_empty() {
            0.0
        } else {
            durations.iter().sum::<i64>() as f64 / durations.len() as f64 / 1000.0
        };
        let mut map_points: Vec<Value> = regions
            .values()
            .filter_map(|entry| entry.map_point())
            .collect();
        map_points.sort_by(|a, b| {
            b["count"]
                .as_i64()
                .unwrap_or(0)
                .cmp(&a["count"].as_i64().unwrap_or(0))
        });

        let mut freq_rows: Vec<(i64, i64)> = frequencies.into_iter().collect();
        freq_rows.sort_by(|a, b| b.1.cmp(&a.1));
        freq_rows.truncate(25);
        let top_frequencies: Vec<Value> = freq_rows
            .into_iter()
            .map(|(hz, count)| json!({"frequencyHz": hz, "count": count}))
            .collect();

        json!({
            "sinceMs": since_ms,
            "untilMs": until_ms,
            "sessions": sessions,
            "uniqueUsers": unique_users.len(),
            "countries": countries.len(),
            "regions": regions.len(),
            "peakConcurrent": peak_concurrent,
            "avgSessionSecs": avg_session_secs,
            "concurrency": concurrency,
            "topCountries": top_aggregates(&countries, 25),
            "topRegions": top_aggregates(&regions, 25),
            "topModes": top_counts(modes, 25, "mode"),
            "topFrequencies": top_frequencies,
            "mapPoints": map_points,
        })
    }

    /// Delete closed sessions older than `retention_days`. Open sessions are
    /// never removed.
    pub fn purge(&self, retention_days: i64) -> usize {
        if retention_days <= 0 {
            return 0;
        }
        let conn = self.conn.lock();
        let cutoff = now_ms() - retention_days.saturating_mul(86_400_000);
        conn.execute(
            "DELETE FROM user_sessions
             WHERE disconnected_at_ms IS NOT NULL AND disconnected_at_ms < ?1",
            params![cutoff],
        )
        .unwrap_or(0)
    }

    /// Delete every **closed** session (manual history purge). Current
    /// connections stay on the live map.
    pub fn clear_all(&self) -> usize {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM user_sessions WHERE disconnected_at_ms IS NOT NULL",
            [],
        )
        .unwrap_or(0)
    }
}

struct Aggregate {
    country_code: String,
    country: String,
    region: String,
    region_code: String,
    city: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    continent: String,
    count: i64,
    modes: HashMap<String, i64>,
    frequencies: HashMap<i64, i64>,
}

impl Aggregate {
    fn add(
        &mut self,
        mode: &str,
        frequency_hz: i64,
        latitude: Option<f64>,
        longitude: Option<f64>,
        city: &str,
    ) {
        self.count += 1;
        self.modes
            .entry(mode.to_string())
            .and_modify(|v| *v += 1)
            .or_insert(1);
        if frequency_hz > 0 {
            let bucket = frequency_bucket(frequency_hz);
            self.frequencies
                .entry(bucket)
                .and_modify(|v| *v += 1)
                .or_insert(1);
        }
        if self.latitude.is_none() {
            self.latitude = latitude;
            self.longitude = longitude;
        }
        if self.city.is_empty() && !city.is_empty() {
            self.city = city.to_string();
        }
    }

    fn top_mode(&self) -> String {
        self.modes
            .iter()
            .max_by_key(|(_, count)| *count)
            .map(|(mode, _)| mode.clone())
            .unwrap_or_default()
    }

    fn top_frequency(&self) -> Option<i64> {
        self.frequencies
            .iter()
            .max_by_key(|(_, count)| *count)
            .map(|(hz, _)| *hz)
    }

    fn to_json(&self) -> Value {
        json!({
            "countryCode": self.country_code,
            "country": self.country,
            "region": self.region,
            "regionCode": self.region_code,
            "city": self.city,
            "continent": self.continent,
            "count": self.count,
            "topMode": self.top_mode(),
            "topFrequencyHz": self.top_frequency(),
        })
    }

    fn map_point(&self) -> Option<Value> {
        let (latitude, longitude) = (self.latitude?, self.longitude?);
        Some(json!({
            "countryCode": self.country_code,
            "country": self.country,
            "region": self.region,
            "regionCode": self.region_code,
            "city": self.city,
            "continent": self.continent,
            "latitude": latitude,
            "longitude": longitude,
            "count": self.count,
            "topMode": self.top_mode(),
            "topFrequencyHz": self.top_frequency(),
        }))
    }
}

fn top_aggregates(map: &HashMap<String, Aggregate>, limit: usize) -> Vec<Value> {
    let mut rows: Vec<Value> = map.values().map(Aggregate::to_json).collect();
    rows.sort_by(|a, b| {
        b["count"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["count"].as_i64().unwrap_or(0))
    });
    rows.truncate(limit);
    rows
}

fn top_counts(map: HashMap<String, i64>, limit: usize, key: &str) -> Vec<Value> {
    let mut rows: Vec<(String, i64)> = map.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    rows.truncate(limit);
    rows.into_iter()
        .map(|(value, count)| json!({ key: value, "count": count }))
        .collect()
}

fn peak_concurrent(events: &[(i64, i32)]) -> i64 {
    let mut current = 0i64;
    let mut peak = 0i64;
    for &(_, delta) in events {
        current += delta as i64;
        peak = peak.max(current);
    }
    peak
}

fn concurrency_peaks(events: &[(i64, i32)], since_ms: i64, until_ms: i64) -> Vec<Value> {
    let span = (until_ms - since_ms).max(1);
    let step = if span <= 2 * 3_600_000 {
        5 * 60_000
    } else if span <= 48 * 3_600_000 {
        3_600_000
    } else {
        86_400_000
    };
    let mut at = since_ms / step * step;
    let mut idx = 0usize;
    let mut current = 0i64;
    let mut rows = Vec::new();
    while at < until_ms {
        while idx < events.len() && events[idx].0 < at {
            current += events[idx].1 as i64;
            idx += 1;
        }
        let mut peak = current;
        while idx < events.len() && events[idx].0 < at + step {
            current += events[idx].1 as i64;
            idx += 1;
            peak = peak.max(current);
        }
        rows.push(json!({"startMs": at, "count": peak}));
        at += step;
    }
    rows
}

fn frequency_bucket(hz: i64) -> i64 {
    let step = if hz < 30_000_000 { 10_000 } else { 100_000 };
    hz / step * step
}

fn open_connection(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA busy_timeout=5000;",
    )?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_sessions (
            id TEXT PRIMARY KEY,
            persistent_id TEXT NOT NULL,
            conn_index INTEGER NOT NULL DEFAULT 0,
            connected_at_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            disconnected_at_ms INTEGER,
            ip TEXT NOT NULL DEFAULT '',
            real_ip TEXT NOT NULL DEFAULT '',
            country_code TEXT NOT NULL DEFAULT '',
            country TEXT NOT NULL DEFAULT '',
            region TEXT NOT NULL DEFAULT '',
            region_code TEXT NOT NULL DEFAULT '',
            city TEXT NOT NULL DEFAULT '',
            latitude REAL,
            longitude REAL,
            continent TEXT NOT NULL DEFAULT '',
            continent_code TEXT NOT NULL DEFAULT '',
            dongle_id TEXT NOT NULL DEFAULT '',
            profile_id TEXT NOT NULL DEFAULT '',
            frequency_hz INTEGER NOT NULL DEFAULT 0,
            mode TEXT NOT NULL DEFAULT '',
            bandwidth INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen
            ON user_sessions(last_seen_ms);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_connected
            ON user_sessions(connected_at_ms);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_persistent
            ON user_sessions(persistent_id);",
    )
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, connected: i64, geo: Option<GeoInfo>) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            persistent_id: format!("user-{id}"),
            conn_index: 1,
            connected_at_ms: connected,
            ip: "192.0.2.1".into(),
            real_ip: String::new(),
            geo,
            dongle_id: "d1".into(),
            profile_id: "p1".into(),
            frequency_hz: 27_265_000,
            mode: "ft8".into(),
            bandwidth: 3_000,
        }
    }

    fn geo(country: &str, region: &str, city: &str, lat: f64, lon: f64) -> GeoInfo {
        GeoInfo {
            country_code: country.into(),
            country: "Testland".into(),
            region: region.into(),
            region_code: String::new(),
            city: city.into(),
            latitude: Some(lat),
            longitude: Some(lon),
            continent: "Europe".into(),
            continent_code: "EU".into(),
        }
    }

    #[test]
    fn live_map_keeps_recent_disconnects_but_not_old_ones() {
        let dir = tempfile::tempdir().unwrap();
        let store = UserStore::open(dir.path().join("users.sqlite"));
        let now = now_ms();
        store.start_session(&session(
            "active",
            now,
            Some(geo("GR", "Attica", "Athens", 37.9, 23.7)),
        ));
        store.start_session(&session(
            "recent",
            now - 10 * 60_000,
            Some(geo("US", "CA", "X", 1.0, 2.0)),
        ));
        store.start_session(&session(
            "old",
            now - 2 * 3_600_000,
            Some(geo("DE", "BE", "Y", 3.0, 4.0)),
        ));
        close_at(&store, "recent", now);
        close_at(&store, "old", now - 2 * 3_600_000);

        let rows = store.live_map(60);
        let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        assert!(ids.contains(&"active"));
        assert!(ids.contains(&"recent"));
        assert!(!ids.contains(&"old"));
    }

    fn close_at(store: &UserStore, id: &str, at: i64) {
        store
            .conn
            .lock()
            .execute(
                "UPDATE user_sessions
                 SET disconnected_at_ms = ?2, last_seen_ms = ?2
                 WHERE id = ?1",
                params![id, at],
            )
            .unwrap();
    }

    #[test]
    fn analytics_counts_locations_modes_and_frequencies() {
        let dir = tempfile::tempdir().unwrap();
        let store = UserStore::open(dir.path().join("users.sqlite"));
        let now = now_ms();
        store.start_session(&session(
            "a",
            now - 60_000,
            Some(geo("GR", "Attica", "Athens", 37.9, 23.7)),
        ));
        store.start_session(&session(
            "b",
            now - 50_000,
            Some(geo("GR", "Attica", "Athens", 37.9, 23.7)),
        ));
        store.start_session(&session(
            "c",
            now - 40_000,
            Some(geo("US", "CA", "Mountain View", 37.4, -122.1)),
        ));
        store.close_session("a");
        store.close_session("b");
        store.close_session("c");

        let value = store.analytics(now - 120_000, now + 1_000);
        assert_eq!(value["sessions"], 3);
        assert_eq!(value["uniqueUsers"], 3);
        assert_eq!(value["countries"], 2);
        assert_eq!(value["topModes"][0]["mode"], "ft8");
        assert_eq!(value["topFrequencies"][0]["frequencyHz"], 27_260_000);
        assert!(value["mapPoints"].as_array().unwrap().len() >= 2);
        assert!(value["peakConcurrent"].as_i64().unwrap() >= 1);
        assert!(value["concurrency"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["count"].as_i64().unwrap_or(0) > 0));
    }

    #[test]
    fn purge_removes_only_old_closed_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = UserStore::open(dir.path().join("users.sqlite"));
        let now = now_ms();
        store.start_session(&session("open", now, None));
        let mut old = session("old", now - 100 * 86_400_000, None);
        old.id = "old".into();
        store.start_session(&old);
        close_at(&store, "old", now - 100 * 86_400_000);
        assert_eq!(store.purge(90), 1);
        let rows = store.live_map(60);
        assert!(rows.iter().any(|row| row["id"] == "open"));
    }

    #[test]
    fn clear_history_keeps_current_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let store = UserStore::open(dir.path().join("users.sqlite"));
        let now = now_ms();
        store.start_session(&session("open", now, None));
        store.start_session(&session("closed", now, None));
        store.close_session("closed");
        assert_eq!(store.clear_all(), 1);
        let rows = store.live_map(60);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "open");
    }
}
