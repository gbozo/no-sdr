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

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use mfsk_core::prelude::{AnyDecoder, DecodeParams, Mode as MfskMode};
use num_complex::Complex32;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};
use crate::ws::{pack_decoder_message, WsManager};

mod acars;
mod acars_channel;
#[cfg(feature = "adsb")]
mod adsb;
#[cfg(any(
    feature = "aprs",
    feature = "navtex",
    feature = "packet",
    feature = "wefax",
    feature = "sstv",
    feature = "hell",
    feature = "text"
))]
mod afsk;
#[cfg(feature = "ais")]
mod ais;
#[cfg(feature = "aprs")]
mod aprs;
#[cfg(feature = "meteor")]
pub(crate) mod fsk441_rx;
mod ft2;
#[cfg(feature = "packet")]
mod g3ruh;
#[cfg(feature = "hell")]
mod hell;
#[cfg(feature = "hell")]
mod hell_font;
#[cfg(all(test, feature = "hell"))]
mod hell_ref_font;
#[cfg(feature = "hell")]
mod hell_rx;
#[cfg(feature = "hfdl")]
mod hfdl;
#[cfg(feature = "js8")]
mod js8;
#[cfg(feature = "js8")]
mod js8_channel;
#[cfg(feature = "ism")]
mod ism;
#[cfg(feature = "meteor")]
mod meteor;
#[cfg(feature = "navtex")]
mod navtex;
#[cfg(feature = "navtex")]
mod navtex_sitor;
#[cfg(feature = "packet")]
mod packet;
#[cfg(feature = "pi4")]
mod pi4;
#[cfg(feature = "sstv")]
mod sstv;
#[cfg(feature = "sstv")]
mod sstv_rx;
#[cfg(feature = "sstv")]
mod sstv_slant;
pub(crate) mod scope;
pub mod store;
#[cfg(feature = "text")]
mod text;
#[cfg(feature = "time")]
mod als162;
#[cfg(feature = "time")]
mod dcf77;
#[cfg(feature = "time")]
mod timecode;
#[cfg(feature = "vdl2")]
mod vdl2;
#[cfg(feature = "wefax")]
mod wefax;
#[cfg(feature = "wefax")]
mod wefax_rx;

/// Decoder channel audio rate. Every slotted mfsk-core mode uses 12 kHz.
pub(crate) const AUDIO_RATE: u32 = 12_000;

/// One half-open RF range, in absolute Hz.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RangeSpec {
    pub start_hz: f64,
    pub end_hz: f64,
}

impl RangeSpec {
    fn new(start_hz: f64, end_hz: f64) -> Self {
        let (start_hz, end_hz) = if start_hz <= end_hz {
            (start_hz, end_hz)
        } else {
            (end_hz, start_hz)
        };
        Self { start_hz, end_hz }
    }

    pub(crate) fn center_hz(&self) -> f64 {
        (self.start_hz + self.end_hz) * 0.5
    }

    pub(crate) fn bandwidth_hz(&self) -> f64 {
        self.end_hz - self.start_hz
    }

    fn expanded(&self, hz: f64) -> Self {
        Self::new(self.start_hz - hz, self.end_hz + hz)
    }

    fn to_json(&self) -> Value {
        json!({
            "startHz": self.start_hz,
            "centerHz": self.center_hz(),
            "endHz": self.end_hz,
            "bandwidthHz": self.bandwidth_hz(),
        })
    }
}

/// Where a foreground decoder actually listens, and what the client should
/// draw around it. This is the single source of truth behind the decoder
/// scope: the client must not guess from the demod bandwidth.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WindowSpec {
    pub dial_hz: f64,
    /// The range the decoder actually consumes, in absolute RF Hz.
    pub window: RangeSpec,
    /// One or more handled ranges. Multi-channel decoders (AIS/VDL2) and raw
    /// decoders get more than one.
    pub handled: Vec<(RangeSpec, String)>,
    /// Suggested wider span for the mini waterfall.
    pub display: RangeSpec,
    /// A narrower band the decoder searches inside `window` (WSPR).
    pub decode_band: Option<RangeSpec>,
    /// `usb`, `am`, `fm`, `lane`, `fixed` or `raw`.
    pub window_kind: &'static str,
    pub tunable: bool,
    pub scope: bool,
    pub expected_audio_hz: f64,
    pub period_s: f64,
}

impl WindowSpec {
    pub(crate) fn to_json(
        &self,
        id: &str,
        mode: &str,
        suggest_tune_hz: Option<f64>,
    ) -> Value {
        let handled: Vec<Value> = self
            .handled
            .iter()
            .map(|(range, label)| {
                let mut value = range.to_json();
                if let Some(object) = value.as_object_mut() {
                    object.insert("label".into(), Value::String(label.clone()));
                }
                value
            })
            .collect();
        let mut value = json!({
            "kind": "window",
            "id": id,
            "mode": mode,
            "dialHz": self.dial_hz,
            "window": self.window.to_json(),
            "handled": handled,
            "display": self.display.to_json(),
            "windowKind": self.window_kind,
            "tunable": self.tunable,
            "scope": self.scope,
            "expectedAudioHz": self.expected_audio_hz,
            "period": self.period_s,
            "suggestTuneHz": suggest_tune_hz,
        });
        if let Some(band) = &self.decode_band {
            if let Some(object) = value.as_object_mut() {
                object.insert("decodeBand".into(), band.to_json());
            }
        }
        value
    }
}

fn usb_window(dial_hz: f64, bandwidth_hz: f64, expected_audio_hz: f64, period_s: f64) -> WindowSpec {
    let window = RangeSpec::new(dial_hz, dial_hz + bandwidth_hz);
    WindowSpec {
        dial_hz,
        handled: vec![(
            window.clone(),
            format!("{:.1} kHz USB", bandwidth_hz / 1000.0),
        )],
        display: window.expanded((bandwidth_hz * 0.5).max(1_000.0)),
        window,
        decode_band: None,
        window_kind: "usb",
        tunable: true,
        scope: true,
        expected_audio_hz,
        period_s,
    }
}

fn centered_window(
    dial_hz: f64,
    bandwidth_hz: f64,
    kind: &'static str,
    expected_audio_hz: f64,
    period_s: f64,
) -> WindowSpec {
    let half = bandwidth_hz * 0.5;
    let window = RangeSpec::new(dial_hz - half, dial_hz + half);
    WindowSpec {
        dial_hz,
        handled: vec![(
            window.clone(),
            format!("{:.1} kHz {}", bandwidth_hz / 1000.0, kind.to_ascii_uppercase()),
        )],
        display: window.expanded((bandwidth_hz * 0.35).max(1_000.0)),
        window,
        decode_band: None,
        window_kind: kind,
        tunable: true,
        scope: true,
        expected_audio_hz,
        period_s,
    }
}

#[allow(dead_code)]
fn fixed_window(
    center_hz: f64,
    rate_hz: f64,
    channels: &[(f64, String)],
    channel_bw_hz: f64,
    label: &str,
    period_s: f64,
) -> WindowSpec {
    let mut handled = Vec::new();
    for (center, name) in channels {
        if (center - center_hz).abs() <= rate_hz * 0.5 {
            handled.push((
                RangeSpec::new(center - channel_bw_hz * 0.5, center + channel_bw_hz * 0.5),
                format!("{label} {name}"),
            ));
        }
    }
    let plan_start = channels
        .iter()
        .map(|(center, _)| center - channel_bw_hz * 0.5)
        .fold(f64::INFINITY, f64::min);
    let plan_end = channels
        .iter()
        .map(|(center, _)| center + channel_bw_hz * 0.5)
        .fold(f64::NEG_INFINITY, f64::max);
    let plan = RangeSpec::new(plan_start, plan_end);
    let window = if handled.is_empty() {
        plan.clone()
    } else {
        RangeSpec::new(
            handled.iter().map(|(r, _)| r.start_hz).fold(f64::INFINITY, f64::min),
            handled.iter().map(|(r, _)| r.end_hz).fold(f64::NEG_INFINITY, f64::max),
        )
    };
    WindowSpec {
        dial_hz: window.center_hz(),
        handled,
        display: plan.expanded(25_000.0),
        window,
        decode_band: None,
        window_kind: "fixed",
        tunable: false,
        scope: false,
        expected_audio_hz: 0.0,
        period_s,
    }
}

#[allow(dead_code)]
fn raw_window(center_hz: f64, rate_hz: f64, label: &str, period_s: f64) -> WindowSpec {
    let window = RangeSpec::new(center_hz - rate_hz * 0.5, center_hz + rate_hz * 0.5);
    WindowSpec {
        dial_hz: window.center_hz(),
        handled: vec![(window.clone(), label.to_string())],
        display: window.clone(),
        window,
        decode_band: None,
        window_kind: "raw",
        tunable: false,
        scope: false,
        expected_audio_hz: 0.0,
        period_s,
    }
}

fn window_period_s(mode: &str) -> f64 {
    if is_ft2(mode) {
        return 3.75;
    }
    #[cfg(feature = "pi4")]
    if is_pi4(mode) {
        return 60.0;
    }
    if let Some(mode) = mfsk_mode(mode) {
        return mode.meta().slot_samples_12k as f64 / AUDIO_RATE as f64;
    }
    #[cfg(feature = "js8")]
    if is_js8(mode) {
        return 15.0;
    }
    #[cfg(feature = "meteor")]
    if is_meteor_mode(mode) {
        return 15.0;
    }
    0.0
}

