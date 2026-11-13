//! SSTV (slow-scan television) channel.
//!
//! The receiver is adapted from `sdroxide-dsp` in `sstv_rx.rs`: it detects the
//! VIS header, decodes scan lines and emits progressive RGB rows. This wrapper
//! feeds it USB audio from the raw IQ stream and turns those rows into
//! `MSG_DECODER` snapshots for the client image viewer.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use num_complex::Complex32;
use sdroxide_types::SstvMode;
use serde_json::{json, Value};
use tracing::debug;

use super::sstv_rx::{SstvEvent, SstvRx};
use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const AUDIO_RATE: u32 = 12_000;
const CHANNEL_BANDWIDTH_HZ: i32 = 3_000;

pub fn is_sstv(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("sstv")
}

fn unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) struct SstvChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    rx: SstvRx,
    complex: Vec<Complex32>,
    resampled: Vec<f32>,
    pending: Vec<Value>,
    image_id: u32,
    mode: Option<SstvMode>,
    width: u16,
    height: u16,
    fsk_id: Option<String>,
    unsupported: Option<String>,
    last_status: Instant,
}

impl SstvChannel {
    pub(crate) fn build(
        cfg: &DecoderConfig,
        center_hz: f64,
        sample_rate: u32,
    ) -> Result<Self, String> {
        let offset = cfg.frequency_hz - center_hz as i64;
        if offset.unsigned_abs() > sample_rate as u64 / 2 {
            return Err(format!(
                "frequency {} is outside the {sample_rate} Hz dongle span around {center_hz}",
                cfg.frequency_hz
            ));
        }

        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            output_sample_rate: (AUDIO_RATE + 200) as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("SSTV channel extractor: {e}"))?;
        extractor.set_bandwidth(CHANNEL_BANDWIDTH_HZ * 2);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = SsbDemod::new(SsbMode::Usb);
        demod
            .init(actual_rate)
            .map_err(|e| format!("SSTV USB demodulator: {e}"))?;
        demod.set_bandwidth(CHANNEL_BANDWIDTH_HZ as f64);

        let mut rx = SstvRx::new(AUDIO_RATE as f64);
        rx.set_expected(setting_mode(cfg));

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
            rx,
            complex: Vec::new(),
            resampled: Vec::new(),
            pending: Vec::new(),
            image_id: 0,
            mode: None,
            width: 0,
            height: 0,
            fsk_id: None,
            unsupported: None,
            last_status: Instant::now() - Duration::from_secs(1),
        })
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], _now_ms: i64) {
        let mut pcm = Vec::new();
        self.extractor.process_into(chunk, &mut pcm);
        if pcm.is_empty() {
            return;
        }

        self.complex.clear();
        self.complex.reserve(pcm.len() / 2);
        for pair in pcm.chunks_exact(2) {
            self.complex.push(Complex32::new(
                pair[0] as f32 / 32768.0,
                pair[1] as f32 / 32768.0,
            ));
        }

        let audio = self.demod.process(&self.complex);
        self.resampled.clear();
        self.resampler.process(&audio, &mut self.resampled);

        let mut events = Vec::new();
        self.rx.process(&self.resampled, &mut events);
        for event in events {
            self.handle_event(event);
        }

        if self.last_status.elapsed() >= Duration::from_millis(500) {
            self.last_status = Instant::now();
            self.pending.push(self.status_json());
        }
    }

    fn handle_event(&mut self, event: SstvEvent) {
        match event {
            SstvEvent::ModeDetected(mode) => {
                self.image_id = self.image_id.wrapping_add(1);
                self.mode = Some(mode);
                let (width, height) = mode.dimensions();
                self.width = width;
                self.height = height;
                self.fsk_id = None;
                self.unsupported = None;
                self.pending.push(json!({
                    "kind": "start",
                    "id": self.cfg.id,
                    "mode": "sstv",
                    "imageId": self.image_id,
                    "sstvMode": mode.label(),
                    "width": width,
                    "height": height,
                    "at": unix_secs(),
                }));
                debug!(decoder = %self.cfg.id, sstv_mode = mode.label(), "SSTV start");
            }
            SstvEvent::Line { y, rgb } => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&rgb);
                self.pending.push(json!({
                    "kind": "line",
                    "id": self.cfg.id,
                    "mode": "sstv",
                    "imageId": self.image_id,
                    "sstvMode": self.mode.map(SstvMode::label),
                    "width": self.width,
                    "height": self.height,
                    "y": y,
                    "rgb": encoded,
                    "at": unix_secs(),
                }));
            }
            SstvEvent::FskId(id) => {
                self.fsk_id = Some(id.clone());
                self.pending.push(json!({
                    "kind": "id",
                    "id": self.cfg.id,
                    "mode": "sstv",
                    "imageId": self.image_id,
                    "callsign": id,
                    "at": unix_secs(),
                }));
            }
            SstvEvent::UnsupportedMode { code, name } => {
                let label = name
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("VIS ${code:02X}"));
                self.unsupported = Some(label.clone());
                self.pending.push(json!({
                    "kind": "unsupported",
                    "id": self.cfg.id,
                    "mode": "sstv",
                    "code": code,
                    "name": label,
                    "at": unix_secs(),
                }));
            }
            SstvEvent::ImageComplete => {
                self.pending.push(json!({
                    "kind": "complete",
                    "id": self.cfg.id,
                    "mode": "sstv",
                    "imageId": self.image_id,
                    "sstvMode": self.mode.map(SstvMode::label),
                    "width": self.width,
                    "height": self.height,
                    "callsign": self.fsk_id,
                    "at": unix_secs(),
                }));
                debug!(decoder = %self.cfg.id, image_id = self.image_id, "SSTV complete");
            }
        }
    }

    fn status_json(&self) -> Value {
        json!({
            "kind": "status",
            "id": self.cfg.id,
            "mode": "sstv",
            "receiving": self.rx.receiving(),
            "progress": self.rx.progress(),
            "signal": self.rx.level(),
            "imageId": self.image_id,
            "sstvMode": self.mode.map(SstvMode::label),
            "width": self.width,
            "height": self.height,
            "callsign": self.fsk_id,
            "unsupported": self.unsupported,
        })
    }
}

fn setting_mode(cfg: &DecoderConfig) -> Option<SstvMode> {
    cfg.settings
        .get("mode")
        .and_then(Value::as_str)
        .and_then(|name| {
            let name = name.trim();
            SstvMode::ALL
                .into_iter()
                .find(|m| m.label().eq_ignore_ascii_case(name))
                .or_else(|| {
                    SstvMode::ALL
                        .into_iter()
                        .find(|m| m.label().replace(' ', "").eq_ignore_ascii_case(name))
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_builds_inside_the_window() {
        let cfg = DecoderConfig {
            id: "sstv-test".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "sstv".into(),
            frequency_hz: 14_230_000,
            bandwidth_hz: 3_000,
            ..DecoderConfig::default()
        };
        assert!(SstvChannel::build(&cfg, 14_230_000.0, 2_400_000).is_ok());
    }

    #[test]
    fn channel_rejects_outside_the_window() {
        let cfg = DecoderConfig {
            id: "sstv-test".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "sstv".into(),
            frequency_hz: 14_230_000,
            bandwidth_hz: 3_000,
            ..DecoderConfig::default()
        };
        assert!(SstvChannel::build(&cfg, 9_200_000.0, 2_400_000).is_err());
    }
}
