//! ALS162 (162 kHz Allouis) phase-modulated time-code decoder.
//!
//! ALS162 keeps the carrier on continuously and keys ±1 rad triangular phase
//! pulses. A single 100 ms pulse is a zero bit; two consecutive pulses are a
//! one bit. Second 59 has no pulse and marks the minute boundary.
//!
//! The receiver follows the reference GNU Radio decoder: mix to baseband,
//! unwrap and detrend the phase, resample to 1 kHz, then correlate against the
//! 25/50/25 ms pulse template.

use std::collections::VecDeque;

use serde_json::json;

use crate::config::DecoderConfig;
use crate::decoders::timecode::{self, TimeCode, TimeStandard};
use crate::decoders::LinearResampler;
use crate::dsp::{IqExtractor, IqExtractorConfig};

const EXTRACT_RATE: i32 = 12_200;
const DETECT_RATE: f64 = 1000.0;
const STATUS_NS: i64 = 500_000_000;

struct PulseDetector {
    template: Vec<f32>,
    window: VecDeque<f32>,
    previous: f32,
    previous2: f32,
    peak: f32,
    sample: i64,
    last_pulse: i64,
}

impl PulseDetector {
    fn new() -> Self {
        // 25 ms up, 50 ms down, 25 ms back to zero at 1 kHz.
        let mut template = Vec::with_capacity(100);
        for i in 0..25 {
            template.push(i as f32 / 25.0);
        }
        for i in 0..50 {
            template.push(1.0 - 2.0 * i as f32 / 50.0);
        }
        for i in 0..25 {
            template.push(-1.0 + i as f32 / 25.0);
        }
        let mean = template.iter().sum::<f32>() / template.len() as f32;
        template.iter_mut().for_each(|v| *v -= mean);
        let norm = template.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            template.iter_mut().for_each(|v| *v /= norm);
        }
        Self {
            template,
            window: VecDeque::with_capacity(100),
            previous: 0.0,
            previous2: 0.0,
            peak: 0.0,
            sample: 0,
            last_pulse: -1000,
        }
    }

    fn push(&mut self, value: f32) -> Option<f64> {
        self.window.push_back(value);
        if self.window.len() > self.template.len() {
            self.window.pop_front();
        }
        if self.window.len() < self.template.len() {
            self.sample += 1;
            return None;
        }

        let mut corr = 0.0f32;
        for (w, t) in self.window.iter().zip(&self.template) {
            corr += w * t;
        }
        let corr = corr.abs();
        self.peak = (self.peak * 0.9995).max(corr);

        let mut pulse = None;
        let threshold = (self.peak * 0.30).max(0.02);
        if self.previous > self.previous2
            && self.previous >= corr
            && self.previous > threshold
            && self.sample - self.last_pulse >= 80
        {
            self.last_pulse = self.sample;
            // A full 100 ms template peaks at the end of the pulse.
            pulse = Some((self.sample - self.template.len() as i64 + 1) as f64 / DETECT_RATE);
        }
        self.previous2 = self.previous;
        self.previous = corr;
        self.sample += 1;
        pulse
    }
}

struct PulseClock {
    frame_open: bool,
    second: usize,
    pulses: usize,
    last_pulse: Option<f64>,
    bits: Vec<u8>,
    last_time: Option<TimeCode>,
}

impl PulseClock {
    fn new() -> Self {
        Self {
            frame_open: false,
            second: 0,
            pulses: 0,
            last_pulse: None,
            bits: Vec::with_capacity(59),
            last_time: None,
        }
    }

    fn push(&mut self, t: f64) -> Option<TimeCode> {
        let Some(last) = self.last_pulse else {
            self.last_pulse = Some(t);
            self.pulses = 1;
            return None;
        };
        let gap = t - last;
        self.last_pulse = Some(t);

        if gap >= 1.5 {
            let mut decoded = None;
            if self.frame_open {
                self.close_second();
                if self.bits.len() == 59 {
                    decoded = timecode::decode(&self.bits, TimeStandard::Als162);
                    if decoded.is_some() {
                        self.last_time = decoded.clone();
                    }
                }
            }
            self.bits.clear();
            self.second = 0;
            self.pulses = 1;
            self.frame_open = true;
            decoded
        } else if gap >= 0.5 {
            if self.frame_open {
                self.close_second();
                self.second += 1;
                if self.second > 58 {
                    self.frame_open = false;
                    self.bits.clear();
                }
            }
            self.pulses = 1;
            None
        } else {
            self.pulses += 1;
            None
        }
    }

    fn close_second(&mut self) {
        if !self.frame_open || self.second > 58 {
            return;
        }
        let bit = match self.pulses {
            1 => 0,
            2 => 1,
            _ => 2,
        };
        self.bits.push(bit);
    }

