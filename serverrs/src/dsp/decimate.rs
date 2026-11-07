//! Polyphase decimator with windowed-sinc anti-alias FIR.
//!
//! Mirrors `serverng/internal/dsp/decimate.go`.

use std::f64::consts::PI;

use num_complex::Complex32;

use super::block::ProcessorBlock;

const MAX_FIR_TAPS_FACTOR_SCALE: usize = 256;

pub struct DecimateBlock {
    factor: usize,
    sub_taps: Vec<f32>,
    sub_bufs: Vec<Complex32>,
    sub_pos: Vec<usize>,
    taps_per_sub: usize,
    prototype_len: usize,
    first_out: i64,
    input_rate: f64,
    bandwidth_hz: i32,
    total_in: i64,
}

impl DecimateBlock {
    pub fn new(factor: usize) -> Self {
        Self {
            factor,
            sub_taps: Vec::new(),
            sub_bufs: Vec::new(),
            sub_pos: Vec::new(),
            taps_per_sub: 0,
            prototype_len: 0,
            first_out: 0,
            input_rate: 0.0,
            bandwidth_hz: 0,
            total_in: 0,
        }
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    pub fn set_bandwidth(&mut self, hz: i32) {
        self.bandwidth_hz = hz;
        if self.factor <= 1 || self.sub_taps.is_empty() {
            return;
        }
        let orig_taps = self.estimate_tap_count(hz);
        self.prototype_len = orig_taps;
        let p = orig_taps.div_ceil(self.factor);
        self.taps_per_sub = p;
        self.first_out = ((p - 1) * self.factor + (orig_taps - 1) % self.factor) as i64;
        let proto = self.design_anti_alias_fir(orig_taps, hz);
        let padded = zero_pad_filter(&proto, self.factor);
        self.split_polyphase(&padded);

        let need = self.factor * self.taps_per_sub;
        if need > self.sub_bufs.capacity() {
            self.alloc_delay_lines();
        }
        self.reset();
    }

    /// Original prototype filter taps (used by tests).
    pub fn prototype_taps(&self) -> Vec<f32> {
        if self.sub_taps.is_empty() || self.factor <= 1 {
            return Vec::new();
        }
        let p = self.taps_per_sub;
        let n = self.prototype_len;
        let mut proto = vec![0.0f32; n];
        for phase in 0..self.factor {
            for k in 0..p {
                let idx = phase + k * self.factor;
                if idx < n {
                    proto[idx] = self.sub_taps[phase * p + k];
                }
            }
        }
        proto
    }

    fn init_from_prototype(&mut self, orig_taps: usize, bandwidth_hz: i32) {
        self.prototype_len = orig_taps;
        let p = orig_taps.div_ceil(self.factor);
        self.taps_per_sub = p;
        let proto = self.design_anti_alias_fir(orig_taps, bandwidth_hz);
        let padded = zero_pad_filter(&proto, self.factor);
        self.split_polyphase(&padded);
        self.first_out = ((p - 1) * self.factor + (orig_taps - 1) % self.factor) as i64;
        self.alloc_delay_lines();
        self.reset();
    }

    fn split_polyphase(&mut self, prototype: &[f32]) {
        let m = self.factor;
        let p = self.taps_per_sub;
        let n = prototype.len();
        self.sub_taps = vec![0.0f32; m * p];
        for phase in 0..m {
            for k in 0..p {
                let idx = phase + k * m;
                if idx < n {
                    self.sub_taps[phase * p + k] = prototype[idx];
                }
            }
        }
    }

    fn alloc_delay_lines(&mut self) {
        self.sub_bufs = vec![Complex32::default(); self.factor * self.taps_per_sub];
        self.sub_pos = vec![0usize; self.factor];
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

fn zero_pad_filter(taps: &[f32], factor: usize) -> Vec<f32> {
    let n = taps.len();
    let rem = n % factor;
    if rem == 0 {
        return taps.to_vec();
    }
    let mut padded = taps.to_vec();
    padded.resize(n + factor - rem, 0.0);
    padded
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
            self.sub_taps.clear();
            return Ok(());
        }
        self.input_rate = sample_rate;
        let taps = self.estimate_tap_count(self.bandwidth_hz);
        self.init_from_prototype(taps, self.bandwidth_hz);
        Ok(())
    }

    fn process_complex(&mut self, input: &[Complex32]) -> Vec<Complex32> {
        if self.factor <= 1 || self.sub_taps.is_empty() {
            return input.to_vec();
        }

        let f = self.factor;
        let p = self.taps_per_sub;
        let n = input.len();
        let mut out = Vec::with_capacity(n / f + 2);
        let first_out = self.first_out;

        for (i, &sample) in input.iter().enumerate() {
            let phase = ((self.total_in + i as i64) % f as i64) as usize;
            let wpos = self.sub_pos[phase];
            self.sub_bufs[phase * p + wpos] = sample;
            self.sub_pos[phase] = (wpos + 1) % p;

            let total_idx = self.total_in + i as i64;
            if total_idx >= first_out && (total_idx - first_out) % f as i64 == 0 {
                let mut sum_re = 0.0f32;
                let mut sum_im = 0.0f32;
                for q in 0..f {
                    let q_off = q * p;
                    let mut pos = if self.sub_pos[q] == 0 {
                        p - 1
                    } else {
                        self.sub_pos[q] - 1
                    };
                    for k in 0..p {
                        let coeff = self.sub_taps[q_off + k];
                        let v = self.sub_bufs[q_off + pos];
                        sum_re += v.re * coeff;
                        sum_im += v.im * coeff;
                        pos = if pos == 0 { p - 1 } else { pos - 1 };
                    }
                }
                out.push(Complex32::new(sum_re, sum_im));
            }
        }

        self.total_in += n as i64;
        out
    }

    fn reset(&mut self) {
        self.sub_bufs.fill(Complex32::default());
        self.sub_pos.fill(0);
        self.total_in = 0;
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
