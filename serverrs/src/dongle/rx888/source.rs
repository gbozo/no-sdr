//! RX-888 Mk2 adapter.
//!
//! The sdroxide driver owns the FX3 firmware upload, the LTC2208 GPIO and the
//! WOLA downconverter. It exposes interleaved `f32` complex I/Q at the DDC
//! output rate; this adapter converts that to the backend's unsigned 8-bit
//! stream.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_rx888::{Rx888Handle, Settings};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tracing::{debug, info, warn};

use crate::config::{DongleConfig, DongleProfile};
use crate::dongle::source::{CommandHandle, Source, SourceCommand};

const EMPTY_SLEEP: Duration = Duration::from_millis(2);
const READ_COMPONENTS: usize = 2 * 32 * 1024;
const DEFAULT_ADC_HZ: f64 = 64_800_000.0;
const DDC_BLOCK: u32 = 8192;

pub fn config_from_dongle(
    dcfg: &DongleConfig,
    _profile: &DongleProfile,
    sample_rate: u32,
) -> Settings {
    let settings = &dcfg.source.settings;
    let adc_rate = setting_f64(settings, "adcRateHz").unwrap_or(DEFAULT_ADC_HZ);
    let ddc_bins = setting_u32(settings, "ddcBins").unwrap_or_else(|| {
        ((sample_rate as f64 * DDC_BLOCK as f64 / adc_rate).round() as u32).clamp(256, 4096)
    });

    let mut cfg = Settings::default();
    cfg.serial = Some(dcfg.source.serial.trim().to_string()).filter(|s| !s.is_empty());
    cfg.adc_rate_hz = adc_rate;
    cfg.ddc_bins = ddc_bins as usize;
    cfg.dither = setting_bool(settings, "dither").unwrap_or(cfg.dither);
    cfg.randomize = setting_bool(settings, "randomize").unwrap_or(cfg.randomize);
    cfg.bias_tee_hf = dcfg.bias_t;
    cfg.bias_tee_vhf = setting_bool(settings, "biasTeeVhf").unwrap_or(false);
    cfg.pga = setting_bool(settings, "pga").unwrap_or(cfg.pga);
    cfg.attenuator_db = setting_f64(settings, "attenuatorDb").unwrap_or(cfg.attenuator_db);
    cfg.vga_db = setting_f64(settings, "vgaDb").unwrap_or(cfg.vga_db);
    cfg.ppm = setting_f64(settings, "ppm").unwrap_or(dcfg.ppm as f64);
    cfg.tuner_gain_db = setting_f64(settings, "tunerGainDb").unwrap_or(cfg.tuner_gain_db);
    cfg.tuner_agc = setting_bool(settings, "tunerAgc").unwrap_or(cfg.tuner_agc);
    cfg
}

pub struct Rx888Source {
    handle: Option<Rx888Handle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl Rx888Source {
    pub fn open(cfg: Settings, center_hz: f64) -> Result<Self> {
        let handle = sdroxide_rx888::spawn(&cfg, center_hz)
            .with_context(|| format!("open RX-888 (serial {:?})", cfg.serial))?;
        let label = handle.label().to_string();
        let serial = handle.serial().unwrap_or_default().to_string();
        let rate_hz = handle.out_rate_hz().round() as u32;
        info!(
            label = %label,
            serial = %serial,
            adc_hz = handle.adc_rate_hz(),
            out_hz = handle.out_rate_hz(),
            "rx888 opened"
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
impl Source for Rx888Source {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("rx888 source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("rx888 source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("rx888 read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "rx888 read loop failed"),
            Err(e) => warn!(error = %e, "rx888 read task failed"),
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
            format!("local rx888 ({})", self.label)
        } else {
            format!("local rx888 ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: Rx888Handle,
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
            warn!("rx888 stream thread stopped");
            break;
        }
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SourceCommand::Raw { cmd, value } => apply_command(&handle, cmd, value),
                SourceCommand::Close => return Ok(()),
            }
        }
        let n = handle.read(&mut fbuf);
        if n == 0 {
            std::thread::sleep(EMPTY_SLEEP);
            continue;
        }
        complex_to_u8(&fbuf[..n], &mut ubuf[..n]);
        if out.blocking_send(ubuf[..n].to_vec()).is_err() {
            debug!("rx888 output channel closed");
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

fn setting_u32(map: &serde_json::Map<String, Value>, key: &str) -> Option<u32> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
}

fn apply_command(handle: &Rx888Handle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_center_hz(value as f64),
        0x02 => debug!(
            value,
            "rx888: ADC/DDC rate change requires reopening the receiver"
        ),
        0x0E => handle.set_bias_tee(value != 0),
        0x30 => handle.set_vga_db(value as f64 / 10.0),
        0x31 => handle.set_att_db(-(value as f64 / 10.0)),
        0x32 => handle.set_dither(value != 0),
        0x33 => handle.set_pga(value != 0),
        0x34 => handle.set_tuner_gain_db(value as f64 / 10.0),
        0x35 => handle.set_tuner_agc(value != 0),
        0x36 => handle.set_bias_tee_vhf(value != 0),
        0x05 => debug!(value, "rx888: ppm is applied at open only"),
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled rx888 command"
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
    fn config_maps_rx888_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  rx1  ".into();
        dcfg.source
            .settings
            .insert("vgaDb".into(), serde_json::json!(21.0));
        dcfg.source
            .settings
            .insert("attenuatorDb".into(), serde_json::json!(-6.0));
        dcfg.source
            .settings
            .insert("pga".into(), serde_json::json!(false));
        dcfg.bias_t = true;
        let cfg = config_from_dongle(&dcfg, &DongleProfile::default(), 2_025_000);
        assert_eq!(cfg.serial.as_deref(), Some("rx1"));
        assert_eq!(cfg.vga_db, 21.0);
        assert_eq!(cfg.attenuator_db, -6.0);
        assert!(!cfg.pga);
        assert!(cfg.bias_tee_hf);
        assert_eq!(cfg.ddc_bins, 256);
    }
}
