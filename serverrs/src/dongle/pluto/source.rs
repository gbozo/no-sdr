//! PlutoSDR adapter for the manager's raw-IQ source contract.
//!
//! The Pluto is a network device even on USB: its gadget exposes IIOD on
//! TCP 30431. The sdroxide driver speaks that protocol directly and exposes
//! interleaved `f32` I/Q.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_pluto::PlutoHandle;
use sdroxide_types::{PlutoAgc, PlutoConfig};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::config::{DongleConfig, DongleProfile};
use crate::dongle::source::{CommandHandle, Source, SourceCommand};

const EMPTY_SLEEP: Duration = Duration::from_millis(2);
const READ_COMPONENTS: usize = 2 * 32 * 1024;

fn address_from(dcfg: &DongleConfig) -> String {
    let host = dcfg.source.host.trim();
    let host = if host.is_empty() { "192.168.2.1" } else { host };
    if dcfg.source.port > 0 {
        format!("{host}:{}", dcfg.source.port)
    } else {
        host.to_string()
    }
}

pub fn config_from_dongle(
    dcfg: &DongleConfig,
    _profile: &DongleProfile,
    sample_rate: u32,
) -> (String, PlutoConfig) {
    let settings = &dcfg.source.settings;
    let address = address_from(dcfg);
    let mut cfg = PlutoConfig {
        address: address.clone(),
        sample_rate_hz: sample_rate as f64,
        ..PlutoConfig::default()
    };
    if let Some(v) = setting_f64(settings, "rxGainDb") {
        cfg.rx_gain_db = v;
    } else if dcfg.gain > 0.0 {
        cfg.rx_gain_db = dcfg.gain;
    }
    if let Some(v) = setting_u8(settings, "agc") {
        cfg.agc = PlutoAgc::from_code(v as f64);
    }
    if let Some(v) = setting_f64(settings, "rfBandwidthHz") {
        cfg.rf_bandwidth_hz = v;
    }
    if let Some(v) = setting_str(settings, "rxPort") {
        cfg.rx_port = v.to_string();
    }
    if let Some(v) = setting_f64(settings, "ppm") {
        cfg.ppm = v;
    } else {
        cfg.ppm = dcfg.ppm as f64;
    }
    if let Some(v) = setting_u32(settings, "bufferSamples") {
        cfg.buffer_samples = v as usize;
    }
    cfg.full_duplex = false;
    (address, cfg)
}

pub struct PlutoSource {
    handle: Option<PlutoHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl PlutoSource {
    pub fn open(address: &str, cfg: PlutoConfig, center_hz: f64) -> Result<Self> {
        let handle = PlutoHandle::open(address, &cfg, center_hz)
            .with_context(|| format!("open Pluto at {address}"))?;
        let label = handle.label();
        let serial = handle.serial.clone();
        let rate_hz = handle.sample_rate_hz.round() as u32;
        info!(
            label = %label,
            serial = %serial,
            model = %handle.model,
            firmware = %handle.firmware,
            rate_hz,
            "pluto opened"
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
impl Source for PlutoSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("pluto source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("pluto source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("pluto read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "pluto read loop failed"),
            Err(e) => warn!(error = %e, "pluto read task failed"),
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
            format!("pluto ({})", self.label)
        } else {
            format!("pluto ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: PlutoHandle,
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
            warn!("pluto connection stopped");
            break;
        }
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SourceCommand::Raw { cmd, value } => apply_command(&mut handle, cmd, value),
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
            debug!("pluto output channel closed");
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

fn setting_u8(map: &serde_json::Map<String, Value>, key: &str) -> Option<u8> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u8::try_from(v).ok())
}

fn setting_u32(map: &serde_json::Map<String, Value>, key: &str) -> Option<u32> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
}

fn setting_str<'a>(map: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

fn apply_command(handle: &mut PlutoHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_rx_freq(value as f64),
        0x02 => debug!(
            value,
            "pluto: sample-rate change requires reopening the device"
        ),
        0x05 => handle.set_ppm(value as f64),
        0x30 => handle.set_rx_gain_db(value as f64 / 10.0),
        0x31 => handle.set_agc_mode(match value {
            0 => "manual",
            2 => "fast_attack",
            3 => "hybrid",
            _ => "slow_attack",
        }),
        0x0E => {
            if value != 0 {
                warn!("pluto: this source has no bias tee control");
            }
        }
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled pluto command"
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
    fn config_maps_address_and_gain() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.host = "pluto.local".into();
        dcfg.source
            .settings
            .insert("rxGainDb".into(), serde_json::json!(37.0));
        dcfg.source
            .settings
            .insert("agc".into(), serde_json::json!(1));
        dcfg.ppm = 4;
        let (address, cfg) = config_from_dongle(&dcfg, &DongleProfile::default(), 2_500_000);
        assert_eq!(address, "pluto.local");
        assert_eq!(cfg.sample_rate_hz, 2_500_000.0);
        assert_eq!(cfg.rx_gain_db, 37.0);
        assert_eq!(cfg.agc, PlutoAgc::SlowAttack);
        assert_eq!(cfg.ppm, 4.0);
    }
}
