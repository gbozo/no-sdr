//! Rust port of the no-sdr backend.
//!
//! Wire-compatible with the existing SolidJS client.

pub mod api;
pub mod codec;
pub mod config;
#[cfg(feature = "decoders")]
pub mod decoders;
pub mod demod;
pub mod dongle;
pub mod dsp;
pub mod history;
pub mod ws;