#[allow(dead_code)]
fn expected_audio_hz(mode: &str) -> f64 {
    let mode = mode.trim().to_ascii_lowercase();
    match mode.as_str() {
        "acars" => 1_800.0,
        "aprs" | "packet" | "navtex" => 1_700.0,
        "wefax" | "sstv" => 1_900.0,
        "dcf77" | "als162" => 0.0,
        "fst4" | "q65" | "jt65" | "jt9" | "wspr" => 1_500.0,
        _ => 1_500.0,
    }
}

/// The RF window a decoder actually consumes, plus what the UI should draw.
///
/// The values mirror the channel constructors: USB modes listen above the
/// dial, AM/FM modes are centred on it, and raw/fixed-plan decoders cover the
/// receiver window or a fixed channel raster.
#[allow(unused_variables)]
pub(crate) fn window_spec(
    mode: &str,
    dial_hz: f64,
    center_hz: f64,
    sample_rate: u32,
) -> WindowSpec {
    let rate_hz = sample_rate.max(1) as f64;
    let period_s = window_period_s(mode);

    #[cfg(feature = "adsb")]
    if is_adsb(mode) {
        return raw_window(
            center_hz,
            rate_hz,
            "receiver window (ADS-B @ 1090 MHz)",
            period_s,
        );
    }
    #[cfg(feature = "ais")]
    if is_ais(mode) {
        let channels: Vec<(f64, String)> = sdroxide_ais::plan::CHANNELS
            .iter()
            .map(|c| (c.center_hz, c.label.to_string()))
            .collect();
        return fixed_window(center_hz, rate_hz, &channels, 25_000.0, "AIS", period_s);
    }
    #[cfg(feature = "vdl2")]
    if is_vdl2(mode) {
        let channels: Vec<(f64, String)> = sdroxide_vdl2::plan::CHANNELS
            .iter()
            .map(|c| (c.center_hz, c.label.to_string()))
            .collect();
        return fixed_window(center_hz, rate_hz, &channels, 25_000.0, "VDL2", period_s);
    }
    #[cfg(feature = "ism")]
    if is_ism(mode) {
        return raw_window(center_hz, rate_hz, "receiver window (ISM)", period_s);
    }
    #[cfg(feature = "hfdl")]
    if is_hfdl(mode) {
        let mut spec = centered_window(dial_hz, 24_000.0, "lane", 0.0, period_s);
        spec.scope = false;
        return spec;
    }
    if is_acars(mode) {
        let mut spec = centered_window(dial_hz, 6_000.0, "am", 1_800.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "aprs")]
    if is_aprs(mode) {
        let mut spec = centered_window(dial_hz, 12_500.0, "fm", 1_700.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "packet")]
    if is_packet(mode) {
        let mut spec = centered_window(dial_hz, 12_500.0, "fm", 1_700.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "time")]
    if is_dcf77(mode) || is_als162(mode) {
        let mut spec = centered_window(dial_hz, 200.0, "am", 0.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "meteor")]
    if is_meteor_mode(mode) {
        // MSK144/FSK441 already have a dedicated meteor display; a second
        // decimator for a mini waterfall is not worth the CPU.
        let mut spec = usb_window(dial_hz, 2_500.0, 1_500.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "js8")]
    if is_js8(mode) {
        // JS8 is FT8-family: same 3 kHz USB window and 15 s slots, so the
        // FT8-style scope and slot UI apply.
        return usb_window(dial_hz, 3_000.0, 1_500.0, period_s);
    }
    #[cfg(feature = "navtex")]
    if is_navtex(mode) {
        let mut spec = usb_window(dial_hz, 3_000.0, 1_700.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "wefax")]
    if is_wefax(mode) {
        let mut spec = usb_window(dial_hz, 3_000.0, 1_900.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "sstv")]
    if is_sstv(mode) {
        let mut spec = usb_window(dial_hz, 3_000.0, 1_900.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "hell")]
    if is_hell(mode) {
        let mut spec = usb_window(dial_hz, 3_000.0, 1_500.0, period_s);
        spec.scope = false;
        return spec;
    }
    #[cfg(feature = "text")]
    if is_text(mode) {
        let mut spec = usb_window(dial_hz, 3_000.0, expected_audio_hz(mode), period_s);
        spec.scope = false;
        return spec;
    }

    // Every remaining mode is a WSJT/FT2/PI4 slotted USB channel.
    let mut spec = usb_window(dial_hz, 3_000.0, 1_500.0, period_s);
    if mode.trim().eq_ignore_ascii_case("wspr") {
        spec.decode_band = Some(RangeSpec::new(dial_hz + 1_400.0, dial_hz + 1_600.0));
        spec.expected_audio_hz = 1_500.0;
    }
    spec
}

pub(crate) fn pack_window_message(
    id: &str,
    mode: &str,
    window: &WindowSpec,
    suggest_tune_hz: Option<f64>,
) -> Vec<u8> {
    crate::ws::pack_decoder_message(mode, window.to_json(id, mode, suggest_tune_hz))
}

/// Approximate on-air width of one decoded signal, used to size the marker in
/// the decoder scope. These are display widths, not decoder bandwidths.
pub(crate) fn signal_bw_hz(mode: &str) -> f64 {
    match mode.trim().to_ascii_lowercase().as_str() {
        "ft8" => 50.0,
        "ft4" => 83.0,
        "ft2" => 167.0,
        "wspr" => 6.0,
        "jt65" => 180.0,
        "jt9" => 16.0,
        "fst4" => 6.0,
        "q65" => 30.0,
        "msk144" | "fsk441" => 1_500.0,
        "js8" => 50.0,
        "acars" => 2_400.0,
        "aprs" | "packet" => 3_000.0,
        "navtex" => 1_700.0,
        "wefax" | "sstv" => 1_900.0,
        "hell" => 1_000.0,
        "olivia" | "thor" | "fsq" => 500.0,
        "psk31" => 31.0,
        "rtty" => 170.0,
        "dcf77" | "als162" => 100.0,
        _ => 0.0,
    }
}

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

struct StoreHandle {
    store: Arc<store::DecoderStore>,
    seen: SnapshotSeen,
}

/// Bounded remember-set for snapshot decoders.
///
/// VDL2, HFDL and ISM re-send a rolling table in every status update. Writing
/// the whole table on each tick would fill SQLite with duplicates, so only
/// items whose identity key has not been seen before are persisted.
#[derive(Default)]
pub(crate) struct SnapshotSeen {
    keys: HashMap<String, VecDeque<String>>,
}

const SNAPSHOT_SEEN_CAP: usize = 4096;

impl SnapshotSeen {
    pub(crate) fn first_seen(&mut self, decoder_id: &str, key: String) -> bool {
        let ring = self.keys.entry(decoder_id.to_string()).or_default();
        if ring.iter().any(|existing| existing == &key) {
            return false;
        }
        ring.push_back(key);
        if ring.len() > SNAPSHOT_SEEN_CAP {
            ring.pop_front();
        }
        true
    }
}