    fn status(&self) -> serde_json::Value {
        json!({
            "kind": "status",
            "listening": true,
            "sync": self.frame_open,
            "bits": self.bits.len(),
            "second": self.second,
            "pulses": self.pulses,
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

struct PhaseDecoder {
    rate: f64,
    raw_phase: f32,
    unwrapped: f64,
    phase_ring: VecDeque<f64>,
    phase_sum: f64,
    resampler: LinearResampler,
    pulses: PulseDetector,
    clock: PulseClock,
    level: f32,
}

impl PhaseDecoder {
    fn new(rate: f64) -> Self {
        Self {
            rate,
            raw_phase: 0.0,
            unwrapped: 0.0,
            phase_ring: VecDeque::with_capacity(rate as usize + 1),
            phase_sum: 0.0,
            resampler: LinearResampler::new(rate, DETECT_RATE),
            pulses: PulseDetector::new(),
            clock: PulseClock::new(),
            level: 0.0,
        }
    }

    fn push(&mut self, re: f32, im: f32) -> Option<TimeCode> {
        let magnitude = (re * re + im * im).sqrt();
        self.level += (magnitude - self.level) * 0.001;

        let raw = im.atan2(re);
        let mut delta = raw - self.raw_phase;
        if delta > std::f32::consts::PI {
            delta -= std::f32::consts::TAU;
        } else if delta < -std::f32::consts::PI {
            delta += std::f32::consts::TAU;
        }
        self.raw_phase = raw;
        self.unwrapped += f64::from(delta);

        let window = (self.rate.round() as usize).max(1);
        if self.phase_ring.len() == window {
            if let Some(old) = self.phase_ring.pop_front() {
                self.phase_sum -= old;
            }
        }
        self.phase_ring.push_back(self.unwrapped);
        self.phase_sum += self.unwrapped;
        let mean = self.phase_sum / self.phase_ring.len() as f64;
        let detrended = (self.unwrapped - mean) as f32;

        let mut resampled = Vec::with_capacity(2);
        self.resampler.process(&[detrended], &mut resampled);
        for value in resampled {
            if let Some(t) = self.pulses.push(value) {
                if let Some(code) = self.clock.push(t) {
                    return Some(code);
                }
            }
        }
        None
    }
}

pub(crate) struct Als162Channel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    pcm: Vec<i16>,
    decoder: PhaseDecoder,
    results: Vec<serde_json::Value>,
    last_status: i64,
}

impl Als162Channel {
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
            dc_offset_removal: false,
        })
        .map_err(|e| format!("ALS162 extractor: {e}"))?;
        extractor.set_bandwidth(cfg.bandwidth_hz.max(200));
        let rate = extractor.output_sample_rate() as f64;
        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            pcm: Vec::new(),
            decoder: PhaseDecoder::new(rate),
            results: Vec::new(),
            last_status: 0,
        })
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now: i64) {
        self.extractor.process_into(chunk, &mut self.pcm);
        if self.pcm.is_empty() {
            return;
        }
        for pair in self.pcm.chunks_exact(2) {
            let re = pair[0] as f32 / 32768.0;
            let im = pair[1] as f32 / 32768.0;
            if let Some(code) = self.decoder.push(re, im) {
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
            let mut status = self.decoder.clock.status();
            if let Some(object) = status.as_object_mut() {
                object.insert("id".into(), json!(self.cfg.id));
                object.insert("mode".into(), json!(self.cfg.mode));
                object.insert("level".into(), json!(self.decoder.level));
            }
            self.results.push(status);
        }
    }

    pub(crate) fn take_results(&mut self) -> Vec<serde_json::Value> {
        std::mem::take(&mut self.results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bcd_bits(value: u32, weights: &[u32]) -> Vec<u8> {
        let split = weights.len().min(4);
        let units = value % 10;
        let tens = value / 10;
        (0..weights.len())
            .map(|i| {
                let digit = if i < split { units } else { tens };
                let bit = i - if i < split { 0 } else { split };
                u8::from(digit & (1 << bit) != 0)
            })
            .collect()
    }

    fn minute_bits() -> Vec<u8> {
        let mut b = vec![0u8; 59];
        b[20] = 1;
        b[21..28].copy_from_slice(&bcd_bits(32, &[1, 2, 4, 8, 10, 20, 40]));
        b[29..35].copy_from_slice(&bcd_bits(14, &[1, 2, 4, 8, 10, 20]));
        b[36..42].copy_from_slice(&bcd_bits(13, &[1, 2, 4, 8, 10, 20]));
        b[42..45].copy_from_slice(&bcd_bits(5, &[1, 2, 4]));
        b[45..50].copy_from_slice(&bcd_bits(11, &[1, 2, 4, 8, 10]));
        b[50..58].copy_from_slice(&bcd_bits(26, &[1, 2, 4, 8, 10, 20, 40, 80]));
        b[18] = 1;
        for (start, end) in [(21, 29), (29, 36), (36, 59)] {
            let ones = b[start..end - 1].iter().filter(|v| **v == 1).count();
            b[end - 1] = (ones % 2) as u8;
        }
        b
    }

    #[test]
    fn pulse_clock_decodes_a_minute() {
        let bits = minute_bits();
        let mut clock = PulseClock::new();
        let mut got = None;

        // Two minutes, each followed by a silent second 59. The first opens
        // the minute marker; the second is a complete frame.
        for minute in 0..2 {
            let base = minute as f64 * 60.0;
            for (second, bit) in bits.iter().copied().enumerate() {
                let t = base + second as f64;
                if let Some(code) = clock.push(t) {
                    got = Some(code);
                }
                if bit == 1 {
                    if let Some(code) = clock.push(t + 0.1) {
                        got = Some(code);
                    }
                }
            }
        }
        // The first pulse of the next minute closes the frame.
        if let Some(code) = clock.push(120.0) {
            got = Some(code);
        }

        let code = got.expect("ALS162 frame");
        assert_eq!((code.year, code.month, code.day), (2026, 11, 13));
        assert_eq!((code.hour, code.minute), (14, 32));
    }

    #[test]
    fn pulse_detector_finds_a_template() {
        let mut detector = PulseDetector::new();
        let mut count = 0;
        for _ in 0..200 {
            for i in 0..100 {
                let value = if i < 25 {
                    i as f32 / 25.0
                } else if i < 75 {
                    1.0 - 2.0 * (i - 25) as f32 / 50.0
                } else {
                    -1.0 + (i - 75) as f32 / 25.0
                };
                if detector.push(value).is_some() {
                    count += 1;
                }
            }
            for _ in 0..900 {
                detector.push(0.0);
            }
        }
        assert!(count >= 150, "detector found {count} pulses");
    }
}
