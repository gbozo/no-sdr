//! Background digital-mode decoders.
//!
//! These are OpenWebRX-style workers: they do not depend on a connected
//! client or on that client choosing a digital mode. Each configured decoder
//! gets its own channel extractor and USB demodulator, fed from the raw device
//! stream. Completed UTC-aligned slots are handed to the decoder and results
//! are broadcast as `MSG_DECODER` to clients subscribed to the same dongle.
//!
//! The first family is FT8/FT4. The extractor/demod layer is mode-generic, so
//! adding another slotted mfsk-core mode is a mode mapping and a slot decoder;
//! continuous modes (ACARS, AIS, APRS, ...) will get their own channel kind
//! rather than being forced into this slotted path.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use mfsk_core::prelude::{AnyDecoder, DecodeParams, Mode as MfskMode};
use num_complex::Complex32;
use parking_lot::Mutex;
use serde_json::json;
use tracing::{info, warn};

use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};
use crate::ws::{pack_decoder_message, WsManager};

mod acars;
mod acars_channel;
#[cfg(feature = "adsb")]
mod adsb;
mod ft2;
pub mod store;

/// Decoder channel audio rate. Every slotted mfsk-core mode uses 12 kHz.
const AUDIO_RATE: u32 = 12_000;

struct DecoderInput {
    center_hz: f64,
    sample_rate: u32,
    chunk: Vec<u8>,
}

struct Worker {
    tx: Sender<DecoderInput>,
    join: Option<JoinHandle<()>>,
}

/// Owns one background worker per dongle that has enabled decoders.
pub struct DecoderManager {
    workers: Mutex<HashMap<String, Worker>>,
}

#[derive(Clone)]
struct StoreHandle {
    store: Arc<store::DecoderStore>,
    retention_days: i64,
}

impl DecoderManager {
    /// Build workers from the configured decoders. Unsupported modes and
    /// decoders without a dongle are logged and skipped, not fatal: a config
    /// written for a future mode must not stop the receiver.
    pub fn new(
        decoders: &[DecoderConfig],
        ws: Arc<WsManager>,
        store: Arc<store::DecoderStore>,
        retention_days: i64,
    ) -> Self {
        let mut by_dongle: HashMap<String, Vec<DecoderConfig>> = HashMap::new();
        for cfg in decoders.iter().filter(|d| d.enabled) {
            if cfg.dongle_id.trim().is_empty() {
                warn!(decoder = %cfg.id, "decoder has no dongleId; skipping");
                continue;
            }
            if !supported_mode(&cfg.mode) {
                warn!(
                    decoder = %cfg.id,
                    mode = %cfg.mode,
                    "decoder mode is not supported yet; skipping"
                );
                continue;
            }
            by_dongle
                .entry(cfg.dongle_id.clone())
                .or_default()
                .push(cfg.clone());
        }

        let mut workers = HashMap::new();
        for (dongle_id, configs) in by_dongle {
            let (tx, rx) = mpsc::channel();
            let worker_ws = Arc::clone(&ws);
            let worker_store = StoreHandle {
                store: Arc::clone(&store),
                retention_days,
            };
            let worker_key = dongle_id.clone();
            let thread_name = format!("decoder-{}", &dongle_id[..dongle_id.len().min(16)]);
            let join = match thread::Builder::new()
                .name(thread_name)
                .spawn(move || run_worker(dongle_id, configs, worker_ws, worker_store, rx))
            {
                Ok(join) => join,
                Err(e) => {
                    warn!(error = %e, "failed to start decoder worker");
                    continue;
                }
            };
            workers.insert(
                worker_key,
                Worker {
                    tx,
                    join: Some(join),
                },
            );
        }

        Self {
            workers: Mutex::new(workers),
        }
    }

    /// Feed one raw device chunk. Never blocks: the worker owns the expensive
    /// extraction, demodulation and decoding.
    pub fn push_chunk(&self, dongle_id: &str, center_hz: f64, sample_rate: u32, chunk: &[u8]) {
        let workers = self.workers.lock();
        let Some(worker) = workers.get(dongle_id) else {
            return;
        };
        let _ = worker.tx.send(DecoderInput {
            center_hz,
            sample_rate,
            chunk: chunk.to_vec(),
        });
    }

    pub fn shutdown(&self) {
        let mut workers = self.workers.lock();
        for (_, mut worker) in workers.drain() {
            drop(worker.tx);
            if let Some(join) = worker.join.take() {
                let _ = join.join();
            }
        }
    }
}

impl Drop for DecoderManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

enum DecoderKind {
    Mfsk(AnyDecoder),
    Ft2,
}

