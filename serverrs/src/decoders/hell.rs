//! Hellschreiber channel: raw IQ → USB audio → dot-column raster.
//!
//! Hell is a facsimile mode, not a text codec. The receiver emits grayscale
//! dots; this wrapper packs whole 14-pixel columns and sends them to the
//! client, which paints the scrolling strip.

use std::time::{Duration, Instant};

use base64::Engine;
use num_complex::Complex32;
use sdroxide_types::HellVariant;
use serde_json::{json, Value};

use super::hell_rx::{HellRx, HELL_ROWS};
use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const AUDIO_RATE: u32 = 12_000;
const CHANNEL_BANDWIDTH_HZ: i32 = 3_000;
const STATUS_INTERVAL: Duration = Duration::from_millis(500);

pub fn is_hell(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("hell")
}

fn setting_f32(cfg: &DecoderConfig, key: &str, default: f32) -> f32 {
    cfg.settings
        .get(key)
        .and_then(Value::as_f64)
        .map(|v| v as f32)
        .unwrap_or(default)
}

fn variant_from(cfg: &DecoderConfig) -> HellVariant {
    match cfg
        .settings
        .get("variant")
        .and_then(Value::as_str)
        .unwrap_or("feld")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "slow" => HellVariant::Slow,
        "x5" => HellVariant::X5,
        "x9" => HellVariant::X9,
        "fsk245" => HellVariant::Fsk245,
        "fsk105" => HellVariant::Fsk105,
        "hell80" => HellVariant::Hell80,
        _ => HellVariant::Feld,
    }
}

pub(crate) struct HellChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    rx: HellRx,
    variant: HellVariant,
    complex: Vec<Complex32>,
    audio: Vec<i16>,
    pending: Vec<Value>,
    dots: Vec<u8>,
    seq: u64,
    columns: u64,
    last_status: Instant,
    level: f32,
}

impl HellChannel {
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

        let variant = variant_from(cfg);
        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            output_sample_rate: (AUDIO_RATE + 200) as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("Hell channel extractor: {e}"))?;
        extractor.set_bandwidth(CHANNEL_BANDWIDTH_HZ * 2);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = SsbDemod::new(SsbMode::Usb);
        demod
            .init(actual_rate)
            .map_err(|e| format!("Hell USB demodulator: {e}"))?;
        demod.set_bandwidth(CHANNEL_BANDWIDTH_HZ as f64);

        let rx = HellRx::new(
            AUDIO_RATE as f64,
            1_500.0,
            variant,
            setting_f32(cfg, "agc", 0.6),
        );

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
            rx,
            variant,
            complex: Vec::new(),
            audio: Vec::new(),
            pending: Vec::new(),
            dots: Vec::new(),
            seq: 0,
            columns: 0,
            last_status: Instant::now(),
            level: 0.0,
        })
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], _now: i64) {
        let mut pcm = std::mem::take(&mut self.audio);
        self.extractor.process_into(chunk, &mut pcm);
        if pcm.is_empty() {
            self.audio = pcm;
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
        let mut resampled = Vec::with_capacity(
            (audio.len() as f64 * AUDIO_RATE as f64 / self.extractor.output_sample_rate() as f64)
                as usize
                + 8,
        );
        self.resampler.process(&audio, &mut resampled);
        self.audio = pcm;

        self.level = self.rx.magnitude();
        // Keep dots across chunks: a column can straddle an IQ block.
        self.rx.process(&resampled, &mut self.dots);
        if self.dots.is_empty() {
            self.emit_status();
            return;
        }

        let whole = self.dots.len() / HELL_ROWS;
        if whole > 0 {
            let bytes: Vec<u8> = self.dots.drain(..whole * HELL_ROWS).collect();
            let cols = base64::engine::general_purpose::STANDARD.encode(&bytes);
            self.pending.push(json!({
                "kind": "columns",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "variant": self.variant.label(),
                "seq": self.seq,
                "rows": HELL_ROWS,
                "cols": cols,
            }));
            self.seq += whole as u64;
            self.columns += whole as u64;
        }
        self.emit_status();
    }

    fn emit_status(&mut self) {
        if self.last_status.elapsed() < STATUS_INTERVAL {
            return;
        }
        self.last_status = Instant::now();
        self.pending.push(json!({
            "kind": "status",
            "id": self.cfg.id,
            "mode": self.cfg.mode,
            "variant": self.variant.label(),
            "receiving": true,
            "columns": self.columns,
            "seq": self.seq,
            "level": self.level,
            "audioHz": 1_500.0,
        }));
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_labels_map() {
        let mut cfg = DecoderConfig::default();
        cfg.settings
            .insert("variant".into(), Value::String("x9".into()));
        assert_eq!(variant_from(&cfg), HellVariant::X9);
        cfg.settings
            .insert("variant".into(), Value::String("hell80".into()));
        assert_eq!(variant_from(&cfg), HellVariant::Hell80);
    }

    #[test]
    fn build_channel_dispatches_hell() {
        let cfg = DecoderConfig {
            id: "hell-40m".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "hell".into(),
            frequency_hz: 7_040_000,
            bandwidth_hz: 3_000,
            settings: serde_json::Map::new(),
        };
        let channel = HellChannel::build(&cfg, 7_040_000.0, 2_400_000).expect("hell channel");
        assert_eq!(channel.variant, HellVariant::Feld);
        assert!(HellChannel::build(&cfg, 9_200_000.0, 2_400_000).is_err());
    }
}
