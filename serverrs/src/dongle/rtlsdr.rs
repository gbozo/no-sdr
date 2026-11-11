//! Local RTL-SDR USB source.
//!
//! Mirrors `serverng/internal/dongle/rtlsdr.go`. Compiled only with the
//! `rtlsdr` feature; without it, opening a local source returns an error.

#[cfg(feature = "rtlsdr")]
mod imp {
    use std::sync::Arc;

    use anyhow::{bail, Result};
    use async_trait::async_trait;
    use serde::Serialize;
    use tokio::sync::{mpsc, watch};
    use tracing::{error, info, warn};

    use super::super::source::{CommandHandle, Source, SourceCommand};

    const CHUNK_SIZE: i32 = 16384;

    /// A locally attached RTL-SDR.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LocalDeviceInfo {
        pub index: i32,
        pub name: String,
        pub serial: String,
        pub product: String,
        pub manufact: String,
        pub available: bool,
    }

    /// Enumerates locally attached RTL-SDR devices.
    pub fn enumerate_local_devices() -> Vec<LocalDeviceInfo> {
        let count = ::rtlsdr::get_device_count();
        let mut out = Vec::with_capacity(count.max(0) as usize);
        for i in 0..count {
            let (manufact, product, serial, _err) = ::rtlsdr::get_device_usb_strings(i);
            out.push(LocalDeviceInfo {
                index: i,
                name: ::rtlsdr::get_device_name(i),
                serial,
                product,
                manufact,
                available: true,
            });
        }
        out
    }

    /// Owns an `rtlsdr` device handle and closes it when the last reference
    /// is dropped.
    ///
    /// The device must never be closed while the blocking read loop is still
    /// inside librtlsdr: `rtlsdr_close()` frees the handle, and a concurrent
    /// `rtlsdr_read_sync()`/`rtlsdr_set_*()` then dereferences freed memory
    /// (observed as a SIGSEGV inside `rtlsdr_set_sample_rate`). The read loop
    /// holds a clone of this `Arc`, so closing can only happen after the loop
    /// has returned.
    struct DeviceGuard(Arc<::rtlsdr::Device>);

    impl Drop for DeviceGuard {
        fn drop(&mut self) {
            let _ = self.0.close();
        }
    }

    impl std::ops::Deref for DeviceGuard {
        type Target = ::rtlsdr::Device;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    /// Direct USB RTL-SDR source.
    pub struct RtlSdrSource {
        device: Arc<DeviceGuard>,
        index: i32,
        cmd_rx: Option<mpsc::UnboundedReceiver<SourceCommand>>,
        cmd_handle: CommandHandle,
    }

    impl RtlSdrSource {
        /// Opens the dongle selected by serial (preferred) or index.
        pub fn open(device_index: i32, serial: &str) -> Result<Self> {
            let index = if !serial.is_empty() {
                let resolved = ::rtlsdr::get_index_by_serial(serial.to_string());
                if resolved >= 0 {
                    resolved
                } else {
                    warn!(serial, fallback = device_index, "rtlsdr: serial not found");
                    device_index
                }
            } else {
                device_index
            };

            let (device, err) = ::rtlsdr::open(index);
            if !matches!(err, ::rtlsdr::Error::NoError) {
                bail!("rtlsdr open device {index}: {err:?}");
            }

            info!(index, "rtlsdr device opened");

            let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
            Ok(Self {
                device: Arc::new(DeviceGuard(device)),
                index,
                cmd_rx: Some(cmd_rx),
                cmd_handle: CommandHandle::new(cmd_tx),
            })
        }

        pub fn index(&self) -> i32 {
            self.index
        }
    }

    #[async_trait]
    impl Source for RtlSdrSource {
        async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
            let mut this = *self;
            let device = this.device.clone();
            let mut cmd_rx = this.cmd_rx.take();

            let result = tokio::task::spawn_blocking(move || {
                if let ::rtlsdr::Error::NoError = device.reset_buffer() {
                    // ok
                } else {
                    error!("rtlsdr reset buffer failed");
                    return;
                }

                loop {
                    if *cancel.borrow() {
                        break;
                    }

                    if let Some(rx) = cmd_rx.as_mut() {
                        while let Ok(cmd) = rx.try_recv() {
                            apply_command(&device, cmd);
                        }
                    }

                    let (data, n, err) = device.read_sync(CHUNK_SIZE);
                    match err {
                        ::rtlsdr::Error::NoError => {}
                        ::rtlsdr::Error::Timeout => continue,
                        other => {
                            if !*cancel.borrow() {
                                error!(error = ?other, "rtlsdr read error");
                            }
                            break;
                        }
                    }
                    if n <= 0 {
                        continue;
                    }
                    if out.blocking_send(data[..n as usize].to_vec()).is_err() {
                        break;
                    }
                }
            })
            .await;

            if let Err(e) = result {
                error!(error = %e, "rtlsdr read task failed");
            }
            // `this` drops here and closes the device.
            drop(this);
        }

        fn command_handle(&self) -> Option<CommandHandle> {
            Some(self.cmd_handle.clone())
        }

        fn description(&self) -> String {
            format!("local rtlsdr #{}", self.index)
        }
    }

    fn apply_command(device: &::rtlsdr::Device, cmd: SourceCommand) {
        let SourceCommand::Raw { cmd, value } = cmd else {
            return;
        };
        let result = match cmd {
            0x01 => device.set_center_freq(value as i32),
            0x02 => device.set_sample_rate(value as i32),
            0x03 => device.set_tuner_gain_mode(value != 0),
            0x04 => device.set_tuner_gain(value as i32),
            0x05 => device.set_freq_correction(value as i32),
            0x08 => device.set_agc_mode(value != 0),
            0x09 => device.set_direct_sampling(match value {
                0 => ::rtlsdr::SamplingMode::None,
                1 => ::rtlsdr::SamplingMode::IADC,
                2 => ::rtlsdr::SamplingMode::QADC,
                _ => ::rtlsdr::SamplingMode::None,
            }),
            0x0A => device.set_offset_tuning(value != 0),
            0x0E => {
                if value != 0 {
                    warn!("rtlsdr: bias-T is not exposed by the rtl-sdr crate; ignoring");
                }
                ::rtlsdr::Error::NoError
            }
            _ => ::rtlsdr::Error::NoError,
        };
        if !matches!(result, ::rtlsdr::Error::NoError) {
            warn!(cmd = format!("{cmd:#04x}"), value, error = ?result, "rtlsdr command failed");
        }
    }
}

#[cfg(not(feature = "rtlsdr"))]
mod imp {
    use anyhow::{bail, Result};
    use serde::Serialize;

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LocalDeviceInfo {
        pub index: i32,
        pub name: String,
        pub serial: String,
        pub product: String,
        pub manufact: String,
        pub available: bool,
    }

    pub fn enumerate_local_devices() -> Vec<LocalDeviceInfo> {
        Vec::new()
    }

    pub struct RtlSdrSource;

    impl RtlSdrSource {
        pub fn open(_device_index: i32, _serial: &str) -> Result<Self> {
            bail!("local rtlsdr support is not compiled in (build with --features rtlsdr)")
        }
    }
}

pub use imp::{enumerate_local_devices, LocalDeviceInfo, RtlSdrSource};
