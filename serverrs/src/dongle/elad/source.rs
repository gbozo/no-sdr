//! ELAD FDM-DUO / FDM-S2 / FDM-S1 adapter.
//!
//! The sdroxide driver selects the FPGA image for the configured rate at open,
//! then exposes interleaved `f32` I/Q. Rate changes therefore require a reopen;
//! controls that can change live are the 12 dB attenuator and preselector.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_elad::EladHandle;
use sdroxide_types::EladConfig;
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
) -> EladConfig {
    let settings = &dcfg.source.settings;
    let mut cfg = EladConfig {
        serial: dcfg.source.serial.trim().to_string(),
        sample_rate_hz: sample_rate,
        ..EladConfig::default()
    };
    if let Some(v) = setting_bool(settings, "attenuator") {
        cfg.attenuator = v;
    }
    if let Some(v) = setting_bool(settings, "preselector") {
        cfg.preselector = v;
    }
    cfg
}

pub struct EladSource {
    handle: Option<EladHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl EladSource {
    pub fn open(cfg: EladConfig, center_hz: f64) -> Result<Self> {
        let handle = EladHandle::open(&cfg, center_hz)
            .with_context(|| format!("open ELAD (serial {:?})", cfg.serial))?;
        let label = handle.label.clone();
        let serial = handle.serial.clone().unwrap_or_default();
        let rate_hz = handle.sample_rate_hz.round() as u32;
        info!(
            label = %label,
            serial = %serial,
            model = ?handle.model,
            firmware = ?handle.firmware,
            rate_hz,
            "elad opened"
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
impl Source for EladSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("elad source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("elad source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("elad read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "elad read loop failed"),
            Err(e) => warn!(error = %e, "elad read task failed"),
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
            format!("local elad ({})", self.label)
        } else {
            format!("local elad ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: EladHandle,
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
            warn!("elad stream thread stopped");
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
            debug!("elad output channel closed");
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

fn setting_bool(map: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

fn apply_command(handle: &EladHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_center_hz(value as f64),
        // The sample rate is the FPGA image, chosen at open.
        0x02 => debug!(value, "elad: rate change requires reopening the receiver"),
        0x0E => {
            if value != 0 {
                warn!("elad: this receiver has no bias tee");
            }
        }
        0x30 => handle.set_attenuator(value != 0),
        0x31 => handle.set_preselector(value != 0),
        _ => debug!(cmd = format!("{cmd:#04x}"), value, "unhandled elad command"),
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
    fn config_maps_elad_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  elad1  ".into();
        dcfg.source
            .settings
            .insert("attenuator".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("preselector".into(), serde_json::json!(false));
        let cfg = config_from_dongle(&dcfg, &DongleProfile::default(), 1_536_000);
        assert_eq!(cfg.serial, "elad1");
        assert_eq!(cfg.sample_rate_hz, 1_536_000);
        assert!(cfg.attenuator);
        assert!(!cfg.preselector);
    }
}