struct DecodeJob {
    audio: Vec<i16>,
    period: i64,
}

pub(crate) struct MfskChannel {
    cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    decode_tx: Sender<DecodeJob>,
    results: Arc<Mutex<Vec<serde_json::Value>>>,
    /// Samples for the slot currently being received.
    audio: Vec<i16>,
    /// Reused extractor/demod scratch.
    pcm: Vec<i16>,
    complex: Vec<Complex32>,
    resampled: Vec<f32>,
    slot_len: usize,
    last_slot: i64,
}

/// Small linear resampler for the extractor's actual output rate, which is
/// `input_rate / integer_factor` and therefore not always exactly 12 kHz.
pub(crate) struct LinearResampler {
    step: f64,
    pos: f64,
    previous: Option<f32>,
}

impl LinearResampler {
    pub(crate) fn new(source_rate: f64, target_rate: f64) -> Self {
        Self {
            step: target_rate / source_rate,
            pos: 0.0,
            previous: None,
        }
    }

    pub(crate) fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if (self.step - 1.0).abs() < 1e-9 {
            out.extend_from_slice(input);
            self.previous = input.last().copied();
            return;
        }
        for &sample in input {
            if let Some(previous) = self.previous {
                while self.pos <= 1.0 {
                    out.push(previous + (sample - previous) * self.pos as f32);
                    self.pos += self.step;
                }
                self.pos -= 1.0;
            }
            self.previous = Some(sample);
        }
    }
}

fn mfsk_mode(mode: &str) -> Option<MfskMode> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "ft8" => Some(MfskMode::Ft8),
        "ft4" => Some(MfskMode::Ft4),
        _ => None,
    }
}

fn is_ft2(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("ft2")
}

fn is_acars(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("acars")
}

#[cfg(feature = "adsb")]
fn is_adsb(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("adsb")
}

fn supported_mode(mode: &str) -> bool {
    #[cfg(feature = "adsb")]
    if is_adsb(mode) {
        return true;
    }
    is_acars(mode) || is_ft2(mode) || mfsk_mode(mode).is_some()
}

fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

impl MfskChannel {
    pub(crate) fn take_results(&self) -> Vec<serde_json::Value> {
        std::mem::take(&mut *self.results.lock())
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
        append_audio(self, &resampled, now);
        self.resampled = resampled;
        self.pcm = pcm;
    }
}

/// One configured decoder channel.
///
/// Slotted WSJT modes take the audio path (extractor → USB demod → 12 kHz);
/// ADS-B takes the raw I/Q path and must never be routed through the audio
/// channeliser.
pub(crate) enum Channel {
    Mfsk(Box<MfskChannel>),
    Acars(acars_channel::AcarsChannel),
    #[cfg(feature = "adsb")]
    Adsb(adsb::AdsbChannel),
}

impl Channel {
    pub(crate) fn config(&self) -> &DecoderConfig {
        match self {
            Channel::Mfsk(channel) => &channel.cfg,
            Channel::Acars(channel) => &channel.cfg,
            #[cfg(feature = "adsb")]
            Channel::Adsb(channel) => &channel.cfg,
        }
    }

    pub(crate) fn take_results(&mut self) -> Vec<serde_json::Value> {
        match self {
            Channel::Mfsk(channel) => channel.take_results(),
            Channel::Acars(channel) => channel.take_results(),
            #[cfg(feature = "adsb")]
            Channel::Adsb(channel) => channel.take_results(),
        }
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now: i64) {
        match self {
            Channel::Mfsk(channel) => channel.process_chunk(chunk, now),
            Channel::Acars(channel) => channel.process_chunk(chunk, now),
            #[cfg(feature = "adsb")]
            Channel::Adsb(channel) => channel.process_chunk(chunk, now),
        }
    }
}

pub(crate) fn build_channel(
    cfg: &DecoderConfig,
    center_hz: f64,
    sample_rate: u32,
) -> Result<Channel, String> {
    #[cfg(feature = "adsb")]
    if is_adsb(&cfg.mode) {
        return Ok(Channel::Adsb(adsb::AdsbChannel::new(
            cfg,
            center_hz,
            sample_rate as f64,
        )));
    }
    if is_acars(&cfg.mode) {
        return acars_channel::AcarsChannel::new(cfg, center_hz, sample_rate)
            .map(Channel::Acars);
    }
    build_mfsk_channel(cfg, center_hz, sample_rate).map(|channel| Channel::Mfsk(Box::new(channel)))
}

