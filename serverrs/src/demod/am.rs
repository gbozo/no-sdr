//! AM envelope demodulator with DC blocking, AGC, and optional audio LPF.
//!
//! Ported from the original Go backend.

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

    // Sharp linear-phase IF selectivity filter (I/Q), applied before the
    // envelope detector. The extractor's Butterworth is only 8th order, which
    // leaves a strong station 5-6 kHz away at roughly -40 to -55 dB; this FIR
    // pushes the adjacent channel into the stopband and stops it capturing the
    // AGC.
    if_i: Option<SimpleFir>,
    if_q: Option<SimpleFir>,
    if_i_in: Vec<f32>,
    if_q_in: Vec<f32>,
    if_i_out: Vec<f32>,
    if_q_out: Vec<f32>,

    // Audio LPF (post-AGC, bandwidth-limiting).
    audio_lpf: Option<SimpleFir>,
    audio_lpf_enabled: bool,
    audio_lpf_buf: Vec<f32>,
    /// Cutoff hint applied when `init` runs (Go stores it in the pre-init path
    /// only indirectly; kept for parity with the Node version).
    pending_cutoff: Option<f64>,
}

/// Taps for the AM IF selectivity filter. At 48 kHz this gives a ~1 kHz
/// transition and >90 dB stopband for negligible CPU.
const IF_TAPS: usize = 191;
/// IF cutoff as a fraction of the requested bandwidth. Slightly above the
/// existing bandwidth/2 edge so the cascaded response keeps the passband.
const IF_CUTOFF_SCALE: f64 = 0.6;

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
            if_i: None,
            if_q: None,
            if_i_in: Vec::new(),
            if_q_in: Vec::new(),
            if_i_out: Vec::new(),
            if_q_out: Vec::new(),
            audio_lpf: None,
            audio_lpf_enabled: false,
            audio_lpf_buf: Vec::new(),
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

        // IF selectivity before the envelope detector. Two real FIRs (I/Q),
        // batched so the hot path stays vectorised and allocation-free.
        let filtered = self.if_i.is_some() && self.if_q.is_some();
        if filtered {
            self.if_i_in.clear();
            self.if_i_in.reserve(n);
            self.if_q_in.clear();
            self.if_q_in.reserve(n);
            for c in input {
                self.if_i_in.push(c.re);
                self.if_q_in.push(c.im);
            }
            self.if_i_out.resize(n, 0.0);
            self.if_q_out.resize(n, 0.0);
            let mut fi = self.if_i.take().unwrap();
            let mut fq = self.if_q.take().unwrap();
            fi.process_batch(&self.if_i_in, &mut self.if_i_out);
            fq.process_batch(&self.if_q_in, &mut self.if_q_out);
            self.if_i = Some(fi);
            self.if_q = Some(fq);
        }

        let target = self.agc_target;
        let attack = self.agc_attack;
        let decay = self.agc_decay;
        let max_gain = self.agc_max;
        let mut gain = self.agc_gain;
        let mut dc_prev = self.dc_prev;
        let mut dc_prev_out = self.dc_prev_out;

        for i in 0..n {
            let (re, im) = if filtered {
                (self.if_i_out[i], self.if_q_out[i])
            } else {
                (input[i].re, input[i].im)
            };
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
                let mut filtered = std::mem::take(&mut self.audio_lpf_buf);
                filtered.clear();
                filtered.resize(out.len(), 0.0);
                lpf.process_batch(&out, &mut filtered);
                std::mem::swap(&mut out, &mut filtered);
                self.audio_lpf_buf = filtered;
            }
        }

        out
    }

    fn reset(&mut self) {
        self.dc_prev = 0.0;
        self.dc_prev_out = 0.0;
        self.agc_gain = 1.0;
        if let Some(fir) = self.audio_lpf.as_mut() {
            fir.reset();
        }
        if let Some(fir) = self.if_i.as_mut() {
            fir.reset();
        }
        if let Some(fir) = self.if_q.as_mut() {
            fir.reset();
        }
        self.if_i_in.clear();
        self.if_q_in.clear();
        self.if_i_out.clear();
        self.if_q_out.clear();
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
            self.if_i = None;
            self.if_q = None;
            return;
        }
        let mut cutoff_hz = hz / 2.0;
        if cutoff_hz > 5000.0 {
            cutoff_hz = 5000.0;
        }
        let norm = cutoff_hz / self.sample_rate;
        if norm >= 0.5 {
            self.audio_lpf_enabled = false;
            self.if_i = None;
            self.if_q = None;
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

        // Sharp IF selectivity: 0.6 * bandwidth keeps the cascaded passband
        // edge near bandwidth/2 while putting the adjacent channel deep into
        // the stopband well before a 9/10 kHz MW neighbour.
        let mut if_cutoff_hz = hz * IF_CUTOFF_SCALE;
        let max_if_cutoff = self.sample_rate * 0.45;
        if if_cutoff_hz > max_if_cutoff {
            if_cutoff_hz = max_if_cutoff;
        }
        let if_norm = if_cutoff_hz / self.sample_rate;
        if if_norm > 0.0 && if_norm < 0.5 {
            match self.if_i.as_mut() {
                None => {
                    self.if_i = Some(SimpleFir::new(IF_TAPS, if_norm));
                    self.if_q = Some(SimpleFir::new(IF_TAPS, if_norm));
                }
                Some(fi) => {
                    fi.design(if_norm);
                    fi.reset();
                    if let Some(fq) = self.if_q.as_mut() {
                        fq.design(if_norm);
                        fq.reset();
                    }
                }
            }
        } else {
            self.if_i = None;
            self.if_q = None;
        }
    }

    /// Whether the sharp IF selectivity filter is active (tests/diagnostics).
    pub fn if_filter_enabled(&self) -> bool {
        self.if_i.is_some() && self.if_q.is_some()
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
        assert!(d.if_filter_enabled());
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

    fn goertzel(samples: &[f32], rate: f64, hz: f64) -> f64 {
        let w = 2.0 * PI * hz / rate;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for &x in samples {
            let s0 = x as f64 + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        ((s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0)).sqrt() * 2.0
            / samples.len() as f64
    }

    /// A strong adjacent carrier 5 kHz away must not dominate the desired
    /// station. The sharp IF FIR should improve the interferer/desired audio
    /// ratio by a wide margin compared with the unfiltered path.
    #[test]
    fn if_filter_rejects_strong_adjacent_carrier() {
        let fs = 48_000.0;
        let n = 48_000; // 1 s
        let make_input = || -> Vec<Complex32> {
            (0..n)
                .map(|i| {
                    let t = i as f64 / fs;
                    let desired = (1.0 + 0.5 * (2.0 * PI * 1_000.0 * t).sin()) * 0.02;
                    let interferer = (1.0 + 0.5 * (2.0 * PI * 1_500.0 * t).sin()) * 0.5;
                    let phase = 2.0 * PI * 5_000.0 * t;
                    Complex32::new(
                        (desired + interferer * phase.cos()) as f32,
                        (interferer * phase.sin()) as f32,
                    )
                })
                .collect()
        };

        let measure = |bandwidth: f64| -> (f64, f64) {
            let mut d = AmDemod::new();
            d.init(fs).unwrap();
            d.set_bandwidth(bandwidth);
            let audio = d.process(&make_input());
            let tail = &audio[audio.len() / 2..];
            (
                goertzel(tail, fs, 1_000.0),
                goertzel(tail, fs, 1_500.0),
            )
        };

        let (d_on, i_on) = measure(6_000.0);
        let (d_off, i_off) = measure(0.0);
        let on_db = 20.0 * (i_on / d_on).log10();
        let off_db = 20.0 * (i_off / d_off).log10();
        assert!(
            on_db < off_db - 15.0,
            "IF filter did not improve adjacent rejection: on={on_db:.1} dB off={off_db:.1} dB"
        );
        assert!(on_db < -10.0, "adjacent audio still too strong: {on_db:.1} dB");
        assert!(d_on > 0.01, "desired audio lost: {d_on}");
    }

    #[test]
    fn zero_bandwidth_disables_lpf() {
        let mut d = AmDemod::new();
        d.init(48_000.0).unwrap();
        d.set_bandwidth(0.0);
        assert!(!d.audio_lpf_enabled);
        assert!(!d.if_filter_enabled());
    }
}
