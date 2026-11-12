//! Native RTL-SDR (RTL2832U) source.
//!
//! Pure Rust over USB via [`nusb`]: no librtlsdr, no libusb and no SoapySDR.
//! Vendor control transfers on endpoint 0 program the demodulator and, through
//! its I2C repeater, the tuner; queued bulk transfers on endpoint `0x81` carry
//! the 8-bit I/Q stream. The same approach gives us a place to add other native
//! SDR backends later without growing the release archive's native dependency
//! list.
//!
//! # Provenance
//!
//! The register sequences, the R82xx initialisation array and the gain tables
//! are adapted from the [`sdroxide`] project's `sdroxide-rtlsdr` and
//! `sdroxide-r82xx` crates, which in turn transcribe osmocom `librtlsdr`
//! (`src/librtlsdr.c`, `src/tuner_r82xx.c`) and the RTL-SDR Blog V4 branches
//! from `rtlsdrblog/rtl-sdr-blog`. Both are GPL-2.0-or-later, compatible with
//! this project's GPL-3.0-or-later. Do not mix forks: they differ in
//! `r82xx_set_bw`, the gain tables and the PLL refdiv branch.
//!
//! [`sdroxide`]: https://github.com/dividebysandwich/sdroxide
//! [`nusb`]: https://docs.rs/nusb

use serde::Serialize;

#[cfg(feature = "rtlsdr")]
mod config;
#[cfg(feature = "rtlsdr")]
mod device;
#[cfg(feature = "rtlsdr")]
mod error;
#[cfg(feature = "rtlsdr")]
mod r82xx;
#[cfg(feature = "rtlsdr")]
mod regs;
#[cfg(feature = "rtlsdr")]
mod rtl2832;
#[cfg(feature = "rtlsdr")]
mod source;
#[cfg(feature = "rtlsdr")]
mod tuner;
#[cfg(feature = "rtlsdr")]
mod usb;

#[cfg(feature = "rtlsdr")]
pub use device::Device;
#[cfg(feature = "rtlsdr")]
pub use error::Error;
#[cfg(feature = "rtlsdr")]
pub use source::RtlSdrSource;
#[cfg(feature = "rtlsdr")]
pub use usb::{parse_eeprom, Eeprom};

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

/// Enumerates locally attached RTL-SDR devices without opening any of them.
#[cfg(feature = "rtlsdr")]
pub fn enumerate_local_devices() -> Vec<LocalDeviceInfo> {
    usb::list()
}

/// Enumerates locally attached RTL-SDR devices (none when the feature is off).
#[cfg(not(feature = "rtlsdr"))]
pub fn enumerate_local_devices() -> Vec<LocalDeviceInfo> {
    Vec::new()
}

/// The native source is compiled out when the `rtlsdr` feature is off. The
/// manager checks the feature before calling this, but the symbol still has to
/// exist so the rest of the module compiles in the dependency-free build.
#[cfg(not(feature = "rtlsdr"))]
pub struct RtlSdrSource;

#[cfg(not(feature = "rtlsdr"))]
impl RtlSdrSource {
    pub fn open(_device_index: i32, _serial: &str) -> anyhow::Result<Self> {
        anyhow::bail!("local rtlsdr support is not compiled in (build with --features rtlsdr)")
    }
}