fn build_mfsk_channel(
    cfg: &DecoderConfig,
    center_hz: f64,
    sample_rate: u32,
) -> Result<MfskChannel, String> {
    let ft2 = is_ft2(&cfg.mode);
    let mode = if ft2 {
        None
    } else {
        Some(mfsk_mode(&cfg.mode).ok_or_else(|| format!("unsupported mode {}", cfg.mode))?)
    };
    let offset = cfg.frequency_hz - center_hz as i64;
    if offset.unsigned_abs() > sample_rate as u64 / 2 {
        return Err(format!(
            "frequency {} is outside the {sample_rate} Hz dongle span around {center_hz}",
            cfg.frequency_hz
        ));
    }

    let mut extractor = IqExtractor::new(IqExtractorConfig {
        input_sample_rate: sample_rate as i32,
        // Ask for slightly more than 12 kHz: the integer decimator rounds to
        // the nearest factor, and undershooting would leave the linear
        // resampler trying to upsample. The final resampler brings this back
        // to exactly 12 kHz for the decoders.
        output_sample_rate: (AUDIO_RATE + 200) as i32,
        tune_offset: offset as i32,
        dc_offset_removal: true,
    })
    .map_err(|e| format!("channel extractor: {e}"))?;
    // `IqExtractor` cuts at half the bandwidth. FT8/FT4 audio occupies
    // roughly 0–3 kHz, so keep a 6 kHz channel around the decoder dial.
    extractor.set_bandwidth((cfg.bandwidth_hz.max(3000) * 2).min(AUDIO_RATE as i32));

    let actual_rate = extractor.output_sample_rate() as f64;
    let mut demod = SsbDemod::new(SsbMode::Usb);
    demod
        .init(actual_rate)
        .map_err(|e| format!("USB demodulator: {e}"))?;
    demod.set_bandwidth(cfg.bandwidth_hz.max(3000) as f64);

    let (decoder, slot_len) = if ft2 {
        (DecoderKind::Ft2, 45_000usize) // 3.75 s at 12 kHz
    } else {
        let mode = mode.expect("non-FT2 mode");
        (
            DecoderKind::Mfsk(AnyDecoder::new(
                mode,
                DecodeParams::for_band((100.0, 3000.0)),
            )),
            mode.meta().slot_samples_12k as usize,
        )
    };

    let (decode_tx, decode_rx) = mpsc::channel();
    let results = Arc::new(Mutex::new(Vec::new()));
    let worker_results = Arc::clone(&results);
    let worker_cfg = cfg.clone();
    thread::Builder::new()
        .name(format!("decoder-slot-{}", cfg.id))
        .spawn(move || decode_worker(decoder, worker_cfg, worker_results, decode_rx))
        .map_err(|e| format!("decoder slot worker: {e}"))?;

    Ok(MfskChannel {
        cfg: cfg.clone(),
        extractor,
        demod,
        resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
        decode_tx,
        results,
        audio: Vec::with_capacity(slot_len + AUDIO_RATE as usize),
        pcm: Vec::new(),
        complex: Vec::new(),
        resampled: Vec::new(),
        slot_len,
        last_slot: 0,
    })
}

fn decode_worker(
    mut decoder: DecoderKind,
    cfg: DecoderConfig,
    results: Arc<Mutex<Vec<serde_json::Value>>>,
    rx: Receiver<DecodeJob>,
) {
    while let Ok(job) = rx.recv() {
        let mut out = Vec::new();
        match &mut decoder {
            DecoderKind::Mfsk(decoder) => {
                let result = decoder.decode_i16(&job.audio, Some(job.period));
                for row in result.rows {
                    let decoded = &row.decoded;
                    out.push(json!({
                        "id": cfg.id,
                        "mode": cfg.mode,
                        "text": decoded.text,
                        "audioHz": decoded.freq_hz,
                        "rfHz": cfg.frequency_hz as f64 + decoded.freq_hz as f64,
                        "snrDb": decoded.snr_db,
                        "dtSec": decoded.dt_sec,
                        "period": job.period,
                        "dialHz": cfg.frequency_hz,
                    }));
                }
            }
            DecoderKind::Ft2 => {
                for result in ft2::decode::decode_slot(&job.audio, 100.0, 3000.0, 1.0, 200) {
                    let Some(text) = mfsk_core::msg::wsjt77::unpack77(result.message77()) else {
                        continue;
                    };
                    out.push(json!({
                        "id": cfg.id,
                        "mode": cfg.mode,
                        "text": text,
                        "audioHz": result.freq_hz,
                        "rfHz": cfg.frequency_hz as f64 + result.freq_hz as f64,
                        "snrDb": result.snr_db,
                        "dtSec": result.dt_sec,
                        "period": job.period,
                        "dialHz": cfg.frequency_hz,
                    }));
                }
            }
        }
        if !out.is_empty() {
            results.lock().extend(out);
        }
    }
}

