//! SQLite persistence for decoder results.
//!
//! One connection guarded by a mutex is enough for the decoder workers and the
//! read API: writes are small, occasional and ordered. WAL keeps readers from
//! blocking a slot's insert.

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
}

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
        Arc::new(Self { conn, path })
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
        json!({"enabled": true, "path": self.path, "messages": count})
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
}

/// Default path when the config leaves it empty.
pub fn default_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("decoders.sqlite")
}
