//! Raw-IQ AIS / Marine VHF decoder.
//!
//! AIS is two 25 kHz GMSK channels at 161.975 and 162.025 MHz, 50 kHz apart.
//! The useful dial is 162.000 MHz: neither channel transmits there, so on a
//! zero-IF front end neither lands in the DC spike. The controller splits the
//! window into whichever channels it reaches and emits a whole vessel table
//! twice a second, like ADS-B.

use num_complex::Complex32;
use sdroxide_ais::{plan, window_covers, AisAction, AisController};
use sdroxide_types::{AisSettings, AIS_GOOD_SPS, AIS_MIN_RATE_HZ, AIS_PLAN_CENTER_HZ};
use serde_json::{json, Value};

use crate::config::DecoderConfig;

const UNAVAILABLE_INTERVAL_MS: i64 = 500;
const INV_U8_SCALE: f32 = 1.0 / 127.5;

pub(crate) struct AisChannel {
    pub(crate) cfg: DecoderConfig,
    controller: Option<AisController>,
    center_hz: f64,
    rate_hz: f64,
    degraded: Option<String>,
    unavailable: Option<String>,
    suggest_center_hz: Option<f64>,
    scratch: Vec<Complex32>,
    results: Vec<Value>,
    last_unavailable_ms: i64,
    /// Running DC estimate. AIS channels sit ±25 kHz from the window centre, so
    /// the zero-IF spike is not on top of either — but it still biases the ADC
    /// and raises the per-channel noise floor, so remove it cheaply.
    dc_re: f32,
    dc_im: f32,
    dc_primed: bool,
    dc_alpha: f32,
}

impl AisChannel {
    pub(crate) fn new(cfg: &DecoderConfig, center_hz: f64, rate_hz: f64) -> Self {
        let rate_hz = rate_hz.max(1.0);
        let mut channel = Self {
            cfg: cfg.clone(),
            controller: None,
            center_hz,
            rate_hz,
            degraded: None,
            unavailable: None,
            suggest_center_hz: None,
            scratch: Vec::new(),
            results: Vec::new(),
            last_unavailable_ms: 0,
            dc_re: 0.0,
            dc_im: 0.0,
            dc_primed: false,
            dc_alpha: (1.0 - (-std::f64::consts::TAU * 10.0 / rate_hz).exp()) as f32,
        };

        if !window_covers(center_hz, rate_hz) {
            channel.unavailable = Some(unsupported_message(center_hz, rate_hz));
            channel.suggest_center_hz = Some(AIS_PLAN_CENTER_HZ);
            tracing::warn!(
                decoder = %cfg.id,
                center_hz,
                rate_hz,
                "AIS channel cannot run in this receiver window"
            );
            return channel;
        }

        let both = plan::channels_in_window(center_hz, rate_hz).len() == 2;
        let channel_rate = plan::channel_rate_for(rate_hz, both);
        let sps = channel_rate / 9_600.0;
        if !both {
            channel.degraded = Some(
                "Only one of the two AIS channels is in this receiver window; ships \
                 alternate channels, so each is heard at half its reporting rate."
                    .to_string(),
            );
        } else if sps < AIS_GOOD_SPS {
            channel.degraded = Some(format!(
                "AIS has only {sps:.1} samples per bit; widen the profile to at \
                 least 100 kHz for reliable decoding."
            ));
        }

        channel.controller = Some(AisController::new(
            center_hz,
            rate_hz,
            settings_from_config(cfg),
        ));
        channel
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.results)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now_ms: i64) {
        let Some(controller) = &self.controller else {
            if now_ms - self.last_unavailable_ms >= UNAVAILABLE_INTERVAL_MS {
                self.last_unavailable_ms = now_ms;
                self.results.push(json!({
                    "vessels": [],
                    "channels": [],
                    "unavailable": self.unavailable,
                    "degraded": self.degraded,
                    "suggestCenterHz": self.suggest_center_hz,
                    "windowCenterHz": self.center_hz,
                    "windowRateHz": self.rate_hz,
                    "bursts": 0,
                    "messages": 0,
                    "badFcs": 0,
                    "unsupported": 0,
                    "samplesPerBit": 0.0,
                    "offsetHz": null,
                }));
            }
            return;
        };

        self.scratch.clear();
        self.scratch.reserve(chunk.len() / 2);
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
            self.scratch
                .push(Complex32::new(i - self.dc_re, q - self.dc_im));
        }
        if self.scratch.is_empty() {
            return;
        }

        controller.on_rx_iq(&self.scratch);
        for action in controller.poll() {
            let AisAction::Status(status) = action;
            let degraded = status.degraded.clone().or_else(|| self.degraded.clone());
            let suggest = status.suggest_center_hz.or(self.suggest_center_hz);
            self.results.push(json!({
                "vessels": status.vessels,
                "channels": status.channels,
                "unavailable": status.unavailable,
                "degraded": degraded,
                "suggestCenterHz": suggest,
                "windowCenterHz": status.window_center_hz,
                "windowRateHz": status.window_rate_hz,
                "bursts": status.bursts,
                "messages": status.messages,
                "badFcs": status.bad_fcs,
                "unsupported": status.unsupported,
                "samplesPerBit": status.samples_per_bit,
                "offsetHz": status.offset_hz,
            }));
        }
    }
}

fn unsupported_message(center_hz: f64, rate_hz: f64) -> String {
    if rate_hz < AIS_MIN_RATE_HZ {
        format!(
            "AIS needs at least {:.0} kHz of stream; this receiver is running at \
             {:.0} kHz.",
            AIS_MIN_RATE_HZ / 1e3,
            rate_hz / 1e3
        )
    } else {
        format!(
            "AIS needs a window covering 161.975 or 162.025 MHz; this receiver is \
             centred at {:.3} MHz with {:.0} kHz of span.",
            center_hz / 1e6,
            rate_hz / 1e3
        )
    }
}

