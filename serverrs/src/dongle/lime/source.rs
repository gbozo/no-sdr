//! LimeSDR adapter for the manager's raw-IQ source contract.
//!
//! `sdroxide-lime` finds LimeSuite with `dlopen` at runtime, so this backend
//! builds without LimeSuite installed and reports the missing library at open
//! time. LimeSuite delivers interleaved `Complex32`; this adapter converts it
//! to the unsigned 8-bit I/Q stream used by the FFT and per-client extractors.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use num_complex::Complex32;
use sdroxide_lime::LimeHandle;
use sdroxide_types::LimeConfig;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::config::{DongleConfig, DongleProfile};
use crate::dongle::source::{CommandHandle, Source, SourceCommand};

const EMPTY_SLEEP: Duration = Duration::from_millis(2);
/// Complex samples read per pass.
const READ_COMPLEX: usize = 32 * 1024;

pub fn config_from_dongle(
    dcfg: &DongleConfig,
    profile: &DongleProfile,
    sample_rate: u32,
) -> LimeConfig {
    let settings = &dcfg.source.settings;
    let mut cfg = LimeConfig {
        device: setting_str(settings, "device")
            .unwrap_or(dcfg.source.serial.as_str())
            .trim()
            .to_string(),
        sample_rate_hz: sample_rate as f64,
        ..LimeConfig::default()
    };

    if let Some(v) = setting_u8(settings, "channel") {
        cfg.channel = v;
    }
    if let Some(v) = setting_u8(settings, "oversample") {
        cfg.oversample = v;
    }
    let gain = setting_f64(settings, "rxGainDb")
        .or_else(|| (profile.gain > 0.0).then_some(profile.gain))
        .or_else(|| (dcfg.gain > 0.0).then_some(dcfg.gain));
    if let Some(v) = gain {
        cfg.rx_gain_db = v.clamp(LimeConfig::GAIN_MIN_DB, LimeConfig::GAIN_MAX_DB);
    }
    if let Some(v) = setting_str(settings, "antennaRx") {
        cfg.antenna_rx = v.to_string();
    }
    if let Some(v) = setting_f64(settings, "lpfRxHz") {
        cfg.lpf_rx_hz = v;
    }
    if let Some(v) = setting_bool(settings, "calibrate") {
        cfg.calibrate = v;
    }
    if let Some(v) = setting_bool(settings, "iqCorrection") {
        cfg.iq_correction = v;
    } else {
        cfg.iq_correction = dcfg.iq_correction;
    }
    if let Some(v) = setting_u32(settings, "fifoKsamples") {
        cfg.fifo_ksamples = v;
    }
    if let Some(v) = setting_f32(settings, "throughputVsLatency") {
        cfg.throughput_vs_latency = v.clamp(0.0, 1.0);
    }

    // This backend is receive-only. Never arm the transmitter.
    cfg.tx_enabled = false;
    cfg
}

