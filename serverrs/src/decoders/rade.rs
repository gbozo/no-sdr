//! FreeDV RADE V1 digital voice.
//!
//! RADE carries synthesized speech rather than text or an image. The channel
//! receives USB audio, feeds `sdroxide_rade::RadeWorker`, and returns decoded
//! 48 kHz speech on a separate `take_audio` path. The generic decoder worker
//! broadcasts that audio as a raw `MSG_AUDIO` frame to the same clients that
//! receive the decoder's status JSON.

use num_complex::Complex32;
use sdroxide_rade::RadeWorker;
use serde_json::json;
use tracing::{debug, warn};

use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

use super::LinearResampler;

const AUDIO_RATE: u32 = 48_000;
const RADE_AUDIO_HZ: f64 = 1470.0;
const STATUS_MS: i64 = 500;

pub(crate) fn is_rade(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("rade")
}

pub(crate) struct RadeChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    worker: RadeWorker,
    pcm: Vec<i16>,
    complex: Vec<Complex32>,
    resampled: Vec<f32>,
    speech: Vec<f32>,
    audio_out: Vec<i16>,
    pending: Vec<serde_json::Value>,
    last_status_ms: i64,
    last_call: Option<String>,
    eoo_count: u64,
}

impl RadeChannel {
    pub(crate) fn new(
        cfg: &DecoderConfig,
        center_hz: f64,
        sample_rate: u32,
    ) -> Result<Self, String> {
        let offset = cfg.frequency_hz - center_hz as i64;
        if offset.unsigned_abs() > sample_rate as u64 / 2 {
            return Err(format!(
                "RADE frequency {} is outside the {sample_rate} Hz dongle span around {center_hz}",
                cfg.frequency_hz
            ));
        }

        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            // A little over 48 kHz so the integer decimator lands above the
            // target and the linear resampler only has to decimate.
            output_sample_rate: (AUDIO_RATE + 200) as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("RADE channel extractor: {e}"))?;
        extractor.set_bandwidth((cfg.bandwidth_hz.max(3000) * 2).min(48_000));

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = SsbDemod::new(SsbMode::Usb);
        demod
            .init(actual_rate)
            .map_err(|e| format!("RADE USB demodulator: {e}"))?;
        demod.set_bandwidth(cfg.bandwidth_hz.max(3000) as f64);

        let worker = RadeWorker::new(f64::from(AUDIO_RATE), f64::from(AUDIO_RATE))
            .map_err(|e| format!("RADE engine: {e}"))?;

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, f64::from(AUDIO_RATE)),
            worker,
            pcm: Vec::new(),
            complex: Vec::new(),
            resampled: Vec::new(),
            speech: Vec::new(),
            audio_out: Vec::new(),
            pending: Vec::new(),
            last_status_ms: 0,
            last_call: None,
            eoo_count: 0,
        })
    }

    pub(crate) fn take_results(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.pending)
    }

    pub(crate) fn take_audio(&mut self) -> Vec<i16> {
        std::mem::take(&mut self.audio_out)
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
        self.pcm = pcm;

        self.worker.push_rx(&resampled);
        self.speech.clear();
        self.worker.pop_rx(&mut self.speech);
        for sample in &self.speech {
            self.audio_out
                .push((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16);
        }
        self.resampled = resampled;

        let stats = self.worker.stats();
        if stats.eoo_count != self.eoo_count {
            self.eoo_count = stats.eoo_count;
        }
        for text in self.worker.poll_text() {
            self.last_call = Some(text.call.clone());
            self.pending.push(json!({
                "kind": "callsign",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "call": text.call,
                "snrDb": text.snr_db,
                "rfHz": self.cfg.frequency_hz as f64 + RADE_AUDIO_HZ,
                "at": now / 1000,
            }));
        }

        if now - self.last_status_ms >= STATUS_MS {
            self.last_status_ms = now;
            self.pending.push(json!({
                "kind": "status",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "sync": stats.sync,
                "snrDb": stats.snr_db,
                "freqOffsetHz": stats.freq_offset_hz,
                "rxLevel": stats.rx_level,
                "eooCount": stats.eoo_count,
                "dropped": stats.dropped,
                "callsign": self.last_call,
                "audioHz": RADE_AUDIO_HZ,
                "listening": true,
            }));
        }

        if stats.dropped > 0 {
            warn!(
                decoder = %self.cfg.id,
                dropped = stats.dropped,
                "RADE receive ring dropped samples"
            );
        }
        if stats.sync {
            debug!(
                decoder = %self.cfg.id,
                snr_db = stats.snr_db,
                level = stats.rx_level,
                "RADE sync"
            );
        }
    }
}


