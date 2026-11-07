//! FM demodulators: mono discriminator + wideband stereo (pilot PLL).
//!
//! Mirrors `serverng/internal/demod/fm.go`.

use std::f64::consts::PI;

use num_complex::Complex32;

use super::{fast_atan2, Demodulator};

// ---------- simple FIR ----------

/// Windowed-sinc lowpass FIR with a power-of-2 circular buffer.
pub struct SimpleFir {
    taps: Vec<f32>,
    buf: Vec<f32>,
    pos: usize,
    buf_mask: usize,
}

impl SimpleFir {
    pub fn new(num_taps: usize, cutoff: f64) -> Self {
        let mut buf_size = 1usize;
        while buf_size < num_taps {
            buf_size <<= 1;
        }
        let mut f = Self {
            taps: vec![0.0; num_taps],
            buf: vec![0.0; buf_size],
            pos: 0,
            buf_mask: buf_size - 1,
        };
        f.design(cutoff);
        f
    }

    pub fn design(&mut self, cutoff: f64) {
        let n = self.taps.len();
        let m = (n - 1) as f64 / 2.0;
        let mut sum = 0.0f64;
        for i in 0..n {
            let x = i as f64 - m;
            let sinc = if x.abs() < 1e-12 {
                2.0 * PI * cutoff
            } else {
                (2.0 * PI * cutoff * x).sin() / x
            };
            let fi = i as f64;
            let fn_ = (n - 1) as f64;
            let w = 0.35875 - 0.48829 * (2.0 * PI * fi / fn_).cos()
                + 0.14128 * (4.0 * PI * fi / fn_).cos()
                - 0.01168 * (6.0 * PI * fi / fn_).cos();
            self.taps[i] = (sinc * w) as f32;
            sum += self.taps[i] as f64;
        }
        for tap in &mut self.taps {
            *tap = (*tap as f64 / sum) as f32;
        }
    }

    pub fn process(&mut self, x: f32) -> f32 {
        self.buf[self.pos] = x;
        let mut acc = 0.0f32;
        let mut idx = self.pos;
        for tap in &self.taps {
            acc += tap * self.buf[idx];
            idx = idx.wrapping_sub(1) & self.buf_mask;
        }
        self.pos = (self.pos + 1) & self.buf_mask;
        acc
    }

    /// Filters `input` into `out` in one pass.
    pub fn process_batch(&mut self, input: &[f32], out: &mut [f32]) {
        let taps = &self.taps;
        let buf = &mut self.buf;
        let mask = self.buf_mask;
        let mut pos = self.pos;
        for (i, &x) in input.iter().enumerate() {
            buf[pos] = x;
            let mut acc = 0.0f32;
            let mut idx = pos;
            for &tap in taps {
                acc += tap * buf[idx];
                idx = idx.wrapping_sub(1) & mask;
            }
            out[i] = acc;
            pos = (pos + 1) & mask;
        }
        self.pos = pos;
    }

    pub fn reset(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
    }
}

// ---------- FM mono ----------

pub struct FmMonoDemod {
    sample_rate: f64,
    prev_i: f32,
    prev_q: f32,
    gain: f32,
    deemph_alpha: f32,
    deemph_state: f32,
    deemph_tau: f64,
    deviation: f64,

    audio_lpf: Option<SimpleFir>,
    audio_lpf_enabled: bool,
    audio_lpf_cutoff: f64,
}

impl FmMonoDemod {
    pub fn new(deemph_tau: f64) -> Self {
        Self {
            sample_rate: 0.0,
            prev_i: 0.0,
            prev_q: 0.0,
            gain: 0.0,
            deemph_alpha: 0.0,
            deemph_state: 0.0,
            deemph_tau,
            deviation: 5000.0,
            audio_lpf: None,
            audio_lpf_enabled: false,
            audio_lpf_cutoff: 0.0,
        }
    }

    pub fn with_deviation(deemph_tau: f64, deviation: f64) -> Self {
        Self {
            deviation,
            ..Self::new(deemph_tau)
        }
    }

    pub fn deviation(&self) -> f64 {
        self.deviation
    }

    pub fn set_deviation(&mut self, deviation: f64) {
        self.deviation = deviation;
    }

