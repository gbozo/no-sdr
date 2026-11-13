//! Continuous keyboard modes: Olivia, THOR and FSQ.
//!
//! These share the same audio path as the other narrowband text modes: raw IQ
//! is extracted around the configured frequency, demodulated as USB, resampled
//! to the modems' 8 kHz internal rate, and fed to the receiver. The receivers
//! emit text incrementally, so results are streamed as text chunks rather than
//! waiting for a slot boundary.

#![allow(dead_code)]

mod fec;
mod fsq;
mod mfsk;
mod olivia;
mod psk;
mod psk_support;
mod rtty;
mod text_varicode;
mod thor;

use std::time::{Duration, Instant};

use num_complex::Complex32;
use serde_json::{json, Value};

use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const CHANNEL_RATE: u32 = 12_200;
const MODEM_RATE: f64 = 8_000.0;
const AUDIO_HZ: f64 = 1_500.0;
const CHANNEL_BANDWIDTH_HZ: i32 = 3_000;
const STATUS_INTERVAL: Duration = Duration::from_millis(500);

enum TextRx {
    Olivia(olivia::OliviaRx),
    Thor(thor::ThorRx),
    Fsq(fsq::FsqRx),
    Psk(psk::PskRx),
    Rtty(rtty::RttyRx),
}

impl TextRx {
    fn process(&mut self, audio: &[f32]) -> String {
        match self {
            TextRx::Olivia(rx) => rx.process(audio),
            TextRx::Thor(rx) => rx.process(audio),
            TextRx::Fsq(rx) => rx.process(audio),
            TextRx::Psk(rx) => rx.process(audio),
            TextRx::Rtty(rx) => rx.process(audio),
        }
    }

    fn magnitude(&self) -> f32 {
        match self {
            TextRx::Olivia(rx) => rx.magnitude(),
            TextRx::Thor(rx) => rx.magnitude(),
            TextRx::Fsq(rx) => rx.magnitude(),
            TextRx::Psk(rx) => rx.magnitude(),
            TextRx::Rtty(rx) => rx.magnitude(),
        }
    }

    fn status_extra(&self) -> Value {
        match self {
            TextRx::Psk(rx) => json!({ "baud": rx.baud() }),
            TextRx::Rtty(rx) => json!({
                "baud": rx.baud(),
                "shiftHz": rx.shift_hz(),
                "reverse": rx.reverse(),
                "afcHz": rx.afc_offset_hz(),
                "confidence": rx.confidence(),
            }),
            _ => Value::Null,
        }
    }
}

pub(crate) fn is_text_mode(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "olivia" | "thor" | "fsq" | "psk31" | "rtty"
    )
}

fn setting_f32(cfg: &DecoderConfig, key: &str, default: f32) -> f32 {
    cfg.settings
        .get(key)
        .and_then(Value::as_f64)
        .map(|v| v as f32)
        .unwrap_or(default)
}

pub(crate) struct TextChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    rx: TextRx,
    audio_hz: f32,
    complex: Vec<Complex32>,
    pcm: Vec<i16>,
    resampled: Vec<f32>,
    pending: Vec<Value>,
    level: f32,
    last_status: Instant,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn psk31_loopback_decodes_text() {
        let mut tx = psk::PskTx::new(MODEM_RATE, AUDIO_HZ);
        tx.push_text("CQ TEST");
        tx.finish();
        let mut rx = psk::PskRx::new(MODEM_RATE, AUDIO_HZ);
        let mut audio = vec![0.0f32; 512];
        let mut text = String::new();
        for _ in 0..400 {
            let n = tx.next_block(&mut audio);
            if n == 0 {
                break;
            }
            text.push_str(&rx.process(&audio[..n]));
        }
        assert!(text.contains("CQ"), "decoded {text:?}");
    }

    #[test]
    fn rtty_loopback_decodes_text() {
        let mut tx = rtty::RttyTx::new(MODEM_RATE, AUDIO_HZ, 45.45, 170.0);
        tx.push_text("CQ TEST");
        let mut rx = rtty::RttyRx::new(MODEM_RATE, AUDIO_HZ, 45.45, 170.0);
        rx.set_afc(false);
        let mut audio = vec![0.0f32; 512];
        let mut text = String::new();
        for _ in 0..400 {
            let n = tx.next_block(&mut audio);
            if n == 0 {
                break;
            }
            text.push_str(&rx.process(&audio[..n]));
        }
        assert!(text.contains("CQ"), "decoded {text:?}");
    }
}

