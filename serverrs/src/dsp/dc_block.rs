//! DC offset removal via a leaky integrator (first-order IIR high-pass).
//!
//! Ported from the original Go backend.
//!
//! ```text
//! y     = x - dcEst
//! dcEst += beta * y
//! beta  = 2*pi * cornerHz / sampleRate
//! ```

use std::f64::consts::PI;

use num_complex::Complex32;

#[derive(Debug, Clone)]
pub struct DcBlocker {
    enabled: bool,
    beta: f32,
    dc_i: f32,
    dc_q: f32,
}

impl DcBlocker {
    pub fn new(sample_rate: f64, corner_hz: f64, enabled: bool) -> Self {
        let mut beta = ((2.0 * PI / sample_rate) * corner_hz) as f32;
        if beta < 0.0 {
            beta = 0.0;
        }
        if beta > 1.0 {
            beta = 1.0;
        }
        Self {
            enabled,
            beta,
            dc_i: 0.0,
            dc_q: 0.0,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn beta(&self) -> f32 {
        self.beta
    }

    /// Applies the blocker to one sample pair (used by the fused converter).
    pub(crate) fn apply_sample(&mut self, re: f32, im: f32) -> (f32, f32) {
        let y_i = re - self.dc_i;
        let y_q = im - self.dc_q;
        self.dc_i += self.beta * y_i;
        self.dc_q += self.beta * y_q;
        (y_i, y_q)
    }

    /// Applies the DC blocker in place. No-op when disabled.
    pub fn process(&mut self, samples: &mut [Complex32]) {
        if !self.enabled {
            return;
        }
        for s in samples.iter_mut() {
            let (re, im) = self.apply_sample(s.re, s.im);
            *s = Complex32::new(re, im);
        }
    }

    pub fn reset(&mut self) {
        self.dc_i = 0.0;
        self.dc_q = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_constant_offset() {
        let mut b = DcBlocker::new(2_400_000.0, 1.0, true);
        let mut data = vec![Complex32::new(0.5, -0.25); 2_000_000];
        b.process(&mut data);
        let tail = &data[1_990_000..];
        let mean_re: f32 = tail.iter().map(|c| c.re).sum::<f32>() / tail.len() as f32;
        let mean_im: f32 = tail.iter().map(|c| c.im).sum::<f32>() / tail.len() as f32;
        assert!(mean_re.abs() < 0.01, "re {mean_re}");
        assert!(mean_im.abs() < 0.01, "im {mean_im}");
    }

    #[test]
    fn disabled_passes_through() {
        let mut b = DcBlocker::new(48_000.0, 1.0, false);
        let mut data = vec![Complex32::new(1.0, 2.0); 8];
        b.process(&mut data);
        assert_eq!(data, vec![Complex32::new(1.0, 2.0); 8]);
    }
}
