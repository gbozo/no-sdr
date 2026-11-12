//! HydraSDR RFOne adapter for the manager's raw-IQ source contract.
//!
//! The RFOne is an Airspy R2 fork: the host conversion is shared, but the USB
//! id, tuning command and three RF ports differ. The sdroxide driver handles
//! all of that and exposes interleaved `f32` I/Q.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_hydrasdr::protocol::{GainCurve, RfPort};
use sdroxide_hydrasdr::HydraSdrHandle;
use sdroxide_types::{HydraSdrConfig, HydraSdrGain};
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
) -> HydraSdrConfig {
    let settings = &dcfg.source.settings;
    let mut cfg = HydraSdrConfig {
        serial: dcfg.source.serial.trim().to_string(),
        sample_rate_hz: sample_rate as f64,
        ..HydraSdrConfig::default()
    };
    if let Some(v) = setting_u8(settings, "gainStep") {
        cfg.gain_step = v;
    }
    if let Some(v) = setting_u8(settings, "gainCurve") {
        cfg.gain_curve = HydraSdrGain::from_code(v);
    }
    if let Some(v) = setting_bool(settings, "lnaAgc") {
        cfg.lna_agc = v;
    }
    if let Some(v) = setting_bool(settings, "mixerAgc") {
        cfg.mixer_agc = v;
    }
    if let Some(v) = setting_u8(settings, "rfPort") {
        cfg.rf_port = match v {
            1 => sdroxide_types::HydraSdrPort::Cable1,
            2 => sdroxide_types::HydraSdrPort::Cable2,
            _ => sdroxide_types::HydraSdrPort::Ant,
        };
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

pub struct HydraSdrSource {
    handle: Option<HydraSdrHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl HydraSdrSource {
    pub fn open(cfg: HydraSdrConfig, center_hz: f64) -> Result<Self> {
        let handle = HydraSdrHandle::open(&cfg, center_hz)
            .with_context(|| format!("open HydraSDR (serial {:?})", cfg.serial))?;
        let label = handle.label.clone();
        let serial = handle.serial.clone().unwrap_or_default();
        let rate_hz = handle.sample_rate_hz.round() as u32;
        info!(
            label = %label,
            serial = %serial,
            firmware = %handle.firmware,
            rate_hz,
            "hydrasdr opened"
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
impl Source for HydraSdrSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("hydrasdr source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("hydrasdr source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("hydrasdr read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "hydrasdr read loop failed"),
            Err(e) => warn!(error = %e, "hydrasdr read task failed"),
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
            format!("local hydrasdr ({})", self.label)
        } else {
            format!("local hydrasdr ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: HydraSdrHandle,
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
            warn!("hydrasdr stream thread stopped");
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
            debug!("hydrasdr output channel closed");
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

fn apply_command(handle: &HydraSdrHandle, cmd: u8, value: u32) {
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
        0x35 => handle.set_rf_port(match value {
            1 => RfPort::Cable1,
            2 => RfPort::Cable2,
            _ => RfPort::Ant,
        }),
        0x05 => debug!(value, "hydrasdr: ppm correction is not supported"),
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled hydrasdr command"
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
    fn config_maps_port_and_gain() {
        let mut dcfg = DongleConfig::default();
        dcfg.source
            .settings
            .insert("gainStep".into(), serde_json::json!(15));
        dcfg.source
            .settings
            .insert("gainCurve".into(), serde_json::json!(1));
        dcfg.source
            .settings
            .insert("rfPort".into(), serde_json::json!(2));
        dcfg.source
            .settings
            .insert("lnaAgc".into(), serde_json::json!(true));
        let cfg = config_from_dongle(&dcfg, &DongleProfile::default(), 10_000_000);
        assert_eq!(cfg.sample_rate_hz, 10_000_000.0);
        assert_eq!(cfg.gain_step, 15);
        assert_eq!(cfg.gain_curve, HydraSdrGain::Sensitivity);
        assert_eq!(cfg.rf_port, sdroxide_types::HydraSdrPort::Cable2);
        assert!(cfg.lna_agc);
    }
}