fn append_audio(channel: &mut MfskChannel, audio: &[f32], now: i64) {
    let slot_ns = (channel.slot_len as i64 * 1_000_000_000) / AUDIO_RATE as i64;
    let slot = now / slot_ns.max(1);
    if channel.last_slot == 0 {
        channel.last_slot = slot;
    } else if slot != channel.last_slot {
        if channel.audio.len() >= channel.slot_len {
            let start = channel.audio.len() - channel.slot_len;
            let slot_audio = channel.audio[start..].to_vec();
            // Decoding happens on the slot worker, never on the dongle read
            // loop. A deep FT8 pass must not stall FFT/audio for every client.
            if channel
                .decode_tx
                .send(DecodeJob {
                    audio: slot_audio,
                    period: channel.last_slot,
                })
                .is_err()
            {
                warn!(decoder = %channel.cfg.id, "decoder slot worker stopped");
            }
        }
        channel.audio.clear();
        channel.last_slot = slot;
    }

    for sample in audio {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        channel.audio.push(value);
    }
    let keep = channel.slot_len + AUDIO_RATE as usize;
    if channel.audio.len() > keep {
        let excess = channel.audio.len() - keep;
        channel.audio.drain(..excess);
    }
}

fn persist_data(
    store: &StoreHandle,
    dongle_id: &str,
    cfg: &DecoderConfig,
    data: &serde_json::Value,
) {
    // ADS-B snapshots are aircraft tables, not messages: keep one upserted
    // entity per ICAO instead of thousands of rows a day.
    if let Some(aircraft) = data.get("aircraft").and_then(|v| v.as_array()) {
        store
            .store
            .upsert_aircraft(&cfg.id, dongle_id, aircraft, store.retention_days);
        return;
    }
    let text = data
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if text.is_empty() {
        return;
    }
    let record = store::DecoderRecord {
        decoder_id: &cfg.id,
        dongle_id,
        mode: &cfg.mode,
        text,
        frequency_hz: data.get("rfHz").and_then(|v| v.as_f64()).unwrap_or(0.0),
        audio_hz: data.get("audioHz").and_then(|v| v.as_f64()).unwrap_or(0.0),
        snr_db: data.get("snrDb").and_then(|v| v.as_f64()).unwrap_or(0.0),
        dt_sec: data.get("dtSec").and_then(|v| v.as_f64()).unwrap_or(0.0),
        period: data.get("period").and_then(|v| v.as_i64()).unwrap_or(0),
        payload: &data.to_string(),
    };
    store.store.insert(&record, store.retention_days);
}

