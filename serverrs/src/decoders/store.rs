//! SQLite persistence for decoder results.
//!
//! One connection guarded by a mutex is enough for the decoder workers and the
//! read API: writes are small, occasional and ordered. WAL keeps readers from
//! blocking a slot's insert.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tracing::{info, warn};

/// One decoded message as written to SQLite.
pub struct DecoderRecord<'a> {
    pub decoder_id: &'a str,
    pub dongle_id: &'a str,
    pub mode: &'a str,
    pub text: &'a str,
    pub frequency_hz: f64,
    pub audio_hz: f64,
    pub snr_db: f64,
    pub dt_sec: f64,
    pub period: i64,
    pub payload: &'a str,
}

/// Decoder result store. A failed open leaves `conn` empty; decoding keeps
/// running and the API simply reports no history.
pub struct DecoderStore {
    conn: Option<Mutex<Connection>>,
    path: PathBuf,
    /// Last entity-table write per decoder/dongle. Snapshots arrive twice a
    /// second; persisting every one would turn an aircraft table into a
    /// thousand-row-per-second write storm for no extra information.
    entity_writes: Mutex<HashMap<String, i64>>,
}

/// Minimum interval between entity-table writes for one decoder. Last-seen
/// timestamps are minute-scale data, so five seconds is plenty.
const ENTITY_WRITE_INTERVAL_MS: i64 = 5_000;

