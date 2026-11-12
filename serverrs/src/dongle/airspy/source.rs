//! Airspy R2 / Mini adapter for the manager's raw-IQ source contract.
//!
//! The sdroxide driver owns USB, the fs/4 host downconversion and the
//! half-band decimator; it exposes interleaved `f32` I/Q. Our pipeline still
//! takes unsigned 8-bit I/Q, so this adapter converts at the boundary.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_airspy::protocol::GainCurve;
use sdroxide_airspy::AirspyHandle;
use sdroxide_types::{AirspyConfig, AirspyGain};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::config::{DongleConfig, DongleProfile};
use crate::dongle::source::{CommandHandle, Source, SourceCommand};

const EMPTY_SLEEP: Duration = Duration::from_millis(2);
/// Interleaved f32 components read per pass.
const READ_COMPONENTS: usize = 2 * 32 * 1024;

pub fn config_from_dongle(
    dcfg: &DongleConfig,
    _profile: &DongleProfile,
    sample_rate: u32,
) -> AirspyConfig {
    let settings = &dcfg.source.settings;
    let mut cfg = AirspyConfig {
        serial: dcfg.source.serial.trim().to_string(),
        sample_rate_hz: sample_rate as f64,
        ..AirspyConfig::default()
    };

    if let Some(v) = setting_u8(settings, "gainStep") {
        cfg.gain_step = v;
    }
    if let Some(v) = setting_u8(settings, "gainCurve") {
        cfg.gain_curve = AirspyGain::from_code(v);
    }
    if let Some(v) = setting_bool(settings, "lnaAgc") {
        cfg.lna_agc = v;
    }
    if let Some(v) = setting_bool(settings, "mixerAgc") {
        cfg.mixer_agc = v;
    }
    if let Some(v) = setting_bool(settings, "packing") {
        cfg.packing = v;
    }
    if let Some(v) = setting_bool(settings, "dcBlock") {
        cfg.dc_block = v;
    }
    if let Some(v) = setting_u8(settings, "transfers") {
        cfg.transfers = v;
    }
    if let Some(v) = setting_u16(settings, "transferKib") {
        cfg.transfer_kib = v;
    }
    cfg.bias_tee = dcfg.bias_t;
    cfg
}

pub struct AirspySource {
    handle: Option<AirspyHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl AirspySource {
    pub fn open(cfg: AirspyConfig, center_hz: f64) -> Result<Self> {
        let handle = AirspyHandle::open(&cfg, center_hz)
            .with_context(|| format!("open Airspy (serial {:?})", cfg.serial))?;
        let label = handle.label.clone();
        let serial = handle.serial.clone().unwrap_or_default();
        let rate_hz = handle.sample_rate_hz.round() as u32;
        info!(
            label = %label,
            serial = %serial,
            firmware = %handle.firmware,
            rate_hz = handle.sample_rate_hz,
            rates = ?handle.rates_hz,
            "airspy opened"
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
impl Source for AirspySource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("airspy source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("airspy source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("airspy read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "airspy read loop failed"),
            Err(e) => warn!(error = %e, "airspy read task failed"),
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
            format!("local airspy ({})", self.label)
        } else {
            format!("local airspy ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: AirspyHandle,
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
            warn!("airspy stream thread stopped");
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
            debug!("airspy output channel closed");
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

fn setting_u8(map: &serde_json::Map<String, Value>, key: &str) -> Option<u8> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u8::try_from(v).ok())
}

fn setting_u16(map: &serde_json::Map<String, Value>, key: &str) -> Option<u16> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u16::try_from(v).ok())
}

fn setting_bool(map: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

fn apply_command(handle: &AirspyHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_center_hz(value as f64),
        0x02 => handle.set_rate_hz(value as f64),
        0x0E => handle.set_bias_tee(value != 0),
        0x30 => handle.set_gain_step(value.min(21) as u8),
        0x31 => handle.set_curve(match value {
            1 => GainCurve::Sensitivity,
            _ => GainCurve::Linearity,
        }),
        0x32 => handle.set_lna_agc(value != 0),
        0x33 => handle.set_mixer_agc(value != 0),
        0x34 => handle.set_dc_block(value != 0),
        // Airspy has no ppm register; the AirspyConfig has no correction field.
        0x05 => debug!(value, "airspy: ppm correction is not supported"),
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled airspy command"
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
    fn config_maps_gain_and_agc_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  abc123  ".into();
        dcfg.source
            .settings
            .insert("gainStep".into(), serde_json::json!(17));
        dcfg.source
            .settings
            .insert("gainCurve".into(), serde_json::json!(1));
        dcfg.source
            .settings
            .insert("lnaAgc".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("mixerAgc".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("dcBlock".into(), serde_json::json!(false));
        dcfg.bias_t = true;

        let cfg = config_from_dongle(&dcfg, &DongleProfile::default(), 6_000_000);
        assert_eq!(cfg.serial, "abc123");
        assert_eq!(cfg.sample_rate_hz, 6_000_000.0);
        assert_eq!(cfg.gain_step, 17);
        assert_eq!(cfg.gain_curve, AirspyGain::Sensitivity);
        assert!(cfg.lna_agc);
        assert!(cfg.mixer_agc);
        assert!(!cfg.dc_block);
        assert!(cfg.bias_tee);
    }
}
