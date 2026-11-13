//! HFDL (ARINC 635) decoder.
//!
//! HFDL is not an audio mode. The engine gives the decoder a dedicated
//! complex lane at 24 kS/s centred on the assigned HF channel; the +1440 Hz
//! USB subcarrier and the burst/FEC work live inside `xng-mode-hfdl`.
//!
//! The channel therefore bypasses `SsbDemod`/`AnyDecoder`: raw `Cu8` IQ is
//! downconverted with `IqExtractor`, resampled to exactly 24 kHz, and fed to
//! `sdroxide_hfdl::HfdlController`. The controller emits a rolling decode log
//! and level/burst counters about once a second.

use num_complex::Complex32;
use sdroxide_hfdl::HfdlController;
use sdroxide_types::{HfdlDecode, HfdlSettings, HfdlStatus, HFDL_LANE_RATE_HZ};
use serde_json::{json, Value};

use crate::config::DecoderConfig;
use crate::dsp::{IqExtractor, IqExtractorConfig};

const UNAVAILABLE_INTERVAL_MS: i64 = 500;

/// Complex linear resampler from the extractor's rounded rate to the exact
/// 24 kHz the HFDL decoder was validated at.
struct ComplexResampler {
    step: f64,
    pos: f64,
    previous: Option<Complex32>,
}

impl ComplexResampler {
    fn new(source_rate: f64, target_rate: f64) -> Self {
        Self {
            step: target_rate / source_rate,
            pos: 0.0,
            previous: None,
        }
    }

    fn process(&mut self, input: &[Complex32], out: &mut Vec<Complex32>) {
        if (self.step - 1.0).abs() < 1e-9 {
            out.extend_from_slice(input);
            self.previous = input.last().copied();
            return;
        }
        for &sample in input {
            if let Some(previous) = self.previous {
                while self.pos <= 1.0 {
                    let t = self.pos as f32;
                    out.push(previous + (sample - previous) * t);
                    self.pos += self.step;
                }
                self.pos -= 1.0;
            }
            self.previous = Some(sample);
        }
    }
}

pub(crate) struct HfdlChannel {
    pub(crate) cfg: DecoderConfig,
    controller: Option<HfdlController>,
    extractor: Option<IqExtractor>,
    resampler: ComplexResampler,
    center_hz: f64,
    rate_hz: f64,
    degraded: Option<String>,
    unavailable: Option<String>,
    suggest_center_hz: Option<f64>,
    scratch: Vec<Complex32>,
    lane: Vec<Complex32>,
    results: Vec<Value>,
    last_unavailable_ms: i64,
}

