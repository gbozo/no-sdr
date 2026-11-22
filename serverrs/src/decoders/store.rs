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
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
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

/// Which configured decoders may appear in a public API response, and how long
/// each decoder's rows remain visible.
#[derive(Debug, Clone, Default)]
pub struct HistoryVisibility {
    /// Configured decoder id and its effective retention in days. 0 means no
    /// age cutoff for that decoder.
    pub decoders: Vec<(String, i64)>,
    /// Retention applied to foreground (`client-*`) decoders and to any
    /// decoder no longer present in the configuration.
    pub global_retention_days: i64,
}

/// Filters for the persisted-message history API.
#[derive(Debug, Clone, Default)]
pub struct HistoryQuery {
    pub mode: Option<String>,
    pub decoder_id: Option<String>,
    pub dongle_id: Option<String>,
    pub search: Option<String>,
    pub since_ms: Option<i64>,
    pub until_ms: Option<i64>,
    pub limit: usize,
    pub offset: usize,
    /// `None` disables configuration-based filtering (admin/audit mode).
    pub visibility: Option<HistoryVisibility>,
    /// Query time used to evaluate visibility retention. 0 means "now".
    pub now_ms: i64,
}

/// Rows removed by a retention/capacity purge.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct PurgeResult {
    pub messages: usize,
    pub entities: usize,
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

/// Which field of an entity JSON payload is its stable key.
#[derive(Clone, Copy)]
enum EntityKey {
    Icao,
    Mmsi,
}

/// Minimum interval between entity-table writes for one decoder. Last-seen
/// timestamps are minute-scale data, so five seconds is plenty.
const ENTITY_WRITE_INTERVAL_MS: i64 = 5_000;

/// Defensive upper bound for one history page.
const MAX_HISTORY_LIMIT: usize = 5_000;

