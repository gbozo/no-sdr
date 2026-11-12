//! RigExpert Fobos SDR adapter for the manager's raw-IQ source contract.
//!
//! `sdroxide-fobos` loads `libfobos` with `dlopen` at runtime. RF and the two
//! single-channel HF ports deliver interleaved `f32` I/Q; the dual-HF port
//! delivers two coherent channels, and this adapter streams the primary one
//! (the WebSDR pipeline has one receiver per dongle).

use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use sdroxide_fobos::{FobosHandle, OpenParams, Port};
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
    center_hz: f64,
) -> OpenParams {
    let settings = &dcfg.source.settings;
    OpenParams {
        serial: dcfg.source.serial.trim().to_string(),
        port: port_from(settings),
        center_hz,
        sample_rate_hz: sample_rate as f64,
        lna_gain: setting_u8(settings, "lnaGain").unwrap_or(2).min(3),
        vga_gain: setting_u8(settings, "vgaGain").unwrap_or(10).min(31),
        clk_external: setting_bool(settings, "clkExternal").unwrap_or(false),
    }
}

fn port_from(settings: &serde_json::Map<String, Value>) -> Port {
    if let Some(name) = setting_str(settings, "port") {
        return match name.trim().to_ascii_lowercase().as_str() {
            "hf1" => Port::Hf1,
            "hf2" => Port::Hf2,
            "hfdual" | "hf-dual" | "diversity" => Port::HfDual,
            _ => Port::Rf,
        };
    }
    match setting_u8(settings, "port") {
        Some(1) => Port::Hf1,
        Some(2) => Port::Hf2,
        Some(3) => Port::HfDual,
        _ => Port::Rf,
    }
}

/// A locally attached Fobos SDR.
pub struct FobosSource {
    handle: Option<FobosHandle>,
    cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
    cmd_handle: CommandHandle,
    label: String,
    serial: String,
    rate_hz: u32,
    dual_hf: bool,
}

impl FobosSource {
    pub fn open(params: OpenParams) -> Result<Self> {
        let dual_hf = params.port == Port::HfDual;
        let handle = FobosHandle::open(params).with_context(|| "open Fobos SDR")?;
        let label = handle.label.clone();
        let serial = handle.board.serial.clone();
        let rate_hz = handle.current_rate_hz().round() as u32;
        info!(
            label = %label,
            serial = %serial,
            board = %handle.board.product,
            firmware = %handle.board.fw_version,
            rate_hz,
            adc_rate_hz = handle.adc_rate_hz,
            "fobos opened"
        );
        if dual_hf {
            warn!(
                "Fobos HF1+HF2 selected: the WebSDR streams the primary channel; \
                 diversity combining is not enabled in this build"
            );
        }

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Ok(Self {
            handle: Some(handle),
            cmd_rx: Some(cmd_rx),
            cmd_handle: CommandHandle::new(cmd_tx),
            label,
            serial,
            rate_hz,
            dual_hf,
        })
    }
}

#[async_trait]
impl Source for FobosSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let Some(handle) = this.handle.take() else {
            warn!("fobos source has no handle");
            return;
        };
        let Some(cmd_rx) = this.cmd_rx.take() else {
            warn!("fobos source has no command channel");
            return;
        };
        let dual_hf = this.dual_hf;
        let result =
            tokio::task::spawn_blocking(move || run_stream(handle, cmd_rx, out, cancel, dual_hf))
                .await;
        match result {
            Ok(Ok(())) => debug!("fobos read loop stopped"),
            Ok(Err(e)) => warn!(error = %e, "fobos read loop failed"),
            Err(e) => warn!(error = %e, "fobos read task failed"),
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
            format!("local fobos ({})", self.label)
        } else {
            format!("local fobos ({}, serial {})", self.label, self.serial)
        }
    }
}

fn run_stream(
    mut handle: FobosHandle,
    mut cmd_rx: mpsc::UnboundedReceiver<SourceCommand>,
    out: mpsc::Sender<Vec<u8>>,
    cancel: watch::Receiver<bool>,
    dual_hf: bool,
) -> Result<()> {
    let mut fbuf = vec![0f32; READ_COMPONENTS];
    let mut aux = vec![0f32; READ_COMPONENTS];
    let mut ubuf = vec![0u8; READ_COMPONENTS];

    loop {
        if *cancel.borrow() {
            break;
        }
        if !handle.is_alive() {
            warn!("fobos stream thread stopped");
            break;
        }

        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                SourceCommand::Raw { cmd, value } => apply_command(&handle, cmd, value),
                SourceCommand::Close => return Ok(()),
            }
        }

        let n = if dual_hf {
            handle.rx_read_pair(&mut fbuf, &mut aux).saturating_mul(2)
        } else {
            handle.rx_read(&mut fbuf)
        };
        if n == 0 {
            std::thread::sleep(EMPTY_SLEEP);
            continue;
        }
        complex_to_u8(&fbuf[..n], &mut ubuf[..n]);
        if out.blocking_send(ubuf[..n].to_vec()).is_err() {
            debug!("fobos output channel closed");
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

fn setting_u8(map: &serde_json::Map<String, Value>, key: &str) -> Option<u8> {
    map.get(key)
        .and_then(Value::as_u64)
        .and_then(|v| u8::try_from(v).ok())
}

fn setting_str<'a>(map: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

fn apply_command(handle: &FobosHandle, cmd: u8, value: u32) {
    match cmd {
        0x01 => handle.set_center_hz(value as f64),
        0x02 => handle.set_rate_hz(value as f64),
        0x30 => handle.set_lna_gain(value.min(3) as u8),
        0x31 => handle.set_vga_gain(value.min(31) as u8),
        0x32 => handle.set_clk_external(value != 0),
        0x0E => {
            if value != 0 {
                warn!("fobos: this source has no bias tee control");
            }
        }
        _ => debug!(
            cmd = format!("{cmd:#04x}"),
            value, "unhandled fobos command"
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
    fn config_maps_fobos_settings() {
        let mut dcfg = DongleConfig::default();
        dcfg.source.serial = "  FOBOS-123  ".into();
        dcfg.source
            .settings
            .insert("port".into(), serde_json::json!("hf2"));
        dcfg.source
            .settings
            .insert("lnaGain".into(), serde_json::json!(1));
        dcfg.source
            .settings
            .insert("vgaGain".into(), serde_json::json!(15));
        dcfg.source
            .settings
            .insert("clkExternal".into(), serde_json::json!(true));

        let params = config_from_dongle(&dcfg, &DongleProfile::default(), 1_250_000, 14_074_000.0);
        assert_eq!(params.serial, "FOBOS-123");
        assert_eq!(params.port, Port::Hf2);
        assert_eq!(params.sample_rate_hz, 1_250_000.0);
        assert_eq!(params.center_hz, 14_074_000.0);
        assert_eq!(params.lna_gain, 1);
        assert_eq!(params.vga_gain, 15);
        assert!(params.clk_external);
    }

    #[test]
    fn port_accepts_numeric_codes() {
        let mut settings = serde_json::Map::new();
        settings.insert("port".into(), serde_json::json!(3));
        assert_eq!(port_from(&settings), Port::HfDual);
        settings.insert("port".into(), serde_json::json!("rf"));
        assert_eq!(port_from(&settings), Port::Rf);
    }
}
