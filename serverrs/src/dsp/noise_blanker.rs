//! Impulse noise blanker (pre-filter).
//!
//! Runs per client on the raw dongle IQ, before the NCO and decimation, so an
//! impulse is removed before the anti-alias FIR smears it across the channel.
//!
//! The running-power statistic covers the whole dongle bandwidth, not the
//! tuned channel: a strong carrier anywhere in band raises the mean and can
//! mask impulses in a weak channel. The threshold is relative to that mean, so
//! the blanker is most effective when the dongle band is otherwise quiet.
//!
//! Ported from the original Go backend; the averaging time and blanking guard
//! are now derived from the sample rate instead of a fixed 100-sample alpha.

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

/// Target time constant for the running-power estimate. Long enough that a
/// modulation peak is not mistaken for an impulse, short enough to follow
/// propagation changes.
const AVERAGE_SECS: f64 = 0.002;
/// How long to blank after a trigger (covers the pulse tail and the dongle's
/// filter ringing).
const GUARD_SECS: f64 = 100e-6;

impl NoiseBlanker {
    pub fn new(threshold: f32, sample_rate: f64) -> Self {
        let mut low = threshold * 0.4;
        if low < 3.0 {
            low = 3.0;
        }
        let mut nb = Self {
            enabled: false,
            threshold,
            threshold_low: low,
            threshold_sq: threshold * threshold,
            threshold_low_sq: low * low,
            avg_mag_sq: 0.0,
            alpha: 0.01,
            blank_count: 0,
            guard_size: 8,
        };
        nb.set_sample_rate(sample_rate);
        nb
    }

    /// Scales the power average and the blanking guard to the sample rate.
    /// A fixed alpha of 0.01 averages 100 samples, i.e. 42 µs at 2.4 MSPS but
    /// 2 ms at 48 kHz — the same slider behaved completely differently per
    /// dongle.
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        if !(sample_rate.is_finite() && sample_rate > 0.0) {
            return;
        }
        let alpha = 1.0 - (-1.0 / (sample_rate * AVERAGE_SECS)).exp();
        self.alpha = alpha.clamp(1e-6, 1.0) as f32;
        self.guard_size = ((sample_rate * GUARD_SECS).round() as i32).clamp(8, 2000);
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
        let mut nb = NoiseBlanker::new(10.0, 2_400_000.0);
        let mut data = vec![Complex32::new(5.0, 5.0); 10];
        let before = data.clone();
        assert_eq!(nb.process(&mut data), 0);
        assert_eq!(data, before);
    }

    #[test]
    fn parameters_scale_with_sample_rate() {
        let slow = NoiseBlanker::new(10.0, 48_000.0);
        let fast = NoiseBlanker::new(10.0, 2_400_000.0);
        assert!(
            fast.alpha < slow.alpha,
            "fast-rate average must be slower per sample ({} vs {})",
            fast.alpha,
            slow.alpha
        );
        assert!(
            fast.guard_size > slow.guard_size,
            "fast-rate guard must be longer in samples ({} vs {})",
            fast.guard_size,
            slow.guard_size
        );
        // ~2 ms average and ~100 µs guard at both rates.
        assert!((1.0 / slow.alpha as f64 - 96.0).abs() < 5.0);
        assert!((1.0 / fast.alpha as f64 - 4800.0).abs() < 50.0);
        assert_eq!(fast.guard_size, 240);
        assert_eq!(slow.guard_size, 8);
    }

    #[test]
    fn blanks_impulse() {
        let mut nb = NoiseBlanker::new(10.0, 2_400_000.0);
        nb.set_enabled(true);
        let mut data = vec![Complex32::new(0.01, 0.01); 100];
        // Let the power average settle.
        for _ in 0..10 {
            nb.process(&mut data);
        }
        data[50] = Complex32::new(10.0, 10.0);
        let blanked = nb.process(&mut data);
        assert!(blanked > 0);
        assert_eq!(data[50], Complex32::default());
    }
}
