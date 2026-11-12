//! Raw-IQ ADS-B / Mode S decoder.
//!
//! ADS-B is not an audio mode: the 1090 MHz downlink is one megabit of
//! pulse-position modulation, so the decoder needs the dongle's raw I/Q at
//! 2 MSPS or more, not a 12 kHz audio channel. This module therefore bypasses
//! `IqExtractor`/`SsbDemod` entirely and feeds `sdroxide-adsb` directly.
//!
//! The worker emits a whole aircraft table about twice a second. Each
//! snapshot is broadcast as a single `MSG_DECODER` message (`decoderType:
//! "adsb"`) and persisted as keyed entities rather than message rows.

use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use num_complex::Complex32;
use sdroxide_adsb::{crc, frame, message, window_covers, Accepted, Demod, Rejected, Tracker};
use sdroxide_types::{AdsbSettings, AdsbStatus, ADSB_FREQ_HZ, ADSB_GOOD_RATE_HZ, ADSB_MIN_RATE_HZ};
use serde_json::{json, Value};

use crate::config::DecoderConfig;

/// How often the "cannot run here" placeholder is re-sent when no worker
/// exists. Matches the worker's own twice-a-second status cadence.
const UNAVAILABLE_INTERVAL_MS: i64 = 500;

/// How often the worker sends an aircraft table snapshot.
const STATUS_INTERVAL: Duration = Duration::from_millis(500);

/// uint8 IQ to ±1.0. Multiplication by the reciprocal, not a division: at
/// 2.4 MSPS this loop converts 4.8 M samples/s on the dongle thread.
const INV_U8_SCALE: f32 = 1.0 / 127.5;

/// One status snapshot plus the diagnostics we keep locally.
struct AdsbSnapshot {
    status: AdsbStatus,
    /// Frames recovered by the one-bit repair pass.
    repaired: u64,
}

/// Decoder thread. Owning this instead of `sdroxide_adsb::AdsbController` lets
/// the receive path repair single-bit CRC errors for aircraft we already
/// track, and lets the IQ buffer be recycled rather than copied.
struct AdsbWorker {
    iq_tx: Option<SyncSender<Vec<Complex32>>>,
    status_rx: Receiver<AdsbSnapshot>,
    recycle_rx: Receiver<Vec<Complex32>>,
    join: Option<JoinHandle<()>>,
}