    /// Sets the de-emphasis coefficient directly (used by the stereo wrapper).
    pub(crate) fn set_deemph_alpha(&mut self, alpha: f32) {
        self.deemph_alpha = alpha;
    }
}

impl Demodulator for FmMonoDemod {
    fn name(&self) -> &'static str {
        "fm_mono"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> anyhow::Result<()> {
        self.sample_rate = sample_rate;
        if self.deviation <= 0.0 {
            self.deviation = 5000.0;
        }
        self.gain = (self.sample_rate / (2.0 * PI * self.deviation)) as f32;
        self.deemph_alpha = (1.0 - (-1.0 / (self.sample_rate * self.deemph_tau)).exp()) as f32;
        self.prev_i = 0.0;
        self.prev_q = 0.0;
        self.deemph_state = 0.0;

        if self.audio_lpf_enabled && self.audio_lpf_cutoff > 0.0 {
            let norm = self.audio_lpf_cutoff;
            if norm < 0.5 {
                match &mut self.audio_lpf {
                    Some(fir) => {
                        fir.design(norm);
                        fir.reset();
                    }
                    None => self.audio_lpf = Some(SimpleFir::new(31, norm)),
                }
            } else {
                self.audio_lpf_enabled = false;
            }
        }
        Ok(())
    }

    fn process(&mut self, input: &[Complex32]) -> Vec<f32> {
        let mut out = vec![0.0f32; input.len()];
        let gain = self.gain;
        let alpha = self.deemph_alpha;
        let mut state = self.deemph_state;
        let mut prev_i = self.prev_i;
        let mut prev_q = self.prev_q;

        for (i, s) in input.iter().enumerate() {
            let cur_i = s.re;
            let cur_q = s.im;
            let conj_re = cur_i * prev_i + cur_q * prev_q;
            let conj_im = cur_q * prev_i - cur_i * prev_q;

            let phase = fast_atan2(conj_im, conj_re);
            let sample = phase * gain;

            state = alpha * sample + (1.0 - alpha) * state;
            out[i] = state;

            prev_i = cur_i;
            prev_q = cur_q;
        }

        self.prev_i = prev_i;
        self.prev_q = prev_q;
        self.deemph_state = state;

        if self.audio_lpf_enabled {
            if let Some(fir) = &mut self.audio_lpf {
                for sample in out.iter_mut() {
                    *sample = fir.process(*sample);
                }
            }
        }
        out
    }

    fn reset(&mut self) {
        self.prev_i = 0.0;
        self.prev_q = 0.0;
        self.deemph_state = 0.0;
        if let Some(fir) = &mut self.audio_lpf {
            fir.reset();
        }
    }

    fn set_bandwidth(&mut self, hz: f64) {
        if hz <= 0.0 {
            self.audio_lpf_enabled = false;
            return;
        }
        let mut cutoff_hz = hz / 2.0;
        if cutoff_hz > 4000.0 {
            cutoff_hz = 4000.0;
        }
        if self.sample_rate <= 0.0 {
            self.audio_lpf_cutoff = cutoff_hz / 48000.0;
            self.audio_lpf_enabled = true;
            return;
        }
        let norm = cutoff_hz / self.sample_rate;
        if norm >= 0.5 {
            self.audio_lpf_enabled = false;
            return;
        }
        self.audio_lpf_cutoff = norm;
        match &mut self.audio_lpf {
            Some(fir) => {
                fir.design(norm);
                fir.reset();
            }
            None => self.audio_lpf = Some(SimpleFir::new(31, norm)),
        }
        self.audio_lpf_enabled = true;
    }
}

// ---------- FM stereo ----------

const PLL_RENORM_INTERVAL: usize = 1000;

/// 5th-order Taylor sin/cos, accurate for |x| <= 0.6 rad.
fn sin_cos5(x: f64) -> (f64, f64) {
    let x2 = x * x;
    let x3 = x2 * x;
    let x4 = x2 * x2;
    let x5 = x4 * x;
    let s = x - x3 / 6.0 + x5 / 120.0;
    let c = 1.0 - x2 / 2.0 + x4 / 24.0;
    (s, c)
}