impl DecoderStore {
    pub fn open(path: impl AsRef<Path>, retention_days: i64) -> Arc<Self> {
        let path = path.as_ref().to_path_buf();
        let conn = match open_connection(&path) {
            Ok(conn) => {
                if let Err(e) = migrate(&conn) {
                    warn!(path = %path.display(), error = %e, "decoder database migration failed");
                    None
                } else {
                    info!(path = %path.display(), "decoder database ready");
                    Some(Mutex::new(conn))
                }
            }
            Err(e) => {
                warn!(path = %path.display(), error = %e, "decoder database unavailable");
                None
            }
        };
        if retention_days > 0 {
            if let Some(conn) = &conn {
                let cutoff = now_ms() - retention_days.saturating_mul(86_400_000);
                let _ = conn.lock().execute(
                    "DELETE FROM decoder_messages WHERE received_ms < ?1",
                    params![cutoff],
                );
            }
        }
        Arc::new(Self {
            conn,
            path,
            entity_writes: Mutex::new(HashMap::new()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn insert(&self, record: &DecoderRecord<'_>, retention_days: i64) {
        let Some(conn) = &self.conn else {
            return;
        };
        let conn = conn.lock();
        let received_ms = now_ms();
        let result = conn.execute(
            "INSERT INTO decoder_messages
             (decoder_id, dongle_id, mode, received_ms, text, frequency_hz, audio_hz,
              snr_db, dt_sec, period, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                record.decoder_id,
                record.dongle_id,
                record.mode,
                received_ms,
                record.text,
                record.frequency_hz,
                record.audio_hz,
                record.snr_db,
                record.dt_sec,
                record.period,
                record.payload,
            ],
        );
        if let Err(e) = result {
            warn!(error = %e, "decoder database insert failed");
        }
        if retention_days > 0 {
            let cutoff = received_ms - retention_days.saturating_mul(86_400_000);
            let _ = conn.execute(
                "DELETE FROM decoder_messages WHERE received_ms < ?1",
                params![cutoff],
            );
        }
    }

    pub fn recent(&self, mode: Option<&str>, since_ms: i64, limit: usize) -> Vec<Value> {
        let Some(conn) = &self.conn else {
            return Vec::new();
        };
        let conn = conn.lock();
        let limit = limit.clamp(1, 1000) as i64;
        let mut out = Vec::new();
        if let Some(mode) = mode {
            let Ok(mut stmt) = conn.prepare(
                "SELECT id, decoder_id, dongle_id, mode, received_ms, text,
                        frequency_hz, audio_hz, snr_db, dt_sec, period, payload
                 FROM decoder_messages
                 WHERE mode = ?1 AND received_ms >= ?2
                 ORDER BY id DESC LIMIT ?3",
            ) else {
                return out;
            };
            let rows = stmt.query_map(params![mode, since_ms, limit], row_to_json);
            if let Ok(rows) = rows {
                out.extend(rows.flatten());
            }
        } else {
            let Ok(mut stmt) = conn.prepare(
                "SELECT id, decoder_id, dongle_id, mode, received_ms, text,
                        frequency_hz, audio_hz, snr_db, dt_sec, period, payload
                 FROM decoder_messages
                 WHERE received_ms >= ?1
                 ORDER BY id DESC LIMIT ?2",
            ) else {
                return out;
            };
            let rows = stmt.query_map(params![since_ms, limit], row_to_json);
            if let Ok(rows) = rows {
                out.extend(rows.flatten());
            }
        }
        out
    }

    /// Upsert one row per aircraft, keyed by its ICAO address.
    ///
    /// ADS-B re-sends the whole table twice a second: writing that into
    /// `decoder_messages` would bury real decodes in position spam, so the
    /// table is kept as keyed entities instead and only changes are written.
    pub fn upsert_aircraft(
        &self,
        decoder_id: &str,
        dongle_id: &str,
        aircraft: &[Value],
        retention_days: i64,
    ) {
        self.upsert_aircraft_at(decoder_id, dongle_id, aircraft, retention_days, now_ms());
    }

    fn upsert_aircraft_at(
        &self,
        decoder_id: &str,
        dongle_id: &str,
        aircraft: &[Value],
        retention_days: i64,
        now: i64,
    ) {
        let Some(conn) = &self.conn else {
            return;
        };
        if aircraft.is_empty() {
            return;
        }
        let write_key = format!("{decoder_id}\u{1f}{dongle_id}");
        {
            let mut writes = self.entity_writes.lock();
            if let Some(last) = writes.get(&write_key) {
                if now - *last < ENTITY_WRITE_INTERVAL_MS {
                    return;
                }
            }
            writes.insert(write_key, now);
        }
        let conn = conn.lock();
        for entry in aircraft {
            let Some(icao) = entry.get("icao").and_then(Value::as_u64) else {
                continue;
            };
            let key = format!("{:06X}", icao & 0xff_ffff);
            let first_seen = entry
                .get("first_at")
                .and_then(Value::as_i64)
                .filter(|v| *v > 0)
                .map(|s| s.saturating_mul(1000))
                .unwrap_or(now);
            let last_seen = entry
                .get("last_at")
                .and_then(Value::as_i64)
                .filter(|v| *v > 0)
                .map(|s| s.saturating_mul(1000))
                .unwrap_or(now);
            let mut payload = entry.clone();
            if let Some(object) = payload.as_object_mut() {
                object.insert("decoderId".to_string(), json!(decoder_id));
                object.insert("dongleId".to_string(), json!(dongle_id));
            }
            let result = conn.execute(
                "INSERT INTO decoder_entities
                 (kind, entity_key, payload, first_seen_ms, last_seen_ms)
                 VALUES ('aircraft', ?1, ?2, ?3, ?4)
                 ON CONFLICT(kind, entity_key) DO UPDATE SET
                     payload = excluded.payload,
                     first_seen_ms = MIN(decoder_entities.first_seen_ms, excluded.first_seen_ms),
                     last_seen_ms = excluded.last_seen_ms",
                params![key, payload.to_string(), first_seen, last_seen],
            );
            if let Err(e) = result {
                warn!(error = %e, "decoder entity upsert failed");
            }
        }
        if retention_days > 0 {
            let cutoff = now - retention_days.saturating_mul(86_400_000);
            let _ = conn.execute(
                "DELETE FROM decoder_entities WHERE last_seen_ms < ?1",
                params![cutoff],
            );
        }
    }

    /// Read keyed entities of one kind, newest first.
    pub fn entities(&self, kind: &str, limit: usize) -> Vec<Value> {
        let Some(conn) = &self.conn else {
            return Vec::new();
        };
        let conn = conn.lock();
        let limit = limit.clamp(1, 1000) as i64;
        let Ok(mut stmt) = conn.prepare(
            "SELECT kind, entity_key, payload, first_seen_ms, last_seen_ms
             FROM decoder_entities
             WHERE kind = ?1
             ORDER BY last_seen_ms DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![kind, limit], |row| {
            let payload: String = row.get(2)?;
            Ok(json!({
                "kind": row.get::<_, String>(0)?,
                "key": row.get::<_, String>(1)?,
                "firstSeenMs": row.get::<_, i64>(3)?,
                "lastSeenMs": row.get::<_, i64>(4)?,
                "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),
            }))
        });
        rows.map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    pub fn stats(&self) -> Value {
        let Some(conn) = &self.conn else {
            return json!({"enabled": false, "path": self.path});
        };
        let conn = conn.lock();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM decoder_messages", [], |row| {
                row.get(0)
            })
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0);
        let entities: i64 = conn
            .query_row("SELECT COUNT(*) FROM decoder_entities", [], |row| {
                row.get(0)
            })
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0);
        json!({
            "enabled": true,
            "path": self.path,
            "messages": count,
            "entities": entities,
        })
    }
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
        "CREATE TABLE IF NOT EXISTS decoder_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            decoder_id TEXT NOT NULL,
            dongle_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            received_ms INTEGER NOT NULL,
            text TEXT NOT NULL,
            frequency_hz REAL NOT NULL,
            audio_hz REAL NOT NULL,
            snr_db REAL NOT NULL,
            dt_sec REAL NOT NULL,
            period INTEGER NOT NULL,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_decoder_messages_mode_time
            ON decoder_messages(mode, received_ms);
        CREATE INDEX IF NOT EXISTS idx_decoder_messages_time
            ON decoder_messages(received_ms);
        CREATE TABLE IF NOT EXISTS decoder_entities (
            kind TEXT NOT NULL,
            entity_key TEXT NOT NULL,
            payload TEXT NOT NULL,
            first_seen_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            PRIMARY KEY(kind, entity_key)
        );",
    )
}

