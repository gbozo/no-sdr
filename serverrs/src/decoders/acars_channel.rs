//! ACARS channel: raw IQ → 12.5 kHz AM audio → the ACARS receiver.
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

/// The ACARS receiver is built for exactly this audio rate (acarsdec's
/// `INTRATE`).
const ACARS_AUDIO_RATE: u32 = 12_500;
/// Complex capture rate. Wide enough for the AFC to see a carrier several kHz
/// off the dial before the AM IF narrows it.
const ACARS_CAPTURE_RATE: u32 = 25_000;
/// Extractor passband during acquisition. The AFC centres the carrier inside
/// this, then the AM IF supplies the selectivity.
pub(crate) const ACARS_CAPTURE_BANDWIDTH_HZ: i32 = 16_000;
/// Default AM IF after the AFC. The MSK tones span 1200–2400 Hz.
const ACARS_IF_BANDWIDTH_HZ: i32 = 6_000;
/// A background decoder may ask for a wider IF (e.g. 12 kHz); cap it so the
/// adjacent 25 kHz airband channel cannot capture the demodulator.
const ACARS_MAX_IF_BANDWIDTH_HZ: i32 = 12_000;
/// Largest carrier correction the AFC will apply.
const ACARS_MAX_AFC_HZ: f64 = 8_000.0;
/// Carrier estimate window: 100 ms at the capture rate. One chunk is only a
/// few milliseconds of noise, whose phase coherence looks like a carrier.
const ACARS_AFC_WINDOW: usize = 2_500;

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
    /// Dial offset from the dongle centre; the AFC adds to this.
    base_offset: i32,
    /// AM IF width requested by the decoder (clamped).
    if_bandwidth: i32,
    /// Current carrier correction accumulated by the AFC.
    afc_hz: f64,
    /// Complex samples accumulated until one AFC estimate window is ready.
    afc_buf: Vec<Complex32>,
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

        // Honour the decoder's bandwidth, but never narrow the AM IF below
        // the ACARS channel. A background ACARS decoder with 12 kHz gets a
        // genuinely wider demodulator; the foreground path asks for 3 kHz and
        // still gets 6 kHz.
        let if_bandwidth = if cfg.bandwidth_hz > 0 {
            cfg.bandwidth_hz
                .clamp(ACARS_IF_BANDWIDTH_HZ, ACARS_MAX_IF_BANDWIDTH_HZ)
        } else {
            ACARS_IF_BANDWIDTH_HZ
        };

        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            // Wide capture for the AFC; the audio is resampled to 12.5 kHz
            // after envelope detection.
            output_sample_rate: ACARS_CAPTURE_RATE as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("ACARS channel extractor: {e}"))?;
        extractor.set_bandwidth(ACARS_CAPTURE_BANDWIDTH_HZ);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = AmDemod::new();
        demod
            .init(actual_rate)
            .map_err(|e| format!("ACARS AM demodulator: {e}"))?;
        demod.set_bandwidth(if_bandwidth as f64);

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
            base_offset: offset as i32,
            if_bandwidth,
            afc_hz: 0.0,
            afc_buf: Vec::with_capacity(ACARS_AFC_WINDOW),
        })
    }

    /// Carrier-tracking AFC.
    ///
    /// The complex baseband still contains the AM carrier; its phase advance
    /// per sample is the offset from the extractor centre. A one-pole loop
    /// moves the NCO so the carrier lands at DC and the narrow AM IF passes
    /// both MSK sidebands. Updates are gated on phase coherence, so noise or
    /// an idle channel leaves the last lock alone.
    fn track_carrier(&mut self) {
        // One chunk is a few milliseconds; at that length noise can look
        // coherent and the loop jumps to the clamp. Accumulate 100 ms, then
        // estimate once.
        self.afc_buf.extend_from_slice(&self.complex);
        if self.afc_buf.len() < ACARS_AFC_WINDOW {
            return;
        }
        let rate = self.extractor.output_sample_rate() as f64;
        let estimate = estimate_carrier(&self.afc_buf, rate);
        self.afc_buf.clear();
        let Some((offset, coherence)) = estimate else {
            return;
        };
        if coherence < 0.30 {
            return;
        }
        // Pull half of the residual per window, but never jump across the
        // band on one measurement.
        let step = (offset * 0.5).clamp(-1_500.0, 1_500.0);
        let next = (self.afc_hz + step).clamp(-ACARS_MAX_AFC_HZ, ACARS_MAX_AFC_HZ);
        self.afc_hz = next;
        self.extractor
            .set_tune_offset(self.base_offset + next.round() as i32);
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

            self.track_carrier();

            let audio = self.demod.process(&self.complex);
            let mut resampled = std::mem::take(&mut self.resampled);
            resampled.clear();
            self.resampler.process(&audio, &mut resampled);

            let mut events = Vec::new();
            self.rx.process(&resampled, &mut events);
            for event in events {
                let AcarsEvent::Message(frame) = event;
                let mut result = message_json(&self.cfg, &frame);
                // The AFC can move the receiver a few kHz onto the carrier;
                // report where the signal actually is, not the nominal dial.
                result["rfHz"] = json!(self.cfg.frequency_hz as f64 + self.afc_hz);
                result["afcHz"] = json!(self.afc_hz);
                self.results.push(result);
            }
            self.resampled = resampled;
        }
        self.pcm = pcm;

        if now_ms - self.last_status_ms >= 500 {
            self.last_status_ms = now_ms;
            self.results.push(json!({
                "kind": "status",
                "id": self.cfg.id,
                "frames": self.rx.frames(),
                "bad": self.rx.bad(),
                "level": self.rx.level(),
                "afcHz": self.afc_hz,
                "bandwidthHz": self.if_bandwidth,
            }));
        }
    }
}

