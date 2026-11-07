//! Impulse noise blanker (pre-filter).
//!
//! Mirrors `serverng/internal/dsp/noise_blanker.go`.

use num_complex::Complex32;

#[derive(Debug, Clone)]
pub struct NoiseBlanker {
    enabled: bool,
    threshold: f32,
    threshold_low: f32,
    threshold_sq: f32,
    threshold_low_sq: f32,
    avg_mag_sq: f32,
    alpha: f32,
    blank_count: i32,
    guard_size: i32,
}

impl NoiseBlanker {
    pub fn new(threshold: f32) -> Self {
        let mut low = threshold * 0.4;
        if low < 3.0 {
            low = 3.0;
        }
        Self {
            enabled: false,
            threshold,
            threshold_low: low,
            threshold_sq: threshold * threshold,
            threshold_low_sq: low * low,
            avg_mag_sq: 0.0,
            alpha: 0.01,
            blank_count: 0,
            guard_size: 8,
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn threshold(&self) -> f32 {
        self.threshold
    }

    pub fn set_threshold(&mut self, t: f32) {
        self.threshold = t;
        self.threshold_sq = t * t;
        let mut low = t * 0.4;
        if low < 3.0 {
            low = 3.0;
        }
        self.threshold_low = low;
        self.threshold_low_sq = low * low;
    }

    /// Blanks impulses in place; returns the number of blanked samples.
    pub fn process(&mut self, data: &mut [Complex32]) -> usize {
        if !self.enabled {
            return 0;
        }
        let mut blanked = 0usize;
        for s in data.iter_mut() {
            let mag_sq = s.re * s.re + s.im * s.im;
            self.avg_mag_sq += self.alpha * (mag_sq - self.avg_mag_sq);

            if self.blank_count > 0 {
                *s = Complex32::default();
                self.blank_count -= 1;
                blanked += 1;
            } else if self.avg_mag_sq > 0.0 && mag_sq > self.avg_mag_sq * self.threshold_sq {
                *s = Complex32::default();
                self.blank_count = self.guard_size;
                blanked += 1;
            } else if self.avg_mag_sq > 0.0 && mag_sq > self.avg_mag_sq * self.threshold_low_sq {
                let excess = (mag_sq - self.avg_mag_sq * self.threshold_low_sq)
                    / (self.avg_mag_sq * (self.threshold_sq - self.threshold_low_sq));
                if excess > 0.5 {
                    *s = Complex32::default();
                    self.blank_count = self.guard_size;
                    blanked += 1;
                }
            }
        }
        blanked
    }

    /// Processes one sample pair (used by the fused converter).
    pub(crate) fn apply_sample(&mut self, re: f32, im: f32) -> (f32, f32) {
        let mag_sq = re * re + im * im;
        self.avg_mag_sq += self.alpha * (mag_sq - self.avg_mag_sq);

        if self.blank_count > 0 {
            self.blank_count -= 1;
            return (0.0, 0.0);
        }
        if self.avg_mag_sq > 0.0 && mag_sq > self.avg_mag_sq * self.threshold_sq {
            self.blank_count = self.guard_size;
            return (0.0, 0.0);
        }
        if self.avg_mag_sq > 0.0 && mag_sq > self.avg_mag_sq * self.threshold_low_sq {
            let excess = (mag_sq - self.avg_mag_sq * self.threshold_low_sq)
                / (self.avg_mag_sq * (self.threshold_sq - self.threshold_low_sq));
            if excess > 0.5 {
                self.blank_count = self.guard_size;
                return (0.0, 0.0);
            }
        }
        (re, im)
    }

    pub fn reset(&mut self) {
        self.avg_mag_sq = 0.0;
        self.blank_count = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_passes_through() {
        let mut nb = NoiseBlanker::new(10.0);
        let mut data = vec![Complex32::new(5.0, 5.0); 10];
        let before = data.clone();
        assert_eq!(nb.process(&mut data), 0);
        assert_eq!(data, before);
    }

    #[test]
    fn blanks_impulse() {
        let mut nb = NoiseBlanker::new(10.0);
        nb.set_enabled(true);
        let mut data = vec![Complex32::new(0.01, 0.01); 100];
        // Let the EMA settle.
        for _ in 0..10 {
            nb.process(&mut data);
        }
        data[50] = Complex32::new(10.0, 10.0);
        let blanked = nb.process(&mut data);
        assert!(blanked > 0);
        assert_eq!(data[50], Complex32::default());
    }
}