impl DecoderManager {
    /// Build workers from the configured decoders. Unsupported modes and
    /// decoders without a dongle are logged and skipped, not fatal: a config
    /// written for a future mode must not stop the receiver.
    pub fn new(
        decoders: &[DecoderConfig],
        ws: Arc<WsManager>,
        store: Arc<store::DecoderStore>,
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
                seen: SnapshotSeen::default(),
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
    #[cfg(feature = "pi4")]
    Pi4,
}

struct DecodeJob {
    audio: Vec<i16>,
    /// UTC slot index, for result metadata.
    slot: i64,
    /// Mode period in seconds. This is what mfsk-core's `period` argument
    /// expects; the slot index is not a period.
    period_s: i64,
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
    last_status: i64,
    /// Smoothed audio level (dBFS) for the status line.
    level: f32,
    /// Opt-in zoom spectrum, fed from the channel's own extracted IQ.
    scope: Option<scope::TapScope>,
    scope_frame: Option<Vec<u8>>,
    decodes: Arc<AtomicU64>,
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
    let key = mode.trim().to_ascii_uppercase().replace('_', "-");
    let key = match key.as_str() {
        "FST4" | "FST4-60" => "FST4-60A",
        "Q65" => "Q65-30A",
        _ => key.as_str(),
    };
    MfskMode::from_name(key)
}

fn is_ft2(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("ft2")
}

#[cfg(feature = "pi4")]
fn is_pi4(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("pi4")
}

fn is_acars(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("acars")
}

#[cfg(feature = "ais")]
fn is_ais(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("ais")
}

#[cfg(feature = "vdl2")]
fn is_vdl2(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("vdl2")
}

#[cfg(feature = "hfdl")]
fn is_hfdl(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("hfdl")
}

#[cfg(feature = "adsb")]
fn is_adsb(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("adsb")
}

#[cfg(feature = "aprs")]
fn is_aprs(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("aprs")
}

#[cfg(feature = "navtex")]
fn is_navtex(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("navtex")
}

#[cfg(feature = "ism")]
fn is_ism(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("ism")
}

#[cfg(feature = "packet")]
fn is_packet(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("packet")
}

#[cfg(feature = "wefax")]
fn is_wefax(mode: &str) -> bool {
    wefax::is_wefax(mode)
}

#[cfg(feature = "sstv")]
fn is_sstv(mode: &str) -> bool {
    sstv::is_sstv(mode)
}

#[cfg(feature = "hell")]
fn is_hell(mode: &str) -> bool {
    hell::is_hell(mode)
}

#[cfg(feature = "text")]
fn is_text(mode: &str) -> bool {
    text::is_text_mode(mode)
}

#[cfg(feature = "meteor")]
fn is_meteor_mode(mode: &str) -> bool {
    meteor::is_meteor(mode)
}

#[cfg(feature = "js8")]
fn is_js8(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("js8")
}

#[cfg(feature = "time")]
fn is_dcf77(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("dcf77")
}

#[cfg(feature = "time")]
fn is_als162(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case("als162")
}

/// A decoder mode that makes sense as a background worker.
///
/// Background decoding is only useful when the mode emits discrete,
/// timestamped messages that can be stored and reviewed later. Continuous
/// text modes (RTTY, PSK31, Olivia, THOR, FSQ) and image modes (WEFAX, SSTV,
/// HELL) are still available as foreground decoders but are deliberately not
/// listed here.
pub struct BackgroundDecoderMode {
    pub mode: &'static str,
    pub label: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    pub default_frequency_hz: i64,
    pub default_bandwidth_hz: i32,
}

const BACKGROUND_MODES: &[BackgroundDecoderMode] = &[
    BackgroundDecoderMode {
        mode: "ft8",
        label: "FT8",
        category: "Weak signal",
        description: "15-second WSJT weak-signal mode; decodes callsigns, grids and reports.",
        default_frequency_hz: 14_074_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "ft4",
        label: "FT4",
        category: "Weak signal",
        description: "Fast 7.5-second WSJT mode for contest and scatter work.",
        default_frequency_hz: 14_080_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "ft2",
        label: "FT2",
        category: "Weak signal",
        description: "3.75-second FT8-family mode for rapid exchanges.",
        default_frequency_hz: 14_080_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "fst4",
        label: "FST4",
        category: "Weak signal",
        description: "Long-period FST4 (15–1800 s) for LF/MF and EME paths.",
        default_frequency_hz: 7_078_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "q65",
        label: "Q65",
        category: "Weak signal",
        description: "Q65 EME and scatter mode; sub-mode is selected in settings.",
        default_frequency_hz: 50_275_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "jt65",
        label: "JT65",
        category: "Weak signal",
        description: "Classic 60-second EME weak-signal mode.",
        default_frequency_hz: 14_076_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "jt9",
        label: "JT9",
        category: "Weak signal",
        description: "Narrow 60-second HF weak-signal mode.",
        default_frequency_hz: 14_078_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "wspr",
        label: "WSPR",
        category: "Propagation",
        description: "Two-minute propagation beacons in a 200 Hz window.",
        default_frequency_hz: 14_095_600,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "pi4",
        label: "PI4",
        category: "Beacon",
        description: "One-minute 4-FSK beacon frames (PI4).",
        default_frequency_hz: 144_471_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "msk144",
        label: "MSK144",
        category: "Meteor",
        description: "Short meteor-scatter bursts with callsign payloads.",
        default_frequency_hz: 50_260_000,
        default_bandwidth_hz: 2_500,
    },
    BackgroundDecoderMode {
        mode: "fsk441",
        label: "FSK441",
        category: "Meteor",
        description: "Legacy meteor-scatter mode; 15 or 30 second periods.",
        default_frequency_hz: 50_260_000,
        default_bandwidth_hz: 2_500,
    },
    BackgroundDecoderMode {
        mode: "js8",
        label: "JS8",
        category: "Weak signal",
        description: "FT8-family keyboard-to-keyboard messaging with directed frames.",
        default_frequency_hz: 7_078_000,
        default_bandwidth_hz: 3_000,
    },
    BackgroundDecoderMode {
        mode: "adsb",
        label: "ADS-B",
        category: "Aircraft",
        description: "1090 MHz Mode S/ADS-B aircraft identities and positions.",
        default_frequency_hz: 1_090_000_000,
        default_bandwidth_hz: 2_400_000,
    },
    BackgroundDecoderMode {
        mode: "acars",
        label: "ACARS",
        category: "Aircraft",
        description: "VHF ACARS aircraft datalink messages.",
        default_frequency_hz: 131_550_000,
        default_bandwidth_hz: 6_000,
    },
    BackgroundDecoderMode {
        mode: "ais",
        label: "AIS",
        category: "Marine",
        description: "Marine AIS vessel identities, positions and status.",
        default_frequency_hz: 162_000_000,
        default_bandwidth_hz: 25_000,
    },
    BackgroundDecoderMode {
        mode: "vdl2",
        label: "VDL2",
        category: "Aircraft",
        description: "VHF VDL Mode 2 aviation datalink messages.",
        default_frequency_hz: 136_812_500,
        default_bandwidth_hz: 25_000,
    },
    BackgroundDecoderMode {
        mode: "hfdl",
        label: "HFDL",
        category: "Aircraft",
        description: "HF datalink aircraft messages and ground-station logs.",
        default_frequency_hz: 21_931_000,
        default_bandwidth_hz: 24_000,
    },
    BackgroundDecoderMode {
        mode: "aprs",
        label: "APRS",
        category: "Amateur",
        description: "Amateur packet positions, weather and telemetry.",
        default_frequency_hz: 144_390_000,
        default_bandwidth_hz: 12_500,
    },
    BackgroundDecoderMode {
        mode: "navtex",
        label: "NAVTEX",
        category: "Marine",
        description: "Marine safety and weather broadcasts (SITOR-B).",
        default_frequency_hz: 518_000,
        default_bandwidth_hz: 1_700,
    },
    BackgroundDecoderMode {
        mode: "packet",
        label: "PACKET",
        category: "Amateur",
        description: "AX.25 packet radio frames.",
        default_frequency_hz: 144_390_000,
        default_bandwidth_hz: 12_500,
    },
    BackgroundDecoderMode {
        mode: "ism",
        label: "ISM",
        category: "Utility",
        description: "ISM-band device reports and bursts.",
        default_frequency_hz: 433_920_000,
        default_bandwidth_hz: 2_400_000,
    },
    BackgroundDecoderMode {
        mode: "dcf77",
        label: "DCF77",
        category: "Time",
        description: "77.5 kHz time-code broadcasts with decoded UTC.",
        default_frequency_hz: 77_500,
        default_bandwidth_hz: 100,
    },
    BackgroundDecoderMode {
        mode: "als162",
        label: "ALS162",
        category: "Time",
        description: "162 kHz French time-code broadcasts with decoded UTC.",
        default_frequency_hz: 162_000,
        default_bandwidth_hz: 100,
    },
];

/// Catalog exposed to the admin UI. Feature-gated modes that are not built in
/// are omitted, so the picker cannot create a decoder the binary cannot run.
pub fn background_modes() -> Vec<Value> {
    BACKGROUND_MODES
        .iter()
        .filter(|mode| supported_mode(mode.mode))
        .map(|mode| {
            json!({
                "mode": mode.mode,
                "label": mode.label,
                "category": mode.category,
                "description": mode.description,
                "defaultFrequencyHz": mode.default_frequency_hz,
                "defaultBandwidthHz": mode.default_bandwidth_hz,
                "background": true,
            })
        })
        .collect()
}

pub fn is_background_mode(mode: &str) -> bool {
    let mode = mode.trim().to_ascii_lowercase();
    BACKGROUND_MODES
        .iter()
        .any(|candidate| candidate.mode == mode && supported_mode(candidate.mode))
}

pub(crate) fn supported_mode(mode: &str) -> bool {
    #[cfg(feature = "adsb")]
    if is_adsb(mode) {
        return true;
    }
    #[cfg(feature = "ais")]
    if is_ais(mode) {
        return true;
    }
    #[cfg(feature = "vdl2")]
    if is_vdl2(mode) {
        return true;
    }
    #[cfg(feature = "hfdl")]
    if is_hfdl(mode) {
        return true;
    }
    #[cfg(feature = "aprs")]
    if is_aprs(mode) {
        return true;
    }
    #[cfg(feature = "navtex")]
    if is_navtex(mode) {
        return true;
    }
    #[cfg(feature = "ism")]
    if is_ism(mode) {
        return true;
    }
    #[cfg(feature = "packet")]
    if is_packet(mode) {
        return true;
    }
    #[cfg(feature = "wefax")]
    if is_wefax(mode) {
        return true;
    }
    #[cfg(feature = "sstv")]
    if is_sstv(mode) {
        return true;
    }
    #[cfg(feature = "hell")]
    if is_hell(mode) {
        return true;
    }
    #[cfg(feature = "text")]
    if is_text(mode) {
        return true;
    }
    #[cfg(feature = "meteor")]
    if is_meteor_mode(mode) {
        return true;
    }
    #[cfg(feature = "pi4")]
    if is_pi4(mode) {
        return true;
    }
    #[cfg(feature = "js8")]
    if is_js8(mode) {
        return true;
    }
    #[cfg(feature = "time")]
    if is_dcf77(mode) || is_als162(mode) {
        return true;
    }
    is_acars(mode) || is_ft2(mode) || mfsk_mode(mode).is_some()
}

pub(crate) fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

impl MfskChannel {
    pub(crate) fn take_results(&self) -> Vec<serde_json::Value> {
        std::mem::take(&mut *self.results.lock())
    }