impl DecoderStore {
    pub fn open(path: impl AsRef<Path>) -> Arc<Self> {
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
        Arc::new(Self {
            conn,
            path,
            entity_writes: Mutex::new(HashMap::new()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn insert(&self, record: &DecoderRecord<'_>) {
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
    }

    /// Recent messages for the legacy `/api/decoder/messages` endpoint.
    pub fn recent(&self, mode: Option<&str>, since_ms: i64, limit: usize) -> Vec<Value> {
        let query = HistoryQuery {
            mode: mode.map(str::to_string),
            since_ms: Some(since_ms),
            limit,
            ..Default::default()
        };
        self.history(&query).0
    }

    /// One page of persisted messages plus the total number matching the
    /// filters. Newest first.
    pub fn history(&self, query: &HistoryQuery) -> (Vec<Value>, i64) {
        let Some(conn) = &self.conn else {
            return (Vec::new(), 0);
        };
        let conn = conn.lock();
        let (filter, params) = message_filter(query);
        let count_sql = format!("SELECT COUNT(*) FROM decoder_messages{filter}");
        let total = conn
            .query_row(&count_sql, params_from_iter(params.iter()), |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0);

        let limit = query.limit.clamp(1, MAX_HISTORY_LIMIT) as i64;
        let offset = query.offset as i64;
        let sql = format!(
            "SELECT id, decoder_id, dongle_id, mode, received_ms, text,
                    frequency_hz, audio_hz, snr_db, dt_sec, period, payload
             FROM decoder_messages{filter}
             ORDER BY received_ms DESC, id DESC LIMIT ? OFFSET ?"
        );
        let mut page_params = params;
        page_params.push(SqlValue::Integer(limit));
        page_params.push(SqlValue::Integer(offset));

        let Ok(mut stmt) = conn.prepare(&sql) else {
            return (Vec::new(), total);
        };
        let rows = stmt.query_map(params_from_iter(page_params.iter()), row_to_json);
        let out = rows
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default();
        (out, total)
    }

    /// Per-mode and per-decoder message counts for the admin/history summary.
    pub fn summary(&self) -> Value {
        let Some(conn) = &self.conn else {
            return json!({"modes": [], "decoders": [], "total": 0, "entities": []});
        };
        let conn = conn.lock();
        let mut decoders = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT mode, decoder_id, dongle_id, COUNT(*), MAX(received_ms), MIN(received_ms)
             FROM decoder_messages
             GROUP BY mode, decoder_id, dongle_id
             ORDER BY MAX(received_ms) DESC",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok(json!({
                    "mode": row.get::<_, String>(0)?,
                    "decoderId": row.get::<_, String>(1)?,
                    "dongleId": row.get::<_, String>(2)?,
                    "count": row.get::<_, i64>(3)?,
                    "latestMs": row.get::<_, i64>(4)?,
                    "oldestMs": row.get::<_, i64>(5)?,
                }))
            }) {
                decoders.extend(rows.flatten());
            }
        }

        // Aggregate the same rows by mode. Keeping this in Rust avoids a
        // second grouped query and guarantees both views agree.
        let mut modes: HashMap<String, (i64, i64, i64, i64)> = HashMap::new();
        for entry in &decoders {
            let mode = entry["mode"].as_str().unwrap_or_default().to_string();
            let count = entry["count"].as_i64().unwrap_or(0);
            let latest = entry["latestMs"].as_i64().unwrap_or(0);
            let oldest = entry["oldestMs"].as_i64().unwrap_or(0);
            let slot = modes.entry(mode).or_insert((0, 0, i64::MAX, 0));
            slot.0 += count;
            slot.1 += 1;
            slot.2 = slot.2.min(oldest);
            slot.3 = slot.3.max(latest);
        }
        let mut mode_rows: Vec<Value> = modes
            .into_iter()
            .map(|(mode, (count, decoders, oldest, latest))| {
                json!({
                    "mode": mode,
                    "count": count,
                    "decoders": decoders,
                    "oldestMs": oldest,
                    "latestMs": latest,
                })
            })
            .collect();
        mode_rows.sort_by(|a, b| {
            b["count"]
                .as_i64()
                .unwrap_or(0)
                .cmp(&a["count"].as_i64().unwrap_or(0))
        });

        let mut entities = Vec::new();
        if let Ok(mut stmt) = conn
            .prepare("SELECT kind, COUNT(*), MAX(last_seen_ms) FROM decoder_entities GROUP BY kind")
        {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok(json!({
                    "kind": row.get::<_, String>(0)?,
                    "count": row.get::<_, i64>(1)?,
                    "latestMs": row.get::<_, i64>(2)?,
                }))
            }) {
                entities.extend(rows.flatten());
            }
        }

        let total: i64 = decoders
            .iter()
            .map(|entry| entry["count"].as_i64().unwrap_or(0))
            .sum();
        json!({
            "modes": mode_rows,
            "decoders": decoders,
            "entities": entities,
            "total": total,
        })
    }

    /// Remove expired rows and enforce the optional row cap. Returns what was
    /// deleted so the maintenance loop can log only meaningful purges.
    pub fn purge(&self, retention_days: i64, max_messages: i64) -> PurgeResult {
        self.purge_with_decoders(retention_days, max_messages, &[])
    }

    /// Apply one decoder's own retention where configured, the global
    /// retention everywhere else, then enforce the global message cap.
    ///
    /// Per-decoder retention is allowed to be longer or shorter than the
    /// global value, so a single blanket DELETE cannot implement it.
    pub fn purge_with_decoders(
        &self,
        retention_days: i64,
        max_messages: i64,
        decoder_retention: &[(String, i64)],
    ) -> PurgeResult {
        let Some(conn) = &self.conn else {
            return PurgeResult::default();
        };
        let conn = conn.lock();
        let mut result = PurgeResult::default();
        let now = now_ms();
        let configured: HashMap<&str, i64> = decoder_retention
            .iter()
            .map(|(id, days)| (id.as_str(), *days))
            .collect();
        let effective_days = |decoder_id: &str| -> i64 {
            if decoder_id.starts_with("client-") {
                return retention_days;
            }
            configured
                .get(decoder_id)
                .copied()
                .filter(|days| *days > 0)
                .unwrap_or(retention_days)
        };

        // Messages: one DELETE per distinct decoder id, using that decoder's
        // effective retention.
        let mut decoder_ids = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT decoder_id FROM decoder_messages") {
            if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                decoder_ids.extend(rows.flatten());
            }
        }
        for decoder_id in decoder_ids {
            let days = effective_days(&decoder_id);
            if days <= 0 {
                continue;
            }
            let cutoff = now - days.saturating_mul(86_400_000);
            result.messages += conn
                .execute(
                    "DELETE FROM decoder_messages
                     WHERE decoder_id = ?1 AND received_ms < ?2",
                    params![decoder_id, cutoff],
                )
                .unwrap_or(0);
        }

        // Entities: group by kind and originating decoder id. The decoder id
        // lives inside the JSON payload so ADS-B/AIS rows follow the same
        // per-decoder policy.
        let mut entity_groups: Vec<(String, Option<String>)> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT DISTINCT kind, json_extract(payload, '$.decoderId')
             FROM decoder_entities",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            }) {
                entity_groups.extend(rows.flatten());
            }
        }
        for (kind, decoder_id) in entity_groups {
            let days = decoder_id
                .as_deref()
                .map(effective_days)
                .unwrap_or(retention_days);
            if days <= 0 {
                continue;
            }
            let cutoff = now - days.saturating_mul(86_400_000);
            let deleted = match decoder_id {
                Some(decoder_id) => conn.execute(
                    "DELETE FROM decoder_entities
                     WHERE kind = ?1
                       AND json_extract(payload, '$.decoderId') = ?2
                       AND last_seen_ms < ?3",
                    params![kind, decoder_id, cutoff],
                ),
                None => conn.execute(
                    "DELETE FROM decoder_entities
                     WHERE kind = ?1
                       AND json_extract(payload, '$.decoderId') IS NULL
                       AND last_seen_ms < ?2",
                    params![kind, cutoff],
                ),
            }
            .unwrap_or(0);
            result.entities += deleted;
        }

        if max_messages > 0 {
            result.messages += conn
                .execute(
                    "DELETE FROM decoder_messages
                     WHERE id NOT IN (
                         SELECT id FROM decoder_messages
                         ORDER BY received_ms DESC, id DESC LIMIT ?1
                     )",
                    params![max_messages],
                )
                .unwrap_or(0);
        }

        if result.messages > 0 || result.entities > 0 {
            info!(
                messages = result.messages,
                entities = result.entities,
                retention_days,
                max_messages,
                decoder_overrides = decoder_retention.len(),
                "decoder database purged"
            );
        }
        result
    }

    /// Delete all history for one mode, or everything when `mode` is `None`.
    /// ADS-B/AIS messages live in the entity table, so their mode also clears
    /// the corresponding entity kind.
    pub fn clear(&self, mode: Option<&str>) -> PurgeResult {
        let Some(conn) = &self.conn else {
            return PurgeResult::default();
        };
        let conn = conn.lock();
        let mut result = PurgeResult::default();
        let mode = mode.map(str::trim).filter(|value| !value.is_empty());

        if let Some(mode) = mode {
            result.messages += conn
                .execute(
                    "DELETE FROM decoder_messages WHERE mode = ?1 COLLATE NOCASE",
                    params![mode],
                )
                .unwrap_or(0);
            let kind = match mode.to_ascii_lowercase().as_str() {
                "adsb" => Some("aircraft"),
                "ais" => Some("vessel"),
                _ => None,
            };
            if let Some(kind) = kind {
                result.entities += conn
                    .execute(
                        "DELETE FROM decoder_entities WHERE kind = ?1",
                        params![kind],
                    )
                    .unwrap_or(0);
            }
        } else {
            result.messages += conn
                .execute("DELETE FROM decoder_messages", [])
                .unwrap_or(0);
            result.entities += conn
                .execute("DELETE FROM decoder_entities", [])
                .unwrap_or(0);
        }

        if result.messages > 0 || result.entities > 0 {
            info!(
                mode = mode.unwrap_or("*"),
                messages = result.messages,
                entities = result.entities,
                "decoder history cleared"
            );
        }
        result
    }

    /// Upsert one row per aircraft, keyed by its ICAO address.
    ///
    /// ADS-B re-sends the whole table twice a second: writing that into
    /// `decoder_messages` would bury real decodes in position spam, so the
    /// table is kept as keyed entities instead and only changes are written.
    pub fn upsert_aircraft(&self, decoder_id: &str, dongle_id: &str, aircraft: &[Value]) {
        self.upsert_entities(
            "aircraft",
            EntityKey::Icao,
            decoder_id,
            dongle_id,
            aircraft,
            now_ms(),
        );
    }

    pub fn upsert_vessels(&self, decoder_id: &str, dongle_id: &str, vessels: &[Value]) {
        self.upsert_entities(
            "vessel",
            EntityKey::Mmsi,
            decoder_id,
            dongle_id,
            vessels,
            now_ms(),
        );
    }

    #[cfg(test)]
    fn upsert_aircraft_at(&self, decoder_id: &str, dongle_id: &str, aircraft: &[Value], now: i64) {
        self.upsert_entities(
            "aircraft",
            EntityKey::Icao,
            decoder_id,
            dongle_id,
            aircraft,
            now,
        );
    }

    fn upsert_entities(
        &self,
        kind: &str,
        key_kind: EntityKey,
        decoder_id: &str,
        dongle_id: &str,
        entities: &[Value],
        now: i64,
    ) {
        let Some(conn) = &self.conn else {
            return;
        };
        if entities.is_empty() {
            return;
        }
        let write_key = format!("{kind}\u{1f}{decoder_id}\u{1f}{dongle_id}");
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
        for entry in entities {
            let key = match key_kind {
                EntityKey::Icao => entry
                    .get("icao")
                    .and_then(Value::as_u64)
                    .map(|v| format!("{:06X}", v & 0xff_ffff)),
                EntityKey::Mmsi => entry
                    .get("mmsi")
                    .and_then(Value::as_u64)
                    .map(|v| v.to_string()),
            };
            let Some(key) = key else {
                continue;
            };
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
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(kind, entity_key) DO UPDATE SET
                     payload = excluded.payload,
                     first_seen_ms = MIN(decoder_entities.first_seen_ms, excluded.first_seen_ms),
                     last_seen_ms = excluded.last_seen_ms",
                params![kind, key, payload.to_string(), first_seen, last_seen],
            );
            if let Err(e) = result {
                warn!(error = %e, "decoder entity upsert failed");
            }
        }
    }

    /// Read keyed entities of one kind, newest first.
    pub fn entities(&self, kind: &str, limit: usize) -> Vec<Value> {
        let Some(conn) = &self.conn else {
            return Vec::new();
        };
        let conn = conn.lock();
        let limit = limit.clamp(1, 5000) as i64;
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

    /// Entities of one kind updated at or after `since_ms`, oldest first.
    pub fn entities_since(&self, kind: &str, since_ms: i64, limit: usize) -> Vec<Value> {
        let Some(conn) = &self.conn else {
            return Vec::new();
        };
        let conn = conn.lock();
        let limit = limit.clamp(1, 5000) as i64;
        let Ok(mut stmt) = conn.prepare(
            "SELECT kind, entity_key, payload, first_seen_ms, last_seen_ms
             FROM decoder_entities
             WHERE kind = ?1 AND last_seen_ms >= ?2
             ORDER BY last_seen_ms ASC LIMIT ?3",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![kind, since_ms, limit], |row| {
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

    /// Recent persisted decodes that carry a Maidenhead grid, plus FT8-family
    /// rows whose grid may only be extractable from the message text.
    pub fn grid_messages(&self, since_ms: i64, limit: usize) -> Vec<Value> {
        self.decode_messages_matching(
            "received_ms >= ?1 AND (json_extract(payload, '$.grid') IS NOT NULL \
             OR mode IN ('ft8', 'ft4', 'ft2'))",
            since_ms,
            limit,
        )
    }

    /// Recent APRS/HFDL-style decodes carrying latitude/longitude fixes.
    pub fn position_messages(&self, since_ms: i64, limit: usize) -> Vec<Value> {
        self.decode_messages_matching(
            "received_ms >= ?1 AND (json_extract(payload, '$.lat') IS NOT NULL \
             OR json_extract(payload, '$.aprs.lat') IS NOT NULL)",
            since_ms,
            limit,
        )
    }

    fn decode_messages_matching(&self, condition: &str, since_ms: i64, limit: usize) -> Vec<Value> {
        let Some(conn) = &self.conn else {
            return Vec::new();
        };
        let conn = conn.lock();
        let limit = limit.clamp(1, 5000) as i64;
        let sql = format!(
            "SELECT id, decoder_id, dongle_id, mode, received_ms, text,
                    frequency_hz, audio_hz, snr_db, dt_sec, period, payload
             FROM decoder_messages
             WHERE {condition}
             ORDER BY received_ms DESC, id DESC LIMIT ?2"
        );
        let Ok(mut stmt) = conn.prepare(&sql) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![since_ms, limit], row_to_json);
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
        let (oldest, newest): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT MIN(received_ms), MAX(received_ms) FROM decoder_messages",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or((None, None));
        let db_bytes = std::fs::metadata(&self.path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        json!({
            "enabled": true,
            "path": self.path,
            "messages": count,
            "entities": entities,
            "oldestMs": oldest,
            "newestMs": newest,
            "dbBytes": db_bytes,
        })
    }
}

/// Build the shared WHERE clause and its positional parameters.
fn message_filter(query: &HistoryQuery) -> (String, Vec<SqlValue>) {
    let mut sql = String::from(" WHERE 1=1");
    let mut params = Vec::new();
    let now = if query.now_ms > 0 {
        query.now_ms
    } else {
        now_ms()
    };

    if let Some(visibility) = &query.visibility {
        sql.push_str(" AND ((decoder_id LIKE 'client-%'");
        if visibility.global_retention_days > 0 {
            sql.push_str(" AND received_ms >= ?");
            params.push(SqlValue::Integer(
                now - visibility
                    .global_retention_days
                    .saturating_mul(86_400_000),
            ));
        }
        sql.push(')');
        for (decoder_id, retention_days) in &visibility.decoders {
            sql.push_str(" OR (decoder_id = ?");
            params.push(SqlValue::Text(decoder_id.clone()));
            if *retention_days > 0 {
                sql.push_str(" AND received_ms >= ?");
                params.push(SqlValue::Integer(
                    now - retention_days.saturating_mul(86_400_000),
                ));
            }
            sql.push(')');
        }
        sql.push(')');
    }

    if let Some(mode) = query
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        sql.push_str(" AND mode = ? COLLATE NOCASE");
        params.push(SqlValue::Text(mode.to_string()));
    }
    if let Some(decoder_id) = query
        .decoder_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        sql.push_str(" AND decoder_id = ?");
        params.push(SqlValue::Text(decoder_id.to_string()));
    }
    if let Some(dongle_id) = query
        .dongle_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        sql.push_str(" AND dongle_id = ?");
        params.push(SqlValue::Text(dongle_id.to_string()));
    }
    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        sql.push_str(" AND text LIKE ? ESCAPE '\\'");
        params.push(SqlValue::Text(format!("%{}%", escape_like(search))));
    }
    if let Some(since_ms) = query.since_ms {
        sql.push_str(" AND received_ms >= ?");
        params.push(SqlValue::Integer(since_ms));
    }
    if let Some(until_ms) = query.until_ms {
        sql.push_str(" AND received_ms <= ?");
        params.push(SqlValue::Integer(until_ms));
    }
    (sql, params)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
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
        CREATE INDEX IF NOT EXISTS idx_decoder_messages_decoder_time
            ON decoder_messages(decoder_id, received_ms);
        CREATE TABLE IF NOT EXISTS decoder_entities (
            kind TEXT NOT NULL,
            entity_key TEXT NOT NULL,
            payload TEXT NOT NULL,
            first_seen_ms INTEGER NOT NULL,
            last_seen_ms INTEGER NOT NULL,
            PRIMARY KEY(kind, entity_key)
        );
        CREATE INDEX IF NOT EXISTS idx_decoder_entities_seen
            ON decoder_entities(last_seen_ms);",
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
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"));
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
        store.insert(&record);
        let rows = store.recent(Some("ft8"), 0, 10);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["text"], "CQ N0CALL");
        assert_eq!(rows[0]["mode"], "ft8");
        assert_eq!(rows[0]["frequencyHz"], 14_074_195.0);
    }

    #[test]
    fn history_filters_paginates_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"));
        for (mode, text, freq) in [
            ("ft8", "CQ N0CALL", 14_074_195.0),
            ("ft8", "CQ K1ABC", 14_074_400.0),
            ("ft4", "CQ DL1ABC", 14_080_100.0),
        ] {
            store.insert(&DecoderRecord {
                decoder_id: "decoder",
                dongle_id: "d1",
                mode,
                text,
                frequency_hz: freq,
                audio_hz: 1_500.0,
                snr_db: -12.0,
                dt_sec: 0.2,
                period: 42,
                payload: "{}",
            });
        }

        let (rows, total) = store.history(&HistoryQuery {
            mode: Some("ft8".to_string()),
            limit: 1,
            ..Default::default()
        });
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 1);

        let (rows, total) = store.history(&HistoryQuery {
            mode: Some("ft8".to_string()),
            offset: 1,
            limit: 1,
            ..Default::default()
        });
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["text"], "CQ N0CALL");

        let (rows, total) = store.history(&HistoryQuery {
            search: Some("DL1".to_string()),
            ..Default::default()
        });
        assert_eq!(total, 1);
        assert_eq!(rows[0]["text"], "CQ DL1ABC");
    }

    #[test]
    fn purge_removes_old_rows_and_enforces_cap() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"));
        for i in 0..5 {
            store.insert(&DecoderRecord {
                decoder_id: "decoder",
                dongle_id: "d1",
                mode: "ft8",
                text: &format!("message {i}"),
                frequency_hz: 14_074_000.0,
                audio_hz: 1_500.0,
                snr_db: 0.0,
                dt_sec: 0.0,
                period: i,
                payload: "{}",
            });
        }
        let result = store.purge(0, 2);
        assert_eq!(result.messages, 3);
        assert_eq!(store.stats()["messages"], 2);

        let result = store.clear(Some("ft8"));
        assert_eq!(result.messages, 2);
        assert_eq!(store.stats()["messages"], 0);
    }

    fn insert_at(
        store: &DecoderStore,
        decoder_id: &str,
        mode: &str,
        text: &str,
        received_ms: i64,
    ) {
        let conn = store.conn.as_ref().unwrap().lock();
        conn.execute(
            "INSERT INTO decoder_messages
             (decoder_id, dongle_id, mode, received_ms, text, frequency_hz, audio_hz,
              snr_db, dt_sec, period, payload)
             VALUES (?1, 'd1', ?2, ?3, ?4, 14074000.0, 1500.0, -10.0, 0.0, 1, '{}')",
            params![decoder_id, mode, received_ms, text],
        )
        .unwrap();
    }

    #[test]
    fn per_decoder_retention_overrides_global_retention() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"));
        let now = now_ms();
        let old = now - 10 * 86_400_000;
        insert_at(&store, "decoder-a", "ft8", "A old", old);
        insert_at(&store, "decoder-b", "ft8", "B old", old);
        insert_at(&store, "client-1", "ft8", "client old", old);

        let old_secs = old / 1000;
        store.upsert_aircraft_at(
            "adsb-a",
            "d1",
            &[json!({"icao": 0x40621d, "last_at": old_secs})],
            now,
        );
        store.upsert_aircraft_at(
            "adsb-b",
            "d1",
            &[json!({"icao": 0x4ca123, "last_at": old_secs})],
            now + 1,
        );

        let result = store.purge_with_decoders(
            5, // global: 5 days
            0,
            &[
                ("decoder-a".to_string(), 30),
                ("decoder-b".to_string(), 1),
                ("adsb-a".to_string(), 30),
                ("adsb-b".to_string(), 1),
            ],
        );
        assert_eq!(result.messages, 2, "b and the foreground client expire");
        assert_eq!(result.entities, 1, "only adsb-b expires");
        let rows = store.recent(None, 0, 20);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["decoderId"], "decoder-a");
        let aircraft = store.entities("aircraft", 10);
        assert_eq!(aircraft.len(), 1);
        assert_eq!(aircraft[0]["payload"]["decoderId"], "adsb-a");
    }

    #[test]
    fn visibility_hides_removed_decoders_and_respects_retention() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"));
        let now = now_ms();
        let old = now - 10 * 86_400_000;
        let recent = now - 86_400_000;
        insert_at(&store, "decoder-a", "ft8", "A old", old);
        insert_at(&store, "decoder-a", "ft8", "A recent", recent);
        insert_at(&store, "decoder-b", "ft8", "B old", old);
        insert_at(&store, "decoder-b", "ft8", "B recent", recent);
        insert_at(&store, "client-1", "ft8", "client old", old);
        insert_at(&store, "client-1", "ft8", "client recent", recent);
        insert_at(&store, "removed", "ft8", "removed recent", recent);

        let visibility = HistoryVisibility {
            decoders: vec![
                ("decoder-a".to_string(), 30),
                ("decoder-b".to_string(), 1),
            ],
            global_retention_days: 5,
        };
        let (rows, total) = store.history(&HistoryQuery {
            visibility: Some(visibility),
            now_ms: now,
            limit: 20,
            ..Default::default()
        });
        assert_eq!(total, 4);
        let texts: Vec<&str> = rows
            .iter()
            .filter_map(|row| row["text"].as_str())
            .collect();
        assert!(texts.contains(&"A old"));
        assert!(texts.contains(&"A recent"));
        assert!(texts.contains(&"B recent"));
        assert!(texts.contains(&"client recent"));
        assert!(!texts.contains(&"B old"));
        assert!(!texts.contains(&"client old"));
        assert!(!texts.contains(&"removed recent"));

        let (_, total_unfiltered) = store.history(&HistoryQuery {
            limit: 20,
            ..Default::default()
        });
        assert_eq!(total_unfiltered, 7);
    }

    #[test]
    fn aircraft_entities_upsert_by_icao() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"));
        let first = vec![json!({
            "icao": 0x40621d,
            "callsign": "",
            "altitude_ft": 38000,
            "first_at": 1_760_000_000,
            "last_at": 1_760_000_001,
        })];
        store.upsert_aircraft_at("adsb-local", "d1", &first, 1_760_000_000_000);
        let second = vec![json!({
            "icao": 0x40621d,
            "callsign": "BAW123",
            "lat": 51.5,
            "lon": -0.1,
            "first_at": 1_760_000_000,
            "last_at": 1_760_000_002,
        })];
        store.upsert_aircraft_at("adsb-local", "d1", &second, 1_760_000_010_000);

        let rows = store.entities("aircraft", 10);
        assert_eq!(rows.len(), 1, "one row per ICAO");
        assert_eq!(rows[0]["key"], "40621D");
        assert_eq!(rows[0]["payload"]["callsign"], "BAW123");
        assert_eq!(rows[0]["payload"]["dongleId"], "d1");
        assert_eq!(rows[0]["firstSeenMs"], 1_760_000_000_000i64);
        assert_eq!(rows[0]["lastSeenMs"], 1_760_000_002_000i64);
    }

    #[test]
    fn vessels_upsert_by_mmsi() {
        let dir = tempfile::tempdir().unwrap();
        let store = DecoderStore::open(dir.path().join("decoders.sqlite"));
        let first = vec![json!({
            "mmsi": 237123456,
            "name": "",
            "sog_kt": 8.4,
            "first_at": 1_760_000_000,
            "last_at": 1_760_000_001,
        })];
        store.upsert_entities(
            "vessel",
            EntityKey::Mmsi,
            "ais-162",
            "d1",
            &first,
            1_760_000_000_000,
        );
        let second = vec![json!({
            "mmsi": 237123456,
            "name": "AGIOS NIKOLAOS",
            "lat": 37.95,
            "lon": 23.64,
            "first_at": 1_760_000_000,
            "last_at": 1_760_000_002,
        })];
        store.upsert_entities(
            "vessel",
            EntityKey::Mmsi,
            "ais-162",
            "d1",
            &second,
            1_760_000_010_000,
        );

        let rows = store.entities("vessel", 10);
        assert_eq!(rows.len(), 1, "one row per MMSI");
        assert_eq!(rows[0]["key"], "237123456");
        assert_eq!(rows[0]["payload"]["name"], "AGIOS NIKOLAOS");
        assert_eq!(rows[0]["payload"]["dongleId"], "d1");
    }
}

/// Default path when the config leaves it empty.
pub fn default_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("decoders.sqlite")
}
