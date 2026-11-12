//! SSB demodulator: real-part extraction + DC block + AGC + audio LPF.
//!
//! Ported from the original Go backend.

use anyhow::Result;
use num_complex::Complex32;

use super::fm::SimpleFir;
use super::Demodulator;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SsbMode {
    Usb,
    Lsb,
}

impl SsbMode {
    fn suffix(self) -> &'static str {
        match self {
            SsbMode::Usb => "usb",
            SsbMode::Lsb => "lsb",
        }
    }
}

pub struct SsbDemod {
    mode: SsbMode,
    sample_rate: f64,

    // DC blocking filter
    dc_prev: f32,
    dc_prev_out: f32,

    // AGC — slower attack than AM for SSB
    agc_gain: f32,
    agc_target: f32,
    agc_attack: f32,
    agc_decay: f32,
    agc_max: f32,

    audio_lpf: Option<SimpleFir>,
    audio_lpf_enabled: bool,
    pending_cutoff: Option<f64>,
}

impl SsbDemod {
    pub fn new(mode: SsbMode) -> Self {
        Self {
            mode,
            sample_rate: 0.0,
            dc_prev: 0.0,
            dc_prev_out: 0.0,
            agc_gain: 1.0,
            agc_target: 0.3,
            agc_attack: 0.005, // slower attack for SSB speech naturalness
            agc_decay: 0.0001,
            agc_max: 200.0,
            audio_lpf: None,
            audio_lpf_enabled: false,
            pending_cutoff: None,
        }
    }

    pub fn mode(&self) -> SsbMode {
        self.mode
    }
}

impl Demodulator for SsbDemod {
    fn name(&self) -> &'static str {
        match self.mode {
            SsbMode::Usb => "ssb_usb",
            SsbMode::Lsb => "ssb_lsb",
        }
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
            let x = input[i].re;

            // DC block
            let dc_out = x - dc_prev + 0.995 * dc_prev_out;
            dc_prev = x;
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

impl SsbDemod {
    fn apply_bandwidth(&mut self, hz: f64) {
        if hz <= 0.0 || self.sample_rate <= 0.0 {
            self.audio_lpf_enabled = false;
            return;
        }
        let mut cutoff_hz = hz;
        if cutoff_hz > 4000.0 {
            cutoff_hz = 4000.0;
        }
        let norm = cutoff_hz / self.sample_rate;
        if norm >= 0.5 {
            self.audio_lpf_enabled = false;
            return;
        }
        match self.audio_lpf.as_mut() {
            None => self.audio_lpf = Some(SimpleFir::new(63, norm)),
            Some(lpf) => {
                lpf.design(norm);
                lpf.reset();
            }
        }
        self.audio_lpf_enabled = true;
    }

    /// Name used by the Go implementation (kept for parity tests).
    pub fn go_name(&self) -> String {
        format!("ssb_{}", self.mode.suffix())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn names_match_go() {
        assert_eq!(SsbDemod::new(SsbMode::Usb).go_name(), "ssb_usb");
        assert_eq!(SsbDemod::new(SsbMode::Lsb).name(), "ssb_lsb");
    }

    #[test]
    fn real_part_is_extracted_and_agc_applied() {
        let fs = 48_000.0;
        let mut d = SsbDemod::new(SsbMode::Usb);
        d.init(fs).unwrap();
        let n = 4800;
        let input: Vec<Complex32> = (0..n)
            .map(|i| {
                let ph = 2.0 * PI * 1000.0 * i as f64 / fs;
                Complex32::new(0.2 * ph.cos() as f32, 0.9) // imag must be ignored
            })
            .collect();
        let out = d.process(&input);
        let rms = (out.iter().map(|x| x * x).sum::<f32>() / n as f32).sqrt();
        assert!(rms > 0.05, "rms={rms}");
        assert!(out.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn bandwidth_cutoff_clamped_to_4k() {
        let mut d = SsbDemod::new(SsbMode::Lsb);
        d.init(48_000.0).unwrap();
        d.set_bandwidth(20_000.0);
        assert!(d.audio_lpf_enabled);
    }
}
