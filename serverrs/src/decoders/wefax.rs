//! Weather facsimile (WEFAX / radiofax) channel.
//!
//! The DSP receiver is adapted from `sdroxide-dsp` in `wefax_rx.rs`. This file
//! only maps decoder configuration onto it, feeds it USB audio from the raw
//! IQ stream, and turns its line events into `MSG_DECODER` snapshots for the
//! client's image viewer.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use num_complex::Complex32;
use serde_json::{json, Value};
use tracing::debug;

use super::wefax_rx::{Ioc, Lpm, WefaxEvent, WefaxRx};
use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const AUDIO_RATE: u32 = 12_000;

pub fn is_wefax(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("wefax")
}

fn setting_str<'a>(cfg: &'a DecoderConfig, key: &str) -> Option<&'a str> {
    cfg.settings.get(key).and_then(Value::as_str)
}

fn setting_bool(cfg: &DecoderConfig, key: &str, default: bool) -> bool {
    cfg.settings
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn setting_f32(cfg: &DecoderConfig, key: &str, default: f32) -> f32 {
    cfg.settings
        .get(key)
        .and_then(Value::as_f64)
        .map(|v| v as f32)
        .unwrap_or(default)
}

fn ioc_from(cfg: &DecoderConfig) -> Ioc {
    match setting_str(cfg, "ioc").map(str::to_ascii_lowercase) {
        Some(v) if v.contains("288") => Ioc::I288,
        _ => Ioc::I576,
    }
}

fn lpm_from(cfg: &DecoderConfig) -> Lpm {
    let value = cfg
        .settings
        .get("lpm")
        .and_then(Value::as_f64)
        .unwrap_or(120.0);
    match value.round() as i32 {
        60 => Lpm::L60,
        90 => Lpm::L90,
        180 => Lpm::L180,
        240 => Lpm::L240,
        _ => Lpm::L120,
    }
}

pub struct WefaxChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    rx: WefaxRx,
    complex: Vec<Complex32>,
    audio: Vec<f32>,
    pending: Vec<Value>,
    image_id: u32,
    width: u16,
    height: u16,
    last_status: Instant,
}

impl WefaxChannel {
    pub fn build(cfg: &DecoderConfig, center_hz: f64, sample_rate: u32) -> Result<Self, String> {
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
        .map_err(|e| format!("WEFAX channel extractor: {e}"))?;
        extractor.set_bandwidth(6_000);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = SsbDemod::new(SsbMode::Usb);
        demod
            .init(actual_rate)
            .map_err(|e| format!("WEFAX USB demodulator: {e}"))?;
        demod.set_bandwidth(3_000.0);

        let mut rx = WefaxRx::new(AUDIO_RATE as f64);
        rx.set_ioc(ioc_from(cfg));
        rx.set_lpm(lpm_from(cfg));
        rx.set_auto_start(setting_bool(cfg, "autoStart", true));
        rx.set_auto_stop(setting_bool(cfg, "autoStop", true));
        rx.set_slant_ppm(setting_f32(cfg, "slantPpm", 0.0));

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
            rx,
            complex: Vec::new(),
            audio: Vec::new(),
            pending: Vec::new(),
            image_id: 0,
            width: 0,
            height: 0,
            last_status: Instant::now() - Duration::from_secs(1),
        })
    }

    pub fn process_chunk(&mut self, chunk: &[u8], _now: i64) {
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
        let demodulated = self.demod.process(&self.complex);
        self.audio.clear();
        self.resampler.process(&demodulated, &mut self.audio);

        let mut events = Vec::new();
        self.rx.process(&self.audio, &mut events);
        for event in events {
            self.handle_event(event);
        }

        if self.last_status.elapsed() >= Duration::from_millis(500) {
            self.last_status = Instant::now();
            self.pending.push(self.status_json());
        }
    }

    pub fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending)
    }

    fn handle_event(&mut self, event: WefaxEvent) {
        match event {
            WefaxEvent::Start { ioc, lpm, auto } => {
                self.image_id = self.image_id.wrapping_add(1);
                self.width = ioc.width();
                self.height = 0;
                self.pending.push(json!({
                    "kind": "start",
                    "id": self.cfg.id,
                    "mode": "wefax",
                    "imageId": self.image_id,
                    "width": self.width,
                    "ioc": ioc.label(),
                    "lpm": lpm.value(),
                    "auto": auto,
                    "at": unix_secs(),
                }));
                debug!(decoder = %self.cfg.id, image_id = self.image_id, "WEFAX start");
            }
            WefaxEvent::Phased { skew } => {
                self.pending.push(json!({
                    "kind": "phased",
                    "id": self.cfg.id,
                    "mode": "wefax",
                    "imageId": self.image_id,
                    "skew": skew,
                    "at": unix_secs(),
                }));
            }
            WefaxEvent::Line { y, gray } => {
                self.height = self.height.max(y.saturating_add(1));
                let encoded = base64::engine::general_purpose::STANDARD.encode(gray);
                self.pending.push(json!({
                    "kind": "line",
                    "id": self.cfg.id,
                    "mode": "wefax",
                    "imageId": self.image_id,
                    "width": self.width,
                    "y": y,
                    "height": self.height,
                    "gray": encoded,
                    "at": unix_secs(),
                }));
            }
            WefaxEvent::Complete { lines, by_tone } => {
                self.height = lines;
                self.pending.push(json!({
                    "kind": "complete",
                    "id": self.cfg.id,
                    "mode": "wefax",
                    "imageId": self.image_id,
                    "width": self.width,
                    "height": lines,
                    "byTone": by_tone,
                    "at": unix_secs(),
                }));
                debug!(decoder = %self.cfg.id, lines, "WEFAX complete");
            }
        }
    }

    fn status_json(&self) -> Value {
        json!({
            "kind": "status",
            "id": self.cfg.id,
            "mode": "wefax",
            "imageId": self.image_id,
            "width": self.width,
            "height": self.height,
            "receiving": self.rx.receiving(),
            "phasing": self.rx.phasing(),
            "lines": self.rx.lines(),
            "ioc": self.rx.ioc().label(),
            "lpm": self.rx.lpm().value(),
            "signal": self.rx.level(),
            "subcarrierHz": self.rx.subcarrier_hz(),
            "slantPpm": self.rx.slant_ppm(),
            "at": unix_secs(),
        })
    }
}

fn unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