fn run_worker(
    dongle_id: String,
    configs: Vec<DecoderConfig>,
    ws: Arc<WsManager>,
    store: StoreHandle,
    rx: Receiver<DecoderInput>,
) {
    let mut channels: Vec<Channel> = Vec::new();
    let mut active_center = f64::NAN;
    let mut active_rate = 0u32;

    info!(
        dongle = %dongle_id,
        decoders = configs.len(),
        "background decoder worker started"
    );

    while let Ok(input) = rx.recv() {
        if input.sample_rate != active_rate || (input.center_hz - active_center).abs() > 0.5 {
            if active_rate != 0 {
                info!(
                    dongle = %dongle_id,
                    center_hz = input.center_hz,
                    sample_rate = input.sample_rate,
                    "decoder channelisation restarted after profile/sample-rate change"
                );
            }
            channels.clear();
            for cfg in &configs {
                match build_channel(cfg, input.center_hz, input.sample_rate) {
                    Ok(channel) => {
                        info!(
                            dongle = %dongle_id,
                            decoder = %cfg.id,
                            mode = %cfg.mode,
                            frequency_hz = cfg.frequency_hz,
                            "decoder channel added"
                        );
                        channels.push(channel);
                    }
                    Err(e) => warn!(
                        dongle = %dongle_id,
                        decoder = %cfg.id,
                        frequency_hz = cfg.frequency_hz,
                        error = %e,
                        "decoder channel not placed in the current dongle span"
                    ),
                }
            }
            active_center = input.center_hz;
            active_rate = input.sample_rate;
        }

        let now = now_ns();
        for channel in &mut channels {
            channel.process_chunk(&input.chunk, now);
            for data in channel.take_results() {
                persist_data(&store, &dongle_id, channel.config(), &data);
                ws.broadcast(
                    &dongle_id,
                    pack_decoder_message(&channel.config().mode, data),
                );
            }
        }
    }

    info!(dongle = %dongle_id, "background decoder worker stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_names_map_to_mfsk_modes() {
        assert_eq!(mfsk_mode("FT8"), Some(MfskMode::Ft8));
        assert_eq!(mfsk_mode("ft4"), Some(MfskMode::Ft4));
        assert!(is_ft2("FT2"));
        assert!(supported_mode("ft2"));
        assert_eq!(mfsk_mode("js8"), None);
        assert!(!supported_mode("js8"));
        assert!(supported_mode("acars"));
        #[cfg(feature = "adsb")]
        assert!(supported_mode("adsb"));
    }

    #[test]
    fn build_channel_dispatches_acars_to_the_am_channel() {
        let acars = DecoderConfig {
            id: "acars-131".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "acars".to_string(),
            frequency_hz: 131_550_000,
            bandwidth_hz: 6_000,
            settings: Default::default(),
        };
        let channel = build_channel(&acars, 131_550_000.0, 2_400_000).expect("acars channel");
        assert!(matches!(channel, Channel::Acars(_)));
    }

    #[cfg(feature = "adsb")]
    #[test]
    fn build_channel_dispatches_adsb_to_the_raw_iq_path() {
        let adsb = DecoderConfig {
            id: "adsb-local".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "adsb".to_string(),
            frequency_hz: 1_090_000_000,
            bandwidth_hz: 2_400_000,
            settings: Default::default(),
        };
        let channel = build_channel(&adsb, 1_090_000_000.0, 2_400_000).expect("adsb channel");
        assert!(matches!(channel, Channel::Adsb(_)));
        drop(channel);

        let ft8 = DecoderConfig {
            mode: "ft8".to_string(),
            frequency_hz: 14_074_000,
            bandwidth_hz: 3_000,
            ..adsb
        };
        let channel = build_channel(&ft8, 14_074_000.0, 2_400_000).expect("ft8 channel");
        assert!(matches!(channel, Channel::Mfsk(_)));
    }

    #[test]
    fn any_decoder_decodes_a_synthetic_ft8_slot() {
        use mfsk_core::prelude::{encode, SlotInput, TxAudio};

        let tx = encode(MfskMode::Ft8, "CQ N0CALL").expect("encode FT8");
        let frame = tx.synthesize(&TxAudio::new(12_000, 1_500.0));
        let mut slot = vec![0.0f32; 180_000];
        slot[6_000..6_000 + frame.len()].copy_from_slice(&frame);

        let mut decoder = AnyDecoder::new(MfskMode::Ft8, DecodeParams::for_band((100.0, 3000.0)));
        let result = decoder.decode(&SlotInput::f32(&slot));
        assert!(!result.rows.is_empty(), "synthetic FT8 slot did not decode");
        assert!(result
            .rows
            .iter()
            .any(|row| row.decoded.text.contains("N0CALL")));
    }

    #[test]
    fn ft2_decodes_a_synthetic_slot() {
        let msg = mfsk_core::msg::wsjt77::pack77("CQ", "OE1ABC", "JN88").expect("pack FT2");
        let tones = ft2::encode::message_to_tones(&msg);
        let frame = ft2::encode::tones_to_i16(&tones, 1_500.0, 10_000);
        let mut slot = vec![0i16; 45_000];
        slot[1_200..1_200 + frame.len()].copy_from_slice(&frame);

        let result = ft2::decode::decode_slot(&slot, 100.0, 3000.0, 1.0, 200);
        assert!(!result.is_empty(), "synthetic FT2 slot did not decode");
        let text = mfsk_core::msg::wsjt77::unpack77(result[0].message77()).unwrap();
        assert!(text.contains("OE1ABC"), "decoded {text}");
    }

    #[test]
    fn any_decoder_decodes_a_synthetic_ft4_slot() {
        use mfsk_core::prelude::{encode, SlotInput, TxAudio};

        let tx = encode(MfskMode::Ft4, "CQ N0CALL").expect("encode FT4");
        let frame = tx.synthesize(&TxAudio::new(12_000, 1_500.0));
        let mut slot = vec![0.0f32; 90_000];
        slot[3_000..3_000 + frame.len()].copy_from_slice(&frame);

        let mut decoder = AnyDecoder::new(MfskMode::Ft4, DecodeParams::for_band((100.0, 3000.0)));
        let result = decoder.decode(&SlotInput::f32(&slot));
        assert!(!result.rows.is_empty(), "synthetic FT4 slot did not decode");
        assert!(result
            .rows
            .iter()
            .any(|row| row.decoded.text.contains("N0CALL")));
    }
}
