//! SDRplay RSP adapter for the manager's raw-IQ source contract.
//!
//! The RSP family is driven through SDRplay's closed `sdrplay_api` service.
//! `sdroxide-sdrplay` loads that library with `dlopen` at runtime, so this
//! backend compiles and ships without the vendor API installed and reports a
//! useful error when it is missing. Samples arrive as interleaved `f32` I/Q
//! and are converted to the unsigned 8-bit format the rest of the pipeline
//! expects.

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_sdrplay::SdrPlayHandle;
use sdroxide_types::{SdrPlayAgc, SdrPlayConfig, SdrPlayDuoTuner, SdrPlayHdrBw};
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
) -> SdrPlayConfig {
    let settings = &dcfg.source.settings;
    let mut cfg = SdrPlayConfig {
        serial: dcfg.source.serial.trim().to_string(),
        sample_rate_hz: sample_rate as f64,
        ..SdrPlayConfig::default()
    };

    if let Some(v) = setting_u32(settings, "bwKhz") {
        cfg.bw_khz = v;
    }
    if let Some(v) = setting_bool(settings, "extendedIfGr") {
        cfg.extended_if_gr = v;
    }
    if let Some(v) = setting_i64(settings, "ifGrDb") {
        let floor = if cfg.extended_if_gr {
            SdrPlayConfig::IF_GR_MIN_EXTENDED
        } else {
            SdrPlayConfig::IF_GR_MIN
        };
        cfg.if_gr_db = v.clamp(i64::from(floor), i64::from(SdrPlayConfig::IF_GR_MAX)) as i32;
    }
    if let Some(v) = setting_u8(settings, "lnaState") {
        cfg.lna_state = v;
    }
    if let Some(v) = setting_u8(settings, "agc") {
        cfg.agc = SdrPlayAgc::from_code(v as f64);
    }
    if let Some(v) = setting_i64(settings, "agcSetpointDbfs") {
        cfg.agc_setpoint_dbfs = v as i32;
    }
    if let Some(v) = setting_f64(settings, "ppm") {
        cfg.ppm = v;
    } else {
        cfg.ppm = dcfg.ppm as f64;
    }
    if let Some(v) = setting_bool(settings, "rfNotch") {
        cfg.rf_notch = v;
    }
    if let Some(v) = setting_bool(settings, "dabNotch") {
        cfg.dab_notch = v;
    }
    if let Some(v) = setting_str(settings, "antenna") {
        cfg.antenna = v.to_string();
    }
    if let Some(v) = setting_u8(settings, "duoTuner") {
        cfg.duo_tuner = if v == 1 {
            SdrPlayDuoTuner::Tuner2
        } else {
            SdrPlayDuoTuner::Tuner1
        };
    }
    if let Some(v) = setting_bool(settings, "hdr") {
        cfg.hdr = v;
    }
    if let Some(v) = setting_u8(settings, "hdrBw") {
        cfg.hdr_bw = SdrPlayHdrBw::from_code(v as f64);
    }
    cfg.bias_tee = setting_bool(settings, "biasTee").unwrap_or(dcfg.bias_t);
    cfg
}

/// A locally attached SDRplay RSP.
pub struct SdrPlaySource {
    handle: Option<SdrPlayHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
}

