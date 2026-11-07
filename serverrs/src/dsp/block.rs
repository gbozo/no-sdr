//! DSP block trait.

use anyhow::Result;
use num_complex::Complex32;

/// A processing stage in an IQ pipeline.
pub trait ProcessorBlock: Send {
    fn name(&self) -> &'static str;
    /// Output sample rate for a given input rate (rate propagation).
    fn sample_rate_out(&self, input_rate: f64) -> f64;
    fn init(&mut self, sample_rate: f64) -> Result<()>;
    fn process_complex(&mut self, input: &[Complex32]) -> Vec<Complex32>;
    fn reset(&mut self);
}
