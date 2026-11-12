//! SigMF IQ recorder.
//!
//! Ported from the original Go backend: raw uint8 IQ chunks are
//! appended to `.sigmf-data` and a `.sigmf-meta` sidecar is written on stop.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;

struct Recording {
    dongle_id: String,
    file: File,
    data_path: PathBuf,
    meta_path: PathBuf,
    center_freq: i64,
    sample_rate: i32,
    started_at: Instant,
    started_at_utc: chrono::DateTime<chrono::Utc>,
    bytes_written: i64,
}

/// Snapshot of an active recording.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub dongle_id: String,
    pub file: String,
    pub bytes_written: i64,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
}

/// Captures raw uint8 IQ samples from running dongles to disk.
pub struct Recorder {
    active: Mutex<HashMap<String, Recording>>,
    output_dir: PathBuf,
}

impl Recorder {
    pub fn new(output_dir: impl Into<PathBuf>) -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            output_dir: output_dir.into(),
        }
    }

    /// Begins recording IQ from `dongle_id`.
    pub fn start(&self, dongle_id: &str, center_freq: i64, sample_rate: i32) -> Result<()> {
        let mut active = self.active.lock();
        if active.contains_key(dongle_id) {
            bail!("already recording dongle {dongle_id}");
        }

        fs::create_dir_all(&self.output_dir)
            .with_context(|| "recorder: create output dir")?;

        let now = chrono::Utc::now();
        let ts = now.format("%Y%m%dT%H%M%SZ").to_string();
        let base = format!("{dongle_id}_{center_freq}_{ts}");
        let data_path = self.output_dir.join(format!("{base}.sigmf-data"));
        let meta_path = self.output_dir.join(format!("{base}.sigmf-meta"));

        let file = File::create(&data_path)
            .with_context(|| "recorder: create data file")?;

        active.insert(
            dongle_id.to_string(),
            Recording {
                dongle_id: dongle_id.to_string(),
                file,
                data_path,
                meta_path,
                center_freq,
                sample_rate,
                started_at: Instant::now(),
                started_at_utc: now,
                bytes_written: 0,
            },
        );
        Ok(())
    }

    /// Ends recording and writes the SigMF metadata sidecar. Returns the data path.
    pub fn stop(&self, dongle_id: &str) -> Result<String> {
        let rec = {
            let mut active = self.active.lock();
            match active.remove(dongle_id) {
                Some(r) => r,
                None => bail!("not recording dongle {dongle_id}"),
            }
        };

        let data_path = rec.data_path.to_string_lossy().to_string();
        let mut file = rec.file;
        file.flush().with_context(|| "recorder: close file")?;
        drop(file);

        let duration = rec.started_at.elapsed().as_secs_f64();
        let meta = json!({
            "global": {
                "core:version": "1.0.0",
                "core:datatype": "cu8",
                "core:sample_rate": rec.sample_rate,
                "core:hw": format!("no-sdr dongle {}", rec.dongle_id),
                "core:recorder": "no-sdr",
            },
            "captures": [{
                "core:sample_start": 0,
                "core:frequency": rec.center_freq,
                "core:datetime": rec.started_at_utc.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
            }],
            "annotations": [{
                "core:sample_start": 0,
                "core:comment": format!("duration={duration:.1}s bytes={}", rec.bytes_written),
            }],
        });
        let meta_json = serde_json::to_vec_pretty(&meta)
            .with_context(|| "recorder: marshal meta")?;
        fs::write(&rec.meta_path, meta_json).with_context(|| "recorder: write meta")?;

        Ok(data_path)
    }

    /// Appends a chunk of raw IQ bytes. No-op when not recording.
    pub fn write_iq(&self, dongle_id: &str, chunk: &[u8]) {
        let mut active = self.active.lock();
        if let Some(rec) = active.get_mut(dongle_id) {
            if let Ok(n) = rec.file.write(chunk) {
                rec.bytes_written += n as i64;
            }
        }
    }

    /// Returns a snapshot of all active recordings.
    pub fn status(&self) -> Vec<RecordingStatus> {
        let active = self.active.lock();
        active
            .values()
            .map(|rec| RecordingStatus {
                dongle_id: rec.dongle_id.clone(),
                file: rec.data_path.to_string_lossy().to_string(),
                bytes_written: rec.bytes_written,
                duration_sec: rec.started_at.elapsed().as_secs_f64(),
            })
            .collect()
    }

    pub fn is_recording(&self, dongle_id: &str) -> bool {
        self.active.lock().contains_key(dongle_id)
    }
}
