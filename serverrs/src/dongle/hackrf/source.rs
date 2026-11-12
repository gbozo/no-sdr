//! HackRF adapter for the manager's raw-IQ source contract.
//!
//! The sdroxide driver already owns the USB thread and its control coalescing.
//! This module only does three things: map our config onto `HackRfConfig`,
//! translate the rtl_tcp-style opcodes into HackRF setters, and convert the
//! driver's signed 8-bit I/Q into the unsigned 8-bit stream the rest of the
//! backend expects.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_hackrf::protocol::GainSetter;
use sdroxide_hackrf::HackRfHandle;
use sdroxide_types::HackRfConfig;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::config::{DongleConfig, DongleProfile};
use crate::dongle::source::{CommandHandle, Source, SourceCommand};

/// How long to sleep when the driver's ring is momentarily empty.
const EMPTY_SLEEP: Duration = Duration::from_millis(2);

/// Read size. HackRF delivers one byte per I/Q component.
const READ_BYTES: usize = 64 * 1024;

/// Build the driver config from the dongle, profile and resolved sample rate.
pub fn config_from_dongle(
    dcfg: &DongleConfig,
    profile: &DongleProfile,
    sample_rate: u32,
) -> HackRfConfig {
    let settings = &dcfg.source.settings;
    let mut cfg = HackRfConfig {
        serial: dcfg.source.serial.trim().to_string(),
        sample_rate_hz: sample_rate as f64,
        ..HackRfConfig::default()
    };

    if let Some(v) = setting_f64(settings, "lnaDb") {
        cfg.lna_db = v;
    }
    if let Some(v) = setting_f64(settings, "vgaDb") {
        cfg.vga_db = v;
    }
    if let Some(v) = setting_bool(settings, "amp") {
        cfg.amp = v;
    }
    if let Some(v) = setting_f64(settings, "filterBwHz") {
        cfg.filter_bw_hz = v;
    }
    if let Some(v) = setting_f64(settings, "ppm") {
        cfg.ppm = v;
    } else {
        cfg.ppm = dcfg.ppm as f64;
    }
    if let Some(v) = setting_u8(settings, "transfers") {
        cfg.transfers = v;
    }
    if let Some(v) = setting_u16(settings, "transferKib") {
        cfg.transfer_kib = v;
    }

    cfg.bias_tee = dcfg.bias_t;
    cfg.iq_correction = dcfg.iq_correction;
    // This backend is receive-only; never arm the transmitter.
    cfg.tx_enabled = false;

    // A single profile/dongle gain maps to the baseband VGA; LNA stays at the
    // driver default unless the operator sets it explicitly.
    if !settings.contains_key("vgaDb") {
        if profile.gain > 0.0 {
            cfg.vga_db = profile.gain;
        } else if dcfg.gain > 0.0 {
            cfg.vga_db = dcfg.gain;
        }
    }
    cfg
}

