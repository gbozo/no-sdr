//! Airspy HF+ adapter for the manager's raw-IQ source contract.
//!
//! The sdroxide driver owns USB, DC cancellation, IQ image balancing and the
//! fine-tuning NCO. It exposes interleaved `f32` I/Q; this adapter converts to
//! the unsigned 8-bit stream used by the rest of the backend.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_airspyhf::AirspyHfHandle;
use sdroxide_types::AirspyHfConfig;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::config::{DongleConfig, DongleProfile};
use crate::dongle::source::{CommandHandle, Source, SourceCommand};

const EMPTY_SLEEP: Duration = Duration::from_millis(2);
const READ_COMPONENTS: usize = 2 * 32 * 1024;

pub fn config_from_dongle(
    dcfg: &DongleConfig,
    _profile: &DongleProfile,
    sample_rate: u32,
) -> AirspyHfConfig {
    let settings = &dcfg.source.settings;
    let mut cfg = AirspyHfConfig {
        serial: dcfg.source.serial.trim().to_string(),
        sample_rate_hz: sample_rate as f64,
        ..AirspyHfConfig::default()
    };

    if let Some(v) = setting_bool(settings, "agc") {
        cfg.agc = v;
    }
    if let Some(v) = setting_bool(settings, "agcThresholdHigh") {
        cfg.agc_threshold_high = v;
    }
    if let Some(v) = setting_f64(settings, "attenuatorDb") {
        cfg.attenuator_db = v;
    }
    if let Some(v) = setting_bool(settings, "lna") {
        cfg.lna = v;
    }
    if let Some(v) = setting_i32(settings, "calibrationPpb") {
        cfg.calibration_ppb = Some(v);
    }
    if let Some(v) = setting_bool(settings, "libDsp") {
        cfg.lib_dsp = v;
    }
    cfg.bias_tee = dcfg.bias_t;
    cfg
}

pub struct AirspyHfSource {
    handle: Option<AirspyHfHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl AirspyHfSource {
    pub fn open(cfg: AirspyHfConfig, center_hz: f64) -> Result<Self> {
        let handle = AirspyHfHandle::open(&cfg, center_hz)
            .with_context(|| format!("open Airspy HF+ (serial {:?})", cfg.serial))?;
        let label = handle.label.clone();
        let serial = if handle.board_serial == 0 {
            String::new()
        } else {
            handle.board_serial.to_string()
        };
        let rate_hz = handle.sample_rate_hz.round() as u32;
        info!(
            label = %label,
            serial = %serial,
            model = ?handle.model,
            firmware = %handle.firmware,
            rate_hz,
            rates = ?handle.rates_hz,
            "airspyhf opened"
        );
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Ok(Self {
            handle: Some(handle),
            cmd_rx: Some(cmd_rx),
            cmd_handle: CommandHandle::new(cmd_tx),
            label,
            serial,
            rate_hz,
        })
    }
}

#[async_trait]
impl Source for AirspyHfSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("airspyhf source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("airspyhf source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("airspyhf read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "airspyhf read loop failed"),
            Err(e) => warn!(error = %e, "airspyhf read task failed"),
        }
    }

    fn command_handle(&self) -> Option<CommandHandle> {
        Some(self.cmd_handle.clone())
    }

    fn sample_rate_hz(&self) -> Option<u32> {
        Some(self.rate_hz)
    }

    fn description(&self) -> String {
        if self.serial.is_empty() {
            format!("local airspyhf ({})", self.label)
        } else {
            format!("local airspyhf ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: AirspyHfHandle,
    mut cmd_rx: mpsc::UnboundedReceiver<SourceCommand>,
    out: mpsc::Sender<Vec<u8>>,
    cancel: watch::Receiver<bool>,
) -> Result<()> {
    let mut fbuf = vec![0f32; READ_COMPONENTS];
    let mut ubuf = vec![0u8; READ_COMPONENTS];

    loop {
        if *cancel.borrow() {
            break;
        }
        if !handle.is_alive() {
            warn!("airspyhf stream thread stopped");
            break;
        }

        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SourceCommand::Raw { cmd, value } => apply_command(&handle, cmd, value),
                SourceCommand::Close => return Ok(()),
            }
        }

        let n = handle.rx_read(&mut fbuf);
        if n == 0 {
            std::thread::sleep(EMPTY_SLEEP);
            continue;
        }
        complex_to_u8(&fbuf[..n], &mut ubuf[..n]);
        if out.blocking_send(ubuf[..n].to_vec()).is_err() {
            debug!("airspyhf output channel closed");
            break;
        }
    }

    handle.release();
    Ok(())
}

fn complex_to_u8(input: &[f32], out: &mut [u8]) {
    for (dst, src) in out.iter_mut().zip(input) {
        *dst = ((src.clamp(-1.0, 1.0) * 127.5) + 127.5).round() as u8;
    }
}

fn setting_f64(map: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

fn setting_bool(map: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

fn setting_i32(map: &serde_json::Map<String, Value>, key: &str) -> Option<i32> {
    map.get(key)
        .and_then(Value::as_i64)
        .and_then(|v| i32::try_from(v).ok())
}

fn apply_command(handle: &AirspyHfHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_center_hz(value as f64),
        // HF+ sample rate is fixed at open (model/firmware dependent).
        0x02 => debug!(
            value,
            "airspyhf: rate change requires reopening the receiver"
        ),
        0x0E => handle.set_bias_tee(value != 0),
        0x30 => handle.set_agc(value != 0),
        0x31 => handle.set_agc_threshold(value != 0),
        // Attenuation is negative dB; the command carries magnitude tenths.
        0x32 => handle.set_attenuator_db(-(value as f64 / 10.0)),
        0x33 => handle.set_lna(value != 0),
        0x34 => handle.set_lib_dsp(value != 0),
        0x35 => handle.set_calibration_ppb(value as i32),
        0x05 => debug!(value, "airspyhf: ppm correction is not supported"),
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled airspyhf command"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complex_floats_convert_to_offset_binary() {
        let input = [-1.0f32, 0.0, 1.0, 0.5, -0.5, 0.0];
        let mut out = [0u8; 6];
        complex_to_u8(&input, &mut out);
        assert_eq!(out, [0, 128, 255, 191, 64, 128]);
    }

    #[test]
    fn config_maps_hf_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  hf123  ".into();
        dcfg.source
            .settings
            .insert("agc".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("agcThresholdHigh".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("attenuatorDb".into(), serde_json::json!(-18.0));
        dcfg.source
            .settings
            .insert("lna".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("calibrationPpb".into(), serde_json::json!(-250));
        dcfg.source
            .settings
            .insert("libDsp".into(), serde_json::json!(false));
        dcfg.bias_t = true;

        let cfg = config_from_dongle(&dcfg, &DongleProfile::default(), 768_000);
        assert_eq!(cfg.serial, "hf123");
        assert_eq!(cfg.sample_rate_hz, 768_000.0);
        assert!(cfg.agc);
        assert!(cfg.agc_threshold_high);
        assert_eq!(cfg.attenuator_db, -18.0);
        assert!(cfg.lna);
        assert_eq!(cfg.calibration_ppb, Some(-250));
        assert!(!cfg.lib_dsp);
        assert!(cfg.bias_tee);
    }
}