fn row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let payload: String = row.get(11)?;
    let payload = serde_json::from_str(&payload).unwrap_or(Value::Null);
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "decoderId": row.get::<_, String>(1)?,
        "dongleId": row.get::<_, String>(2)?,
        "mode": row.get::<_, String>(3)?,
        "receivedMs": row.get::<_, i64>(4)?,
        "text": row.get::<_, String>(5)?,
        "frequencyHz": row.get::<_, f64>(6)?,
        "audioHz": row.get::<_, f64>(7)?,
        "snrDb": row.get::<_, f64>(8)?,
        "dtSec": row.get::<_, f64>(9)?,
        "period": row.get::<_, i64>(10)?,
        "payload": payload,
    }))
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inserts_and_reads_messages() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"), 0);
        let record = DecoderRecord {
            decoder_id: "ft8-20m",
            dongle_id: "d1",
            mode: "ft8",
            text: "CQ N0CALL",
            frequency_hz: 14_074_195.0,
            audio_hz: 1_500.0,
            snr_db: -12.0,
            dt_sec: 0.2,
            period: 42,
            payload: r#"{"text":"CQ N0CALL"}"#,
        };
        store.insert(&record, 0);
        let rows = store.recent(Some("ft8"), 0, 10);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["text"], "CQ N0CALL");
        assert_eq!(rows[0]["mode"], "ft8");
        assert_eq!(rows[0]["frequencyHz"], 14_074_195.0);
    }

    #[test]
    fn aircraft_entities_upsert_by_icao() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"), 0);
        let first = vec![json!({
            "icao": 0x40621d,
            "callsign": "",
            "altitude_ft": 38000,
            "first_at": 1_760_000_000,
            "last_at": 1_760_000_001,
        })];
        store.upsert_aircraft_at("adsb-local", "d1", &first, 0, 1_760_000_000_000);
        let second = vec![json!({
            "icao": 0x40621d,
            "callsign": "BAW123",
            "lat": 51.5,
            "lon": -0.1,
            "first_at": 1_760_000_000,
            "last_at": 1_760_000_002,
        })];
        store.upsert_aircraft_at("adsb-local", "d1", &second, 0, 1_760_000_010_000);

        let rows = store.entities("aircraft", 10);
        assert_eq!(rows.len(), 1, "one row per ICAO");
        assert_eq!(rows[0]["key"], "40621D");
        assert_eq!(rows[0]["payload"]["callsign"], "BAW123");
        assert_eq!(rows[0]["payload"]["dongleId"], "d1");
        assert_eq!(rows[0]["firstSeenMs"], 1_760_000_000_000i64);
        assert_eq!(rows[0]["lastSeenMs"], 1_760_000_002_000i64);
    }
}

/// Default path when the config leaves it empty.
pub fn default_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("decoders.sqlite")
}