impl TextChannel {
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
            output_sample_rate: CHANNEL_RATE as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("text channel extractor: {e}"))?;
        extractor.set_bandwidth(CHANNEL_BANDWIDTH_HZ * 2);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = SsbDemod::new(SsbMode::Usb);
        demod
            .init(actual_rate)
            .map_err(|e| format!("text USB demodulator: {e}"))?;
        demod.set_bandwidth(CHANNEL_BANDWIDTH_HZ as f64);

        let audio_hz = setting_f32(cfg, "audioHz", AUDIO_HZ as f32).clamp(200.0, 3000.0) as f64;
        let mode = cfg.mode.trim().to_ascii_lowercase();
        let rx = match mode.as_str() {
            "olivia" => {
                let tones = setting_f32(cfg, "tones", 8.0).round().clamp(2.0, 64.0) as usize;
                let bw = setting_f32(cfg, "bandwidthHz", 500.0).clamp(125.0, 2000.0) as f64;
                TextRx::Olivia(olivia::OliviaRx::new(MODEM_RATE, audio_hz, tones, bw))
            }
            "thor" => {
                let baud = setting_f32(cfg, "baud", 18.5).clamp(2.0, 100.0) as f64;
                TextRx::Thor(thor::ThorRx::new(MODEM_RATE, audio_hz, baud))
            }
            "fsq" => {
                let baud = setting_f32(cfg, "baud", 3.0).clamp(1.0, 10.0) as f64;
                TextRx::Fsq(fsq::FsqRx::new(MODEM_RATE, audio_hz, baud))
            }
            "psk31" => {
                let baud = setting_f32(cfg, "baud", psk::PSK31_BAUD as f32).clamp(15.0, 250.0);
                TextRx::Psk(psk::PskRx::new_baud(MODEM_RATE, audio_hz, baud as f64))
            }
            "rtty" => {
                let baud = setting_f32(cfg, "baud", 45.45).clamp(30.0, 300.0) as f64;
                let shift = setting_f32(cfg, "shiftHz", 170.0).clamp(50.0, 1000.0) as f64;
                let mut rx = rtty::RttyRx::new(MODEM_RATE, audio_hz, baud, shift);
                if let Some(reverse) = cfg.settings.get("reverse").and_then(Value::as_bool) {
                    rx.set_reverse(reverse);
                }
                let afc = cfg
                    .settings
                    .get("afc")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                rx.set_afc(afc);
                TextRx::Rtty(rx)
            }
            other => return Err(format!("unsupported text mode {other}")),
        };

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, MODEM_RATE),
            rx,
            audio_hz: audio_hz as f32,
            complex: Vec::new(),
            pcm: Vec::new(),
            resampled: Vec::new(),
            pending: Vec::new(),
            level: 0.0,
            last_status: Instant::now(),
        })
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now: i64) {
        let mut pcm = std::mem::take(&mut self.pcm);
        self.extractor.process_into(chunk, &mut pcm);
        if pcm.is_empty() {
            self.pcm = pcm;
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
        let mut resampled = std::mem::take(&mut self.resampled);
        resampled.clear();
        self.resampler.process(&audio, &mut resampled);
        self.level = self.rx.magnitude();
        let text = self.rx.process(&resampled);
        self.pcm = pcm;
        self.resampled = resampled;

        if !text.is_empty() {
            self.pending.push(json!({
                "kind": "text",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "text": text,
                "rfHz": self.cfg.frequency_hz,
                "audioHz": self.audio_hz,
                "level": self.level,
                "at": now / 1_000_000_000,
            }));
        }

        if self.last_status.elapsed() >= STATUS_INTERVAL {
            let mut status = json!({
                "kind": "status",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "level": self.level,
                "audioHz": self.audio_hz,
                "listening": true,
            });
            if let (Some(object), Value::Object(extra)) =
                (status.as_object_mut(), self.rx.status_extra())
            {
                object.extend(extra);
            }
            self.pending.push(status);
            self.last_status = Instant::now();
        }
    }
}