    /// Enable the zoom spectrum on this channel's already-extracted IQ.
    /// Returns false when the span cannot be covered by the channel rate.
    pub(crate) fn set_scope(&mut self, display: &RangeSpec, fps: u32) -> bool {
        let input_rate = self.extractor.output_sample_rate() as f64;
        match scope::TapScope::new(input_rate, self.cfg.frequency_hz as f64, display, fps) {
            Ok(tap) => {
                self.scope = Some(tap);
                self.scope_frame = None;
                tracing::debug!(decoder = %self.cfg.id, "decoder tap scope enabled");
                true
            }
            Err(e) => {
                warn!(decoder = %self.cfg.id, error = %e, "decoder tap scope unavailable");
                self.scope = None;
                false
            }
        }
    }

    pub(crate) fn take_scope(&mut self) -> Option<Vec<u8>> {
        self.scope_frame.take()
    }

    pub(crate) fn clear_scope(&mut self) {
        self.scope = None;
        self.scope_frame = None;
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
        if let Some(scope) = self.scope.as_mut() {
            self.scope_frame = scope.push(&self.complex);
        }
        let audio = self.demod.process(&self.complex);
        let mut resampled = std::mem::take(&mut self.resampled);
        resampled.clear();
        self.resampler.process(&audio, &mut resampled);
        if !resampled.is_empty() {
            let power: f32 = resampled.iter().map(|s| s * s).sum::<f32>()
                / resampled.len() as f32;
            let level = 10.0 * (power + 1e-12).log10();
            self.level = if self.level <= -119.0 {
                level
            } else {
                self.level + 0.25 * (level - self.level)
            };
        }
        append_audio(self, &resampled, now);
        self.resampled = resampled;
        self.pcm = pcm;

        if now.saturating_sub(self.last_status) >= 500_000_000 {
            self.last_status = now;
            let slot_ns = (self.slot_len as i64 * 1_000_000_000) / AUDIO_RATE as i64;
            let slot_ns = slot_ns.max(1);
            let slot = now / slot_ns;
            let next_slot_ms = (slot_ns - (now % slot_ns)) / 1_000_000;
            let status = json!({
                "kind": "status",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "level": self.level,
                "audioHz": 1500.0,
                "dialHz": self.cfg.frequency_hz,
                "period": slot_ns as f64 / 1_000_000_000.0,
                "slot": slot,
                "nextSlotMs": next_slot_ms,
                "decodes": self.decodes.load(Ordering::Relaxed),
                "listening": true,
            });
            self.results.lock().push(status);
        }
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
    #[cfg(feature = "aprs")]
    Aprs(aprs::AprsChannel),
    #[cfg(feature = "ais")]
    Ais(ais::AisChannel),
    #[cfg(feature = "vdl2")]
    Vdl2(vdl2::Vdl2Channel),
    #[cfg(feature = "hfdl")]
    Hfdl(hfdl::HfdlChannel),
    #[cfg(feature = "navtex")]
    Navtex(navtex::NavtexChannel),
    #[cfg(feature = "ism")]
    Ism(ism::IsmChannel),
    #[cfg(feature = "packet")]
    Packet(packet::PacketChannel),
    #[cfg(feature = "wefax")]
    Wefax(wefax::WefaxChannel),
    #[cfg(feature = "sstv")]
    Sstv(sstv::SstvChannel),
    #[cfg(feature = "hell")]
    Hell(hell::HellChannel),
    #[cfg(feature = "text")]
    Text(text::TextChannel),
    #[cfg(feature = "meteor")]
    Meteor(meteor::MeteorChannel),
    #[cfg(feature = "js8")]
    Js8(js8_channel::Js8Channel),
    #[cfg(feature = "time")]
    Dcf77(dcf77::Dcf77Channel),
    #[cfg(feature = "time")]
    Als162(als162::Als162Channel),
}

impl Channel {
    /// Enable the zoom spectrum when this channel can provide it from data it
    /// already extracts. Returns false for channels that need a separate
    /// [`scope::ScopeProcessor`] (or do not support the scope at all).
    pub(crate) fn set_scope(&mut self, display: &RangeSpec, fps: u32) -> bool {
        match self {
            Channel::Mfsk(channel) => channel.set_scope(display, fps),
            #[cfg(feature = "js8")]
            Channel::Js8(channel) => channel.set_scope(display, fps),
            _ => false,
        }
    }

    pub(crate) fn take_scope(&mut self) -> Option<Vec<u8>> {
        match self {
            Channel::Mfsk(channel) => channel.take_scope(),
            #[cfg(feature = "js8")]
            Channel::Js8(channel) => channel.take_scope(),
            _ => None,
        }
    }

    pub(crate) fn clear_scope(&mut self) {
        match self {
            Channel::Mfsk(channel) => channel.clear_scope(),
            #[cfg(feature = "js8")]
            Channel::Js8(channel) => channel.clear_scope(),
            _ => {}
        }
    }

    pub(crate) fn config(&self) -> &DecoderConfig {
        match self {
            Channel::Mfsk(channel) => &channel.cfg,
            Channel::Acars(channel) => &channel.cfg,
            #[cfg(feature = "adsb")]
            Channel::Adsb(channel) => &channel.cfg,
            #[cfg(feature = "aprs")]
            Channel::Aprs(channel) => &channel.cfg,
            #[cfg(feature = "ais")]
            Channel::Ais(channel) => &channel.cfg,
            #[cfg(feature = "vdl2")]
            Channel::Vdl2(channel) => &channel.cfg,
            #[cfg(feature = "hfdl")]
            Channel::Hfdl(channel) => &channel.cfg,
            #[cfg(feature = "navtex")]
            Channel::Navtex(channel) => &channel.cfg,
            #[cfg(feature = "ism")]
            Channel::Ism(channel) => &channel.cfg,
            #[cfg(feature = "packet")]
            Channel::Packet(channel) => &channel.cfg,
            #[cfg(feature = "wefax")]
            Channel::Wefax(channel) => &channel.cfg,
            #[cfg(feature = "sstv")]
            Channel::Sstv(channel) => &channel.cfg,
            #[cfg(feature = "hell")]
            Channel::Hell(channel) => &channel.cfg,
            #[cfg(feature = "text")]
            Channel::Text(channel) => &channel.cfg,
            #[cfg(feature = "meteor")]
            Channel::Meteor(channel) => &channel.cfg,
            #[cfg(feature = "js8")]
            Channel::Js8(channel) => &channel.cfg,
            #[cfg(feature = "time")]
            Channel::Dcf77(channel) => &channel.cfg,
            #[cfg(feature = "time")]
            Channel::Als162(channel) => &channel.cfg,
        }
    }

    pub(crate) fn take_results(&mut self) -> Vec<serde_json::Value> {
        match self {
            Channel::Mfsk(channel) => channel.take_results(),
            Channel::Acars(channel) => channel.take_results(),
            #[cfg(feature = "adsb")]
            Channel::Adsb(channel) => channel.take_results(),
            #[cfg(feature = "aprs")]
            Channel::Aprs(channel) => channel.take_results(),
            #[cfg(feature = "ais")]
            Channel::Ais(channel) => channel.take_results(),
            #[cfg(feature = "vdl2")]
            Channel::Vdl2(channel) => channel.take_results(),
            #[cfg(feature = "hfdl")]
            Channel::Hfdl(channel) => channel.take_results(),
            #[cfg(feature = "navtex")]
            Channel::Navtex(channel) => channel.take_results(),
            #[cfg(feature = "ism")]
            Channel::Ism(channel) => channel.take_results(),
            #[cfg(feature = "packet")]
            Channel::Packet(channel) => channel.take_results(),
            #[cfg(feature = "wefax")]
            Channel::Wefax(channel) => channel.take_results(),
            #[cfg(feature = "sstv")]
            Channel::Sstv(channel) => channel.take_results(),
            #[cfg(feature = "hell")]
            Channel::Hell(channel) => channel.take_results(),
            #[cfg(feature = "text")]
            Channel::Text(channel) => channel.take_results(),
            #[cfg(feature = "meteor")]
            Channel::Meteor(channel) => channel.take_results(),
            #[cfg(feature = "js8")]
            Channel::Js8(channel) => channel.take_results(),
            #[cfg(feature = "time")]
            Channel::Dcf77(channel) => channel.take_results(),
            #[cfg(feature = "time")]
            Channel::Als162(channel) => channel.take_results(),
        }
    }

