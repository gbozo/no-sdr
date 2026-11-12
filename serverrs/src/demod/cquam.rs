//! Motorola C-QUAM AM stereo demodulator.
//!
//! Ported from the original Go backend.

use std::f64::consts::PI;

use anyhow::Result;
use num_complex::Complex32;

use super::{fast_atan2, Demodulator};

/// Approximation of `1/sqrt(x)` (Quake fast inverse square root + one
/// Newton-Raphson step).
fn inv_sqrt32(x: f32) -> f32 {
    let i = 0x5f3759dfu32.wrapping_sub(x.to_bits() >> 1);
    let y = f32::from_bits(i);
    y * (1.5 - 0.5 * x * y * y)
}

fn sqrt_mag32(re: f32, im: f32) -> f32 {
    (re * re + im * im).sqrt()
}

pub struct CquamDemod {
    sample_rate: f64,

    // PLL VCO state (complex)
    vco_re: f32,
    vco_im: f32,
    omega2: f32,
    alpha: f32,
    beta: f32,

    // cos(gamma) from C-QUAM decode
    cos_gamma: f32,

    // 25 Hz Goertzel pilot detection
    g_coeff: f32,
    g_s1: f32,
    g_s2: f32,
    g_block_size: usize,
    g_sample_count: usize,
    pilot_mag: f32,
    lock_level: f32,

    // DC blocking filter per channel: y = x - x_prev + 0.995 * y_prev
    dc_prev_l: f32,
    dc_prev_out_l: f32,
    dc_prev_r: f32,
    dc_prev_out_r: f32,

    // AGC per channel
    agc_gain_l: f32,
    agc_gain_r: f32,
    agc_target: f32,
    agc_attack: f32,
    agc_decay: f32,
    agc_max: f32,
}

impl Default for CquamDemod {
    fn default() -> Self {
        Self::new()
    }
}

impl CquamDemod {
    pub fn new() -> Self {
        Self {
            sample_rate: 0.0,
            vco_re: 1.0,
            vco_im: 0.0,
            omega2: 0.0,
            alpha: 0.0,
            beta: 0.0,
            cos_gamma: 1.0,
            g_coeff: 0.0,
            g_s1: 0.0,
            g_s2: 0.0,
            g_block_size: 0,
            g_sample_count: 0,
            pilot_mag: 0.0,
            lock_level: 0.0,
            dc_prev_l: 0.0,
            dc_prev_out_l: 0.0,
            dc_prev_r: 0.0,
            dc_prev_out_r: 0.0,
            agc_gain_l: 1.0,
            agc_gain_r: 1.0,
            agc_target: 0.3,
            agc_attack: 0.01,
            agc_decay: 0.0001,
            agc_max: 100.0,
        }
    }

    pub fn is_locked(&self) -> bool {
        self.lock_level > 0.5
    }

    pub fn lock_level(&self) -> f32 {
        self.lock_level
    }

    pub fn pilot_mag(&self) -> f32 {
        self.pilot_mag
    }

    pub fn cos_gamma(&self) -> f32 {
        self.cos_gamma
    }
}

impl Demodulator for CquamDemod {
    fn name(&self) -> &'static str {
        "cquam"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> Result<()> {
        self.sample_rate = sample_rate;

        // PLL: 2nd order, zeta=0.707, omegaN=100 rad/s.
        let omega_n = 100.0 / self.sample_rate;
        let zeta = 0.707;
        self.alpha = (2.0 * zeta * omega_n) as f32;
        self.beta = (omega_n * omega_n) as f32;

        self.vco_re = 1.0;
        self.vco_im = 0.0;
        self.omega2 = 0.0;
        self.cos_gamma = 1.0;

        // 25 Hz Goertzel: block size for ~25 Hz resolution.
        self.g_block_size = (self.sample_rate / 25.0) as usize;
        if self.g_block_size < 64 {
            self.g_block_size = 64;
        }
        let k = 25.0 * self.g_block_size as f64 / self.sample_rate;
        self.g_coeff = (2.0 * (2.0 * PI * k / self.g_block_size as f64).cos()) as f32;
        self.g_s1 = 0.0;
        self.g_s2 = 0.0;
        self.g_sample_count = 0;
        self.pilot_mag = 0.0;
        self.lock_level = 0.0;

        self.dc_prev_l = 0.0;
        self.dc_prev_out_l = 0.0;
        self.dc_prev_r = 0.0;
        self.dc_prev_out_r = 0.0;

        self.agc_gain_l = 1.0;
        self.agc_gain_r = 1.0;

        Ok(())
    }

