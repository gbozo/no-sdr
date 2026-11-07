//! Forward FFT backed by `rustfft`.
//!
//! Historically this was a hand-written radix-4 Cooley-Tukey implementation
//! mirroring the Go backend. `rustfft` performs runtime SIMD dispatch
//! (SSE/AVX/NEON) and is roughly 18x faster for the 8k/16k transforms used by
//! the FFT processor, with the same unnormalised forward-DFT convention.

use std::sync::Arc;

use anyhow::{bail, Result};
use num_complex::Complex32;
use rustfft::{Fft as RustFft, FftPlanner};

pub struct Fft {
    size: usize,
    plan: Arc<dyn RustFft<f32>>,
    scratch: Vec<Complex32>,
}

impl Fft {
    pub fn new(size: usize) -> Result<Self> {
        if size < 4 || !size.is_power_of_two() {
            bail!("fft: size must be a power of 2 and >= 4");
        }
        let mut planner = FftPlanner::<f32>::new();
        let plan = planner.plan_fft_forward(size);
        let scratch = vec![Complex32::default(); plan.get_inplace_scratch_len()];
        Ok(Self {
            size,
            plan,
            scratch,
        })
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// In-place forward FFT (unnormalised, matching a standard DFT).
    pub fn transform(&mut self, data: &mut [Complex32]) {
        debug_assert_eq!(data.len(), self.size);
        self.plan.process_with_scratch(data, &mut self.scratch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn naive_dft(input: &[Complex32]) -> Vec<Complex32> {
        let n = input.len();
        (0..n)
            .map(|k| {
                let mut sum = Complex32::new(0.0, 0.0);
                for (t, &x) in input.iter().enumerate() {
                    let angle = -2.0 * PI * (k * t) as f64 / n as f64;
                    sum += x * Complex32::new(angle.cos() as f32, angle.sin() as f32);
                }
                sum
            })
            .collect()
    }

    #[test]
    fn matches_naive_dft() {
        for size in [4usize, 8, 16, 32, 64] {
            let input: Vec<Complex32> = (0..size)
                .map(|i| Complex32::new((i as f32 * 0.3).sin(), (i as f32 * 0.7).cos()))
                .collect();
            let mut got = input.clone();
            Fft::new(size).unwrap().transform(&mut got);
            let want = naive_dft(&input);
            for (g, w) in got.iter().zip(want.iter()) {
                assert!((g.re - w.re).abs() < 1e-2, "size {size}: {g} vs {w}");
                assert!((g.im - w.im).abs() < 1e-2, "size {size}: {g} vs {w}");
            }
        }
    }

    #[test]
    fn dc_bin_equals_sum() {
        let size = 16;
        let input: Vec<Complex32> = (0..size).map(|i| Complex32::new(i as f32, 0.0)).collect();
        let mut got = input.clone();
        Fft::new(size).unwrap().transform(&mut got);
        let sum: f32 = input.iter().map(|c| c.re).sum();
        assert!((got[0].re - sum).abs() < 1e-2);
    }

    #[test]
    fn rejects_invalid_size() {
        assert!(Fft::new(3).is_err());
        assert!(Fft::new(2).is_err());
    }
}
