//! MSK144 and FSK441 meteor-scatter decoders.
//!
//! Both modes are slotted but search the whole slot for short meteor bursts
//! rather than assuming a frame at a fixed offset. MSK144 is decoded with
//! mfsk-core's sliding-window receiver at 12 kHz. FSK441 uses the local
//! 11 025 Hz G3RUH-style ping search in [`super::fsk441_rx`], which is the
//! rate at which the mode's 25-samples-per-dit constants line up.

use mfsk_core::decoder::Depth;
use mfsk_core::msk144::decode as msk144_decode;
use serde_json::json;
use tracing::debug;

use super::fsk441_rx;
use super::{DecoderConfig, LinearResampler};
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const MSK144_RATE: f64 = 12_000.0;
const FSK441_RATE: f64 = 11_025.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum MeteorKind {
    Msk144,
    Fsk441,
}

impl MeteorKind {
    fn mode(self) -> &'static str {
        match self {
            Self::Msk144 => "msk144",
            Self::Fsk441 => "fsk441",
        }
    }

    fn rate(self) -> f64 {
        match self {
            Self::Msk144 => MSK144_RATE,
            Self::Fsk441 => FSK441_RATE,
        }
    }
}

pub struct MeteorChannel {
    pub(crate) cfg: DecoderConfig,
    kind: MeteorKind,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    audio: Vec<f32>,
    resampled: Vec<f32>,
    slot_len: usize,
    period_s: u32,
    last_slot: i64,
    level_db: f32,
    decodes: u64,
    last_status: i64,
    pub(crate) pending: Vec<serde_json::Value>,
}

impl MeteorChannel {
    pub fn build(cfg: &DecoderConfig, center_hz: f64, sample_rate: u32) -> Result<Self, String> {
        let kind = match cfg.mode.trim().to_ascii_lowercase().as_str() {
            "msk144" => MeteorKind::Msk144,
            "fsk441" => MeteorKind::Fsk441,
            other => return Err(format!("unsupported meteor mode {other}")),
        };
        let offset = cfg.frequency_hz - center_hz as i64;
        if offset.unsigned_abs() > sample_rate as u64 / 2 {
            return Err(format!(
                "frequency {} is outside the {sample_rate} Hz dongle span around {center_hz}",
                cfg.frequency_hz
            ));
        }

        let target_rate = kind.rate();
        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            output_sample_rate: (target_rate as i32) + 200,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("channel extractor: {e}"))?;
        let actual_rate = extractor.output_sample_rate() as f64;
        extractor.set_bandwidth(5000);

        let mut demod = SsbDemod::new(SsbMode::Usb);
        demod
            .init(actual_rate)
            .map_err(|e| format!("USB demodulator: {e}"))?;
        demod.set_bandwidth(4000.0);

        let period_s = if kind == MeteorKind::Msk144 {
            15
        } else {
            cfg.settings
                .get("period")
                .and_then(serde_json::Value::as_u64)
                .filter(|v| *v == 15 || *v == 30)
                .unwrap_or(30) as u32
        };
        let slot_len = (period_s as f64 * target_rate).round() as usize;