impl HfdlChannel {
    pub(crate) fn new(cfg: &DecoderConfig, center_hz: f64, rate_hz: f64) -> Self {
        let rate_hz = rate_hz.max(1.0);
        let offset = cfg.frequency_hz - center_hz as i64;
        let mut channel = Self {
            cfg: cfg.clone(),
            controller: None,
            extractor: None,
            resampler: ComplexResampler::new(24_200.0, HFDL_LANE_RATE_HZ),
            center_hz,
            rate_hz,
            degraded: None,
            unavailable: None,
            suggest_center_hz: None,
            scratch: Vec::new(),
            lane: Vec::new(),
            results: Vec::new(),
            last_unavailable_ms: 0,
        };

        // The decoder needs a 24 kHz lane centred on the HFDL channel. Keep
        // the requirement explicit: a bad window must say so, not look quiet.
        if offset.unsigned_abs() as f64 + HFDL_LANE_RATE_HZ / 2.0 > rate_hz / 2.0 {
            channel.unavailable = Some(format!(
                "HFDL needs a 24 kHz lane around {:.3} kHz; this receiver is \
                 centred at {:.3} kHz with {:.1} kHz of span.",
                cfg.frequency_hz as f64 / 1e3,
                center_hz / 1e3,
                rate_hz / 1e3
            ));
            channel.suggest_center_hz = Some(cfg.frequency_hz as f64);
            tracing::warn!(
                decoder = %cfg.id,
                center_hz,
                rate_hz,
                "HFDL channel cannot run in this receiver window"
            );
            return channel;
        }

        let mut extractor = match IqExtractor::new(IqExtractorConfig {
            input_sample_rate: rate_hz as i32,
            output_sample_rate: 24_200,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        }) {
            Ok(extractor) => extractor,
            Err(e) => {
                channel.unavailable = Some(format!("HFDL channel extractor: {e}"));
                return channel;
            }
        };
        extractor.set_bandwidth(HFDL_LANE_RATE_HZ as i32);
        channel.resampler =
            ComplexResampler::new(extractor.output_sample_rate() as f64, HFDL_LANE_RATE_HZ);
        channel.extractor = Some(extractor);

        let mut settings = HfdlSettings::default();
        settings.enabled = true;
        settings.frequency_hz = cfg.frequency_hz as f64;
        channel.controller = Some(HfdlController::new(HFDL_LANE_RATE_HZ, settings));
        channel
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.results)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now_ms: i64) {
        let (Some(controller), Some(extractor)) = (&self.controller, self.extractor.as_mut())
        else {
            if now_ms - self.last_unavailable_ms >= UNAVAILABLE_INTERVAL_MS {
                self.last_unavailable_ms = now_ms;
                self.results.push(self.empty_status());
            }
            return;
        };

        self.scratch.clear();
        self.scratch.reserve(chunk.len() / 2);
        // Convert offset-binary Cu8 to complex baseband. `IqExtractor` takes
        // raw bytes itself; converting twice would be wasted, so this path
        // uses the extractor's byte API and then converts its i16 lane.
        let mut i16_lane = Vec::new();
        extractor.process_into(chunk, &mut i16_lane);
        if i16_lane.is_empty() {
            return;
        }
        for pair in i16_lane.chunks_exact(2) {
            self.scratch.push(Complex32::new(
                pair[0] as f32 / 32768.0,
                pair[1] as f32 / 32768.0,
            ));
        }

        self.lane.clear();
        self.resampler.process(&self.scratch, &mut self.lane);
        if !self.lane.is_empty() {
            controller.on_rx_iq(&self.lane);
        }
        if let Some(status) = controller.poll() {
            self.results.push(status_json(
                &status,
                &self.degraded,
                &self.unavailable,
                self.center_hz,
                self.rate_hz,
                self.suggest_center_hz,
            ));
        }
    }

    fn empty_status(&self) -> Value {
        json!({
            "running": false,
            "levelDbfs": 0.0,
            "bursts": 0,
            "decodes": 0,
            "log": [],
            "unavailable": self.unavailable,
            "degraded": self.degraded,
            "suggestCenterHz": self.suggest_center_hz,
            "windowCenterHz": self.center_hz,
            "windowRateHz": self.rate_hz,
        })
    }
}

fn status_json(
    status: &HfdlStatus,
    degraded: &Option<String>,
    unavailable: &Option<String>,
    center_hz: f64,
    rate_hz: f64,
    suggest_center_hz: Option<f64>,
) -> Value {
    let log: Vec<Value> = status.log.iter().map(decode_json).collect();
    json!({
        "running": status.running,
        "levelDbfs": status.level_dbfs,
        "bursts": status.bursts,
        "decodes": status.decodes,
        "log": log,
        "unavailable": unavailable,
        "degraded": degraded,
        "suggestCenterHz": suggest_center_hz,
        "windowCenterHz": center_hz,
        "windowRateHz": rate_hz,
    })
}

fn decode_json(decode: &HfdlDecode) -> Value {
    json!({
        "unix": decode.unix,
        "kind": decode.kind,
        "gs": decode.gs,
        "freqKhz": decode.freq_khz,
        "snrDb": decode.snr_db,
        "freqSkewHz": decode.freq_skew_hz,
        "fecCorrected": decode.fec_corrected,
        "details": decode.details,
        "position": decode.position.as_ref().map(|fix| json!({
            "lat": fix.lat,
            "lon": fix.lon,
            "aircraftId": fix.aircraft_id,
            "icao": fix.icao,
            "flight": fix.flight,
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sdroxide_types::HFDL_DEFAULT_HZ;

    fn cfg(frequency_hz: i64) -> DecoderConfig {
        DecoderConfig {
            id: "hfdl-test".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "hfdl".into(),
            frequency_hz,
            ..DecoderConfig::default()
        }
    }

    #[test]
    fn channel_reports_unavailable_outside_window() {
        let channel = HfdlChannel::new(&cfg(HFDL_DEFAULT_HZ as i64), 100_000_000.0, 2_400_000.0);
        assert!(channel.unavailable.is_some());
        assert_eq!(channel.suggest_center_hz, Some(HFDL_DEFAULT_HZ));
    }

    #[test]
    fn channel_builds_inside_window() {
        let channel = HfdlChannel::new(&cfg(HFDL_DEFAULT_HZ as i64), HFDL_DEFAULT_HZ, 2_400_000.0);
        assert!(channel.controller.is_some());
        assert!(channel.extractor.is_some());
    }
}
