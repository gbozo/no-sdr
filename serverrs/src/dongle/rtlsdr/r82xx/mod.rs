//! The Rafael Micro R820T / R820T2 / R828D tuner, independent of what it is
//! wired to.
//!
//! The driver reaches its registers through [`TunerBus`] and nothing else, so
//! the same code drives the tuner behind an RTL2832U's I2C repeater and the one
//! inside an RX-888 Mk2, which sits on the FX3's I2C passthrough. Two very
//! different buses, one transcription of the register sequence.
//!
//! Two properties of the part shape everything here. Its registers are
//! write-only above R5, so a shadow copy is mandatory and read-modify-write
//! goes through the shadow rather than the bus. And reads come back
//! bit-reversed, starting from R0 every time — the part has no random-access
//! read at all.
//!
//! # Provenance
//!
//! Transcribed from osmocom `librtlsdr` `src/tuner_r82xx.c` at commit
//! `84195f169f5b4b7dc06a10efb1e210d02b49e51c`, which already carries the
//! RTL-SDR Blog V4 branches — so this is one reference, not a blend of upstream
//! and the blog fork. GPL-2.0-or-later, compatible with this workspace's
//! GPL-3.0-or-later. Do not mix forks: they differ in `r82xx_set_bw`, the gain
//! tables and the PLL refdiv branch, and blending them produces a radio that is
//! subtly deaf.

pub mod bus;
pub mod driver;
mod error;
pub mod tables;

pub use bus::{BusError, BusResult, TunerBus};
pub use driver::{
    apply_ppm, Chip, GainSetting, R82xx, DEFAULT_IF_HZ, R820T_I2C_ADDR, R828D_I2C_ADDR,
    R82XX_CHECK_VAL,
};
pub use error::Error;
