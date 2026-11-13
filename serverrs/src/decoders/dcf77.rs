//! DCF77 (77.5 kHz) amplitude-modulated time-code decoder.
//!
//! DCF77 is a continuous carrier whose amplitude is reduced to ~15% for the
//! first 100 ms (bit 0) or 200 ms (bit 1) of each second. Second 59 carries no
//! pulse, so the ~2 s gap between pulse starts marks the next minute.

use num_complex::Complex32;
use serde_json::json;

use crate::config::DecoderConfig;
use crate::decoders::timecode::{self, TimeCode, TimeStandard};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const EXTRACT_RATE: i32 = 12_200;
const STATUS_NS: i64 = 500_000_000;

struct EnvelopeDecoder {
    rate: f64,
    high: f32,
    low: f32,
    ready: bool,
    keyed: bool,
    low_start: f64,
    last_low_start: Option<f64>,
    minute_open: bool,
    bits: Vec<u8>,
    bit_index: usize,
    seconds: f64,
    last_time: Option<TimeCode>,
}

impl EnvelopeDecoder {
    fn new(rate: f64) -> Self {
        Self {
            rate,
            high: 0.0,
            low: 0.0,
            ready: false,
            keyed: false,
            low_start: 0.0,
            last_low_start: None,
            minute_open: false,
            bits: Vec::with_capacity(59),
            bit_index: 0,
            seconds: 0.0,
            last_time: None,
        }
    }

    fn push(&mut self, magnitude: f32) -> Option<TimeCode> {
        let t = self.seconds;
        self.seconds += 1.0 / self.rate;

        if !self.ready {
            self.high = magnitude;
            self.low = magnitude;
            self.ready = true;
            return None;
        }

        // Track the carrier floor immediately and let it recover slowly; the
        // carrier peak decays slowly too. That keeps the hysteresis thresholds
        // stable across both the 100 ms and 200 ms drops.
        if magnitude < self.low {
            self.low = magnitude;
        } else {
            self.low += (magnitude - self.low) * 0.0002;
        }
        if magnitude > self.high {
            self.high = magnitude;
        } else {
            self.high -= (self.high - magnitude) * 0.00005;
        }
        let span = self.high - self.low;
        if span <= 0.00005 {
            return None;
        }
        let threshold = self.low + 0.5 * span;
        let release = self.low + 0.78 * span;

        if !self.keyed && magnitude < threshold {
            self.keyed = true;
            self.on_low_start(t);
        } else if self.keyed && magnitude > release {
            self.keyed = false;
            return self.on_low_end(t);
        }
        None
    }

    fn on_low_start(&mut self, t: f64) {
        if let Some(last) = self.last_low_start {
            let gap = t - last;
            if gap >= 1.5 {
                if self.minute_open && self.bits.len() == 59 {
                    // The caller reads this through `last_time` below.
                }
                self.bits.clear();
                self.bit_index = 0;
                self.minute_open = true;
            } else if gap > 3.0 {
                self.minute_open = false;
                self.bits.clear();
            }
        }
        self.last_low_start = Some(t);
        self.low_start = t;
    }

    fn on_low_end(&mut self, t: f64) -> Option<TimeCode> {
        let duration = t - self.low_start;
        if !self.minute_open || self.bit_index >= 59 {
            return None;
        }
        let bit = if (0.04..0.16).contains(&duration) {
            0
        } else if (0.16..0.28).contains(&duration) {
            1
        } else {
            2
        };
        self.bits.push(bit);
        self.bit_index += 1;
        if self.bit_index == 59 {
            let decoded = timecode::decode(&self.bits, TimeStandard::Dcf77);
            if decoded.is_some() {
                self.last_time = decoded.clone();
            }
            return decoded;
        }
        None
    }

    fn status(&self) -> serde_json::Value {
        json!({
            "kind": "status",
            "listening": true,
            "sync": self.minute_open,
            "bits": self.bits.len(),
            "level": self.low + 0.5 * (self.high - self.low),
            "high": self.high,
            "low": self.low,
            "keyed": self.keyed,
            "time": self.last_time.as_ref().map(time_json),
        })
    }
}

fn time_json(code: &TimeCode) -> serde_json::Value {
    json!({
        "year": code.year,
        "month": code.month,
        "day": code.day,
        "hour": code.hour,
        "minute": code.minute,
        "weekday": code.weekday,
        "utcOffsetMin": code.utc_offset_min,
        "unix": code.unix,
        "dst": code.dst,
        "leapSecond": code.leap_second,
        "clockChange": code.clock_change,
        "holidayToday": code.holiday_today,
        "holidayTomorrow": code.holiday_tomorrow,
        "text": code.text,
    })
}

