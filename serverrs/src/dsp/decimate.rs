//! Polyphase decimator with windowed-sinc anti-alias FIR.
//!
//! Mirrors `serverng/internal/dsp/decimate.go`.

use std::f64::consts::PI;

use num_complex::Complex32;

use super::block::ProcessorBlock;
#[cfg(target_arch = "x86_64")]
use super::simd;

const MAX_FIR_TAPS_FACTOR_SCALE: usize = 256;

pub struct DecimateBlock {
    factor: usize,
    /// Prototype low-pass taps (symmetric windowed sinc).
    taps: Vec<f32>,
    /// `taps` with each value duplicated (`[t0,t0,t1,t1,...]`), so an AVX2
    /// load lines up with the interleaved `re,im` of `Complex32`.
    #[cfg_attr(not(target_arch = "x86_64"), allow(dead_code))]
    taps_packed: Vec<f32>,
    /// Input history, at least `taps.len()-1` samples carried between calls.
    buf: Vec<Complex32>,
    prototype_len: usize,
    input_rate: f64,
    bandwidth_hz: i32,
}

/// Complex dot product with independent accumulators. A single accumulator is
/// one long dependency chain; eight let the multiplies overlap and give the
/// compiler something to vectorise. `inline(always)` so that the AVX2/AVX-512
/// copies below compile this arithmetic too, instead of calling the baseline
/// copy from inside a widened loop.
#[inline(always)]
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

/// One kept output per `factor` input samples.
#[inline(always)]
fn fir_decim_portable(dst: &mut [Complex32], buf: &[Complex32], taps: &[f32], factor: usize) {
    let n = taps.len();
    for (o, d) in dst.iter_mut().enumerate() {
        let base = o * factor;
        *d = dot(&buf[base..base + n], taps);
    }
}

