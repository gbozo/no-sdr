//! AM envelope demodulator with DC blocking, AGC, and optional audio LPF.
//!
//! Mirrors `serverng/internal/demod/am.go`.

use anyhow::Result;
use num_complex::Complex32;

use super::fm::SimpleFir;
use super::Demodulator;

pub struct AmDemod {
    sample_rate: f64,

    // DC blocking filter: y = x - x_prev + 0.995 * y_prev
    dc_prev: f32,
    dc_prev_out: f32,

    // Simple AGC: gain tracks target amplitude
    agc_gain: f32,
    agc_target: f32,
    agc_attack: f32,
    agc_decay: f32,
    agc_max: f32,

    // Audio LPF (post-AGC, bandwidth-limiting).
    audio_lpf: Option<SimpleFir>,
    audio_lpf_enabled: bool,
    /// Cutoff hint applied when `init` runs (Go stores it in the pre-init path
    /// only indirectly; kept for parity with the Node version).
    pending_cutoff: Option<f64>,
}

impl Default for AmDemod {
    fn default() -> Self {
        Self::new()
    }
}

impl AmDemod {
    pub fn new() -> Self {
        Self {
            sample_rate: 0.0,
            dc_prev: 0.0,
            dc_prev_out: 0.0,
            agc_gain: 1.0,
            agc_target: 0.3,
            agc_attack: 0.01,
            agc_decay: 0.0001,
            agc_max: 100.0,
            audio_lpf: None,
            audio_lpf_enabled: false,
            pending_cutoff: None,
        }
    }
}

impl Demodulator for AmDemod {
    fn name(&self) -> &'static str {
        "am"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> Result<()> {
        self.sample_rate = sample_rate;
        self.dc_prev = 0.0;
        self.dc_prev_out = 0.0;
        self.agc_gain = 1.0;
        if let Some(cutoff) = self.pending_cutoff.take() {
            self.apply_bandwidth(cutoff);
        }
        Ok(())
    }

    fn process(&mut self, input: &[Complex32]) -> Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];

        let target = self.agc_target;
        let attack = self.agc_attack;
        let decay = self.agc_decay;
        let max_gain = self.agc_max;
        let mut gain = self.agc_gain;
        let mut dc_prev = self.dc_prev;
        let mut dc_prev_out = self.dc_prev_out;

        for i in 0..n {
            let re = input[i].re;
            let im = input[i].im;
            // Envelope detection
            let env = (re * re + im * im).sqrt();

            // DC block
            let dc_out = env - dc_prev + 0.995 * dc_prev_out;
            dc_prev = env;
            dc_prev_out = dc_out;

            // AGC
            let abs_val = (dc_out * gain).abs();
            if abs_val > target {
                gain *= 1.0 - attack;
            } else {
                gain *= 1.0 + decay;
            }
            if gain > max_gain {
                gain = max_gain;
            } else if gain < 0.001 {
                gain = 0.001;
            }
            out[i] = dc_out * gain;
        }

        self.agc_gain = gain;
        self.dc_prev = dc_prev;
        self.dc_prev_out = dc_prev_out;

        if self.audio_lpf_enabled {
            if let Some(lpf) = self.audio_lpf.as_mut() {
                for sample in out.iter_mut() {
                    let v = *sample;
                    *sample = lpf.process(v);
                }
            }
        }

        out
    }

    fn reset(&mut self) {
        self.dc_prev = 0.0;
        self.dc_prev_out = 0.0;
        self.agc_gain = 1.0;
        if let Some(lpf) = self.audio_lpf.as_mut() {
            lpf.reset();
        }
    }

    fn set_bandwidth(&mut self, hz: f64) {
        if self.sample_rate <= 0.0 {
            self.pending_cutoff = Some(hz);
            return;
        }
        self.apply_bandwidth(hz);
    }
}

impl AmDemod {
    fn apply_bandwidth(&mut self, hz: f64) {
        if hz <= 0.0 || self.sample_rate <= 0.0 {
            self.audio_lpf_enabled = false;
            return;
        }
        let mut cutoff_hz = hz / 2.0;
        if cutoff_hz > 5000.0 {
            cutoff_hz = 5000.0;
        }
        let norm = cutoff_hz / self.sample_rate;
        if norm >= 0.5 {
            self.audio_lpf_enabled = false;
            return;
        }
        match self.audio_lpf.as_mut() {
            None => self.audio_lpf = Some(SimpleFir::new(31, norm)),
            Some(lpf) => {
                lpf.design(norm);
                lpf.reset();
            }
        }
        self.audio_lpf_enabled = true;
    }

    /// Current AGC gain (test/diagnostics).
    pub fn agc_gain(&self) -> f32 {
        self.agc_gain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn envelope_am_tone_recovered() {
        let fs = 48_000.0;
        let mut d = AmDemod::new();
        d.init(fs).unwrap();
        // Carrier at 0 Hz with 1 kHz amplitude modulation.
        let n = 48_000;
        let input: Vec<Complex32> = (0..n)
            .map(|i| {
                let m = 0.5 + 0.5 * (2.0 * PI * 1000.0 * i as f64 / fs).sin() as f32;
                Complex32::new(m, 0.0)
            })
            .collect();
        let out = d.process(&input);
        assert_eq!(out.len(), n);
        // Output should contain a 1 kHz component and no large DC.
        let dc: f32 = out.iter().sum::<f32>() / n as f32;
        let rms: f32 = (out.iter().map(|x| x * x).sum::<f32>() / n as f32).sqrt();
        assert!(dc.abs() < 0.05, "dc={dc}");
        assert!(rms > 0.01, "rms={rms}");
    }

    #[test]
    fn bandwidth_sets_lpf_and_rejects_ultrasonic() {
        let fs = 48_000.0;
        let mut d = AmDemod::new();
        d.init(fs).unwrap();
        d.set_bandwidth(10_000.0); // cutoff 5 kHz
        assert!(d.audio_lpf_enabled);
        // Feed a real carrier whose *envelope* is modulated at 15 kHz vs 1 kHz.
        // Envelope detection turns the modulation into audio, which the LPF must
        // then reject above 5 kHz.
        let modulated = |hz: f64, n: usize| -> Vec<Complex32> {
            (0..n)
                .map(|i| {
                    let m = 0.5 + 0.4 * (2.0 * PI * hz * i as f64 / fs).sin() as f32;
                    Complex32::new(m, 0.0)
                })
                .collect()
        };
        let hi = d.process(&modulated(15_000.0, 4096));
        let lo = d.process(&modulated(1_000.0, 4096));
        let rms = |v: &[f32]| (v.iter().map(|x| x * x).sum::<f32>() / v.len() as f32).sqrt();
        assert!(rms(&hi) < rms(&lo) * 0.35, "hi={} lo={}", rms(&hi), rms(&lo));
    }

    #[test]
    fn zero_bandwidth_disables_lpf() {
        let mut d = AmDemod::new();
        d.init(48_000.0).unwrap();
        d.set_bandwidth(0.0);
        assert!(!d.audio_lpf_enabled);
    }
}