/// A locally attached HackRF.
pub struct HackRfSource {
    handle: Option<HackRfHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl HackRfSource {
    pub fn open(cfg: HackRfConfig, center_hz: f64) -> Result<Self> {
        let handle = HackRfHandle::open(&cfg, center_hz)
            .with_context(|| format!("open HackRF (serial {:?})", cfg.serial))?;
        let label = handle.label.clone();
        let serial = handle.serial.clone().unwrap_or_default();
        let rate_hz = handle.sample_rate_hz.round() as u32;
        info!(
            label = %label,
            serial = %serial,
            board = ?handle.kind,
            firmware = %handle.firmware,
            rate_hz = handle.sample_rate_hz,
            "hackrf opened"
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
impl Source for HackRfSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("hackrf source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("hackrf source has no command channel");
            return;
        };

        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("hackrf read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "hackrf read loop failed"),
            Err(e) => warn!(error = %e, "hackrf read task failed"),
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
            format!("local hackrf ({})", self.label)
        } else {
            format!("local hackrf ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: HackRfHandle,
    mut cmd_rx: mpsc::UnboundedReceiver<SourceCommand>,
    out: mpsc::Sender<Vec<u8>>,
    cancel: watch::Receiver<bool>,
) -> Result<()> {
    let mut buf = vec![0u8; READ_BYTES];

    loop {
        if *cancel.borrow() {
            break;
        }
        if !handle.is_alive() {
            warn!("hackrf stream thread stopped");
            break;
        }

        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SourceCommand::Raw { cmd, value } => apply_command(&handle, cmd, value),
                SourceCommand::Close => return Ok(()),
            }
        }

        let n = handle.rx_read(&mut buf);
        if n == 0 {
            std::thread::sleep(EMPTY_SLEEP);
            continue;
        }

        // HackRF's wire format is signed 8-bit. The FFT/IQ pipeline expects
        // offset-binary unsigned 8-bit centred at 127.5.
        signed_to_offset_binary(&mut buf[..n]);
        if out.blocking_send(buf[..n].to_vec()).is_err() {
            debug!("hackrf output channel closed");
            break;
        }
    }

    handle.release();
    Ok(())
}

/// Map signed `i8` samples carried in `u8` to offset-binary unsigned bytes.
fn signed_to_offset_binary(bytes: &mut [u8]) {
    for b in bytes {
        *b ^= 0x80;
    }
}

fn setting_f64(map: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

fn setting_bool(map: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
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

/// Map the shared rtl_tcp-style opcodes plus HackRF-specific ones.
fn apply_command(handle: &HackRfHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_center_hz(value as f64),
        0x02 => handle.set_rate_hz(value as f64),
        0x05 => handle.set_ppm(value as f64),
        0x0E => {
            if handle.has_bias_tee {
                handle.set_bias_tee(value != 0);
            } else if value != 0 {
                warn!("hackrf: this board has no bias tee");
            }
        }
        // HackRF-specific gain stages. Values are tenths of a dB.
        0x30 => handle.set_gain(GainSetter::Lna, value as f64 / 10.0),
        0x31 => handle.set_gain(GainSetter::Vga, value as f64 / 10.0),
        0x32 => handle.set_amp(false, value != 0),
        0x33 => handle.set_filter_bw_hz(value as f64),
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled hackrf command"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signed_samples_become_offset_binary() {
        let mut bytes = vec![0x80u8, 0x00, 0x7f, 0xff];
        signed_to_offset_binary(&mut bytes);
        assert_eq!(bytes, vec![0x00, 0x80, 0xff, 0x7f]);
    }

    #[test]
    fn config_maps_hardware_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  abc123  ".into();
        dcfg.source.settings.insert("lnaDb".into(), json!(24.0));
        dcfg.source.settings.insert("vgaDb".into(), json!(30.0));
        dcfg.source.settings.insert("amp".into(), json!(true));
        dcfg.source
            .settings
            .insert("filterBwHz".into(), json!(8_000_000.0));
        dcfg.bias_t = true;
        dcfg.ppm = 7;
        dcfg.iq_correction = false;
        let profile = DongleProfile {
            gain: 12.0,
            ..DongleProfile::default()
        };

        let cfg = config_from_dongle(&dcfg, &profile, 2_000_000);
        assert_eq!(cfg.serial, "abc123");
        assert_eq!(cfg.sample_rate_hz, 2_000_000.0);
        assert_eq!(cfg.lna_db, 24.0);
        assert_eq!(cfg.vga_db, 30.0);
        assert!(cfg.amp);
        assert_eq!(cfg.filter_bw_hz, 8_000_000.0);
        assert!(cfg.bias_tee);
        assert_eq!(cfg.ppm, 7.0);
        assert!(!cfg.iq_correction);
        assert!(!cfg.tx_enabled);
    }

    #[test]
    fn single_gain_maps_to_vga_not_lna() {
        let dcfg = DongleConfig::default();
        let profile = DongleProfile {
            gain: 20.0,
            ..DongleProfile::default()
        };
        let cfg = config_from_dongle(&dcfg, &profile, 2_000_000);
        assert_eq!(cfg.vga_db, 20.0);
        assert_eq!(cfg.lna_db, HackRfConfig::default().lna_db);
    }
}
