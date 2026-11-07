//! Synchronous AM demodulator with a PLL-based carrier lock.
//!
//! Mirrors `serverng/internal/demod/sam.go`.

use std::f64::consts::PI;

use anyhow::Result;
use num_complex::Complex32;

use super::Demodulator;

pub struct SamDemod {
    sample_rate: f64,
    pll_phase: f64,
    pll_freq: f64,
    pll_omega: f64,
    g1: f64,
    g2: f64,
    lock_level: f32,
    locked: bool,
    lock_alpha: f32,

    // DC blocker
    dc_alpha: f32,
    dc_state: f32,

    // Low-pass filter
    lp_alpha: f32,
    lp_state: f32,
}

impl Default for SamDemod {
    fn default() -> Self {
        Self::new()
    }
}

impl SamDemod {
    pub fn new() -> Self {
        Self {
            sample_rate: 0.0,
            pll_phase: 0.0,
            pll_freq: 0.0,
            pll_omega: 0.0,
            g1: 0.0,
            g2: 0.0,
            lock_level: 0.0,
            locked: false,
            lock_alpha: 0.0,
            dc_alpha: 0.0,
            dc_state: 0.0,
            lp_alpha: 0.0,
            lp_state: 0.0,
        }
    }

    pub fn is_locked(&self) -> bool {
        self.locked
    }

    pub fn lock_level(&self) -> f32 {
        self.lock_level
    }
}

impl Demodulator for SamDemod {
    fn name(&self) -> &'static str {
        "sam"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> Result<()> {
        self.sample_rate = sample_rate;

        // 2nd-order PLL loop filter: BW=150 Hz, zeta=0.707.
        let bw = 150.0;
        let omega_n = 2.0 * PI * bw / self.sample_rate;
        let zeta = 0.707;
        self.g1 = 2.0 * zeta * omega_n;
        self.g2 = omega_n * omega_n;

        self.pll_phase = 0.0;
        self.pll_freq = 0.0;
        self.pll_omega = 0.0;
        self.lock_level = 0.0;
        self.locked = false;
        self.lock_alpha = (1.0 - (-1.0 / (self.sample_rate * 0.05)).exp()) as f32; // 50 ms

        // DC blocker: high-pass with ~20 Hz cutoff.
        self.dc_alpha = (1.0 - (-2.0 * PI * 20.0 / self.sample_rate).exp()) as f32;
        self.dc_state = 0.0;

        // LPF: ~5 kHz cutoff for audio output.
        let mut lp_cutoff = 5000.0;
        if lp_cutoff > self.sample_rate / 2.0 {
            lp_cutoff = self.sample_rate / 2.0 * 0.9;
        }
        self.lp_alpha = (1.0 - (-2.0 * PI * lp_cutoff / self.sample_rate).exp()) as f32;
        self.lp_state = 0.0;

        Ok(())
    }

    fn process(&mut self, input: &[Complex32]) -> Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];

        let mut pll_phase = self.pll_phase;
        let mut pll_omega = self.pll_omega;
        let mut lock_level = self.lock_level;
        let lock_alpha = self.lock_alpha;
        let mut dc_state = self.dc_state;
        let dc_alpha = self.dc_alpha;
        let mut lp_state = self.lp_state;
        let lp_alpha = self.lp_alpha;
        let g1 = self.g1;
        let g2 = self.g2;

        for i in 0..n {
            let re = input[i].re as f64;
            let im = input[i].im as f64;

            let cos_p = pll_phase.cos();
            let sin_p = pll_phase.sin();

            // Coherent detection.
            let demod = re * cos_p + im * sin_p;

            // Phase error.
            let err = -re * sin_p + im * cos_p;

            // Loop filter (2nd order).
            pll_omega += g2 * err;
            let pll_freq = pll_omega + g1 * err;
            pll_phase += pll_freq;

            if pll_phase > PI {
                pll_phase -= 2.0 * PI;
            } else if pll_phase < -PI {
                pll_phase += 2.0 * PI;
            }

            // Lock indicator: ratio of coherent power to total power.
            let total_pow = (re * re + im * im + 1e-20) as f32;
            let coherent_pow = (demod * demod) as f32;
            lock_level = lock_alpha * (coherent_pow / total_pow) + (1.0 - lock_alpha) * lock_level;

            // DC blocker.
            dc_state = dc_alpha * demod as f32 + (1.0 - dc_alpha) * dc_state;
            let sample = demod as f32 - dc_state;

            // LPF.
            lp_state = lp_alpha * sample + (1.0 - lp_alpha) * lp_state;
            out[i] = lp_state;
        }

        self.pll_phase = pll_phase;
        self.pll_omega = pll_omega;
        self.lock_level = lock_level;
        self.dc_state = dc_state;
        self.lp_state = lp_state;
        self.locked = lock_level > 0.5;

        out
    }

    fn reset(&mut self) {
        self.pll_phase = 0.0;
        self.pll_freq = 0.0;
        self.pll_omega = 0.0;
        self.lock_level = 0.0;
        self.locked = false;
        self.dc_state = 0.0;
        self.lp_state = 0.0;
    }

    fn set_bandwidth(&mut self, hz: f64) {
        if hz <= 0.0 || self.sample_rate <= 0.0 {
            return;
        }
        let mut cutoff_hz = hz / 2.0;
        if cutoff_hz > 8000.0 {
            cutoff_hz = 8000.0;
        }
        if cutoff_hz > self.sample_rate / 2.0 {
            cutoff_hz = self.sample_rate / 2.0 * 0.9;
        }
        self.lp_alpha = (1.0 - (-2.0 * PI * cutoff_hz / self.sample_rate).exp()) as f32;
        self.lp_state = 0.0; // reset to avoid transient
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locks_to_strong_carrier_and_recovers_am() {
        let fs = 48_000.0;
        let mut d = SamDemod::new();
        d.init(fs).unwrap();

        let n = 48_000;
        let input: Vec<Complex32> = (0..n)
            .map(|i| {
                let m = 0.5 + 0.5 * (2.0 * PI * 1000.0 * i as f64 / fs).sin() as f32;
                Complex32::new(m, 0.0)
            })
            .collect();
        let out = d.process(&input);
        assert!(d.is_locked(), "lock_level={}", d.lock_level());
        let rms = (out.iter().map(|x| x * x).sum::<f32>() / n as f32).sqrt();
        assert!(rms > 0.05, "rms={rms}");
    }

    #[test]
    fn bandwidth_rescales_lp() {
        let mut d = SamDemod::new();
        d.init(48_000.0).unwrap();
        let before = d.lp_alpha;
        d.set_bandwidth(20_000.0); // cutoff clamped to 8 kHz
        assert!(d.lp_alpha > before);
    }
}
