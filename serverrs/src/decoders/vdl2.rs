//! Raw-IQ VDL Mode 2 decoder.
//!
//! VDL2 is fourteen 25 kHz D8PSK channels between 136.650 and 136.975 MHz,
//! 10500 symbols/s. The useful dial is 136.8125 MHz. The controller splits the
//! window into whichever channels it reaches and emits a message log plus a
//! station table twice a second.

use num_complex::Complex32;
use sdroxide_types::{
    Vdl2Settings, Vdl2Status, VDL2_GOOD_SPS, VDL2_MIN_RATE_HZ, VDL2_PLAN_CENTER_HZ,
};
use sdroxide_vdl2::{plan, window_covers, Vdl2Action, Vdl2Controller};
use serde_json::{json, Value};

use crate::config::DecoderConfig;

const UNAVAILABLE_INTERVAL_MS: i64 = 500;
const INV_U8_SCALE: f32 = 1.0 / 127.5;

pub(crate) struct Vdl2Channel {
    pub(crate) cfg: DecoderConfig,
    controller: Option<Vdl2Controller>,
    center_hz: f64,
    rate_hz: f64,
    degraded: Option<String>,
    unavailable: Option<String>,
    suggest_center_hz: Option<f64>,
    scratch: Vec<Complex32>,
    results: Vec<Value>,
    last_unavailable_ms: i64,
    dc_re: f32,
    dc_im: f32,
    dc_primed: bool,
    dc_alpha: f32,
}

impl Vdl2Channel {
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
            channel.suggest_center_hz = Some(VDL2_PLAN_CENTER_HZ);
            tracing::warn!(
                decoder = %cfg.id,
                center_hz,
                rate_hz,
                "VDL2 channel cannot run in this receiver window"
            );
            return channel;
        }

        let live = plan::channels_in_window(center_hz, rate_hz).len();
        if live < plan::CHANNELS.len() {
            channel.degraded = Some(format!(
                "Only {live} of {} VDL2 channels are in this receiver window; a wider \
                 profile hears the rest.",
                plan::CHANNELS.len()
            ));
        }

        channel.controller = Some(Vdl2Controller::new(
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
                    "channels": [],
                    "stations": [],
                    "messages": [],
                    "unavailable": self.unavailable,
                    "degraded": self.degraded,
                    "suggestCenterHz": self.suggest_center_hz,
                    "windowCenterHz": self.center_hz,
                    "windowRateHz": self.rate_hz,
                    "bursts": 0,
                    "syncs": 0,
                    "headers": 0,
                    "headerBad": 0,
                    "rsFail": 0,
                    "rsCorrected": 0,
                    "hdlcBad": 0,
                    "fecBypassed": 0,
                    "fcsBad": 0,
                    "frames": 0,
                    "multiblock": 0,
                    "multiblockOk": 0,
                    "samplesPerSymbol": 0.0,
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
            let Vdl2Action::Status(status) = action;
            self.results.push(status_json(&status, &self.degraded));
        }
    }
}

fn status_json(status: &Vdl2Status, fallback_degraded: &Option<String>) -> Value {
    let mut degraded = status
        .degraded
        .clone()
        .or_else(|| fallback_degraded.clone());
    if degraded.is_none()
        && status.samples_per_symbol > 0.0
        && f64::from(status.samples_per_symbol) < VDL2_GOOD_SPS
    {
        degraded = Some(format!(
            "VDL2 has only {:.1} samples per symbol; widen the profile for reliable \
             decoding.",
            status.samples_per_symbol
        ));
    }

    let messages: Vec<Value> = status
        .messages
        .iter()
        .map(|message| {
            let mut value = serde_json::to_value(message).unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                object.insert("summary".to_string(), json!(message.summary()));
                object.insert("srcHex".to_string(), json!(message.src_hex()));
                object.insert("dstHex".to_string(), json!(message.dst_hex()));
                object.insert("frameLabel".to_string(), json!(message.frame.label()));
            }
            value
        })
        .collect();

    json!({
        "channels": status.channels,
        "stations": status.stations,
        "messages": messages,
        "unavailable": status.unavailable,
        "degraded": degraded,
        "suggestCenterHz": status.suggest_center_hz,
        "windowCenterHz": status.window_center_hz,
        "windowRateHz": status.window_rate_hz,
        "bursts": status.bursts,
        "syncs": status.syncs,
        "headers": status.headers,
        "headerBad": status.header_bad,
        "rsFail": status.rs_fail,
        "rsCorrected": status.rs_corrected,
        "hdlcBad": status.hdlc_bad,
        "fecBypassed": status.fec_bypassed,
        "fcsBad": status.fcs_bad,
        "frames": status.frames,
        "multiblock": status.multiblock,
        "multiblockOk": status.multiblock_ok,
        "samplesPerSymbol": status.samples_per_symbol,
    })
}

fn unsupported_message(center_hz: f64, rate_hz: f64) -> String {
    if rate_hz < VDL2_MIN_RATE_HZ {
        format!(
            "VDL2 needs at least {:.0} kHz of stream; this receiver is running at \
             {:.0} kHz.",
            VDL2_MIN_RATE_HZ / 1e3,
            rate_hz / 1e3
        )
    } else {
        format!(
            "VDL2 needs a window covering 136.650–136.975 MHz; this receiver is \
             centred at {:.3} MHz with {:.0} kHz of span.",
            center_hz / 1e6,
            rate_hz / 1e3
        )
    }
}