fn settings_from_config(cfg: &DecoderConfig) -> AisSettings {
    let mut settings = AisSettings::default();
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
    let u8_value = |keys: &[&str]| -> Option<u8> {
        keys.iter()
            .find_map(|key| map.get(*key))
            .and_then(Value::as_u64)
            .map(|v| v.min(u8::MAX as u64) as u8)
    };
    let bool_value = |keys: &[&str]| -> Option<bool> {
        keys.iter()
            .find_map(|key| map.get(*key))
            .and_then(Value::as_bool)
    };

    if let Some(v) = bool_value(&["enabled"]) {
        settings.enabled = v;
    }
    if let Some(v) = u8_value(&["channels"]) {
        settings.channels = v;
    }
    if let Some(v) = u8_value(&["thresholdDb", "threshold_db"]) {
        settings.threshold_db = v;
    }
    if let Some(v) = u16_value(&["dropMapS", "drop_map_s"]) {
        settings.drop_map_s = v;
    }
    if let Some(v) = u16_value(&["dropListS", "drop_list_s"]) {
        settings.drop_list_s = v;
    }
    if let Some(v) = u16_value(&["trailMinutes", "trail_minutes"]) {
        settings.trail_minutes = v;
    }
    if let Some(v) = f32_value(&["vectorMinutes", "vector_minutes"]) {
        settings.vector_minutes = v;
    }
    if let Some(v) = u16_value(&["maxVessels", "max_vessels"]) {
        settings.max_vessels = v;
    }
    settings.sane()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DecoderConfig {
        DecoderConfig {
            id: "ais-162".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "ais".to_string(),
            frequency_hz: AIS_PLAN_CENTER_HZ as i64,
            bandwidth_hz: 25_000,
            settings: Default::default(),
        }
    }

    #[test]
    fn a_window_over_the_wrong_band_reports_the_fix() {
        let channel = AisChannel::new(&cfg(), 109_000_000.0, 2_400_000.0);
        assert!(channel.controller.is_none());
        assert!(channel.unavailable.as_deref().unwrap().contains("161.975"));
        assert_eq!(channel.suggest_center_hz, Some(AIS_PLAN_CENTER_HZ));
    }

    #[test]
    fn a_too_narrow_window_reports_the_width() {
        let channel = AisChannel::new(&cfg(), AIS_PLAN_CENTER_HZ, 24_000.0);
        assert!(channel.controller.is_none());
        assert!(channel.unavailable.as_deref().unwrap().contains("48 kHz"));
    }

    #[test]
    fn one_channel_in_a_narrow_window_is_degraded_but_runs() {
        let channel = AisChannel::new(&cfg(), sdroxide_types::AIS_CHANNEL_A_HZ, 50_000.0);
        assert!(channel.controller.is_some());
        assert!(channel.degraded.as_deref().unwrap().contains("Only one"));
    }

    #[test]
    fn a_synthetic_ais_transmission_reaches_the_snapshot() {
        use std::time::{Duration, Instant};

        use sdroxide_ais::tx::{modulate_bits, shift, Noise, Payload, TxParams};

        fn cu8(iq: &[Complex32]) -> Vec<u8> {
            let mut out = Vec::with_capacity(iq.len() * 2);
            for z in iq {
                for value in [z.re, z.im] {
                    out.push(((value * 127.5 + 127.5).round().clamp(0.0, 255.0)) as u8);
                }
            }
            out
        }

        let rate = 150_000.0;
        let center = AIS_PLAN_CENTER_HZ;
        let mut channel = AisChannel::new(&cfg(), center, rate);

        let params = TxParams {
            sample_rate: rate,
            ..TxParams::default()
        };
        let bits = Payload::new(168)
            .put(0, 6, 1)
            .put(8, 30, 244_660_000)
            .put(50, 10, 154)
            .put_signed(61, 28, (4.8973 * 600_000.0) as i64)
            .put_signed(89, 27, (52.3791 * 600_000.0) as i64)
            .put(116, 12, 900)
            .bits();
        let mut signal = modulate_bits(&bits, &params);
        shift(&mut signal, plan::CHANNELS[1].center_hz - center, rate);

        let mut noise = Noise::new(0xA15);
        let mut quiet = vec![Complex32::default(); 40_000];
        noise.add(&mut quiet, 0.004);
        noise.add(&mut signal, 0.004);

        channel.process_chunk(&cu8(&quiet), 1_000);
        channel.process_chunk(&cu8(&signal), 1_100);
        channel.process_chunk(&cu8(&quiet), 1_200);

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            channel.process_chunk(&cu8(&quiet[..2_000]), 1_300);
            for snapshot in channel.take_results() {
                if snapshot
                    .get("vessels")
                    .and_then(Value::as_array)
                    .map(|list| !list.is_empty())
                    .unwrap_or(false)
                {
                    found = true;
                }
            }
            if found {
                break;
            }
        }
        assert!(found, "synthetic AIS transmission produced no vessel");
    }

    #[test]
    fn snapshot_shape_is_stable() {
        let mut channel = AisChannel::new(&cfg(), 109_000_000.0, 2_400_000.0);
        channel.process_chunk(&[127, 127, 127, 127], 1_000);
        let value = channel.take_results().pop().unwrap();
        for key in [
            "vessels",
            "channels",
            "unavailable",
            "degraded",
            "suggestCenterHz",
            "windowCenterHz",
            "windowRateHz",
            "bursts",
            "messages",
            "badFcs",
            "unsupported",
            "samplesPerBit",
            "offsetHz",
        ] {
            assert!(value.get(key).is_some(), "snapshot missing {key}");
        }
    }
}