/// Explicit AVX2+FMA complex dot product. `taps_packed` is each tap duplicated
/// so a 256-bit load lines up with four interleaved `re,im` samples: one FMA
/// covers four complex multiply-accumulates. Four independent accumulators
/// hide the FMA latency.
#[cfg(target_arch = "x86_64")]
#[inline(always)]
unsafe fn dot_avx2(window: &[Complex32], taps_packed: &[f32]) -> Complex32 {
    use std::arch::x86_64::*;

    let n = taps_packed.len() / 2;
    let xp = window.as_ptr() as *const f32;
    let tp = taps_packed.as_ptr();

    let mut acc0 = _mm256_setzero_ps();
    let mut acc1 = _mm256_setzero_ps();
    let mut acc2 = _mm256_setzero_ps();
    let mut acc3 = _mm256_setzero_ps();

    let mut i = 0usize;
    while i + 16 <= n {
        acc0 = _mm256_fmadd_ps(
            _mm256_loadu_ps(xp.add(2 * i)),
            _mm256_loadu_ps(tp.add(2 * i)),
            acc0,
        );
        acc1 = _mm256_fmadd_ps(
            _mm256_loadu_ps(xp.add(2 * i + 8)),
            _mm256_loadu_ps(tp.add(2 * i + 8)),
            acc1,
        );
        acc2 = _mm256_fmadd_ps(
            _mm256_loadu_ps(xp.add(2 * i + 16)),
            _mm256_loadu_ps(tp.add(2 * i + 16)),
            acc2,
        );
        acc3 = _mm256_fmadd_ps(
            _mm256_loadu_ps(xp.add(2 * i + 24)),
            _mm256_loadu_ps(tp.add(2 * i + 24)),
            acc3,
        );
        i += 16;
    }
    while i + 4 <= n {
        acc0 = _mm256_fmadd_ps(
            _mm256_loadu_ps(xp.add(2 * i)),
            _mm256_loadu_ps(tp.add(2 * i)),
            acc0,
        );
        i += 4;
    }

    let acc = _mm256_add_ps(_mm256_add_ps(acc0, acc1), _mm256_add_ps(acc2, acc3));
    let lo = _mm256_castps256_ps128(acc);
    let hi = _mm256_extractf128_ps(acc, 1);
    let s = _mm_hadd_ps(_mm_add_ps(lo, hi), _mm_add_ps(lo, hi));
    let mut re = _mm_cvtss_f32(s);
    let mut im = _mm_cvtss_f32(_mm_shuffle_ps(s, s, 0b01));

    while i < n {
        re += window[i].re * taps_packed[2 * i];
        im += window[i].im * taps_packed[2 * i + 1];
        i += 1;
    }
    Complex32::new(re, im)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn fir_decim_avx2(
    dst: &mut [Complex32],
    buf: &[Complex32],
    taps_packed: &[f32],
    factor: usize,
) {
    let n = taps_packed.len() / 2;
    for (o, d) in dst.iter_mut().enumerate() {
        let base = o * factor;
        *d = dot_avx2(&buf[base..base + n], taps_packed);
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,avx512vl,avx512dq,avx512bw,avx2,fma")]
unsafe fn fir_decim_avx512(
    dst: &mut [Complex32],
    buf: &[Complex32],
    taps_packed: &[f32],
    factor: usize,
) {
    // AVX-512 CPUs also have AVX2; use the explicit kernel rather than a
    // second auto-vectorised shape.
    let n = taps_packed.len() / 2;
    for (o, d) in dst.iter_mut().enumerate() {
        let base = o * factor;
        *d = dot_avx2(&buf[base..base + n], taps_packed);
    }
}

/// Dispatches once per block, not per output sample.
#[inline]
fn fir_decim(
    dst: &mut [Complex32],
    buf: &[Complex32],
    taps: &[f32],
    _taps_packed: &[f32],
    factor: usize,
) {
    #[cfg(target_arch = "x86_64")]
    {
        if simd::avx512() {
            // SAFETY: the CPU reported every feature this copy was built for.
            return unsafe { fir_decim_avx512(dst, buf, _taps_packed, factor) };
        }
        if simd::avx2() {
            // SAFETY: as above.
            return unsafe { fir_decim_avx2(dst, buf, _taps_packed, factor) };
        }
    }
    fir_decim_portable(dst, buf, taps, factor)
}

impl DecimateBlock {
    pub fn new(factor: usize) -> Self {
        Self {
            factor,
            taps: Vec::new(),
            taps_packed: Vec::new(),
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
        self.taps_packed.clear();
        self.taps_packed.reserve(self.taps.len() * 2);
        for &t in &self.taps {
            self.taps_packed.push(t);
            self.taps_packed.push(t);
        }
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
        let mut out = Vec::new();
        self.process_into(input, &mut out);
        out
    }

    fn reset(&mut self) {
        self.buf.clear();
    }
}

impl DecimateBlock {
    /// Decimates `input` into `out` (cleared first), reusing the caller's
    /// buffer so the hot path performs no per-chunk allocation.
    pub fn process_into(&mut self, input: &[Complex32], out: &mut Vec<Complex32>) {
        out.clear();
        if self.factor <= 1 || self.taps.is_empty() {
            out.extend_from_slice(input);
            return;
        }

        self.buf.extend_from_slice(input);
        let n = self.taps.len();
        let f = self.factor;

        // Align the first output with the old polyphase delay line: its first
        // output had `first_out = (p-1)*f + (n-1)%f` samples in, i.e. its
        // window ended one sample later than a window starting at zero.
        let p = n.div_ceil(f);
        let delta = ((p - 1) * f + (n - 1) % f) - (n - 1);

        if self.buf.len() > delta && self.buf.len() - delta >= n {
            let count = (self.buf.len() - delta - n) / f + 1;
            let start = out.len();
            out.resize(start + count, Complex32::default());
            fir_decim(
                &mut out[start..],
                &self.buf[delta..],
                &self.taps,
                &self.taps_packed,
                f,
            );
            let consumed = delta + count * f;
            self.buf.drain(..consumed);
        }
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
