//! Front-end IQ correction: DC offset and adaptive I/Q imbalance.
//!
//! Zero-IF tuners leave a DC spike at the centre and, because the I and Q
//! analogue paths never match exactly, a mirror image of every signal. The DC
//! part is a leaky running mean. The imbalance part is the standard
//! orthogonalise-and-normalise loop:
//!
//! ```text
//! i' = i
//! q' = gain * (q - alpha * i)
//! ```
//!
//! applied to the output and updated from block statistics of that output:
//! `alpha` until E[i*q'] = 0, `gain` until E[q'^2] = E[i^2]. Blocks that look
//! like a genuinely symmetric signal rather than a hardware defect are
//! discarded, and both coefficients are clamped.

use num_complex::Complex32;

/// Samples per estimator update (~7 ms at 2.4 MSPS).
const BLOCK: usize = 16_384;
/// Time constant for the imbalance loop, seconds.
const TAU_S: f64 = 0.35;
const MU_MIN: f64 = 0.005;
const MU_MAX: f64 = 0.25;
const MAX_ALPHA: f64 = 0.2;
const MAX_GAIN: f64 = 1.25;
const IMPLAUSIBLE_ALPHA: f64 = 0.5;
const IMPLAUSIBLE_RATIO: f64 = 3.0;

pub struct IqCorrect {
    dc_alpha: f64,
    mean_re: f64,
    mean_im: f64,
    balance: bool,
    mu: f64,
    alpha: f64,
    gain: f64,
    n: usize,
    sum_ii: f64,
    sum_qq: f64,
    sum_iq: f64,
}

