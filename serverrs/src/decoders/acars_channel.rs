//! ACARS channel: raw IQ → 12 kHz AM audio → `sdroxide` ACARS receiver.
//!
//! ACARS sits on the VHF airband as an amplitude-modulated 2400-baud MSK
//! signal in a roughly 5 kHz-wide channel. The shared `IqExtractor` pulls that
//! channel out of the dongle stream, `AmDemod` produces the audio, and the
//! receiver in [`super::acars`] frames and checks the messages.

use std::time::{SystemTime, UNIX_EPOCH};

use num_complex::Complex32;
use serde_json::{json, Value};

use super::acars::{AcarsEvent, AcarsRx, CENTER_HZ};
use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{AmDemod, Demodulator};
use crate::dsp::{IqExtractor, IqExtractorConfig};

/// The ACARS receiver is built for exactly this audio rate.
const ACARS_AUDIO_RATE: u32 = 12_000;
/// Channel width around the carrier. The MSK tones span 1200–2400 Hz and the
/// AM sidebands add a little on each side.
const ACARS_BANDWIDTH_HZ: i32 = 6_000;

pub(crate) struct AcarsChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: AmDemod,
    resampler: LinearResampler,
    rx: AcarsRx,
    results: Vec<Value>,
    pcm: Vec<i16>,
    complex: Vec<Complex32>,
    resampled: Vec<f32>,
    last_status_ms: i64,
}

impl AcarsChannel {
    pub(crate) fn new(
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
            // Ask for slightly over 12 kHz so the integer decimator does not
            // land below it; the linear resampler takes it to exactly 12 kHz.
            output_sample_rate: (ACARS_AUDIO_RATE + 200) as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("ACARS channel extractor: {e}"))?;
        extractor.set_bandwidth(ACARS_BANDWIDTH_HZ);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = AmDemod::new();
        demod
            .init(actual_rate)
            .map_err(|e| format!("ACARS AM demodulator: {e}"))?;
        demod.set_bandwidth(ACARS_BANDWIDTH_HZ as f64);

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, ACARS_AUDIO_RATE as f64),
            rx: AcarsRx::new(ACARS_AUDIO_RATE as f64),
            results: Vec::new(),
            pcm: Vec::new(),
            complex: Vec::new(),
            resampled: Vec::new(),
            last_status_ms: 0,
        })
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.results)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now_ms: i64) {
        let mut pcm = std::mem::take(&mut self.pcm);
        self.extractor.process_into(chunk, &mut pcm);
        if !pcm.is_empty() {
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

            let mut events = Vec::new();
            self.rx.process(&resampled, &mut events);
            for event in events {
                let AcarsEvent::Message(frame) = event;
                let text = frame.text.trim().to_string();
                self.results.push(json!({
                    "kind": "message",
                    "id": self.cfg.id,
                    "mode": self.cfg.mode,
                    "text": text,
                    "rfHz": self.cfg.frequency_hz as f64,
                    "audioHz": CENTER_HZ,
                    "snrDb": 0.0,
                    "dtSec": 0.0,
                    "period": 0,
                    "acars": {
                        "mode": frame.mode,
                        "address": frame.address,
                        "ack": frame.ack,
                        "label": frame.label,
                        "blockId": frame.block_id,
                        "text": frame.text,
                        "crcOk": frame.crc_ok,
                        "at": unix_now(),
                    },
                }));
            }
            self.resampled = resampled;
        }
        self.pcm = pcm;

        if now_ms - self.last_status_ms >= 500 {
            self.last_status_ms = now_ms;
            self.results.push(json!({
                "kind": "status",
                "frames": self.rx.frames(),
                "bad": self.rx.bad(),
                "level": self.rx.level(),
            }));
        }
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