/// Build the `decoderType: "acars"` event for one block.
///
/// The parsed application fields are nested under `acars.fields`, and the
/// position/callsign are repeated at the top level so the map's existing
/// `json_extract(payload, '$.lat')` position query and popup pick them up.
fn message_json(cfg: &DecoderConfig, frame: &super::acars::AcarsFrame) -> Value {
    let text = frame.text.trim().to_string();
    let mut fields = serde_json::Map::new();
    let f = &frame.fields;
    let mut put = |key: &str, value: &Option<String>| {
        if let Some(value) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            fields.insert(key.to_string(), json!(value));
        }
    };
    put("origin", &f.origin);
    put("destination", &f.destination);
    put("eta", &f.eta);
    put("gateOut", &f.gate_out);
    put("wheelsOff", &f.wheels_off);
    put("wheelsOn", &f.wheels_on);
    put("gateIn", &f.gate_in);
    put("fuel", &f.fuel);
    put("type", &f.aircraft_type);
    put("altitude", &f.altitude);

    let mut acars = json!({
        "mode": frame.mode,
        "address": frame.address,
        "ack": frame.ack,
        "label": frame.label,
        "blockId": frame.block_id,
        "text": frame.text,
        "crcOk": frame.crc_ok,
        "at": unix_now(),
    });
    if !frame.flight_id.is_empty() {
        acars["flight"] = json!(frame.flight_id);
    }
    if !frame.message_no.is_empty() {
        acars["msgNo"] = json!(frame.message_no);
    }
    if frame.body != text {
        acars["body"] = json!(frame.body);
    }
    if !fields.is_empty() {
        acars["fields"] = Value::Object(fields);
    }

    let mut event = json!({
        "kind": "message",
        "id": cfg.id,
        "mode": cfg.mode,
        "text": text,
        "rfHz": cfg.frequency_hz as f64,
        "audioHz": CENTER_HZ,
        "snrDb": 0.0,
        "dtSec": 0.0,
        "period": 0,
        "signalBwHz": 2_400.0,
        "stats": {
            "crcOk": frame.crc_ok,
        },
        "acars": acars,
    });
    if let Some(lat) = f.latitude {
        event["lat"] = json!(lat);
    }
    if let Some(lon) = f.longitude {
        event["lon"] = json!(lon);
    }
    if !frame.address.is_empty() {
        event["callsign"] = json!(frame.address);
    }
    event
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decoders::acars::AcarsFrame;

    #[test]
    fn acars_event_exposes_parsed_fields_and_position() {
        let cfg = DecoderConfig {
            id: "acars-131".into(),
            mode: "acars".into(),
            frequency_hz: 131_550_000,
            ..Default::default()
        };
        let mut frame = AcarsFrame {
            mode: "2".into(),
            address: "A7-BHT".into(),
            ack: " ".into(),
            label: "16".into(),
            block_id: "1".into(),
            text: "S81AQR048KFUEL 12.3T LAT N 47.176/LON E 2.943".into(),
            ..Default::default()
        };
        frame.message_no = "S81A".into();
        frame.flight_id = "QR048K".into();
        frame.body = "FUEL 12.3T LAT N 47.176/LON E 2.943".into();
        frame.fields.fuel = Some("12.3T".into());
        frame.fields.aircraft_type = Some("B77W".into());
        frame.fields.origin = Some("EGLL".into());
        frame.fields.destination = Some("KJFK".into());
        frame.fields.latitude = Some(47.176);
        frame.fields.longitude = Some(2.943);
        frame.crc_ok = true;

        let event = message_json(&cfg, &frame);
        assert_eq!(event["kind"], "message");
        assert_eq!(event["mode"], "acars");
        assert_eq!(event["callsign"], "A7-BHT");
        assert_eq!(event["lat"], 47.176);
        assert_eq!(event["lon"], 2.943);
        assert_eq!(event["acars"]["flight"], "QR048K");
        assert_eq!(event["acars"]["msgNo"], "S81A");
        assert_eq!(event["acars"]["body"], "FUEL 12.3T LAT N 47.176/LON E 2.943");
        assert_eq!(event["acars"]["fields"]["fuel"], "12.3T");
        assert_eq!(event["acars"]["fields"]["type"], "B77W");
        assert_eq!(event["acars"]["fields"]["origin"], "EGLL");
        assert_eq!(event["acars"]["fields"]["destination"], "KJFK");
    }
}