    /// Feed one raw chunk.
    ///
    /// The public contract is **nanoseconds**, because slots and status
    /// intervals are sub-second. The channel implementations predate that
    /// convention and are split between ns and ms; convert at this boundary
    /// so a foreground and a background worker cannot disagree.
    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now_ns: i64) {
        let now_ms = now_ns / 1_000_000;
        match self {
            Channel::Mfsk(channel) => channel.process_chunk(chunk, now_ns),
            Channel::Acars(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "adsb")]
            Channel::Adsb(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "aprs")]
            Channel::Aprs(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "ais")]
            Channel::Ais(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "vdl2")]
            Channel::Vdl2(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "hfdl")]
            Channel::Hfdl(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "navtex")]
            Channel::Navtex(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "ism")]
            Channel::Ism(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "packet")]
            Channel::Packet(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "wefax")]
            Channel::Wefax(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "sstv")]
            Channel::Sstv(channel) => channel.process_chunk(chunk, now_ms),
            #[cfg(feature = "hell")]
            Channel::Hell(channel) => channel.process_chunk(chunk, now_ms),
            // Text uses ns for its `at` seconds and Instant for status.
            #[cfg(feature = "text")]
            Channel::Text(channel) => channel.process_chunk(chunk, now_ns),
            #[cfg(feature = "meteor")]
            Channel::Meteor(channel) => {
                let results = channel.process(chunk, now_ns);
                channel.pending.extend(results);
            }
            #[cfg(feature = "js8")]
            Channel::Js8(channel) => channel.process_chunk(chunk, now_ns),
            #[cfg(feature = "time")]
            Channel::Dcf77(channel) => channel.process_chunk(chunk, now_ns),
            #[cfg(feature = "time")]
            Channel::Als162(channel) => channel.process_chunk(chunk, now_ns),
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
        return acars_channel::AcarsChannel::new(cfg, center_hz, sample_rate).map(Channel::Acars);
    }
    #[cfg(feature = "aprs")]
    if is_aprs(&cfg.mode) {
        return aprs::AprsChannel::new(cfg, center_hz, sample_rate).map(Channel::Aprs);
    }
    #[cfg(feature = "ais")]
    if is_ais(&cfg.mode) {
        return Ok(Channel::Ais(ais::AisChannel::new(
            cfg,
            center_hz,
            sample_rate as f64,
        )));
    }
    #[cfg(feature = "vdl2")]
    if is_vdl2(&cfg.mode) {
        return Ok(Channel::Vdl2(vdl2::Vdl2Channel::new(
            cfg,
            center_hz,
            sample_rate as f64,
        )));
    }
    #[cfg(feature = "hfdl")]
    if is_hfdl(&cfg.mode) {
        return Ok(Channel::Hfdl(hfdl::HfdlChannel::new(
            cfg,
            center_hz,
            sample_rate as f64,
        )));
    }
    #[cfg(feature = "navtex")]
    if is_navtex(&cfg.mode) {
        return navtex::NavtexChannel::new(cfg, center_hz, sample_rate).map(Channel::Navtex);
    }
    #[cfg(feature = "ism")]
    if is_ism(&cfg.mode) {
        return Ok(Channel::Ism(ism::IsmChannel::new(
            cfg,
            center_hz,
            sample_rate as f64,
        )));
    }
    #[cfg(feature = "packet")]
    if is_packet(&cfg.mode) {
        return packet::PacketChannel::new(cfg, center_hz, sample_rate).map(Channel::Packet);
    }
    #[cfg(feature = "wefax")]
    if is_wefax(&cfg.mode) {
        return wefax::WefaxChannel::build(cfg, center_hz, sample_rate).map(Channel::Wefax);
    }
    #[cfg(feature = "sstv")]
    if is_sstv(&cfg.mode) {
        return sstv::SstvChannel::build(cfg, center_hz, sample_rate).map(Channel::Sstv);
    }
    #[cfg(feature = "hell")]
    if is_hell(&cfg.mode) {
        return hell::HellChannel::build(cfg, center_hz, sample_rate).map(Channel::Hell);
    }
    #[cfg(feature = "text")]
    if is_text(&cfg.mode) {
        return text::TextChannel::build(cfg, center_hz, sample_rate).map(Channel::Text);
    }
    #[cfg(feature = "meteor")]
    if is_meteor_mode(&cfg.mode) {
        return meteor::MeteorChannel::build(cfg, center_hz, sample_rate).map(Channel::Meteor);
    }
    #[cfg(feature = "js8")]
    if is_js8(&cfg.mode) {
        return js8_channel::build_channel(cfg, center_hz, sample_rate).map(Channel::Js8);
    }
    #[cfg(feature = "time")]
    if is_dcf77(&cfg.mode) {
        return dcf77::Dcf77Channel::new(cfg, center_hz, sample_rate).map(Channel::Dcf77);
    }
    #[cfg(feature = "time")]
    if is_als162(&cfg.mode) {
        return als162::Als162Channel::new(cfg, center_hz, sample_rate).map(Channel::Als162);
    }
    build_mfsk_channel(cfg, center_hz, sample_rate).map(|channel| Channel::Mfsk(Box::new(channel)))
}

fn build_mfsk_channel(
    cfg: &DecoderConfig,
    center_hz: f64,
    sample_rate: u32,
) -> Result<MfskChannel, String> {
    let ft2 = is_ft2(&cfg.mode);
    #[cfg(feature = "pi4")]
    let pi4 = is_pi4(&cfg.mode);
    #[cfg(not(feature = "pi4"))]
    let pi4 = false;
    let mode = if ft2 || pi4 {
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

    #[cfg(feature = "pi4")]
    let (decoder, slot_len) = if pi4 {
        (DecoderKind::Pi4, 60 * AUDIO_RATE as usize) // one-minute beacon window
    } else if ft2 {
        (DecoderKind::Ft2, 45_000usize) // 3.75 s at 12 kHz
    } else {
        mfsk_decoder(cfg, mode.expect("non-FT2 mode"))
    };
    #[cfg(not(feature = "pi4"))]
    let (decoder, slot_len) = if ft2 {
        (DecoderKind::Ft2, 45_000usize) // 3.75 s at 12 kHz
    } else {
        mfsk_decoder(cfg, mode.expect("non-FT2 mode"))
    };

    let (decode_tx, decode_rx) = mpsc::channel();
    let results = Arc::new(Mutex::new(Vec::new()));
    let decodes = Arc::new(AtomicU64::new(0));
    let worker_results = Arc::clone(&results);
    let worker_decodes = Arc::clone(&decodes);
    let worker_cfg = cfg.clone();
    thread::Builder::new()
        .name(format!("decoder-slot-{}", cfg.id))
        .spawn(move || {
            decode_worker(
                decoder,
                worker_cfg,
                worker_results,
                worker_decodes,
                decode_rx,
            )
        })
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
        last_status: 0,
        level: -120.0,
        scope: None,
        scope_frame: None,
        decodes,
    })
}

fn mfsk_decoder(cfg: &DecoderConfig, mode: MfskMode) -> (DecoderKind, usize) {
    let band = if mode == MfskMode::Wspr {
        (1400.0, 1600.0)
    } else {
        (100.0, 3000.0)
    };
    let _ = cfg;
    (
        DecoderKind::Mfsk(AnyDecoder::new(mode, DecodeParams::for_band(band))),
        mode.meta().slot_samples_12k as usize,
    )
}