impl SdrPlaySource {
    pub fn open(cfg: SdrPlayConfig, center_hz: f64) -> Result<Self> {
        let handle = sdroxide_sdrplay::spawn(&cfg, center_hz)
            .with_context(|| format!("open SDRplay (serial {:?})", cfg.serial))?;
        let label = handle.label();
        let serial = handle.serial().to_string();
        let model = handle.model();
        let rate_hz = handle.out_rate_hz().round() as u32;
        info!(
            label = %label,
            serial = %serial,
            model = model.label(),
            rate_hz,
            analog_bw_hz = handle.analog_bw_hz(),
            low_if_khz = handle.low_if_khz(),
            "sdrplay opened"
        );
        if handle.overloaded() {
            warn!("SDRplay reports ADC overload at open; reduce the LNA state or IF gain");
        }
        if let Some(warning) = sdroxide_types::SdrPlayDevice::degraded_warning(&serial, model) {
            warn!("{warning}");
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
impl Source for SdrPlaySource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("sdrplay source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("sdrplay source has no command channel");
            return;
        };
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel)).await;
        match result {
            Ok(Ok(())) => debug!("sdrplay read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "sdrplay read loop failed"),
            Err(e) => warn!(error = %e, "sdrplay read task failed"),
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
            format!("local sdrplay ({})", self.label)
        } else {
            format!("local sdrplay ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: SdrPlayHandle,
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
            warn!("sdrplay stream thread stopped");
            break;
        }
        if handle.removed() {
            warn!("sdrplay device was removed");
            break;
        }

        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SourceCommand::Raw { cmd, value } => apply_command(&mut handle, cmd, value),
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
            debug!("sdrplay output channel closed");
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

fn setting_f64(map: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

fn setting_i64(map: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    map.get(key).and_then(Value::as_i64)
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

fn apply_command(handle: &mut SdrPlayHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_center_hz(value as f64),
        0x02 => debug!(
            value,
            "sdrplay: sample-rate change requires reopening the device"
        ),
        0x05 => handle.set_ppm(value as f64),
        0x0E => handle.set_bias_tee(value != 0),
        0x20 => handle.set_if_gr_db(value as i32),
        0x21 => handle.set_lna_state(value as u8),
        0x30 => handle.set_agc(value as i32),
        0x31 => handle.set_agc_setpoint(value as i32),
        0x32 => handle.set_rf_notch(value != 0),
        0x33 => handle.set_dab_notch(value != 0),
        0x34 => handle.set_hdr(value != 0),
        0x35 => handle.set_hdr_bw(value as i32),
        0x36 => handle.set_extended_if_gr(value != 0),
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled sdrplay command"
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
    fn config_maps_rsp_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  1234567890  ".into();
        dcfg.source
            .settings
            .insert("bwKhz".into(), serde_json::json!(1536));
        dcfg.source
            .settings
            .insert("ifGrDb".into(), serde_json::json!(37));
        dcfg.source
            .settings
            .insert("lnaState".into(), serde_json::json!(5));
        dcfg.source
            .settings
            .insert("agc".into(), serde_json::json!(0));
        dcfg.source
            .settings
            .insert("agcSetpointDbfs".into(), serde_json::json!(-45));
        dcfg.source
            .settings
            .insert("ppm".into(), serde_json::json!(3.5));
        dcfg.source
            .settings
            .insert("rfNotch".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("dabNotch".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("antenna".into(), serde_json::json!("Antenna B"));
        dcfg.source
            .settings
            .insert("duoTuner".into(), serde_json::json!(1));
        dcfg.source
            .settings
            .insert("hdr".into(), serde_json::json!(true));
        dcfg.source
            .settings
            .insert("hdrBw".into(), serde_json::json!(2));
        dcfg.source
            .settings
            .insert("extendedIfGr".into(), serde_json::json!(true));
        dcfg.bias_t = true;

        let cfg = config_from_dongle(&dcfg, &DongleProfile::default(), 6_000_000);
        assert_eq!(cfg.serial, "1234567890");
        assert_eq!(cfg.sample_rate_hz, 6_000_000.0);
        assert_eq!(cfg.bw_khz, 1536);
        assert_eq!(cfg.if_gr_db, 37);
        assert_eq!(cfg.lna_state, 5);
        assert_eq!(cfg.agc, SdrPlayAgc::Off);
        assert_eq!(cfg.agc_setpoint_dbfs, -45);
        assert_eq!(cfg.ppm, 3.5);
        assert!(cfg.rf_notch);
        assert!(cfg.dab_notch);
        assert_eq!(cfg.antenna, "Antenna B");
        assert_eq!(cfg.duo_tuner, SdrPlayDuoTuner::Tuner2);
        assert!(cfg.hdr);
        assert_eq!(cfg.hdr_bw, SdrPlayHdrBw::Mhz1_2);
        assert!(cfg.extended_if_gr);
        assert!(cfg.bias_tee);
    }
}
