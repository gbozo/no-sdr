//! Demodulators: FM (mono/stereo), AM, SSB, CW, SAM, C-QUAM, RDS.
//!
//! Mirrors `serverng/internal/demod`.

use anyhow::Result;
use num_complex::Complex32;

pub mod am;
pub mod cquam;
pub mod cw;
pub mod fm;
pub mod rds;
pub mod sam;
pub mod ssb;

pub use am::AmDemod;
pub use cquam::CquamDemod;
pub use cw::CwDemod;
pub use fm::{FmMonoDemod, FmStereoDemod, SimpleFir};
pub use rds::{EonEntry, RdsData, RdsDecoder, PTY_NAMES};
pub use sam::SamDemod;
pub use ssb::{SsbDemod, SsbMode};

/// Common interface for demodulators. Complex baseband in, real audio out
/// (FM stereo and C-QUAM return interleaved L/R).
pub trait Demodulator: Send {
    fn name(&self) -> &'static str;
    /// Output sample rate for a given input rate.
    fn sample_rate_out(&self, input_rate: f64) -> f64;
    fn init(&mut self, sample_rate: f64) -> Result<()>;
    /// Demodulates a block. Returns mono audio, or interleaved L/R for stereo.
    fn process(&mut self, input: &[Complex32]) -> Vec<f32>;
    fn reset(&mut self);
    /// Optional bandwidth hint. Default is a no-op.
    fn set_bandwidth(&mut self, _hz: f64) {}

    /// FM stereo only: composite baseband from the last `process` call.
    fn composite(&self) -> Option<&[f32]> {
        None
    }
    /// FM stereo only: per-sample 19 kHz pilot phase from the last `process` call.
    fn pilot_phases(&self) -> Option<&[f64]> {
        None
    }
    /// FM stereo only: whether a 19 kHz pilot is currently detected.
    fn pilot_detected(&self) -> bool {
        false
    }
}

/// Polynomial approximation of `atan2(y, x)` matching the Go/TypeScript version.
pub fn fast_atan2(y: f32, x: f32) -> f32 {
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let ax = x.abs();
    let ay = y.abs();

    let swapped = ax < ay;
    let a = if swapped { ax / ay } else { ay / ax };

    let s = a * a;
    let mut r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a;
    r += a;

    if swapped {
        r = 1.5707963268 - r;
    }
    if x < 0.0 {
        r = 3.1415926536 - r;
    }
    if y < 0.0 {
        r = -r;
    }
    r
}