/// A locally attached LimeSDR.
pub struct LimeSource {
    handle: Option<LimeHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl LimeSource {
    pub fn open(cfg: LimeConfig, center_hz: f64) -> Result<Self> {
        let handle = LimeHandle::open(&cfg, center_hz)
            .with_context(|| format!("open LimeSDR (device {:?})", cfg.device))?;
        let label = handle.label().to_string();
        let info = handle.info();
        let serial = info.serial.clone();
        let rate_hz = handle.sample_rate().round() as u32;
        info!(
            label = %label,
            serial = %serial,
            board = %info.name,
            firmware = %info.firmware,
            rate_hz,
            analog_bw_hz = handle.analog_bw(),
            channel = handle.channel(),
            "limesdr opened"
        );
        if cfg.tx_enabled {
            warn!("LimeSDR transmit is disabled in this WebSDR build");
        }
        if let Some(note) = handle.status_note() {
            warn!("LimeSDR: {note}");
        }

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
impl Source for LimeSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("limesdr source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("limesdr source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("limesdr read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "limesdr read loop failed"),
            Err(e) => warn!(error = %e, "limesdr read task failed"),
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
            format!("local limesdr ({})", self.label)
        } else {
            format!("local limesdr ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: LimeHandle,
    mut cmd_rx: mpsc::UnboundedReceiver<SourceCommand>,
    out: mpsc::Sender<Vec<u8>>,
    cancel: watch::Receiver<bool>,
) -> Result<()> {
    let mut cbuf = vec![Complex32::new(0.0, 0.0); READ_COMPLEX];
    let mut ubuf = vec![0u8; READ_COMPLEX * 2];

    loop {
        if *cancel.borrow() {
            break;
        }
        if handle.needs_reopen() {
            warn!("limesdr stream stopped and could not be restarted");
            break;
        }

        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SourceCommand::Raw { cmd, value } => apply_command(&mut handle, cmd, value),
                SourceCommand::Close => return Ok(()),
            }
        }

        let n = match handle.read_within(&mut cbuf, 200) {
            Ok(n) => n,
            Err(e) => {
                warn!(error = %e, "limesdr read failed");
                break;
            }
        };
        if n == 0 {
            std::thread::sleep(EMPTY_SLEEP);
            continue;
        }
        complex_to_u8(&cbuf[..n], &mut ubuf[..n * 2]);
        if out.blocking_send(ubuf[..n * 2].to_vec()).is_err() {
            debug!("limesdr output channel closed");
            break;
        }
    }

    handle.close();
    Ok(())
}

fn complex_to_u8(input: &[Complex32], out: &mut [u8]) {
    for (chunk, sample) in out.chunks_exact_mut(2).zip(input) {
        chunk[0] = ((sample.re.clamp(-1.0, 1.0) * 127.5) + 127.5).round() as u8;
        chunk[1] = ((sample.im.clamp(-1.0, 1.0) * 127.5) + 127.5).round() as u8;
    }
}

fn setting_bool(map: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

fn setting_f32(map: &serde_json::Map<String, Value>, key: &str) -> Option<f32> {
    map.get(key).and_then(Value::as_f64).map(|v| v as f32)
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

fn apply_command(handle: &mut LimeHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => {
            if let Err(e) = handle.set_center_hz(value as f64) {
                warn!(error = %e, "limesdr retune failed");
            }
        }
        0x02 => debug!(
            value,
            "limesdr: sample-rate change requires reopening the device"
        ),
        0x30 => {
            if let Err(e) = handle.set_gain_db(false, value as f64 / 10.0) {
                warn!(error = %e, "limesdr gain change failed");
            }
        }
        0x31 => {
            if let Err(e) = handle.calibrate() {
                warn!(error = %e, "limesdr calibration failed");
            }
        }
        0x05 => debug!(value, "limesdr: ppm correction is not supported"),
        0x0E => {
            if value != 0 {
                warn!("limesdr: this source has no bias tee control");
            }
        }
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled limesdr command"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complex_samples_convert_to_offset_binary() {
        let input = [
            Complex32::new(-1.0, 0.0),
            Complex32::new(1.0, 0.5),
            Complex32::new(-0.5, 0.0),
        ];
        let mut out = [0u8; 6];
        complex_to_u8(&input, &mut out);
        assert_eq!(out, [0, 128, 255, 191, 64, 128]);
    }

    #[test]
    fn config_maps_lime_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  LimeSDR-USB, serial=abc  ".into();
        dcfg.source
            .settings
            .insert("channel".into(), serde_json::json!(1));
        dcfg.source
            .settings
            .insert("oversample".into(), serde_json::json!(4));
        dcfg.source
            .settings
            .insert("rxGainDb".into(), serde_json::json!(32.0));
        dcfg.source
            .settings
            .insert("antennaRx".into(), serde_json::json!("LNAL"));
        dcfg.source
            .settings
            .insert("lpfRxHz".into(), serde_json::json!(5_000_000.0));
        dcfg.source
            .settings
            .insert("calibrate".into(), serde_json::json!(false));
        dcfg.source
            .settings
            .insert("iqCorrection".into(), serde_json::json!(false));
        dcfg.source
            .settings
            .insert("fifoKsamples".into(), serde_json::json!(512));
        dcfg.source
            .settings
            .insert("throughputVsLatency".into(), serde_json::json!(0.25));

        let cfg = config_from_dongle(&dcfg, &DongleProfile::default(), 10_000_000);
        assert_eq!(cfg.device, "LimeSDR-USB, serial=abc");
        assert_eq!(cfg.sample_rate_hz, 10_000_000.0);
        assert_eq!(cfg.channel, 1);
        assert_eq!(cfg.oversample, 4);
        assert_eq!(cfg.rx_gain_db, 32.0);
        assert_eq!(cfg.antenna_rx, "LNAL");
        assert_eq!(cfg.lpf_rx_hz, 5_000_000.0);
        assert!(!cfg.calibrate);
        assert!(!cfg.iq_correction);
        assert_eq!(cfg.fifo_ksamples, 512);
        assert_eq!(cfg.throughput_vs_latency, 0.25);
        assert!(!cfg.tx_enabled);
    }
}