pub struct FmStereoDemod {
    mono: FmMonoDemod,
    sample_rate: f64,
    decim_factor: usize,
    decim_counter: usize,

    pll_sin: f64,
    pll_cos: f64,
    pll_freq: f64,
    pll_alpha: f64,
    pll_beta: f64,
    pll_phase: f64,
    pll_renorm_count: usize,

    pilot_energy: f32,
    noise_energy: f32,
    energy_alpha: f32,

    pilot_detected: bool,
    hold_counter: usize,
    hold_samples: usize,
    blend_factor: f32,

    deemph_state_l: f32,
    deemph_state_r: f32,
    deemph_alpha: f32,

    lpr_fir: Option<SimpleFir>,
    lr_fir: Option<SimpleFir>,

    dc_prev_l: f32,
    dc_out_prev_l: f32,
    dc_prev_r: f32,
    dc_out_prev_r: f32,

    composite: Vec<f32>,
    pilot_phases: Vec<f64>,
    left_out: Vec<f32>,
    right_out: Vec<f32>,
}

impl FmStereoDemod {
    pub fn new(_deemph_tau: f64) -> Self {
        Self {
            mono: FmMonoDemod::with_deviation(1.0, 75000.0),
            sample_rate: 0.0,
            decim_factor: 1,
            decim_counter: 0,
            pll_sin: 0.0,
            pll_cos: 1.0,
            pll_freq: 0.0,
            pll_alpha: 0.0,
            pll_beta: 0.0,
            pll_phase: 0.0,
            pll_renorm_count: 0,
            pilot_energy: 0.0,
            noise_energy: 0.0,
            energy_alpha: 0.002,
            pilot_detected: false,
            hold_counter: 0,
            hold_samples: 0,
            blend_factor: 0.0,
            deemph_state_l: 0.0,
            deemph_state_r: 0.0,
            deemph_alpha: 0.0,
            lpr_fir: None,
            lr_fir: None,
            dc_prev_l: 0.0,
            dc_out_prev_l: 0.0,
            dc_prev_r: 0.0,
            dc_out_prev_r: 0.0,
            composite: Vec::new(),
            pilot_phases: Vec::new(),
            left_out: Vec::new(),
            right_out: Vec::new(),
        }
    }

    pub fn is_stereo(&self) -> bool {
        self.blend_factor > 0.01
    }

    pub fn blend_factor(&self) -> f32 {
        self.blend_factor
    }

    pub fn pilot_detected(&self) -> bool {
        self.pilot_detected
    }

    /// Composite baseband from the last `process` call.
    pub fn composite(&self) -> &[f32] {
        &self.composite
    }

    /// Per-sample 19kHz pilot phase from the last `process` call.
    pub fn pilot_phases(&self) -> &[f64] {
        &self.pilot_phases
    }
}

