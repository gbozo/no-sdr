//! Forward FFT (Cooley-Tukey DIT, paired radix-2 stages).
//!
//! Mirrors `serverng/internal/dsp/fft.go`.

use anyhow::{bail, Result};
use num_complex::Complex32;
use std::f64::consts::PI;

pub struct Fft {
    size: usize,
    twiddles: Vec<Complex32>,
    bitrev: Vec<usize>,
    log2size: u32,
}

impl Fft {
    pub fn new(size: usize) -> Result<Self> {
        if size < 4 || !size.is_power_of_two() {
            bail!("fft: size must be a power of 2 and >= 4");
        }
        let log2size = size.trailing_zeros();
        Ok(Self {
            size,
            twiddles: compute_twiddles(size),
            bitrev: compute_bit_reversal(size, log2size),
            log2size,
        })
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// In-place forward FFT.
    pub fn transform(&self, data: &mut [Complex32]) {
        debug_assert_eq!(data.len(), self.size);
        let n = self.size;

        bit_reversal_permute(data, &self.bitrev);

        let mut s = 0u32;
        // If log2(N) is odd, do one radix-2 stage first.
        if self.log2size & 1 == 1 {
            let mut i = 0;
            while i < n {
                let r0 = data[i];
                let r1 = data[i + 1];
                data[i] = r0 + r1;
                data[i + 1] = r0 - r1;
                i += 2;
            }
            s = 1;
        }

        while s + 1 < self.log2size {
            let halfm1 = 1usize << s;
            let m1 = halfm1 << 1;
            let halfm2 = m1;
            let m2 = halfm2 << 1;
            let tw_base1 = n >> (s + 1);
            let tw_base2 = n >> (s + 2);

            let mut k = 0usize;
            while k < n {
                // First sub-stage.
                for j in 0..halfm1 {
                    let w = self.twiddles[(j * tw_base1) % n];
                    let mut off = 0usize;
                    while off < m2 {
                        let p = k + off + j;
                        let q = p + halfm1;
                        let e = data[p];
                        let o = data[q];
                        let t = o * w;
                        data[p] = e + t;
                        data[q] = e - t;
                        off += m1;
                    }
                }
                // Second sub-stage.
                for j in 0..halfm2 {
                    let w = self.twiddles[(j * tw_base2) % n];
                    let p = k + j;
                    let q = p + halfm2;
                    let e = data[p];
                    let o = data[q];
                    let t = o * w;
                    data[p] = e + t;
                    data[q] = e - t;
                }
                k += m2;
            }
            s += 2;
        }
    }
}

fn compute_bit_reversal(n: usize, bits: u32) -> Vec<usize> {
    (0..n).map(|i| reverse_bits(i, bits)).collect()
}

fn reverse_bits(mut val: usize, bits: u32) -> usize {
    let mut result = 0usize;
    for _ in 0..bits {
        result = (result << 1) | (val & 1);
        val >>= 1;
    }
    result
}

fn compute_twiddles(n: usize) -> Vec<Complex32> {
    (0..n)
        .map(|k| {
            let angle = -2.0 * PI * k as f64 / n as f64;
            Complex32::new(angle.cos() as f32, angle.sin() as f32)
        })
        .collect()
}

fn bit_reversal_permute(data: &mut [Complex32], perm: &[usize]) {
    for i in 0..perm.len() {
        let j = perm[i];
        if i < j {
            data.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive_dft(input: &[Complex32]) -> Vec<Complex32> {
        let n = input.len();
        (0..n)
            .map(|k| {
                let mut sum = Complex32::new(0.0, 0.0);
                for (t, &x) in input.iter().enumerate() {
                    let angle = -2.0 * PI * (k * t) as f64 / n as f64;
                    sum += x * Complex32::new(angle.cos() as f32, angle.sin() as f32);
                }
                sum
            })
            .collect()
    }

    #[test]
    fn matches_naive_dft() {
        for size in [4usize, 8, 16, 32, 64] {
            let input: Vec<Complex32> = (0..size)
                .map(|i| Complex32::new((i as f32 * 0.3).sin(), (i as f32 * 0.7).cos()))
                .collect();
            let mut got = input.clone();
            Fft::new(size).unwrap().transform(&mut got);
            let want = naive_dft(&input);
            for (g, w) in got.iter().zip(want.iter()) {
                assert!((g.re - w.re).abs() < 1e-2, "size {size}: {g} vs {w}");
                assert!((g.im - w.im).abs() < 1e-2, "size {size}: {g} vs {w}");
            }
        }
    }

    #[test]
    fn dc_bin_equals_sum() {
        let size = 16;
        let input: Vec<Complex32> = (0..size).map(|i| Complex32::new(i as f32, 0.0)).collect();
        let mut got = input.clone();
        Fft::new(size).unwrap().transform(&mut got);
        let sum: f32 = input.iter().map(|c| c.re).sum();
        assert!((got[0].re - sum).abs() < 1e-2);
    }

    #[test]
    fn rejects_invalid_size() {
        assert!(Fft::new(3).is_err());
        assert!(Fft::new(2).is_err());
    }
}