    fn process(&mut self, input: &[Complex32]) -> Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; 2 * n];

        let mut vco_re = self.vco_re;
        let mut vco_im = self.vco_im;
        let mut omega2 = self.omega2;
        let alpha = self.alpha;
        let beta = self.beta;
        let mut g_s1 = self.g_s1;
        let mut g_s2 = self.g_s2;
        let mut g_count = self.g_sample_count;
        let mut pilot_mag = self.pilot_mag;
        let g_coeff = self.g_coeff;
        let g_block_size = self.g_block_size;

        let mut dc_prev_l = self.dc_prev_l;
        let mut dc_prev_out_l = self.dc_prev_out_l;
        let mut dc_prev_r = self.dc_prev_r;
        let mut dc_prev_out_r = self.dc_prev_out_r;

        let mut gain_l = self.agc_gain_l;
        let mut gain_r = self.agc_gain_r;
        let target = self.agc_target;
        let attack = self.agc_attack;
        let decay = self.agc_decay;
        let max_gain = self.agc_max;

        for i in 0..n {
            let in_re = input[i].re;
            let in_im = input[i].im;

            // PLL: mix input with the VCO (complex conjugate multiply).
            let mix_re = in_re * vco_re + in_im * vco_im;
            let mix_im = -in_re * vco_im + in_im * vco_re;

            // Phase error.
            let err = fast_atan2(mix_im, mix_re);

            // Loop filter.
            omega2 += beta * err;
            let phase_delta = omega2 + alpha * err;

            // Update the VCO: rotate by phaseDelta.
            let cos_d = (phase_delta as f64).cos() as f32;
            let sin_d = (phase_delta as f64).sin() as f32;
            let new_re = vco_re * cos_d - vco_im * sin_d;
            let new_im = vco_re * sin_d + vco_im * cos_d;

            // Normalize VCO magnitude to prevent drift.
            let mag = inv_sqrt32(new_re * new_re + new_im * new_im);
            vco_re = new_re * mag;
            vco_im = new_im * mag;

            // C-QUAM decode.
            let mut envelope = sqrt_mag32(in_re, in_im);
            if envelope < 1e-10 {
                envelope = 1e-10;
            }
            let cos_gamma = mix_re / envelope;
            let l_plus_r = envelope * cos_gamma;
            let l_minus_r = mix_im;

            let left = (l_plus_r + l_minus_r) * 0.5;
            let right = (l_plus_r - l_minus_r) * 0.5;

            // DC block.
            let dc_out_l = left - dc_prev_l + 0.995 * dc_prev_out_l;
            dc_prev_l = left;
            dc_prev_out_l = dc_out_l;

            let dc_out_r = right - dc_prev_r + 0.995 * dc_prev_out_r;
            dc_prev_r = right;
            dc_prev_out_r = dc_out_r;

            // AGC L.
            let abs_l = (dc_out_l * gain_l).abs();
            if abs_l > target {
                gain_l *= 1.0 - attack;
            } else {
                gain_l *= 1.0 + decay;
            }
            if gain_l > max_gain {
                gain_l = max_gain;
            } else if gain_l < 0.001 {
                gain_l = 0.001;
            }

            // AGC R.
            let abs_r = (dc_out_r * gain_r).abs();
            if abs_r > target {
                gain_r *= 1.0 - attack;
            } else {
                gain_r *= 1.0 + decay;
            }
            if gain_r > max_gain {
                gain_r = max_gain;
            } else if gain_r < 0.001 {
                gain_r = 0.001;
            }

            out[2 * i] = dc_out_l * gain_l;
            out[2 * i + 1] = dc_out_r * gain_r;

            // 25 Hz Goertzel on the L-R signal for pilot detection.
            let s0 = l_minus_r + g_coeff * g_s1 - g_s2;
            g_s2 = g_s1;
            g_s1 = s0;
            g_count += 1;

            if g_count >= g_block_size {
                let power = g_s1 * g_s1 + g_s2 * g_s2 - g_coeff * g_s1 * g_s2;
                let power = power.abs();
                pilot_mag = power.sqrt() / g_block_size as f32;
                g_s1 = 0.0;
                g_s2 = 0.0;
                g_count = 0;
            }
        }

        self.vco_re = vco_re;
        self.vco_im = vco_im;
        self.omega2 = omega2;
        // `cos_gamma` is assigned to a loop local in Go, so the struct field
        // never changes during `Process`; mirror that behaviour by leaving it
        // untouched here.

        self.g_s1 = g_s1;
        self.g_s2 = g_s2;
        self.g_sample_count = g_count;
        self.pilot_mag = pilot_mag;

        self.dc_prev_l = dc_prev_l;
        self.dc_prev_out_l = dc_prev_out_l;
        self.dc_prev_r = dc_prev_r;
        self.dc_prev_out_r = dc_prev_out_r;

        self.agc_gain_l = gain_l;
        self.agc_gain_r = gain_r;

        // Lock level based on pilot magnitude.
        const LOCK_THRESHOLD: f32 = 0.01;
        if pilot_mag > LOCK_THRESHOLD {
            self.lock_level = 0.99 * self.lock_level + 0.01;
        } else {
            self.lock_level = 0.99 * self.lock_level;
        }

        out
    }

    fn reset(&mut self) {
        self.vco_re = 1.0;
        self.vco_im = 0.0;
        self.omega2 = 0.0;
        self.cos_gamma = 1.0;
        self.g_s1 = 0.0;
        self.g_s2 = 0.0;
        self.g_sample_count = 0;
        self.pilot_mag = 0.0;
        self.lock_level = 0.0;
        self.dc_prev_l = 0.0;
        self.dc_prev_out_l = 0.0;
        self.dc_prev_r = 0.0;
        self.dc_prev_out_r = 0.0;
        self.agc_gain_l = 1.0;
        self.agc_gain_r = 1.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inv_sqrt_is_accurate_enough() {
        for &x in &[0.25f32, 1.0, 2.0, 100.0] {
            let got = inv_sqrt32(x);
            let want = 1.0 / x.sqrt();
            assert!((got - want).abs() / want < 1e-2, "x={x} got={got} want={want}");
        }
    }

    #[test]
    fn outputs_stereo_pairs_and_locks_onto_pilot() {
        let fs = 48_000.0;
        let mut d = CquamDemod::new();
        d.init(fs).unwrap();

        // Carrier with a 25 Hz quadrature pilot (the C-QUAM stereo pilot).
        // The lock-level EMA advances once per `process` call, so feed
        // 20 ms chunks like the real pipeline.
        let chunk = 960usize;
        let mut out = Vec::new();
        for c in 0..150 {
            let input: Vec<Complex32> = (0..chunk)
                .map(|k| {
                    let i = c * chunk + k;
                    let t = i as f64 / fs;
                    let pilot = 0.1 * (2.0 * PI * 25.0 * t).sin();
                    Complex32::new(1.0, pilot as f32)
                })
                .collect();
            out.extend(d.process(&input));
        }
        assert_eq!(out.len(), 2 * 150 * chunk);
        assert!(d.lock_level() > 0.5, "lock={}", d.lock_level());
        assert!(out.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn zero_input_is_finite() {
        let mut d = CquamDemod::new();
        d.init(48_000.0).unwrap();
        let out = d.process(&vec![Complex32::new(0.0, 0.0); 1000]);
        assert!(out.iter().all(|x| x.is_finite()));
    }
}