impl Drop for AdsbWorker {
    fn drop(&mut self) {
        // Close the IQ side first so the worker leaves its receive loop.
        self.iq_tx.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// A raw-IQ ADS-B worker.
pub(crate) struct AdsbChannel {
    pub(crate) cfg: DecoderConfig,
    /// `None` when the receiver window cannot carry ADS-B at all. In that case
    /// the channel still explains why instead of looking like a quiet sky.
    worker: Option<AdsbWorker>,
    center_hz: f64,
    rate_hz: f64,
    /// Set when the decoder runs but the window is below the good rate.
    degraded: Option<String>,
    /// Set when the worker cannot be created at all.
    unavailable: Option<String>,
    suggest_center_hz: Option<f64>,
    /// Recycled IQ buffer kept when the worker's queue is full.
    spare: Option<Vec<Complex32>>,
    results: Vec<Value>,
    last_unavailable_ms: i64,
    /// Running DC estimate for the raw-IQ high-pass. The RTL-SDR's zero-IF
    /// LO leakage is a constant offset of roughly -37 dBFS at the tuned
    /// frequency; left in, it raises the demodulator's tracked noise floor by
    /// more than 20 dB and hides weak aircraft.
    dc_re: f32,
    dc_im: f32,
    dc_primed: bool,
    dc_alpha: f32,
}

impl AdsbChannel {
    pub(crate) fn new(cfg: &DecoderConfig, center_hz: f64, rate_hz: f64) -> Self {
        let rate_hz = rate_hz.max(1.0);
        let mut channel = Self {
            cfg: cfg.clone(),
            worker: None,
            center_hz,
            rate_hz,
            degraded: None,
            unavailable: None,
            suggest_center_hz: None,
            spare: None,
            results: Vec::new(),
            last_unavailable_ms: 0,
            dc_re: 0.0,
            dc_im: 0.0,
            dc_primed: false,
            // ~10 Hz high-pass: tracks tuner DC drift without touching the
            // 0.5 µs Mode S chips or aircraft Doppler near the carrier.
            dc_alpha: (1.0 - (-std::f64::consts::TAU * 10.0 / rate_hz).exp()) as f32,
        };

        if !window_covers(center_hz, rate_hz) {
            channel.unavailable = Some(unsupported_message(center_hz, rate_hz));
            channel.suggest_center_hz = Some(ADSB_FREQ_HZ);
            tracing::warn!(
                decoder = %cfg.id,
                center_hz,
                rate_hz,
                "ADS-B channel cannot run in this receiver window"
            );
            return channel;
        }

        if rate_hz < ADSB_GOOD_RATE_HZ {
            channel.degraded = Some(format!(
                "Receiver is running at {:.2} MSPS. ADS-B needs 2.40 MSPS for full \
                 sensitivity; at this rate only strong aircraft decode reliably.",
                rate_hz / 1e6
            ));
            tracing::info!(
                decoder = %cfg.id,
                rate_hz,
                "ADS-B channel is degraded: widen the profile to 2.4 MSPS"
            );
        }

        // Bounded so a slow decoder drops blocks instead of growing memory.
        let (iq_tx, iq_rx) = mpsc::sync_channel(8);
        let (status_tx, status_rx): (Sender<AdsbSnapshot>, Receiver<AdsbSnapshot>) =
            mpsc::channel();
        let (recycle_tx, recycle_rx) = mpsc::sync_channel(8);
        let settings = settings_from_config(cfg);
        let worker_center = center_hz;
        let worker_rate = rate_hz;
        match thread::Builder::new()
            .name("adsb-worker".to_string())
            .spawn(move || {
                run_worker(
                    iq_rx,
                    status_tx,
                    recycle_tx,
                    settings,
                    worker_center,
                    worker_rate,
                );
            }) {
            Ok(join) => {
                channel.worker = Some(AdsbWorker {
                    iq_tx: Some(iq_tx),
                    status_rx,
                    recycle_rx,
                    join: Some(join),
                });
            }
            Err(e) => {
                channel.unavailable = Some(format!("ADS-B worker could not start: {e}"));
                tracing::error!(decoder = %cfg.id, error = %e, "ADS-B worker could not start");
            }
        }
        channel
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.results)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now_ms: i64) {
        let Some(worker) = &self.worker else {
            if now_ms - self.last_unavailable_ms >= UNAVAILABLE_INTERVAL_MS {
                self.last_unavailable_ms = now_ms;
                self.results.push(self.unavailable_value());
            }
            return;
        };

        while let Ok(snapshot) = worker.status_rx.try_recv() {
            self.results
                .push(snapshot_json(&snapshot, self.degraded.as_deref()));
        }
        while let Ok(buffer) = worker.recycle_rx.try_recv() {
            if self.spare.is_none() {
                self.spare = Some(buffer);
            }
        }

        let mut buffer = self
            .spare
            .take()
            .unwrap_or_else(|| Vec::with_capacity(chunk.len() / 2));
        buffer.clear();
        for pair in chunk.chunks_exact(2) {
            let i = (pair[0] as f32 - 127.5) * INV_U8_SCALE;
            let q = (pair[1] as f32 - 127.5) * INV_U8_SCALE;
            if !self.dc_primed {
                self.dc_re = i;
                self.dc_im = q;
                self.dc_primed = true;
            }
            self.dc_re += self.dc_alpha * (i - self.dc_re);
            self.dc_im += self.dc_alpha * (q - self.dc_im);
            buffer.push(Complex32::new(i - self.dc_re, q - self.dc_im));
        }
        if buffer.is_empty() {
            self.spare = Some(buffer);
            return;
        }

        let sent = match worker.iq_tx.as_ref() {
            Some(tx) => tx.try_send(buffer),
            None => return,
        };
        if let Err(TrySendError::Full(buffer)) | Err(TrySendError::Disconnected(buffer)) = sent {
            self.spare = Some(buffer);
        }
    }

    fn unavailable_value(&self) -> Value {
        json!({
            "aircraft": [],
            "unavailable": self.unavailable,
            "degraded": self.degraded,
            "suggestCenterHz": self.suggest_center_hz,
            "windowCenterHz": self.center_hz,
            "windowRateHz": self.rate_hz,
            "preambles": 0,
            "frames": 0,
            "repaired": 0,
            "badCrc": 0,
            "unmatched": 0,
        })
    }
}

fn snapshot_json(snapshot: &AdsbSnapshot, fallback_degraded: Option<&str>) -> Value {
    let status = &snapshot.status;
    let degraded = status
        .degraded
        .clone()
        .or_else(|| fallback_degraded.map(str::to_string));
    json!({
        "aircraft": status.aircraft,
        "unavailable": status.unavailable,
        "degraded": degraded,
        "suggestCenterHz": status.suggest_center_hz,
        "windowCenterHz": status.window_center_hz,
        "windowRateHz": status.window_rate_hz,
        "preambles": status.preambles,
        "frames": status.frames,
        "repaired": snapshot.repaired,
        "badCrc": status.bad_crc,
        "unmatched": status.unmatched,
    })
}

/// A candidate that has passed the check sequence, or been repaired into one.
enum Checked {
    Clean(Accepted),
    Repaired(Accepted, Vec<u8>),
}

/// Check a candidate, repairing a single bit when the 24-bit check sequence
/// lands exactly one bit away from valid.
///
/// This applies to every DF17/18 address, including one not seen before: the
/// operator asked for maximum weak-frame recovery, and a one-bit repair on an
/// extended squitter is self-validating (the corrected frame passes the full
/// 24-bit CRC). Two-bit repairs are still refused, and all-zero addresses are
/// not aircraft.
fn check_candidate(bytes: &[u8], known: impl Fn(u32) -> bool) -> Result<Checked, Rejected> {
    match frame::accept(bytes, &known) {
        Ok(acc) => return Ok(Checked::Clean(acc)),
        Err(Rejected::BadCrc) => {}
        Err(other) => return Err(other),
    }

    let df = message::downlink_format(bytes);
    if !matches!(df, 17 | 18) || bytes.len() != message::message_len(df) {
        return Err(Rejected::BadCrc);
    }
    let icao = u32::from(bytes[1]) << 16 | u32::from(bytes[2]) << 8 | u32::from(bytes[3]);
    if icao == 0 {
        return Err(Rejected::BadCrc);
    }

    let mut fixed = bytes.to_vec();
    for bit in 0..bytes.len() * 8 {
        let mask = 0x80u8 >> (bit % 8);
        fixed[bit / 8] ^= mask;
        if crc::syndrome(&fixed) == 0 {
            if let Ok(acc) = frame::accept(&fixed, &known) {
                return Ok(Checked::Repaired(acc, fixed));
            }
        }
        fixed[bit / 8] ^= mask;
    }
    Err(Rejected::BadCrc)
}

fn run_worker(
    iq_rx: Receiver<Vec<Complex32>>,
    status_tx: Sender<AdsbSnapshot>,
    recycle_tx: SyncSender<Vec<Complex32>>,
    settings: AdsbSettings,
    center_hz: f64,
    rate_hz: f64,
) {
    let mut demod = Demod::new(rate_hz);
    let mut tracker = Tracker::new(settings);
    let mut candidates = Vec::new();
    let mut samples = 0u64;
    let (mut frames, mut bad_crc, mut unmatched, mut repaired) = (0u64, 0u64, 0u64, 0u64);
    let mut last_emit = Instant::now();

    tracing::info!(rate = rate_hz, center = center_hz, "ADS-B decoder started");

    while let Ok(iq) = iq_rx.recv() {
        demod.push(&iq, &mut candidates);
        let now = unix_now();
        let mono = samples as f64 / rate_hz.max(1.0);
        samples += iq.len() as u64;

        for candidate in &candidates {
            match check_candidate(&candidate.bytes, |icao| tracker.knows(icao, now)) {
                Ok(Checked::Clean(acc)) => {
                    frames += 1;
                    tracker.absorb(&acc, &candidate.bytes, candidate.rssi_dbfs, now, mono);
                }
                Ok(Checked::Repaired(acc, fixed)) => {
                    frames += 1;
                    repaired += 1;
                    tracker.absorb(&acc, &fixed, candidate.rssi_dbfs, now, mono);
                    tracing::debug!(
                        icao = format_args!("{:06X}", acc.icao()),
                        "ADS-B frame recovered by one-bit repair"
                    );
                }
                Err(Rejected::BadCrc | Rejected::Malformed) => bad_crc += 1,
                Err(Rejected::Unmatched) => unmatched += 1,
                Err(Rejected::Unsupported) => {}
            }
        }
        candidates.clear();
        let _ = recycle_tx.try_send(iq);

        if last_emit.elapsed() >= STATUS_INTERVAL {
            last_emit = Instant::now();
            tracker.expire(now);
            let status = AdsbStatus {
                aircraft: tracker.snapshot(),
                unavailable: None,
                suggest_center_hz: None,
                window_center_hz: center_hz,
                window_rate_hz: rate_hz,
                preambles: demod.preambles,
                frames,
                bad_crc,
                unmatched,
                degraded: None,
            };
            if status_tx.send(AdsbSnapshot { status, repaired }).is_err() {
                break;
            }
        }
    }

    tracing::info!(rate = rate_hz, center = center_hz, "ADS-B decoder stopped");
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn unsupported_message(center_hz: f64, rate_hz: f64) -> String {
    if rate_hz < ADSB_MIN_RATE_HZ {
        format!(
            "ADS-B needs at least 2.00 MSPS to resolve a Mode S chip; this receiver \
             is running at {:.2} MSPS.",
            rate_hz / 1e6
        )
    } else {
        format!(
            "ADS-B needs a window that covers 1090.000 MHz; this receiver is centred \
             at {:.3} MHz with {:.2} MSPS of span.",
            center_hz / 1e6,
            rate_hz / 1e6
        )
    }
}

/// Read the optional per-decoder settings from `decoders[].settings`.
///
/// Unknown keys are ignored, and the result is clamped by `AdsbSettings::sane`
/// so a typo in YAML cannot produce a zero-length history or an unbounded
/// aircraft table.
fn settings_from_config(cfg: &DecoderConfig) -> AdsbSettings {
    let mut settings = AdsbSettings::default();
    let map = &cfg.settings;
    let u16_value = |keys: &[&str]| -> Option<u16> {
        keys.iter()
            .find_map(|key| map.get(*key))
            .and_then(Value::as_u64)
            .map(|v| v.min(u16::MAX as u64) as u16)
    };
    let f32_value = |keys: &[&str]| -> Option<f32> {
        keys.iter()
            .find_map(|key| map.get(*key))
            .and_then(Value::as_f64)
            .map(|v| v as f32)
    };
    let bool_value = |keys: &[&str]| -> Option<bool> {
        keys.iter()
            .find_map(|key| map.get(*key))
            .and_then(Value::as_bool)
    };

    if let Some(v) = bool_value(&["enabled"]) {
        settings.enabled = v;
    }
    if let Some(v) = u16_value(&["dropMapS", "drop_map_s"]) {
        settings.drop_map_s = v;
    }
    if let Some(v) = u16_value(&["dropListS", "drop_list_s"]) {
        settings.drop_list_s = v;
    }
    if let Some(v) = u16_value(&["historyPoints", "history_points"]) {
        settings.history_points = v;
    }
    if let Some(v) = f32_value(&["vectorMinutes", "vector_minutes"]) {
        settings.vector_minutes = v;
    }
    if let Some(v) = u16_value(&["maxAircraft", "max_aircraft"]) {
        settings.max_aircraft = v;
    }
    settings.sane()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sdroxide_adsb::{modulate, Demod};

    /// A real DF17 position squitter from the published test vectors.
    const DF17: [u8; 14] = [
        0x8D, 0x40, 0x62, 0x1D, 0x58, 0xC3, 0x82, 0xD6, 0x90, 0xC8, 0xAC, 0x28, 0x63, 0xA7,
    ];

    fn cfg(settings: Value) -> DecoderConfig {
        DecoderConfig {
            id: "adsb-local".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "adsb".to_string(),
            frequency_hz: ADSB_FREQ_HZ as i64,
            bandwidth_hz: 2_400_000,
            settings: settings.as_object().cloned().unwrap_or_default(),
        }
    }

    #[test]
    fn the_synthetic_modem_round_trips_a_df17() {
        let mut demod = Demod::new(2_400_000.0);
        let iq = modulate(&DF17, 2_400_000.0, 1.0, 0.02, 0x9E37_79B9);
        let mut out = Vec::new();
        demod.push(&iq, &mut out);
        assert!(
            out.iter().any(|c| c.bytes == DF17),
            "synthetic DF17 was not recovered by the demodulator"
        );
    }

    /// The channel sees cu8 from the dongle, not `Complex32`: quantise the
    /// synthetic DF17 to the wire format and run it back through exactly the
    /// conversion `process_chunk` uses.
    #[test]
    fn cu8_round_trip_still_decodes_a_df17() {
        let iq = modulate(&DF17, 2_400_000.0, 1.0, 0.02, 0x1234_5678);
        let mut cu8 = Vec::with_capacity(iq.len() * 2);
        for sample in &iq {
            for value in [sample.re, sample.im] {
                let q = (value * 127.5 + 127.5).round().clamp(0.0, 255.0) as u8;
                cu8.push(q);
            }
        }

        let mut back = Vec::with_capacity(cu8.len() / 2);
        for pair in cu8.chunks_exact(2) {
            back.push(Complex32::new(
                (pair[0] as f32 - 127.5) * INV_U8_SCALE,
                (pair[1] as f32 - 127.5) * INV_U8_SCALE,
            ));
        }

        let mut demod = Demod::new(2_400_000.0);
        let mut out = Vec::new();
        demod.push(&back, &mut out);
        assert!(
            out.iter().any(|c| c.bytes == DF17),
            "cu8-quantised DF17 was not recovered"
        );
    }

    #[test]
    fn dc_block_restores_a_weak_frame_under_lo_leakage() {
        fn dc_block(iq: &[Complex32], rate_hz: f64) -> Vec<Complex32> {
            let alpha = (1.0 - (-std::f64::consts::TAU * 10.0 / rate_hz).exp()) as f32;
            let mut dc_re = 0.0f32;
            let mut dc_im = 0.0f32;
            let mut primed = false;
            iq.iter()
                .map(|z| {
                    if !primed {
                        dc_re = z.re;
                        dc_im = z.im;
                        primed = true;
                    }
                    dc_re += alpha * (z.re - dc_re);
                    dc_im += alpha * (z.im - dc_im);
                    Complex32::new(z.re - dc_re, z.im - dc_im)
                })
                .collect()
        }

        let rate = 2_400_000.0;
        // A weak reply plus a large zero-IF DC offset, the shape of the LO
        // leakage this receiver actually shows.
        let mut iq = modulate(&DF17, rate, 0.15, 0.01, 0x5EED_1234);
        for z in &mut iq {
            z.re += 0.5;
            z.im += 0.5;
        }

        let mut raw = Demod::new(rate);
        let mut raw_out = Vec::new();
        raw.push(&iq, &mut raw_out);
        assert!(
            !raw_out.iter().any(|c| c.bytes == DF17),
            "test setup is not desensed by the DC offset"
        );

        let cleaned = dc_block(&iq, rate);
        let mut demod = Demod::new(rate);
        let mut out = Vec::new();
        demod.push(&cleaned, &mut out);
        assert!(
            out.iter().any(|c| c.bytes == DF17),
            "DC removal did not restore the weak frame"
        );
    }

    /// Replay a recorded cu8 capture (set `ADSB_CAPTURE=/path/file.cu8`) and
    /// compare the demodulator with and without the DC blocker. Ignored by
    /// default because it needs hardware data.
    #[test]
    #[ignore = "needs ADSB_CAPTURE=/path/to/capture.cu8"]
    fn decode_a_recorded_capture() {
        let path = match std::env::var("ADSB_CAPTURE") {
            Ok(path) => path,
            Err(_) => return,
        };
        let data = std::fs::read(path).expect("capture file");
        let rate = 2_400_000.0;
        let alpha = (1.0 - (-std::f64::consts::TAU * 10.0 / rate).exp()) as f32;

        let run = |block_dc: bool| {
            let mut demod = Demod::new(rate);
            let mut out = Vec::new();
            let mut accepted = 0usize;
            let mut df17 = 0usize;
            let mut icaos = std::collections::HashSet::new();
            let mut block = Vec::with_capacity(8192);
            let (mut dc_re, mut dc_im, mut primed) = (0.0f32, 0.0f32, false);
            for pair in data.chunks_exact(2) {
                let mut i = (pair[0] as f32 - 127.5) * INV_U8_SCALE;
                let mut q = (pair[1] as f32 - 127.5) * INV_U8_SCALE;
                if block_dc {
                    if !primed {
                        dc_re = i;
                        dc_im = q;
                        primed = true;
                    }
                    dc_re += alpha * (i - dc_re);
                    dc_im += alpha * (q - dc_im);
                    i -= dc_re;
                    q -= dc_im;
                }
                block.push(Complex32::new(i, q));
                if block.len() >= 8192 {
                    demod.push(&block, &mut out);
                    for c in &out {
                        if sdroxide_adsb::frame::accept(&c.bytes, |_| false).is_ok() {
                            accepted += 1;
                            if c.bytes[0] >> 3 == 17 {
                                df17 += 1;
                                icaos.insert(
                                    ((c.bytes[1] as u32) << 16)
                                        | ((c.bytes[2] as u32) << 8)
                                        | c.bytes[3] as u32,
                                );
                            }
                        }
                    }
                    out.clear();
                    block.clear();
                }
            }
            if !block.is_empty() {
                demod.push(&block, &mut out);
                for c in &out {
                    if sdroxide_adsb::frame::accept(&c.bytes, |_| false).is_ok() {
                        accepted += 1;
                        if c.bytes[0] >> 3 == 17 {
                            df17 += 1;
                            icaos.insert(
                                ((c.bytes[1] as u32) << 16)
                                    | ((c.bytes[2] as u32) << 8)
                                    | c.bytes[3] as u32,
                            );
                        }
                    }
                }
            }
            (accepted, df17, icaos.len())
        };

        let raw = run(false);
        let blocked = run(true);
        println!(
            "recorded capture: raw={:?} dc_blocked={:?} (accepted, df17, unique ICAO)",
            raw, blocked
        );
        assert!(blocked.0 > 0, "no CRC-valid frames even with DC removal");
    }

    /// One corrupted bit in the payload is recoverable for any valid address,
    /// not just one already in the table.
    #[test]
    fn one_bit_repair_is_accepted_for_new_addresses() {
        let mut bad = DF17.to_vec();
        bad[7] ^= 0x10;

        assert!(matches!(
            frame::accept(&bad, |_| false),
            Err(Rejected::BadCrc)
        ));

        for known in [false, true] {
            match check_candidate(&bad, move |_| known).expect("one-bit repair") {
                Checked::Repaired(acc, fixed) => {
                    assert_eq!(fixed, DF17);
                    assert_eq!(acc.icao(), 0x40_621D);
                }
                Checked::Clean(_) => panic!("expected a repaired frame"),
            }
        }
    }

    /// Two corrupted bits must not be guessed into a frame.
    #[test]
    fn two_bit_errors_are_not_repaired() {
        let mut bad = DF17.to_vec();
        bad[7] ^= 0x10;
        bad[9] ^= 0x04;
        assert!(check_candidate(&bad, |icao| icao == 0x40_621D).is_err());
    }

    #[test]
    fn the_channel_decodes_a_synthetic_df17_with_dc_offset() {
        use std::time::Duration;

        let mut channel = AdsbChannel::new(&cfg(Value::Null), 1_090_000_000.0, 2_400_000.0);
        assert!(channel.worker.is_some());

        // 0.5 s of 2.4 MSPS IQ with one reply at the start and a large DC
        // offset, in the cu8 format the dongle delivers.
        let rate = 2_400_000.0;
        let mut iq = vec![Complex32::new(0.0, 0.0); (rate * 0.5) as usize];
        let burst = modulate(&DF17, rate, 0.3, 0.01, 0xFEED_FACE);
        iq[..burst.len()].copy_from_slice(&burst);
        let mut chunk = Vec::with_capacity(iq.len() * 2);
        for z in &iq {
            let i = ((z.re + 0.5) * 127.5 + 127.5).round().clamp(0.0, 255.0) as u8;
            let q = ((z.im + 0.5) * 127.5 + 127.5).round().clamp(0.0, 255.0) as u8;
            chunk.push(i);
            chunk.push(q);
        }

        channel.process_chunk(&chunk, 1_000);
        let mut snapshots = Vec::new();
        for i in 0..25 {
            std::thread::sleep(Duration::from_millis(100));
            channel.process_chunk(&[127, 127, 127, 127], 1_100 + i);
            snapshots = channel.take_results();
            if !snapshots.is_empty() {
                break;
            }
        }
        let status = snapshots
            .iter()
            .find(|value| value.get("frames").is_some())
            .expect("no status snapshot");
        assert!(
            status["frames"].as_u64().unwrap_or(0) > 0,
            "channel decoded no frames: {status}"
        );
        assert!(
            status["aircraft"]
                .as_array()
                .map(|a| !a.is_empty())
                .unwrap_or(false),
            "no aircraft in snapshot: {status}"
        );
    }

    #[test]
    fn a_narrow_window_reports_why_it_cannot_run() {
        let mut channel = AdsbChannel::new(&cfg(Value::Null), 1_090_000_000.0, 1_024_000.0);
        assert!(channel.worker.is_none());
        assert!(channel
            .unavailable
            .as_deref()
            .unwrap()
            .contains("2.00 MSPS"));
        assert_eq!(channel.suggest_center_hz, Some(ADSB_FREQ_HZ));

        channel.process_chunk(&[127, 127, 127, 127], 1_000);
        let results = channel.take_results();
        assert_eq!(results.len(), 1);
        assert!(results[0]["unavailable"]
            .as_str()
            .unwrap()
            .contains("2.00 MSPS"));
        assert_eq!(results[0]["aircraft"].as_array().unwrap().len(), 0);

        // Rate-limited: no new placeholder within the same half second.
        channel.process_chunk(&[127, 127, 127, 127], 1_100);
        assert!(channel.take_results().is_empty());
    }

    #[test]
    fn the_wrong_centre_reports_the_tuning_fix() {
        let channel = AdsbChannel::new(&cfg(Value::Null), 868_880_000.0, 2_400_000.0);
        assert!(channel.worker.is_none());
        assert!(channel.unavailable.as_deref().unwrap().contains("1090.000"));
        assert_eq!(channel.suggest_center_hz, Some(ADSB_FREQ_HZ));
    }

    #[test]
    fn two_msps_runs_but_is_degraded() {
        let channel = AdsbChannel::new(&cfg(Value::Null), 1_090_000_000.0, 2_048_000.0);
        assert!(channel.worker.is_some());
        assert!(channel.degraded.as_deref().unwrap().contains("2.40 MSPS"));
    }

    #[test]
    fn settings_accept_camel_and_snake_case() {
        let settings = settings_from_config(&cfg(json!({
            "dropMapS": 5,
            "history_points": 12,
            "maxAircraft": 50,
        })));
        assert_eq!(settings.drop_map_s, 5);
        assert_eq!(settings.history_points, 12);
        assert_eq!(settings.max_aircraft, 50);
        // sane() enforces drop_list >= drop_map.
        assert!(settings.drop_list_s >= settings.drop_map_s);
    }

    /// The snapshot is one JSON object with the fields the client map expects.
    #[test]
    fn snapshot_shape_is_stable() {
        let mut channel = AdsbChannel::new(&cfg(Value::Null), 1_090_000_000.0, 1_024_000.0);
        channel.process_chunk(&[127, 127], 1_000);
        let value = channel.take_results().pop().unwrap();
        for key in [
            "aircraft",
            "unavailable",
            "degraded",
            "suggestCenterHz",
            "windowCenterHz",
            "windowRateHz",
            "preambles",
            "frames",
            "repaired",
            "badCrc",
            "unmatched",
        ] {
            assert!(value.get(key).is_some(), "snapshot missing {key}");
        }
    }
}
