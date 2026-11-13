//! ISM-band sensor and meter decoder.
//!
//! `sdroxide-ism` owns the channel plan, burst gate, protocol decoders and
//! device table. This adapter feeds it the raw device window and serialises its
//! reports for the client. The embedded rtl_433 lane is not compiled in here;
//! the native decoders are pure Rust.

use num_complex::Complex32;
use sdroxide_ism::{IsmAction, IsmController};
use sdroxide_types::{IsmReport, IsmSettings, IsmStatus};
use serde_json::{json, Value};

use crate::config::DecoderConfig;

const INV_U8_SCALE: f32 = 1.0 / 127.5;

pub(crate) struct IsmChannel {
    pub(crate) cfg: DecoderConfig,
    controller: IsmController,
    results: Vec<Value>,
    scratch: Vec<Complex32>,
    dc_re: f32,
    dc_im: f32,
    dc_primed: bool,
    dc_alpha: f32,
}

impl IsmChannel {
    pub(crate) fn new(cfg: &DecoderConfig, center_hz: f64, rate_hz: f64) -> Self {
        let rate_hz = rate_hz.max(1.0);
        let mut settings = IsmSettings::default();
        settings.enabled = true;
        // Enable every native family. rtl_433 is not compiled into this
        // build, so leave that lane off rather than advertising a window it
        // cannot fill.
        settings.families = u32::MAX;
        settings.rtl433.bands = 0;
        if let Some(threshold) = cfg.settings.get("thresholdDb").and_then(Value::as_i64) {
            settings.threshold_db = threshold.clamp(0, i16::MAX as i64) as i16;
        }
        if let Some(max) = cfg.settings.get("maxDevices").and_then(Value::as_u64) {
            settings.max_devices = max.min(u16::MAX as u64) as u16;
        }

        let controller = IsmController::new(center_hz, rate_hz, settings, String::new());
        Self {
            cfg: cfg.clone(),
            controller,
            results: Vec::new(),
            scratch: Vec::new(),
            dc_re: 0.0,
            dc_im: 0.0,
            dc_primed: false,
            dc_alpha: (1.0 - (-std::f64::consts::TAU * 10.0 / rate_hz).exp()) as f32,
        }
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.results)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], _now_ms: i64) {
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

        self.controller.on_rx_iq(&self.scratch);
        for action in self.controller.poll() {
            match action {
                IsmAction::Reports(devices) => self.results.push(json!({
                    "kind": "reports",
                    "devices": devices.iter().map(report_json).collect::<Vec<_>>(),
                })),
                IsmAction::Status(status) => {
                    self.results.push(status_json(&status));
                }
            }
        }
    }
}

fn report_json(report: &IsmReport) -> Value {
    json!({
        "id": report.id,
        "protocol": report.protocol.label(),
        "kind": report.fmt_kind(),
        "model": report.model,
        "device": report.device,
        "freqHz": report.freq_hz,
        "snrDb": report.snr_db,
        "firstAt": report.first_at,
        "lastAt": report.last_at,
        "count": report.count,
        "readings": report.readings.iter().map(|r| json!({
            "quantity": r.quantity.label(),
            "value": r.value,
            "unit": r.quantity.unit(),
            "decimals": r.quantity.decimals(),
        })).collect::<Vec<_>>(),
        "readingsText": report.fmt_readings(),
        "extra": report.extra,
        "encrypted": report.encrypted,
        "rawHex": report.raw_hex,
    })
}

fn status_json(status: &IsmStatus) -> Value {
    json!({
        "kind": "status",
        "channels": status.channels.iter().map(|c| json!({
            "freqHz": c.freq_hz,
            "label": c.label,
            "live": c.live,
            "reason": c.reason,
        })).collect::<Vec<_>>(),
        "unavailable": status.unavailable,
        "suggestCenterHz": status.suggest_center_hz,
        "bursts": status.bursts,
        "decodes": status.decodes,
        "windowCenterHz": status.window_center_hz,
        "windowRateHz": status.window_rate_hz,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_builds_for_a_wide_window() {
        let cfg = DecoderConfig {
            id: "ism-test".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "ism".into(),
            frequency_hz: 868_950_000,
            bandwidth_hz: 2_000_000,
            ..DecoderConfig::default()
        };
        let _channel = IsmChannel::new(&cfg, 868_950_000.0, 2_400_000.0);
    }
}