fn decode_worker(
    mut decoder: DecoderKind,
    cfg: DecoderConfig,
    results: Arc<Mutex<Vec<serde_json::Value>>>,
    decodes: Arc<AtomicU64>,
    rx: Receiver<DecodeJob>,
) {
    while let Ok(job) = rx.recv() {
        debug!(
            decoder = %cfg.id,
            samples = job.audio.len(),
            slot = job.slot,
            period_s = job.period_s,
            "decoder slot worker started"
        );
        let started = std::time::Instant::now();
        let mut out = Vec::new();
        let mut budget: Option<Value> = None;
        match &mut decoder {
            DecoderKind::Mfsk(decoder) => {
                let result = decoder.decode_i16(&job.audio, Some(job.slot));
                budget = Some(json!({
                    "exhausted": result.budget.exhausted,
                    "candidatesSkipped": result.budget.candidates_skipped,
                    "stagesRun": result.budget.stages_run,
                    "cutAtSync": result.budget.cut_at_sync,
                    "cutAtScore": result.budget.cut_at_score,
                    "rowsSubtracted": result.budget.rows_subtracted,
                }));
                for row in result.rows {
                    let decoded = &row.decoded;
                    let detail = &row.detail;
                    let hard = detail.hard_errors.unwrap_or(0);
                    let confidence = if hard == 0 {
                        1.0
                    } else {
                        (1.0 - hard as f32 / 40.0).clamp(0.0, 0.99)
                    };
                    out.push(json!({
                        "kind": "decode",
                        "id": cfg.id,
                        "mode": cfg.mode,
                        "text": decoded.text,
                        "audioHz": decoded.freq_hz,
                        "rfHz": cfg.frequency_hz as f64 + decoded.freq_hz as f64,
                        "snrDb": decoded.snr_db,
                        "dtSec": decoded.dt_sec,
                        "period": job.slot,
                        "dialHz": cfg.frequency_hz,
                        "signalBwHz": signal_bw_hz(&cfg.mode),
                        "stats": {
                            "crcOk": true,
                            "fecCorrected": detail.hard_errors,
                            "hardErrors": detail.hard_errors,
                            "syncScore": detail.sync_score,
                            "syncCv": detail.sync_cv,
                            "confidence": confidence,
                            "pass": detail.pass,
                            "hashResolved": detail.hash_resolved,
                        },
                    }));
                }
            }
            DecoderKind::Ft2 => {
                for result in ft2::decode::decode_slot(&job.audio, 100.0, 3000.0, 1.0, 200) {
                    let Some(text) = mfsk_core::msg::wsjt77::unpack77(result.message77()) else {
                        continue;
                    };
                    let hard = result.hard_errors;
                    let confidence = if hard == 0 {
                        1.0
                    } else {
                        (1.0 - hard as f32 / 40.0).clamp(0.0, 0.99)
                    };
                    out.push(json!({
                        "kind": "decode",
                        "id": cfg.id,
                        "mode": cfg.mode,
                        "text": text,
                        "audioHz": result.freq_hz,
                        "rfHz": cfg.frequency_hz as f64 + result.freq_hz as f64,
                        "snrDb": result.snr_db,
                        "dtSec": result.dt_sec,
                        "period": job.slot,
                        "dialHz": cfg.frequency_hz,
                        "signalBwHz": signal_bw_hz(&cfg.mode),
                        "stats": {
                            "crcOk": true,
                            "fecCorrected": hard,
                            "hardErrors": hard,
                            "syncScore": result.sync_score,
                            "syncCv": result.sync_cv,
                            "confidence": confidence,
                            "pass": result.pass,
                        },
                    }));
                }
            }
            #[cfg(feature = "pi4")]
            DecoderKind::Pi4 => {
                let audio: Vec<f32> = job
                    .audio
                    .iter()
                    .map(|sample| *sample as f32 / 32768.0)
                    .collect();
                for result in pi4::decode::decode_window(&audio, AUDIO_RATE, 0) {
                    out.push(json!({
                        "kind": "decode",
                        "id": cfg.id,
                        "mode": cfg.mode,
                        "text": result.text,
                        "audioHz": result.tone0_hz,
                        "rfHz": cfg.frequency_hz as f64 + result.tone0_hz as f64,
                        "snrDb": result.snr_db,
                        "dtSec": result.dt_sec,
                        "period": job.slot,
                        "dialHz": cfg.frequency_hz,
                        "signalBwHz": signal_bw_hz(&cfg.mode),
                        "variant": result.variant.label(),
                        "fit": result.fit,
                        "hardErrors": result.hard_errors,
                        "stats": {
                            "crcOk": true,
                            "fecCorrected": result.hard_errors,
                            "hardErrors": result.hard_errors,
                            "confidence": result.fit.clamp(0.0, 1.0),
                        },
                    }));
                }
            }
        }
        let decoded = out.len();
        out.push(json!({
            "kind": "slot",
            "id": cfg.id,
            "mode": cfg.mode,
            "slot": job.slot,
            "periodSec": job.period_s,
            "decodes": decoded,
            "elapsedMs": started.elapsed().as_millis() as u64,
            "budget": budget,
        }));
        decodes.fetch_add(decoded as u64, Ordering::Relaxed);
        results.lock().extend(out);
    }
}