/// Phase-difference carrier estimate over one complex chunk.
///
/// Returns `(offset_hz, coherence)`. Coherence is ~1 for a clean carrier and
/// low for noise, so the AFC can decide whether the measurement is usable.
fn estimate_carrier(samples: &[Complex32], rate: f64) -> Option<(f64, f64)> {
    if samples.len() < 64 || rate <= 0.0 {
        return None;
    }
    // Do NOT remove the mean: a centred AM carrier is a positive real DC, and
    // the phase-difference detector should read that as zero offset. Removing
    // it leaves a zero-mean real waveform whose sign flips look like a Nyquist
    // offset and would throw the AFC to the clamp.
    let mut power = 0.0f64;
    let mut acc = Complex32::default();
    let mut prev = samples[0];
    power += f64::from(prev.norm_sqr());
    for &sample in &samples[1..] {
        acc += prev.conj() * sample;
        power += f64::from(sample.norm_sqr());
        prev = sample;
    }
    if power <= 1e-12 {
        return None;
    }
    let coherence = f64::from(acc.norm()) / power;
    let offset = f64::from(acc.arg()) * rate / std::f64::consts::TAU;
    Some((offset, coherence))
}

#[cfg(test)]
mod afc_tests {
    use super::*;
    use std::f64::consts::TAU;

    fn tone(hz: f64, rate: f64, n: usize) -> Vec<Complex32> {
        (0..n)
            .map(|i| Complex32::from_polar(0.5, (TAU * hz * i as f64 / rate) as f32))
            .collect()
    }

    #[test]
    fn carrier_estimator_reads_a_tone() {
        let (offset, coherence) =
            estimate_carrier(&tone(3500.0, 25_000.0, 500), 25_000.0).expect("estimate");
        assert!((offset - 3500.0).abs() < 100.0, "offset {offset}");
        assert!(coherence > 0.9, "coherence {coherence}");
    }

    #[test]
    fn centred_am_carrier_reads_zero_offset() {
        let samples: Vec<Complex32> = (0..500)
            .map(|i| {
                let m = 0.6
                    + 0.4 * (TAU * 1200.0 * i as f64 / 25_000.0).sin();
                Complex32::new(m as f32, 0.0)
            })
            .collect();
        let (offset, coherence) = estimate_carrier(&samples, 25_000.0).expect("estimate");
        assert!(offset.abs() < 100.0, "offset {offset}");
        assert!(coherence > 0.5, "coherence {coherence}");
    }

    #[test]
    fn noise_has_low_coherence() {
        let mut x = 0x1234_5678u32;
        let samples: Vec<Complex32> = (0..500)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let i = (x >> 8) as f32 / 16_777_216.0 - 0.5;
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let q = (x >> 8) as f32 / 16_777_216.0 - 0.5;
                Complex32::new(i, q)
            })
            .collect();
        let (_, coherence) = estimate_carrier(&samples, 25_000.0).expect("estimate");
        assert!(coherence < 0.25, "coherence {coherence}");
    }
}