pub(crate) struct Dcf77Channel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    complex: Vec<Complex32>,
    pcm: Vec<i16>,
    decoder: Option<EnvelopeDecoder>,
    results: Vec<serde_json::Value>,
    last_status: i64,
}

impl Dcf77Channel {
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
            output_sample_rate: EXTRACT_RATE,
            tune_offset: offset as i32,
            // The carrier is at DC after the NCO; removing IQ DC would remove
            // the very carrier whose envelope we need.
            dc_offset_removal: false,
        })
        .map_err(|e| format!("DCF77 extractor: {e}"))?;
        extractor.set_bandwidth(cfg.bandwidth_hz.max(200));
        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            complex: Vec::new(),
            pcm: Vec::new(),
            decoder: None,
            results: Vec::new(),
            last_status: 0,
        })
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now: i64) {
        self.complex.clear();
        self.pcm.clear();
        self.extractor.process_into(chunk, &mut self.pcm);
        if self.pcm.is_empty() {
            return;
        }
        if self.decoder.is_none() {
            self.decoder = Some(EnvelopeDecoder::new(
                self.extractor.output_sample_rate() as f64,
            ));
        }

        let decoder = self.decoder.as_mut().expect("set above");
        for pair in self.pcm.chunks_exact(2) {
            let re = pair[0] as f32 / 32768.0;
            let im = pair[1] as f32 / 32768.0;
            let magnitude = (re * re + im * im).sqrt();
            if let Some(code) = decoder.push(magnitude) {
                self.results.push(json!({
                    "kind": "time",
                    "id": self.cfg.id,
                    "mode": self.cfg.mode,
                    "text": code.text,
                    "rfHz": self.cfg.frequency_hz,
                    "at": now / 1_000_000_000,
                    "time": time_json(&code),
                }));
            }
        }

        if now.saturating_sub(self.last_status) >= STATUS_NS {
            self.last_status = now;
            if let Some(decoder) = self.decoder.as_ref() {
                self.results.push(decoder.status());
            }
        }
    }

    pub(crate) fn take_results(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minute_bits() -> Vec<u8> {
        let mut b = vec![0u8; 59];
        b[20] = 1;
        b[18] = 1;
        // 2026-11-13 14:32 CET
        for (start, weights, value) in [
            (21, &[1u32, 2, 4, 8, 10, 20, 40][..], 32u32),
            (29, &[1, 2, 4, 8, 10, 20][..], 14),
            (36, &[1, 2, 4, 8, 10, 20][..], 13),
            (42, &[1, 2, 4][..], 5),
            (45, &[1, 2, 4, 8, 10][..], 11),
            (50, &[1, 2, 4, 8, 10, 20, 40, 80][..], 26),
        ] {
            let split = weights.len().min(4);
            let units = value % 10;
            let tens = value / 10;
            for i in 0..weights.len() {
                let digit = if i < split { units } else { tens };
                let bit = i - if i < split { 0 } else { split };
                if digit & (1 << bit) != 0 {
                    b[start + i] = 1;
                }
            }
        }
        for (start, end) in [(21, 29), (29, 36), (36, 59)] {
            let ones = b[start..end - 1].iter().filter(|v| **v == 1).count();
            b[end - 1] = (ones % 2) as u8;
        }
        b
    }

    #[test]
    fn envelope_timing_decodes_a_minute() {
        let bits = minute_bits();
        let mut dec = EnvelopeDecoder::new(1000.0);
        let mut got = None;
        // Two minutes: the first gives the decoder the minute marker, the
        // second is the complete frame it can report.
        for _minute in 0..2 {
            for bit in bits.iter().copied() {
                let low_ms = if bit == 1 { 200 } else { 100 };
                for ms in 0..1000 {
                    let level = if ms < low_ms { 0.15 } else { 1.0 };
                    if let Some(code) = dec.push(level) {
                        got = Some(code);
                    }
                    // 1 ms per push at 1 kHz.
                }
            }
            // Second 59 has no pulse; its silent carrier creates the >1.5 s
            // gap that closes the minute.
            for _ in 0..1000 {
                if let Some(code) = dec.push(1.0) {
                    got = Some(code);
                }
            }
        }
        let code = got.expect("DCF77 frame");
        assert_eq!((code.year, code.month, code.day), (2026, 11, 13));
        assert_eq!((code.hour, code.minute), (14, 32));
    }
}