fn settings_from_config(cfg: &DecoderConfig) -> Vdl2Settings {
    let mut settings = Vdl2Settings::default();
    let map = &cfg.settings;
    let u16_value = |keys: &[&str]| -> Option<u16> {
        keys.iter()
            .find_map(|key| map.get(*key))
            .and_then(Value::as_u64)
            .map(|v| v.min(u16::MAX as u64) as u16)
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

    if let Some(v) = u16_value(&["channels", "channelMask", "channel_mask"]) {
        settings.channels = v;
    }
    if let Some(v) = u8_value(&["thresholdDb", "threshold_db"]) {
        settings.threshold_db = v;
    }
    if let Some(v) = u16_value(&["dropListS", "drop_list_s"]) {
        settings.drop_list_s = v;
    }
    if let Some(v) = u16_value(&["maxStations", "max_stations"]) {
        settings.max_stations = v;
    }
    if let Some(v) = u16_value(&["maxMessages", "max_messages"]) {
        settings.max_messages = v;
    }
    if let Some(v) = bool_value(&["showOther", "show_other"]) {
        settings.show_other = v;
    }
    settings.sane()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DecoderConfig {
        DecoderConfig {
            id: "vdl2-136".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "vdl2".to_string(),
            frequency_hz: VDL2_PLAN_CENTER_HZ as i64,
            bandwidth_hz: 25_000,
            settings: Default::default(),
        }
    }

    #[test]
    fn a_window_over_the_wrong_band_reports_the_fix() {
        let channel = Vdl2Channel::new(&cfg(), 109_000_000.0, 2_400_000.0);
        assert!(channel.controller.is_none());
        assert!(channel.unavailable.as_deref().unwrap().contains("136.650"));
        assert_eq!(channel.suggest_center_hz, Some(VDL2_PLAN_CENTER_HZ));
    }

    #[test]
    fn a_too_narrow_window_reports_the_width() {
        let channel = Vdl2Channel::new(&cfg(), VDL2_PLAN_CENTER_HZ, 24_000.0);
        assert!(channel.controller.is_none());
        assert!(channel.unavailable.as_deref().unwrap().contains("34 kHz"));
    }

    #[test]
    fn a_partial_plan_is_degraded_but_runs() {
        let channel = Vdl2Channel::new(&cfg(), 136_650_000.0, 50_000.0);
        assert!(channel.controller.is_some());
        assert!(channel.degraded.as_deref().unwrap().contains("of"));
    }

    #[test]
    fn a_synthetic_vdl2_frame_reaches_the_snapshot() {
        use std::time::{Duration, Instant};

        use sdroxide_types::{Vdl2AddrKind, Vdl2Frame};
        use sdroxide_vdl2::avlc;
        use sdroxide_vdl2::tx::{modulate, Noise, TxParams};

        fn cu8(iq: &[Complex32]) -> Vec<u8> {
            let mut out = Vec::with_capacity(iq.len() * 2);
            for z in iq {
                for value in [z.re, z.im] {
                    out.push(((value * 127.5 + 127.5).round().clamp(0.0, 255.0)) as u8);
                }
            }
            out
        }

        let center = plan::CHANNELS[7].center_hz;
        let rate = 96_000.0;
        let mut channel = Vdl2Channel::new(&cfg(), center, rate);

        let frame = avlc::build(
            avlc::Address {
                addr: 0x10_A1_B2,
                kind: Vdl2AddrKind::GroundAdmin,
                cr: true,
            },
            avlc::Address {
                addr: 0x44_0F_31,
                kind: Vdl2AddrKind::Aircraft,
                cr: false,
            },
            avlc::control_octet(Vdl2Frame::Ui { pf: false }),
            b"\xff\xff\x01hello there",
        );
        let params = TxParams {
            sample_rate: rate,
            freq_offset_hz: 0.0,
            amplitude: 0.5,
            ..TxParams::default()
        };
        let mut signal = modulate(&frame, &params, 4000.0);
        Noise::new(0x5EED).add(&mut signal, 0.004);

        let mut quiet = vec![Complex32::default(); 40_000];
        Noise::new(7).add(&mut quiet, 0.004);

        channel.process_chunk(&cu8(&quiet), 1_000);
        for block in signal.chunks(4_000) {
            channel.process_chunk(&cu8(block), 1_100);
            std::thread::sleep(Duration::from_millis(2));
        }
        channel.process_chunk(&cu8(&quiet[..2_000]), 1_200);

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut found = false;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            channel.process_chunk(&cu8(&quiet[..2_000]), 1_300);
            for snapshot in channel.take_results() {
                if snapshot
                    .get("messages")
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
        assert!(found, "synthetic VDL2 transmission produced no message");
    }

    #[test]
    fn snapshot_shape_is_stable() {
        let mut channel = Vdl2Channel::new(&cfg(), 109_000_000.0, 2_400_000.0);
        channel.process_chunk(&[127, 127, 127, 127], 1_000);
        let value = channel.take_results().pop().unwrap();
        for key in [
            "channels",
            "stations",
            "messages",
            "unavailable",
            "degraded",
            "suggestCenterHz",
            "windowCenterHz",
            "windowRateHz",
            "bursts",
            "syncs",
            "headers",
            "headerBad",
            "frames",
            "fcsBad",
            "samplesPerSymbol",
        ] {
            assert!(value.get(key).is_some(), "snapshot missing {key}");
        }
    }
}