fn append_audio(channel: &mut MfskChannel, audio: &[f32], now: i64) {
    let slot_ns = (channel.slot_len as i64 * 1_000_000_000) / AUDIO_RATE as i64;
    let slot = now / slot_ns.max(1);
    if channel.last_slot == 0 {
        channel.last_slot = slot;
    } else if slot != channel.last_slot {
        // The extractor/resampler has a small startup latency, so the first
        // boundary can arrive a few samples short of a full slot. Pad the
        // front rather than losing the whole slot; a genuinely mid-slot start
        // is still far outside this tolerance.
        let tolerance = AUDIO_RATE as usize / 10;
        if channel.audio.len() + tolerance >= channel.slot_len {
            let slot_audio = if channel.audio.len() >= channel.slot_len {
                let start = channel.audio.len() - channel.slot_len;
                channel.audio[start..].to_vec()
            } else {
                let mut padded = vec![0i16; channel.slot_len - channel.audio.len()];
                padded.extend_from_slice(&channel.audio);
                padded
            };
            // Decoding happens on the slot worker, never on the dongle read
            // loop. A deep FT8 pass must not stall FFT/audio for every client.
            let samples = slot_audio.len();
            let send_result = channel
                .decode_tx
                .send(DecodeJob {
                    audio: slot_audio,
                    slot: channel.last_slot,
                    period_s: ((channel.slot_len as f64 / AUDIO_RATE as f64).round() as i64).max(1),
                });
            if send_result.is_err()
            {
                warn!(decoder = %channel.cfg.id, "decoder slot worker stopped");
            } else {
                debug!(
                    decoder = %channel.cfg.id,
                    samples,
                    slot_len = channel.slot_len,
                    "decoder slot queued"
                );
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

/// Persist one decoder result. Shared by background workers and per-client
/// foreground decoders so both produce identical history rows.
pub(crate) fn persist_result(
    store: &store::DecoderStore,
    seen: &mut SnapshotSeen,
    decoder_id: &str,
    dongle_id: &str,
    mode: &str,
    data: &serde_json::Value,
) {
    // ADS-B/AIS snapshots are entity tables, not messages: keep one upserted
    // row per ICAO/MMSI instead of thousands of rows a day.
    if let Some(aircraft) = data.get("aircraft").and_then(|v| v.as_array()) {
        store.upsert_aircraft(decoder_id, dongle_id, aircraft);
        return;
    }
    if let Some(vessels) = data.get("vessels").and_then(|v| v.as_array()) {
        store.upsert_vessels(decoder_id, dongle_id, vessels);
        return;
    }

    // VDL2 status updates carry a rolling message list.
    if let Some(messages) = data.get("messages").and_then(|v| v.as_array()) {
        for message in messages {
            let at = message.get("at").and_then(|v| v.as_i64()).unwrap_or(0);
            let raw = message
                .get("rawHex")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !seen.first_seen(decoder_id, format!("vdl2|{at}|{raw}")) {
                continue;
            }
            let text = message
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            insert_message(
                store,
                decoder_id,
                dongle_id,
                mode,
                text,
                message
                    .get("freq_hz")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                0.0,
                message
                    .get("snr_db")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                0.0,
                at,
                message,
            );
        }
        return;
    }

    // HFDL status updates carry a rolling decode log.
    if let Some(log) = data.get("log").and_then(|v| v.as_array()) {
        for decode in log {
            let unix = decode.get("unix").and_then(|v| v.as_i64()).unwrap_or(0);
            let kind = decode
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let details = decode
                .get("details")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !seen.first_seen(decoder_id, format!("hfdl|{unix}|{kind}|{details}")) {
                continue;
            }
            let text = if details.is_empty() {
                kind.to_string()
            } else {
                format!("{kind} {details}")
            };
            insert_message(
                store,
                decoder_id,
                dongle_id,
                mode,
                &text,
                decode.get("freqKhz").and_then(|v| v.as_f64()).unwrap_or(0.0) * 1000.0,
                0.0,
                decode.get("snrDb").and_then(|v| v.as_f64()).unwrap_or(0.0),
                0.0,
                unix,
                decode,
            );
        }
        return;
    }

    // ISM reports are one row per device; persist only a changed report.
    if let Some(devices) = data.get("devices").and_then(|v| v.as_array()) {
        for device in devices {
            let id = device.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
            let last_at = device
                .get("lastAt")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let count = device.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
            if !seen.first_seen(decoder_id, format!("ism|{id}|{last_at}|{count}")) {
                continue;
            }
            let protocol = device
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let device_id = device
                .get("device")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let model = device
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let readings = device
                .get("readingsText")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let text = [protocol, device_id, model, readings]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            insert_message(
                store,
                decoder_id,
                dongle_id,
                mode,
                &text,
                device
                    .get("freqHz")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                0.0,
                device.get("snrDb").and_then(|v| v.as_f64()).unwrap_or(0.0),
                0.0,
                last_at,
                device,
            );
        }
        return;
    }

    // Event-style decoders (FT8, APRS, NAVTEX, ACARS, ...) have one message.
    let text = data
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    insert_message(
        store,
        decoder_id,
        dongle_id,
        mode,
        text,
        data.get("rfHz").and_then(|v| v.as_f64()).unwrap_or(0.0),
        data.get("audioHz").and_then(|v| v.as_f64()).unwrap_or(0.0),
        data.get("snrDb").and_then(|v| v.as_f64()).unwrap_or(0.0),
        data.get("dtSec").and_then(|v| v.as_f64()).unwrap_or(0.0),
        data.get("period").and_then(|v| v.as_i64()).unwrap_or(0),
        data,
    );
}

#[allow(clippy::too_many_arguments)]
fn insert_message(
    store: &store::DecoderStore,
    decoder_id: &str,
    dongle_id: &str,
    mode: &str,
    text: &str,
    frequency_hz: f64,
    audio_hz: f64,
    snr_db: f64,
    dt_sec: f64,
    period: i64,
    payload: &serde_json::Value,
) {
    if text.is_empty() {
        return;
    }
    let record = store::DecoderRecord {
        decoder_id,
        dongle_id,
        mode,
        text,
        frequency_hz,
        audio_hz,
        snr_db,
        dt_sec,
        period,
        payload: &payload.to_string(),
    };
    store.insert(&record);
}

fn run_worker(
    dongle_id: String,
    configs: Vec<DecoderConfig>,
    ws: Arc<WsManager>,
    mut store: StoreHandle,
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
                persist_result(
                    &store.store,
                    &mut store.seen,
                    &channel.config().id,
                    &dongle_id,
                    &channel.config().mode,
                    &data,
                );
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
    fn rolling_snapshot_is_persisted_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = store::DecoderStore::open(dir.path().join("decoders.sqlite"));
        let mut seen = SnapshotSeen::default();
        let snapshot = json!({
            "messages": [
                {
                    "at": 100,
                    "rawHex": "AA",
                    "summary": "message one",
                    "freq_hz": 136_975_000.0,
                    "snr_db": 12.0,
                },
                {
                    "at": 101,
                    "rawHex": "BB",
                    "summary": "message two",
                    "freq_hz": 136_800_000.0,
                    "snr_db": 8.0,
                }
            ]
        });
        persist_result(&store, &mut seen, "vdl2-136", "d1", "vdl2", &snapshot);
        // A later status snapshot repeats the rolling table. Only new entries
        // may become new rows.
        persist_result(&store, &mut seen, "vdl2-136", "d1", "vdl2", &snapshot);

        let rows = store.recent(Some("vdl2"), 0, 10);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["text"], "message two");
        assert_eq!(rows[1]["text"], "message one");
        assert_eq!(rows[0]["decoderId"], "vdl2-136");
    }

    #[test]
    fn window_spec_reports_usb_am_and_fixed_ranges() {
        let ft8 = window_spec("ft8", 14_074_000.0, 14_075_000.0, 2_400_000);
        assert_eq!(ft8.window_kind, "usb");
        assert_eq!(ft8.window.start_hz, 14_074_000.0);
        assert_eq!(ft8.window.end_hz, 14_077_000.0);
        assert!(ft8.scope && ft8.tunable);

        let acars = window_spec("acars", 131_550_000.0, 131_550_000.0, 2_400_000);
        assert_eq!(acars.window_kind, "am");
        assert_eq!(acars.window.center_hz(), 131_550_000.0);
        assert_eq!(acars.window.bandwidth_hz(), 6_000.0);

        let hfdl = window_spec("hfdl", 21_931_000.0, 21_931_000.0, 2_400_000);
        assert_eq!(hfdl.window.bandwidth_hz(), 24_000.0);

        #[cfg(feature = "ais")]
        {
            let ais = window_spec("ais", 162_000_000.0, 162_000_000.0, 2_400_000);
            assert_eq!(ais.window_kind, "fixed");
            assert_eq!(ais.handled.len(), 2);
            assert!(!ais.tunable && !ais.scope);
        }
    }

    #[test]
    fn wspr_window_has_a_narrow_decode_band() {
        let wspr = window_spec("wspr", 14_095_600.0, 14_095_600.0, 2_400_000);
        let band = wspr.decode_band.expect("WSPR decode band");
        assert_eq!(band.start_hz, 14_095_600.0 + 1_400.0);
        assert_eq!(band.end_hz, 14_095_600.0 + 1_600.0);
    }

    #[test]
    fn full_mfsk_channel_decodes_a_synthetic_ft8_slot() {
        use mfsk_core::prelude::{encode, TxAudio};
        use std::time::{Duration, Instant};

        // 48 kHz keeps the test quick while still exercising the extractor,
        // USB demodulator, resampler, slot buffer and slot worker.
        let input_rate = 48_000u32;
        let cfg = DecoderConfig {
            id: "ft8-path-test".into(),
            enabled: true,
            dongle_id: "d".into(),
            mode: "ft8".into(),
            frequency_hz: 0,
            bandwidth_hz: 3_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let mut channel = build_channel(&cfg, 0.0, input_rate).expect("build FT8 channel");

        let tx = encode(MfskMode::Ft8, "CQ N0CALL").expect("encode FT8");
        let frame = tx.synthesize(&TxAudio::new(12_000, 1_500.0));
        // Place the frame 0.5 s into a 15 s slot, then upsample 12 k -> 48 k.
        let slot_12k = 180_000usize;
        // Two slots so the first boundary has a full slot plus the startup
        // latency allowance. The frame is in the first slot.
        let mut audio_12k = vec![0.0f32; slot_12k * 2 + 12_000];
        // Real receivers never produce digital silence; zero-filled audio sends
        // mfsk-core's OSD down a pathological path. Use deterministic noise.
        let mut lcg = 0x1234_5678u32;
        for sample in &mut audio_12k {
            lcg = lcg.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *sample = ((lcg >> 8) as f32 / 16_777_216.0 - 0.5) * 0.02;
        }
        let frame_at = 6_000;
        audio_12k[frame_at..frame_at + frame.len()].copy_from_slice(&frame);
        let mut iq = Vec::with_capacity(audio_12k.len() * 4 * 2);
        let mut previous = 0.0f32;
        for &sample in &audio_12k {
            for i in 0..4 {
                let value = previous + (sample - previous) * (i as f32 / 4.0);
                let v = value.clamp(-1.0, 1.0);
                iq.push(((v * 127.5 + 127.5) as u8).min(255));
                iq.push(127); // Q = 0: the extractor/USB demod recovers the real audio.
            }
            previous = sample;
        }

        // Confirm the synthetic frame is decodable before it goes through the
        // channel, so a failure points at the DSP path rather than the fixture.
        let mut direct = AnyDecoder::new(MfskMode::Ft8, DecodeParams::for_band((100.0, 3000.0)));
        let direct_result = direct.decode(&mfsk_core::prelude::SlotInput::f32(
            &audio_12k[..slot_12k],
        ));
        assert!(!direct_result.rows.is_empty(), "synthetic fixture is invalid");

        // Start exactly on a slot boundary and feed one full slot plus a little.
        let slot_ns = 15_000_000_000i64;
        let chunk_samples = 4_800usize; // 0.1 s at 48 kHz
        let mut now = slot_ns * 10;
        let mut offset = 0usize;
        while offset < iq.len() {
            let end = (offset + chunk_samples * 2).min(iq.len());
            channel.process_chunk(&iq[offset..end], now);
            offset = end;
            now += (chunk_samples as i64 * 1_000_000_000) / input_rate as i64;
        }

        // Give the detached slot worker time to finish.
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut found = String::new();
        while Instant::now() < deadline && found.is_empty() {
            for value in channel.take_results() {
                if value.get("kind").and_then(|k| k.as_str()) == Some("decode") {
                    found = value
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or_default()
                        .to_string();
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            found.contains("N0CALL"),
            "full FT8 channel path did not decode: {found:?}"
        );
    }

    #[test]
    fn mode_names_map_to_mfsk_modes() {
        assert_eq!(mfsk_mode("FT8"), Some(MfskMode::Ft8));
        assert_eq!(mfsk_mode("ft4"), Some(MfskMode::Ft4));
        assert!(is_ft2("FT2"));
        assert!(supported_mode("ft2"));
        assert_eq!(mfsk_mode("fst4").map(|m| m.name()), Some("FST4-60A"));
        assert_eq!(mfsk_mode("fst4-60").map(|m| m.name()), Some("FST4-60A"));
        assert_eq!(mfsk_mode("fst4-120").map(|m| m.name()), Some("FST4-120"));
        assert_eq!(mfsk_mode("q65").map(|m| m.name()), Some("Q65-30A"));
        assert_eq!(mfsk_mode("q65-60d").map(|m| m.name()), Some("Q65-60D"));
        assert_eq!(mfsk_mode("jt65").map(|m| m.name()), Some("JT65"));
        assert_eq!(mfsk_mode("jt9").map(|m| m.name()), Some("JT9"));
        assert!(supported_mode("fst4-120"));
        assert!(supported_mode("q65-60d"));
        assert!(supported_mode("jt65"));
        assert!(supported_mode("jt9"));
        assert_eq!(mfsk_mode("wspr").map(|m| m.name()), Some("WSPR"));
        assert!(supported_mode("wspr"));
        #[cfg(feature = "pi4")]
        {
            assert!(is_pi4("PI4"));
            assert!(supported_mode("pi4"));
        }
        assert_eq!(mfsk_mode("js8"), None);
        #[cfg(feature = "js8")]
        assert!(supported_mode("js8"));
        assert!(supported_mode("acars"));
        #[cfg(feature = "adsb")]
        assert!(supported_mode("adsb"));
        #[cfg(feature = "ais")]
        assert!(supported_mode("ais"));
        #[cfg(feature = "vdl2")]
        assert!(supported_mode("vdl2"));
        #[cfg(feature = "hfdl")]
        assert!(supported_mode("hfdl"));
        #[cfg(feature = "packet")]
        assert!(supported_mode("packet"));
        assert!(supported_mode("sstv"));
        #[cfg(feature = "hell")]
        assert!(supported_mode("hell"));
        #[cfg(feature = "meteor")]
        {
            assert!(supported_mode("msk144"));
            assert!(supported_mode("fsk441"));
        }
    }

    #[cfg(feature = "wefax")]
    #[test]
    fn build_channel_dispatches_wefax_to_the_audio_channel() {
        let wefax = DecoderConfig {
            id: "wefax-7880".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "wefax".to_string(),
            frequency_hz: 7_880_000,
            bandwidth_hz: 3_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&wefax, 7_880_000.0, 2_400_000).expect("wefax channel");
        assert!(matches!(channel, Channel::Wefax(_)));
        drop(channel);

        assert!(build_channel(&wefax, 9_200_000.0, 2_400_000).is_err());
    }

    #[cfg(feature = "sstv")]
    #[test]
    fn build_channel_dispatches_sstv_to_the_audio_channel() {
        let sstv = DecoderConfig {
            id: "sstv-14230".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "sstv".to_string(),
            frequency_hz: 14_230_000,
            bandwidth_hz: 3_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&sstv, 14_230_000.0, 2_400_000).expect("sstv channel");
        assert!(matches!(channel, Channel::Sstv(_)));
        drop(channel);

        assert!(build_channel(&sstv, 9_200_000.0, 2_400_000).is_err());
    }

    #[cfg(feature = "hell")]
    #[test]
    fn build_channel_dispatches_hell_to_the_audio_channel() {
        let hell = DecoderConfig {
            id: "hell-40m".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "hell".to_string(),
            frequency_hz: 7_040_000,
            bandwidth_hz: 3_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&hell, 7_040_000.0, 2_400_000).expect("hell channel");
        assert!(matches!(channel, Channel::Hell(_)));
        drop(channel);

        assert!(build_channel(&hell, 9_200_000.0, 2_400_000).is_err());
    }

    #[cfg(feature = "text")]
    #[test]
    fn build_channel_dispatches_text_modes_to_the_audio_channel() {
        for mode in ["olivia", "thor", "fsq", "psk31", "rtty"] {
            let cfg = DecoderConfig {
                id: format!("{mode}-test"),
                enabled: true,
                dongle_id: "d1".to_string(),
                mode: mode.to_string(),
                frequency_hz: 7_040_000,
                bandwidth_hz: 3_000,
                retention_days: 0,
                settings: Default::default(),
            };
            let channel = build_channel(&cfg, 7_040_000.0, 2_400_000)
                .unwrap_or_else(|e| panic!("{mode} channel: {e}"));
            assert!(matches!(channel, Channel::Text(_)));
        }

        let cfg = DecoderConfig {
            id: "olivia-test".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "olivia".to_string(),
            frequency_hz: 7_040_000,
            bandwidth_hz: 3_000,
            retention_days: 0,
            settings: Default::default(),
        };
        assert!(build_channel(&cfg, 9_200_000.0, 2_400_000).is_err());
    }

    #[cfg(feature = "meteor")]
    #[test]
    fn build_channel_dispatches_meteor_modes() {
        for (mode, hz) in [("msk144", 50_260_000), ("fsk441", 50_260_000)] {
            let cfg = DecoderConfig {
                id: format!("{mode}-test"),
                enabled: true,
                dongle_id: "d1".to_string(),
                mode: mode.to_string(),
                frequency_hz: hz,
                bandwidth_hz: 3_000,
                retention_days: 0,
                settings: Default::default(),
            };
            let channel =
                build_channel(&cfg, hz as f64, 2_400_000).unwrap_or_else(|e| panic!("{mode}: {e}"));
            assert!(matches!(channel, Channel::Meteor(_)));
        }
        let cfg = DecoderConfig {
            id: "msk144-test".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "msk144".to_string(),
            frequency_hz: 50_260_000,
            bandwidth_hz: 3_000,
            retention_days: 0,
            settings: Default::default(),
        };
        assert!(build_channel(&cfg, 9_200_000.0, 2_400_000).is_err());
    }

    #[test]
    fn build_channel_dispatches_weak_signal_modes() {
        for (mode, hz) in [
            ("fst4", 7_078_000),
            ("fst4-120", 7_078_000),
            ("q65", 50_275_000),
            ("q65-60d", 50_275_000),
            ("jt65", 14_076_000),
            ("jt9", 14_078_000),
            ("wspr", 14_095_600),
        ] {
            let cfg = DecoderConfig {
                id: format!("{mode}-test"),
                enabled: true,
                dongle_id: "d1".to_string(),
                mode: mode.to_string(),
                frequency_hz: hz,
                bandwidth_hz: 3_000,
                retention_days: 0,
                settings: Default::default(),
            };
            let channel =
                build_channel(&cfg, hz as f64, 2_400_000).unwrap_or_else(|e| panic!("{mode}: {e}"));
            assert!(matches!(channel, Channel::Mfsk(_)));
        }
    }

    #[cfg(feature = "pi4")]
    #[test]
    fn build_channel_dispatches_pi4_to_the_audio_channel() {
        let cfg = DecoderConfig {
            id: "pi4-test".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "pi4".to_string(),
            frequency_hz: 144_471_000,
            bandwidth_hz: 3_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&cfg, 144_471_000.0, 2_400_000).expect("pi4 channel");
        match channel {
            Channel::Mfsk(channel) => assert_eq!(channel.slot_len, 720_000),
            _ => panic!("PI4 did not use the audio channel"),
        }
        assert!(build_channel(&cfg, 9_200_000.0, 2_400_000).is_err());
    }

    #[cfg(feature = "time")]
    #[test]
    fn build_channel_dispatches_time_signals() {
        let dcf77 = DecoderConfig {
            id: "dcf77".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "dcf77".to_string(),
            frequency_hz: 77_500,
            bandwidth_hz: 200,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&dcf77, 100_000.0, 2_400_000).expect("DCF77 channel");
        assert!(matches!(channel, Channel::Dcf77(_)));
        drop(channel);

        let als162 = DecoderConfig {
            mode: "als162".to_string(),
            frequency_hz: 162_000,
            ..dcf77
        };
        let channel = build_channel(&als162, 100_000.0, 2_400_000).expect("ALS162 channel");
        assert!(matches!(channel, Channel::Als162(_)));
    }

    #[cfg(feature = "packet")]
    #[test]
    fn build_channel_dispatches_packet_to_the_ax25_channel() {
        let packet = DecoderConfig {
            id: "packet-2m".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "packet".to_string(),
            frequency_hz: 145_010_000,
            bandwidth_hz: 12_500,
            retention_days: 0,
            settings: serde_json::Map::new(),
        };
        let channel = build_channel(&packet, 145_000_000.0, 2_400_000).expect("packet channel");
        assert!(matches!(channel, Channel::Packet(_)));
        drop(channel);
    }

    #[cfg(feature = "hfdl")]
    #[test]
    fn build_channel_dispatches_hfdl_to_the_lane_path() {
        let hfdl = DecoderConfig {
            id: "hfdl-21931".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "hfdl".to_string(),
            frequency_hz: 21_931_000,
            bandwidth_hz: 24_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&hfdl, 21_931_000.0, 2_400_000).expect("hfdl channel");
        assert!(matches!(channel, Channel::Hfdl(_)));
        drop(channel);
    }

    #[cfg(feature = "vdl2")]
    #[test]
    fn build_channel_dispatches_vdl2_to_the_raw_iq_path() {
        let vdl2 = DecoderConfig {
            id: "vdl2-136".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "vdl2".to_string(),
            frequency_hz: 136_812_500,
            bandwidth_hz: 25_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&vdl2, 136_812_500.0, 2_400_000).expect("vdl2 channel");
        assert!(matches!(channel, Channel::Vdl2(_)));
    }

    #[cfg(feature = "ais")]
    #[test]
    fn build_channel_dispatches_ais_to_the_raw_iq_path() {
        let ais = DecoderConfig {
            id: "ais-162".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "ais".to_string(),
            frequency_hz: 162_000_000,
            bandwidth_hz: 25_000,
            retention_days: 0,
            settings: Default::default(),
        };
        let channel = build_channel(&ais, 162_000_000.0, 2_400_000).expect("ais channel");
        assert!(matches!(channel, Channel::Ais(_)));
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
            retention_days: 0,
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
            retention_days: 0,
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
    fn any_decoder_decodes_synthetic_fst4_and_q65_slots() {
        use mfsk_core::prelude::{encode, SlotInput, TxAudio};

        for mode_name in ["FST4-15", "Q65-15A"] {
            let mode = MfskMode::from_name(mode_name).expect("mode available");
            let tx = encode(mode, "CQ N0CALL").expect("encode weak-signal mode");
            let frame = tx.synthesize(&TxAudio::new(12_000, 1_500.0));
            let slot_len = mode.meta().slot_samples_12k as usize;
            let mut slot = vec![0.0f32; slot_len];
            let start = 6_000.min(slot_len.saturating_sub(frame.len()));
            slot[start..start + frame.len()].copy_from_slice(&frame);

            let mut decoder = AnyDecoder::new(mode, DecodeParams::for_band((100.0, 3000.0)));
            let result = decoder.decode(&SlotInput::f32(&slot));
            assert!(
                !result.rows.is_empty(),
                "synthetic {mode_name} slot did not decode"
            );
        }
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
