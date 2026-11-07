//! Integer-factor band-limited interpolator (anti-imaging).
//!
//! Used by the server-side Opus pipeline to raise SSB/CW demod audio
//! (24 kHz / 12 kHz) to Opus's 48 kHz. Zero-stuffing by `factor` followed by a
//! windowed-sinc low-pass; the taps are normalised and scaled by `factor` so
//! the interpolated signal keeps its amplitude.

use std::f64::consts::PI;

use super::window::new_window;

#[inline]
fn dot(window: &[f32], taps: &[f32]) -> f32 {
    const ACC: usize = 8;
    let mut acc = [0.0f32; ACC];
    let mut ws = window.chunks_exact(ACC);
    let mut ts = taps.chunks_exact(ACC);
    for (xs, tt) in (&mut ws).zip(&mut ts) {
        for i in 0..ACC {
            acc[i] += xs[i] * tt[i];
        }
    }
    let mut sum = 0.0f32;
    for a in acc {
        sum += a;
    }
    for (x, &t) in ws.remainder().iter().zip(ts.remainder()) {
        sum += x * t;
    }
    sum
}

pub struct Interpolator {
    factor: usize,
    taps_rev: Vec<f32>,
    buf: Vec<f32>,
}

impl Interpolator {
    /// `factor` = output rate / input rate (2 for 24→48 kHz, 4 for 12→48 kHz).
    pub fn new(factor: usize) -> Self {
        assert!(factor >= 2);
        let n = 16 * factor + 1;
        let cutoff = 0.5 / factor as f64;
        let m = (n - 1) as f64 / 2.0;

        let mut taps = vec![0.0f32; n];
        let mut sum = 0.0f64;
        let win = new_window("blackman-harris", n).unwrap_or_else(|_| vec![1.0; n]);
        for i in 0..n {
            let x = i as f64 - m;
            let sinc = if x.abs() < 1e-12 {
                2.0 * PI * cutoff
            } else {
                (2.0 * PI * cutoff * x).sin() / x
            };
            taps[i] = (sinc * win[i] as f64) as f32;
            sum += taps[i] as f64;
        }
        // Normalise DC gain, then compensate the 1/factor zero-stuffing loss.
        let gain = factor as f64 / sum;
        for t in &mut taps {
            *t = (*t as f64 * gain) as f32;
        }

        Self {
            factor,
            taps_rev: taps.iter().rev().copied().collect(),
            buf: Vec::new(),
        }
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    /// Appends `factor × input.len()` samples to `out` once the filter is warm.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        self.buf.reserve(input.len() * self.factor);
        for &x in input {
            self.buf.push(x * self.factor as f32);
            for _ in 1..self.factor {
                self.buf.push(0.0);
            }
        }

        let n = self.taps_rev.len();
        if self.buf.len() >= n {
            let count = self.buf.len() - n + 1;
            out.reserve(count);
            for o in 0..count {
                out.push(dot(&self.buf[o..o + n], &self.taps_rev));
            }
            self.buf.drain(..count);
        }
    }

    pub fn reset(&mut self) {
        self.buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: f64, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * PI * freq * i as f64 / rate).sin() as f32)
            .collect()
    }

    #[test]
    fn doubles_rate_and_preserves_tone() {
        let mut up = Interpolator::new(2);
        let input = tone(1000.0, 24_000.0, 4800);
        let mut out = Vec::new();
        up.process(&input, &mut out);
        // Warm-up delay plus 2x samples; allow one filter length of slack.
        assert!(out.len() > input.len() * 2 - 64, "{}", out.len());

        let tail = &out[out.len() - 4096..];
        let mut re = 0.0f64;
        let mut im = 0.0f64;
        let rate = 48_000.0;
        for (k, &s) in tail.iter().enumerate() {
            let t = k as f64 / rate;
            let (sn, cs) = (2.0 * PI * 1000.0 * t).sin_cos();
            re += s as f64 * cs;
            im += s as f64 * sn;
        }
        let mag = (re * re + im * im).sqrt() / tail.len() as f64;
        assert!(mag > 0.4, "1 kHz amplitude {mag}");
    }

    #[test]
    fn chunked_matches_whole() {
        let input = tone(1000.0, 12_000.0, 2400);
        let mut a = Interpolator::new(4);
        let mut whole = Vec::new();
        a.process(&input, &mut whole);

        let mut b = Interpolator::new(4);
        let mut split = Vec::new();
        for chunk in input.chunks(37) {
            b.process(chunk, &mut split);
        }
        assert_eq!(whole.len(), split.len());
        for (x, y) in whole.iter().zip(split.iter()) {
            assert!((x - y).abs() < 1e-5);
        }
    }
}
