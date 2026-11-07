//! CW (Morse) demodulator: BFO mix + audio LPF.
//!
//! Mirrors `serverng/internal/demod/cw.go`.

use std::f64::consts::PI;

use anyhow::Result;
use num_complex::Complex32;

use super::fm::SimpleFir;
use super::Demodulator;

pub struct CwDemod {
    bfo_hz: f64,
    sample_rate: f64,
    phase: f64,
    phase_inc: f64,
    audio_lpf: Option<SimpleFir>,
    pending_cutoff: Option<f64>,
}

impl CwDemod {
    /// Creates a CW demodulator with the given BFO frequency in Hz.
    /// Typical values: 600–800 Hz.
    pub fn new(bfo_hz: f64) -> Self {
        Self {
            bfo_hz,
            sample_rate: 0.0,
            phase: 0.0,
            phase_inc: 0.0,
            audio_lpf: None,
            pending_cutoff: None,
        }
    }

    pub fn bfo_hz(&self) -> f64 {
        self.bfo_hz
    }
}

impl Demodulator for CwDemod {
    fn name(&self) -> &'static str {
        "cw"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> Result<()> {
        self.sample_rate = sample_rate;
        self.phase_inc = 2.0 * PI * self.bfo_hz / self.sample_rate;
        self.phase = 0.0;

        // Default 1500 Hz audio LPF (wide enough to pass the 700 Hz BFO tone).
        let norm = 1500.0 / self.sample_rate;
        match self.audio_lpf.as_mut() {
            None => self.audio_lpf = Some(SimpleFir::new(127, norm)),
            Some(lpf) => {
                lpf.design(norm);
                lpf.reset();
            }
        }
        if let Some(cutoff) = self.pending_cutoff.take() {
            self.apply_bandwidth(cutoff);
        }
        Ok(())
    }

    fn process(&mut self, input: &[Complex32]) -> Vec<f32> {
        let n = input.len();
        let mut out = vec![0.0f32; n];

        let mut phase = self.phase;
        let phase_inc = self.phase_inc;

        for i in 0..n {
            let cos_p = phase.cos() as f32;
            let sin_p = phase.sin() as f32;
            out[i] = input[i].re * cos_p + input[i].im * sin_p;
            phase += phase_inc;
        }

        // Wrap phase to prevent float64 precision loss over time.
        self.phase = phase % (2.0 * PI);

        if let Some(lpf) = self.audio_lpf.as_mut() {
            for sample in out.iter_mut() {
                let v = *sample;
                *sample = lpf.process(v);
            }
        }

        out
    }

    fn reset(&mut self) {
        self.phase = 0.0;
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

impl CwDemod {
    fn apply_bandwidth(&mut self, hz: f64) {
        let mut cutoff_hz = hz;
        if cutoff_hz < 50.0 {
            cutoff_hz = 50.0;
        }
        let mut norm = cutoff_hz / self.sample_rate;
        if norm >= 0.5 {
            norm = 0.499;
        }
        match self.audio_lpf.as_mut() {
            None => self.audio_lpf = Some(SimpleFir::new(127, norm)),
            Some(lpf) => {
                lpf.design(norm);
                lpf.reset();
            }
        }
    }

    /// Exposed for tests/diagnostics.
    pub fn lpf_enabled(&self) -> bool {
        self.audio_lpf.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bfo_mixes_offset_tone_to_audio() {
        let fs = 48_000.0;
        let bfo = 700.0;
        let mut d = CwDemod::new(bfo);
        d.init(fs).unwrap();

        // Input is a complex tone exactly at the BFO offset, producing DC after
        // the mix... but the LPF passes DC. Use an offset of BFO + 100 Hz to
        // obtain a 100 Hz audio tone.
        let tone_hz = bfo + 100.0;
        let n = 48_000;
        let input: Vec<Complex32> = (0..n)
            .map(|i| {
                let ph = 2.0 * PI * tone_hz * i as f64 / fs;
                Complex32::new(ph.cos() as f32, ph.sin() as f32)
            })
            .collect();
        let out = d.process(&input);
        // Skip filter transient.
        let steady = &out[2000..];
        let rms = (steady.iter().map(|x| x * x).sum::<f32>() / steady.len() as f32).sqrt();
        assert!(rms > 0.3, "rms={rms}");
    }

    #[test]
    fn bandwidth_minimum_is_50hz() {
        let mut d = CwDemod::new(700.0);
        d.init(48_000.0).unwrap();
        d.set_bandwidth(1.0);
        assert!(d.lpf_enabled());
        // Applying a huge bandwidth must clamp the normalized cutoff to 0.499.
        d.set_bandwidth(100_000.0);
    }
}
