//! Polyphase decimator with windowed-sinc anti-alias FIR.
//!
//! Mirrors `serverng/internal/dsp/decimate.go`.

use std::f64::consts::PI;

use num_complex::Complex32;

use super::block::ProcessorBlock;

const MAX_FIR_TAPS_FACTOR_SCALE: usize = 256;

pub struct DecimateBlock {
    factor: usize,
    /// Prototype low-pass taps (symmetric windowed sinc).
    taps: Vec<f32>,
    /// Input history, at least `taps.len()-1` samples carried between calls.
    buf: Vec<Complex32>,
    prototype_len: usize,
    input_rate: f64,
    bandwidth_hz: i32,
}

/// Complex dot product with independent accumulators. A single accumulator is
/// one long dependency chain; eight let the multiplies overlap and give the
/// compiler something to vectorise.
#[inline]
fn dot(window: &[Complex32], taps: &[f32]) -> Complex32 {
    const ACC: usize = 8;
    let mut acc = [Complex32::default(); ACC];
    let mut ws = window.chunks_exact(ACC);
    let mut ts = taps.chunks_exact(ACC);
    for (xs, tt) in (&mut ws).zip(&mut ts) {
        for i in 0..ACC {
            acc[i].re += xs[i].re * tt[i];
            acc[i].im += xs[i].im * tt[i];
        }
    }
    let mut sum = Complex32::default();
    for a in acc {
        sum += a;
    }
    for (x, &t) in ws.remainder().iter().zip(ts.remainder()) {
        sum.re += x.re * t;
        sum.im += x.im * t;
    }
    sum
}

impl DecimateBlock {
    pub fn new(factor: usize) -> Self {
        Self {
            factor,
            taps: Vec::new(),
            buf: Vec::new(),
            prototype_len: 0,
            input_rate: 0.0,
            bandwidth_hz: 0,
        }
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    pub fn set_bandwidth(&mut self, hz: i32) {
        self.bandwidth_hz = hz;
        if self.factor <= 1 || self.prototype_len == 0 || self.input_rate <= 0.0 {
            return;
        }
        let taps = self.estimate_tap_count(hz);
        self.init_from_prototype(taps, hz);
    }

    /// Original prototype filter taps (used by tests).
    pub fn prototype_taps(&self) -> Vec<f32> {
        self.taps.clone()
    }

    fn init_from_prototype(&mut self, orig_taps: usize, bandwidth_hz: i32) {
        self.prototype_len = orig_taps;
        self.taps = self.design_anti_alias_fir(orig_taps, bandwidth_hz);
        self.buf.clear();
    }

    fn estimate_tap_count(&self, bandwidth_hz: i32) -> usize {
        let mut n = self.factor * 5 + 1;
        if n < 31 {
            n = 31;
        }
        if bandwidth_hz > 0 && self.input_rate > 0.0 {
            let output_nyquist = self.input_rate / self.factor as f64 / 2.0;
            let passband_hz = bandwidth_hz as f64 / 2.0;
            if passband_hz < output_nyquist {
                let transition_hz = output_nyquist - passband_hz;
                if transition_hz > 0.0 {
                    let min_taps = (4.0 * self.input_rate / transition_hz) as usize;
                    if min_taps > n {
                        n = min_taps;
                    }
                }
            }
        }
        let cap_taps = (MAX_FIR_TAPS_FACTOR_SCALE * self.factor + 9) / 10;
        if n > cap_taps {
            n = cap_taps;
        }
        if n % 2 == 0 {
            n += 1;
        }
        n
    }

    fn design_anti_alias_fir(&self, num_taps: usize, bandwidth_hz: i32) -> Vec<f32> {
        let mut cutoff = 0.5 / self.factor as f64;
        if bandwidth_hz > 0 && self.input_rate > 0.0 {
            let c = bandwidth_hz as f64 / 2.0 / self.input_rate;
            if c > 0.0 && c < cutoff {
                cutoff = c;
            }
        }
        let mut taps = vec![0.0f32; num_taps];
        let m = (num_taps - 1) as f64 / 2.0;
        let mut sum = 0.0f64;
        for (i, tap) in taps.iter_mut().enumerate() {
            let x = i as f64 - m;
            let sinc = if x.abs() < 1e-12 {
                2.0 * PI * cutoff
            } else {
                (2.0 * PI * cutoff * x).sin() / x
            };
            let fi = i as f64;
            let fn_ = (num_taps - 1) as f64;
            let w = 0.35875 - 0.48829 * (2.0 * PI * fi / fn_).cos()
                + 0.14128 * (4.0 * PI * fi / fn_).cos()
                - 0.01168 * (6.0 * PI * fi / fn_).cos();
            *tap = (sinc * w) as f32;
            sum += *tap as f64;
        }
        for tap in &mut taps {
            *tap = (*tap as f64 / sum) as f32;
        }
        taps
    }
}

impl ProcessorBlock for DecimateBlock {
    fn name(&self) -> &'static str {
        "decimate"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate / self.factor as f64
    }