impl IqCorrect {
    /// `corner_hz` is the DC blocker corner. Imbalance correction is enabled
    /// when `balance` is true.
    pub fn new(sample_rate: f64, corner_hz: f64, balance: bool) -> Self {
        let dc_alpha = if sample_rate > 0.0 {
            (1.0 - (-std::f64::consts::TAU * corner_hz / sample_rate).exp()).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let mu = if sample_rate > 0.0 {
            (BLOCK as f64 / sample_rate / TAU_S).clamp(MU_MIN, MU_MAX)
        } else {
            MU_MAX
        };
        Self {
            dc_alpha,
            mean_re: 0.0,
            mean_im: 0.0,
            balance,
            mu,
            alpha: 0.0,
            gain: 1.0,
            n: 0,
            sum_ii: 0.0,
            sum_qq: 0.0,
            sum_iq: 0.0,
        }
    }

    /// Corrects a block in place.
    pub fn process(&mut self, buf: &mut [Complex32]) {
        let dc_alpha = self.dc_alpha;
        let mut mean_re = self.mean_re;
        let mut mean_im = self.mean_im;

        // Without imbalance correction the DC blocker alone is one pass.
        if !self.balance {
            for s in buf.iter_mut() {
                mean_re += dc_alpha * (s.re as f64 - mean_re);
                mean_im += dc_alpha * (s.im as f64 - mean_im);
                s.re -= mean_re as f32;
                s.im -= mean_im as f32;
            }
            self.mean_re = mean_re;
            self.mean_im = mean_im;
            return;
        }

        // DC blocker and imbalance correction are both per-sample functions of
        // the same input sample, so they can share one pass. The block
        // statistics still accumulate in exactly the same order.
        let mut at = 0;
        while at < buf.len() {
            let take = (BLOCK - self.n).min(buf.len() - at);
            let alpha = self.alpha as f32;
            let gain = self.gain as f32;
            let (mut ii, mut qq, mut iq) = (0.0f64, 0.0f64, 0.0f64);
            for s in &mut buf[at..at + take] {
                mean_re += dc_alpha * (s.re as f64 - mean_re);
                mean_im += dc_alpha * (s.im as f64 - mean_im);
                let i = s.re - mean_re as f32;
                let q0 = s.im - mean_im as f32;
                let q = gain * (q0 - alpha * i);
                s.re = i;
                s.im = q;
                ii += (i as f64) * (i as f64);
                qq += (q as f64) * (q as f64);
                iq += (i as f64) * (q as f64);
            }
            self.mean_re = mean_re;
            self.mean_im = mean_im;
            self.sum_ii += ii;
            self.sum_qq += qq;
            self.sum_iq += iq;
            self.n += take;
            at += take;
            if self.n >= BLOCK {
                self.update();
            }
        }
    }

    fn update(&mut self) {
        let (ii, qq, iq) = (self.sum_ii, self.sum_qq, self.sum_iq);
        self.n = 0;
        self.sum_ii = 0.0;
        self.sum_qq = 0.0;
        self.sum_iq = 0.0;

        if ii <= f64::MIN_POSITIVE || qq <= f64::MIN_POSITIVE {
            return;
        }

        let rho = iq / ii;
        if rho.abs() <= IMPLAUSIBLE_ALPHA {
            self.alpha = (self.alpha + self.mu * rho / self.gain).clamp(-MAX_ALPHA, MAX_ALPHA);
        }
        let ratio = (ii / qq).sqrt();
        if (1.0 / IMPLAUSIBLE_RATIO..=IMPLAUSIBLE_RATIO).contains(&ratio) {
            self.gain = (self.gain * ratio.powf(self.mu)).clamp(1.0 / MAX_GAIN, MAX_GAIN);
        }
    }

    pub fn reset(&mut self) {
        self.mean_re = 0.0;
        self.mean_im = 0.0;
        self.alpha = 0.0;
        self.gain = 1.0;
        self.n = 0;
        self.sum_ii = 0.0;
        self.sum_qq = 0.0;
        self.sum_iq = 0.0;
    }

    /// Current `(alpha, gain)` estimates (diagnostics/tests).
    pub fn estimate(&self) -> (f64, f64) {
        (self.alpha, self.gain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize, seed: &mut u64) -> Vec<Complex32> {
        (0..n)
            .map(|_| {
                *seed ^= *seed << 13;
                *seed ^= *seed >> 7;
                *seed ^= *seed << 17;
                let a = (*seed >> 40) as f32 / 8_388_608.0 - 1.0;
                *seed ^= *seed << 13;
                *seed ^= *seed >> 7;
                *seed ^= *seed << 17;
                let b = (*seed >> 40) as f32 / 8_388_608.0 - 1.0;
                Complex32::new(0.1 * a, 0.1 * b)
            })
            .collect()
    }

    fn spoil(buf: &mut [Complex32], gain: f32, phase: f32, dc: Complex32) {
        for s in buf {
            let i = s.re;
            let q = gain * (s.im * phase.cos() + s.re * phase.sin());
            *s = Complex32::new(i + dc.re, q + dc.im);
        }
    }

    #[test]
    fn removes_dc_offset() {
        let mut seed = 0x2545_f491_4f6c_dd1d;
        let mut buf = noise(200_000, &mut seed);
        spoil(&mut buf, 1.0, 0.0, Complex32::new(0.05, -0.03));
        let mut corr = IqCorrect::new(2_400_000.0, 10.0, true);
        corr.process(&mut buf);
        let tail = &buf[100_000..];
        let mean = tail.iter().fold(Complex32::new(0.0, 0.0), |a, b| a + *b)
            / Complex32::new(tail.len() as f32, 0.0);
        assert!(mean.norm() < 2e-3, "residual DC {mean:?}");
    }

    #[test]
    fn converges_towards_imbalance() {
        // 5% gain error, 3 degrees of quadrature skew.
        let mut seed = 0x1234_5678_9abc_def1;
        let mut buf = noise(1_000_000, &mut seed);
        spoil(&mut buf, 1.05, 3.0f32.to_radians(), Complex32::new(0.0, 0.0));
        let mut corr = IqCorrect::new(2_400_000.0, 10.0, true);
        corr.process(&mut buf);
        let (alpha, gain) = corr.estimate();
        assert!(alpha.abs() > 1e-4, "alpha did not move: {alpha}");
        assert!(gain < 1.0, "gain did not move: {gain}");
        assert!(alpha.abs() <= MAX_ALPHA && gain <= MAX_GAIN);
    }

    #[test]
    fn reset_clears_estimate() {
        let mut corr = IqCorrect::new(2_400_000.0, 10.0, true);
        corr.alpha = 0.1;
        corr.gain = 1.1;
        corr.reset();
        assert_eq!(corr.estimate(), (0.0, 1.0));
    }
}