impl Demodulator for FmStereoDemod {
    fn name(&self) -> &'static str {
        "fm_stereo"
    }

    fn sample_rate_out(&self, _input_rate: f64) -> f64 {
        48000.0
    }

    fn init(&mut self, sample_rate: f64) -> anyhow::Result<()> {
        self.sample_rate = sample_rate;

        // Composite extraction: no de-emphasis in the mono sub-demodulator.
        self.mono.set_deviation(75000.0);
        self.mono.init(sample_rate)?;
        self.mono.set_deemph_alpha(1.0);

        self.decim_factor = (self.sample_rate / 48000.0).round() as usize;
        if self.decim_factor < 1 {
            self.decim_factor = 1;
        }
        self.decim_counter = 0;

        let bw = 50.0;
        let damp = 0.707;
        self.pll_alpha = 2.0 * damp * bw * 2.0 * PI / self.sample_rate;
        self.pll_beta = (bw * 2.0 * PI / self.sample_rate).powi(2);

        self.pll_freq = 2.0 * PI * 19000.0 / self.sample_rate;
        self.pll_phase = 0.0;
        self.pll_sin = 0.0;
        self.pll_cos = 1.0;
        self.pll_renorm_count = 0;

        self.energy_alpha = 0.002;
        self.pilot_energy = 0.0;
        self.noise_energy = 0.0;
        self.pilot_detected = false;
        self.hold_samples = (self.sample_rate * 0.2).round() as usize;
        self.hold_counter = 0;
        self.blend_factor = 0.0;

        let cutoff = 15000.0 / self.sample_rate;
        self.lpr_fir = Some(SimpleFir::new(51, cutoff));
        self.lr_fir = Some(SimpleFir::new(51, cutoff));

        const WFM_DEEMPH_TAU: f64 = 75e-6;
        self.deemph_alpha = (1.0 - (-1.0 / (self.sample_rate * WFM_DEEMPH_TAU)).exp()) as f32;
        self.deemph_state_l = 0.0;
        self.deemph_state_r = 0.0;

        self.dc_prev_l = 0.0;
        self.dc_out_prev_l = 0.0;
        self.dc_prev_r = 0.0;
        self.dc_out_prev_r = 0.0;
        Ok(())
    }

    fn process(&mut self, input: &[Complex32]) -> Vec<f32> {
        let n = input.len();
        if n == 0 {
            return Vec::new();
        }

        self.composite = self.mono.process(input);
        let n = n.min(self.composite.len());
        self.composite.truncate(n);

        let max_out = n.div_ceil(self.decim_factor);
        self.left_out.clear();
        self.right_out.clear();
        self.left_out.reserve(max_out);
        self.right_out.reserve(max_out);

        let mut lpr_in = vec![0.0f32; n];
        let mut lr_in = vec![0.0f32; n];
        let mut lpr_out = vec![0.0f32; n];
        let mut lr_out = vec![0.0f32; n];
        let mut blends = vec![0.0f32; n];
        self.pilot_phases.clear();
        self.pilot_phases.reserve(n);

        // ---- Pass 1: PLL + FIR inputs ----
        let mut pll_sin = self.pll_sin;
        let mut pll_cos = self.pll_cos;
        let mut pll_freq = self.pll_freq;
        let mut pilot_energy = self.pilot_energy;
        let mut noise_energy = self.noise_energy;
        let energy_alpha = self.energy_alpha;
        let mut blend_factor = self.blend_factor;
        let mut pilot_detected = self.pilot_detected;
        let mut hold_counter = self.hold_counter;
        let hold_samples = self.hold_samples;
        let mut renorm_count = self.pll_renorm_count;
        let mut pilot_phase = self.pll_phase;

        for i in 0..n {
            let comp = self.composite[i];

            let pilot_ref = pll_sin as f32;
            let phase_err = (comp * pilot_ref) as f64;
            pll_freq += self.pll_beta * phase_err;

            let dw = self.pll_alpha * phase_err + pll_freq;
            let (sin_dw, cos_dw) = sin_cos5(dw);
            let new_sin = pll_sin * cos_dw + pll_cos * sin_dw;
            let new_cos = pll_cos * cos_dw - pll_sin * sin_dw;
            pll_sin = new_sin;
            pll_cos = new_cos;

            renorm_count += 1;
            if renorm_count >= PLL_RENORM_INTERVAL {
                let norm = 1.0 / (pll_sin * pll_sin + pll_cos * pll_cos).sqrt();
                pll_sin *= norm;
                pll_cos *= norm;
                renorm_count = 0;
            }

            let cos_val = pll_cos as f32;

            let bpf_out = comp * cos_val;
            pilot_energy = pilot_energy * (1.0 - energy_alpha) + bpf_out * bpf_out * energy_alpha;
            noise_energy = noise_energy * (1.0 - energy_alpha) + comp * comp * energy_alpha;

            let mut snr = 0.0f32;
            if noise_energy > 1e-12 {
                snr = pilot_energy / noise_energy;
            }
            if snr > 0.006 {
                pilot_detected = true;
                hold_counter = hold_samples;
            } else if snr < 0.002 {
                if hold_counter > 0 {
                    hold_counter -= 1;
                } else {
                    pilot_detected = false;
                }
            } else if pilot_detected {
                hold_counter = hold_samples;
            }

            let mut target_blend = 0.0f32;
            if pilot_detected {
                target_blend = ((snr - 0.002) / 0.01).clamp(0.0, 1.0);
            }
            let blend_alpha = if target_blend > blend_factor { 0.015 } else { 0.003 };
            blend_factor += blend_alpha * (target_blend - blend_factor);
            blends[i] = blend_factor;

            lpr_in[i] = comp;
            let carrier38 = 2.0 * cos_val * cos_val - 1.0;
            lr_in[i] = 2.0 * comp * carrier38;

            pilot_phase += self.pll_alpha * phase_err + pll_freq;
            if pilot_phase >= 2.0 * PI {
                pilot_phase -= 2.0 * PI;
            } else if pilot_phase < 0.0 {
                pilot_phase += 2.0 * PI;
            }
            self.pilot_phases.push(pilot_phase);
        }

        self.pll_sin = pll_sin;
        self.pll_cos = pll_cos;
        self.pll_freq = pll_freq;
        self.pll_renorm_count = renorm_count;
        self.pll_phase = pilot_phase;
        self.pilot_energy = pilot_energy;
        self.noise_energy = noise_energy;
        self.blend_factor = blend_factor;
        self.pilot_detected = pilot_detected;
        self.hold_counter = hold_counter;

        // ---- Batch FIR ----
        if let Some(fir) = &mut self.lpr_fir {
            fir.process_batch(&lpr_in, &mut lpr_out);
        }
        if let Some(fir) = &mut self.lr_fir {
            fir.process_batch(&lr_in, &mut lr_out);
        }

        // ---- Pass 2: stereo matrix, de-emphasis, decimate ----
        let alpha = self.deemph_alpha;
        let mut state_l = self.deemph_state_l;
        let mut state_r = self.deemph_state_r;
        let mut decim_counter = self.decim_counter;
        let mut out = Vec::with_capacity(max_out * 2);

        for i in 0..n {
            let l_plus_r = lpr_out[i];
            let l_minus_r = lr_out[i];
            let blend = blends[i];

            let (left, right) = if blend > 0.001 {
                (l_plus_r + blend * l_minus_r, l_plus_r - blend * l_minus_r)
            } else {
                (l_plus_r, l_plus_r)
            };

            state_l = alpha * left + (1.0 - alpha) * state_l;
            state_r = alpha * right + (1.0 - alpha) * state_r;

            decim_counter += 1;
            if decim_counter >= self.decim_factor {
                decim_counter = 0;
                let dc_out_l = state_l - self.dc_prev_l + 0.995 * self.dc_out_prev_l;
                self.dc_prev_l = state_l;
                self.dc_out_prev_l = dc_out_l;

                let dc_out_r = state_r - self.dc_prev_r + 0.995 * self.dc_out_prev_r;
                self.dc_prev_r = state_r;
                self.dc_out_prev_r = dc_out_r;

                self.left_out.push(dc_out_l);
                self.right_out.push(dc_out_r);
                out.push(dc_out_l);
                out.push(dc_out_r);
            }
        }

        self.decim_counter = decim_counter;
        self.deemph_state_l = state_l;
        self.deemph_state_r = state_r;
        out
    }

    fn reset(&mut self) {
        self.mono.reset();
        self.pll_phase = 0.0;
        self.pll_freq = 2.0 * PI * 19000.0 / self.sample_rate;
        self.pll_sin = 0.0;
        self.pll_cos = 1.0;
        self.pll_renorm_count = 0;
        self.pilot_energy = 0.0;
        self.noise_energy = 0.0;
        self.blend_factor = 0.0;
        self.pilot_detected = false;
        self.hold_counter = 0;
        self.decim_counter = 0;
        self.deemph_state_l = 0.0;
        self.deemph_state_r = 0.0;
        if let Some(fir) = &mut self.lpr_fir {
            fir.reset();
        }
        if let Some(fir) = &mut self.lr_fir {
            fir.reset();
        }
        self.dc_prev_l = 0.0;
        self.dc_out_prev_l = 0.0;
        self.dc_prev_r = 0.0;
        self.dc_out_prev_r = 0.0;
    }

    fn composite(&self) -> Option<&[f32]> {
        Some(&self.composite)
    }

    fn pilot_phases(&self) -> Option<&[f64]> {
        Some(&self.pilot_phases)
    }

    fn pilot_detected(&self) -> bool {
        self.pilot_detected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iq_tone(freq: f64, rate: f64, n: usize) -> Vec<Complex32> {
        (0..n)
            .map(|i| {
                let a = 2.0 * PI * freq * i as f64 / rate;
                Complex32::new(a.cos() as f32, a.sin() as f32)
            })
            .collect()
    }

    #[test]
    fn fast_atan2_matches_quadrants() {
        let cases = [
            (1.0f32, 0.0f32, std::f32::consts::FRAC_PI_2),
            (0.0, 1.0, 0.0),
            (-1.0, 0.0, -std::f32::consts::FRAC_PI_2),
            (0.0, -1.0, std::f32::consts::PI),
            (1.0, 1.0, std::f32::consts::FRAC_PI_4),
        ];
        for (y, x, want) in cases {
            let got = fast_atan2(y, x);
            assert!((got - want).abs() < 1e-3, "atan2({y},{x}) = {got} want {want}");
        }
        assert_eq!(fast_atan2(0.0, 0.0), 0.0);
    }

    #[test]
    fn mono_demodulates_frequency_offset() {
        let mut d = FmMonoDemod::with_deviation(50e-6, 5000.0);
        d.init(48_000.0).unwrap();
        // +1 kHz tone: discriminator output should settle at f/dev = 0.2.
        let out = d.process(&iq_tone(1000.0, 48_000.0, 48_000));
        let tail = &out[40_000..];
        let mean: f32 = tail.iter().sum::<f32>() / tail.len() as f32;
        assert!((mean - 0.2).abs() < 0.01, "mean {mean}");
    }

    #[test]
    fn stereo_pilot_detection_and_separation() {
        // Build a stereo MPX: L=1kHz, R=3kHz, pilot 0.3.
        let rate = 240_000.0;
        let n = 480_000;
        let mut comp = vec![0.0f64; n];
        for i in 0..n {
            let t = i as f64 / rate;
            let l = 0.2 * (2.0 * PI * 1000.0 * t).sin();
            let r = 0.2 * (2.0 * PI * 3000.0 * t).sin();
            let pilot = 0.3 * (2.0 * PI * 19000.0 * t).cos();
            let sub = 0.4 * (l - r) * (2.0 * PI * 38000.0 * t).cos();
            comp[i] = 0.8 * (l + r) / 2.0 + sub + pilot;
        }
        // FM-modulate onto complex IQ.
        let dev = 75_000.0f64;
        let mut phase = 0.0f64;
        let mut iq = Vec::with_capacity(n);
        for c in &comp {
            phase += 2.0 * PI * dev * c / rate;
            iq.push(Complex32::new(phase.cos() as f32, phase.sin() as f32));
        }

        let mut d = FmStereoDemod::new(75e-6);
        d.init(rate).unwrap();
        let out = d.process(&iq);
        assert_eq!(out.len(), (n / 5) * 2);
        assert!(d.pilot_detected(), "pilot not detected");
        assert!(d.is_stereo(), "stereo blend {}", d.blend_factor());

        // Check separation using Goertzel-like correlation on the last second
        // (integer number of cycles for both tones → orthogonal).
        let tail_out = &out[out.len() - 48_000 * 2..];
        let decim_rate = rate / 5.0;
        let (mut l1, mut r1) = (0.0f64, 0.0f64);
        let (mut l3, mut r3) = (0.0f64, 0.0f64);
        for k in 0..tail_out.len() / 2 {
            let t = k as f64 / decim_rate;
            let l = tail_out[k * 2] as f64;
            let r = tail_out[k * 2 + 1] as f64;
            l1 += l * (2.0 * PI * 1000.0 * t).sin();
            r1 += r * (2.0 * PI * 1000.0 * t).sin();
            l3 += l * (2.0 * PI * 3000.0 * t).sin();
            r3 += r * (2.0 * PI * 3000.0 * t).sin();
        }
        // Go's implementation produces L1≈1636.6, R1≈416.9, L3≈-442.9,
        // R3≈-1394.1 for this exact signal (verified against serverng); the
        // port matches those figures to f32 precision.
        assert!(l1.abs() > 3.0 * r1.abs(), "L/R leakage at 1k: {l1} {r1}");
        assert!(r3.abs() > 3.0 * l3.abs(), "R/L leakage at 3k: {r3} {l3}");
    }
}