    fn init(&mut self, sample_rate: f64) -> anyhow::Result<()> {
        if self.factor <= 1 {
            self.taps.clear();
            return Ok(());
        }
        self.input_rate = sample_rate;
        let taps = self.estimate_tap_count(self.bandwidth_hz);
        self.init_from_prototype(taps, self.bandwidth_hz);
        Ok(())
    }

    fn process_complex(&mut self, input: &[Complex32]) -> Vec<Complex32> {
        if self.factor <= 1 || self.taps.is_empty() {
            return input.to_vec();
        }

        self.buf.extend_from_slice(input);
        let n = self.taps.len();
        let f = self.factor;

        // Align the first output with the old polyphase delay line: its first
        // output had `first_out = (p-1)*f + (n-1)%f` samples in, i.e. its
        // window ended one sample later than a window starting at zero.
        let p = n.div_ceil(f);
        let delta = ((p - 1) * f + (n - 1) % f) - (n - 1);

        let mut out = Vec::new();
        if self.buf.len() > delta && self.buf.len() - delta >= n {
            let count = (self.buf.len() - delta - n) / f + 1;
            out.reserve(count);
            for o in 0..count {
                let base = delta + o * f;
                out.push(dot(&self.buf[base..base + n], &self.taps));
            }
            let consumed = delta + count * f;
            self.buf.drain(..consumed);
        }
        out
    }

    fn reset(&mut self) {
        self.buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: f64, n: usize) -> Vec<Complex32> {
        (0..n)
            .map(|i| {
                let a = 2.0 * std::f64::consts::PI * freq * i as f64 / rate;
                Complex32::new(a.cos() as f32, a.sin() as f32)
            })
            .collect()
    }

    fn rms(v: &[Complex32]) -> f64 {
        (v.iter().map(|c| (c.re * c.re + c.im * c.im) as f64).sum::<f64>() / v.len() as f64).sqrt()
    }

    #[test]
    fn decimates_by_factor() {
        let mut d = DecimateBlock::new(10);
        d.init(2_400_000.0).unwrap();
        let input = tone(10_000.0, 2_400_000.0, 24_000);
        let out = d.process_complex(&input);
        assert!((out.len() as i64 - 2395).abs() <= 2, "{}", out.len());
        // Passband tone survives.
        assert!(rms(&out[100..]) > 0.5, "{}", rms(&out[100..]));
    }

    #[test]
    fn rejects_alias_tone() {
        let mut d = DecimateBlock::new(10);
        d.init(2_400_000.0).unwrap();
        // 0.25 normalized = 600 kHz: 5x cutoff, deep stopband. Mirrors the Go
        // aliasing-rejection test.
        let input = tone(600_000.0, 2_400_000.0, 24_000);
        let out = d.process_complex(&input);
        let avg_mag: f64 = out
            .iter()
            .map(|c| ((c.re as f64) * (c.re as f64) + (c.im as f64) * (c.im as f64)).sqrt())
            .sum::<f64>()
            / out.len() as f64;
        assert!(avg_mag < 0.001, "{avg_mag}");
    }

    #[test]
    fn prototype_is_odd_and_normalized() {
        let mut d = DecimateBlock::new(10);
        d.init(2_400_000.0).unwrap();
        let taps = d.prototype_taps();
        assert!(taps.len() % 2 == 1);
        let sum: f32 = taps.iter().sum();
        assert!((sum - 1.0).abs() < 1e-3, "{sum}");
    }

    #[test]
    fn chunk_boundaries_match() {
        let mut a = DecimateBlock::new(7);
        a.init(1_000_000.0).unwrap();
        let mut b = DecimateBlock::new(7);
        b.init(1_000_000.0).unwrap();
        let input = tone(5000.0, 1_000_000.0, 7000);
        let all = a.process_complex(&input);
        let mut split = Vec::new();
        for chunk in input.chunks(333) {
            split.extend(b.process_complex(chunk));
        }
        assert_eq!(all.len(), split.len());
        for (x, y) in all.iter().zip(split.iter()) {
            assert!((x - y).norm() < 1e-3);
        }
    }
}