        Ok(Self {
            cfg: cfg.clone(),
            kind,
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, target_rate),
            audio: Vec::with_capacity(slot_len + target_rate as usize),
            resampled: Vec::new(),
            slot_len,
            period_s,
            last_slot: 0,
            level_db: -120.0,
            decodes: 0,
            last_status: 0,
            pending: Vec::new(),
        })
    }

    pub fn take_results(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.pending)
    }

    pub fn process(&mut self, chunk: &[u8], now_ns: i64) -> Vec<serde_json::Value> {
        let mut pcm = Vec::new();
        self.extractor.process_into(chunk, &mut pcm);
        if pcm.is_empty() {
            return Vec::new();
        }

        let mut complex = Vec::with_capacity(pcm.len() / 2);
        for pair in pcm.chunks_exact(2) {
            complex.push(num_complex::Complex32::new(
                pair[0] as f32 / 32768.0,
                pair[1] as f32 / 32768.0,
            ));
        }
        let audio = self.demod.process(&complex);
        self.resampled.clear();
        self.resampler.process(&audio, &mut self.resampled);
        if !self.resampled.is_empty() {
            let sum: f32 =
                self.resampled.iter().map(|v| v * v).sum::<f32>() / self.resampled.len() as f32;
            self.level_db = 10.0 * sum.max(1e-12).log10();
        }

        let slot_ns = (self.slot_len as i64 * 1_000_000_000) / self.kind.rate() as i64;
        let slot = now_ns / slot_ns.max(1);
        let mut out = Vec::new();
        if self.last_slot == 0 {
            self.last_slot = slot;
        } else if slot != self.last_slot {
            if self.audio.len() >= self.slot_len {
                let start = self.audio.len() - self.slot_len;
                self.decode_slot(&self.audio[start..].to_vec(), self.last_slot, &mut out);
            }
            self.audio.clear();
            self.last_slot = slot;
        }

        self.audio.extend_from_slice(&self.resampled);
        let keep = self.slot_len + self.kind.rate() as usize;
        if self.audio.len() > keep {
            let excess = self.audio.len() - keep;
            self.audio.drain(..excess);
        }

        if now_ns - self.last_status >= 500_000_000 {
            self.last_status = now_ns;
            out.push(self.status_json());
        }
        out
    }

    fn status_json(&self) -> serde_json::Value {
        json!({
            "kind": "status",
            "id": self.cfg.id,
            "mode": self.kind.mode(),
            "level": self.level_db,
            "audioHz": 1500.0,
            "period": self.period_s,
            "decodes": self.decodes,
            "listening": !self.audio.is_empty(),
        })
    }

    fn decode_slot(&mut self, audio: &[f32], period: i64, out: &mut Vec<serde_json::Value>) {
        match self.kind {
            MeteorKind::Msk144 => {
                let mut pcm = Vec::with_capacity(audio.len());
                for &sample in audio {
                    pcm.push((sample.clamp(-1.0, 1.0) * 28_000.0) as i16);
                }
                for decode in msk144_decode::decode_slot(&pcm, 1500.0, 200.0, Depth::Deep) {
                    self.decodes += 1;
                    out.push(json!({
                        "kind": "decode",
                        "id": self.cfg.id,
                        "mode": self.kind.mode(),
                        "text": decode.message,
                        "audioHz": decode.freq_hz,
                        "rfHz": self.cfg.frequency_hz as f64 + decode.freq_hz as f64,
                        "snrDb": decode.snr_db,
                        "dtSec": decode.tsec,
                        "period": period,
                        "dialHz": self.cfg.frequency_hz,
                    }));
                }
            }
            MeteorKind::Fsk441 => {
                for ping in fsk441_rx::fsk441_find_pings(audio) {
                    self.decodes += 1;
                    out.push(json!({
                        "kind": "decode",
                        "id": self.cfg.id,
                        "mode": self.kind.mode(),
                        "text": ping.text,
                        "audioHz": ping.audio_hz,
                        "rfHz": self.cfg.frequency_hz as f64 + ping.audio_hz as f64,
                        "snrDb": ping.snr_db,
                        "dtSec": ping.start_s,
                        "durationSec": ping.duration_s,
                        "confidence": ping.confidence,
                        "period": period,
                        "dialHz": self.cfg.frequency_hz,
                    }));
                }
            }
        }
        debug!(
            decoder = %self.cfg.id,
            mode = self.kind.mode(),
            "meteor slot decoded"
        );
    }
}

pub fn is_meteor(mode: &str) -> bool {
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "msk144" | "fsk441"
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn fsk441_decodes_a_synthetic_ping() {
        let msg = "CQ DE W1ABC";
        let tones = super::fsk441_rx::fsk441_encode_tones(msg);
        let mut slot = vec![0.0f32; 2205];
        slot.extend_from_slice(&super::fsk441_rx::fsk441_generate_audio(&tones));
        slot.extend(std::iter::repeat_n(0.0, 2205));
        let pings = super::fsk441_rx::fsk441_find_pings(&slot);
        assert!(pings.iter().any(|ping| ping.text == msg), "{pings:?}");
    }
}
