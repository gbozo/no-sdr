//! Numerically controlled oscillator (frequency shift).
//!
//! Uses a block-wise complex phasor recurrence instead of a sine table with
//! per-sample interpolation. The f64 phasor advances once per 8 samples; the
//! samples inside a block are reached from a precomputed lane table, so their
//! complex multiplies are independent and can pipeline/vectorise.
//!
//! Semantics match the previous implementation: `out = in * e^{-j phase}`,
//! phase-continuous across retunes.

use std::f64::consts::PI;

use num_complex::Complex;
use num_complex::Complex32;

use super::block::ProcessorBlock;
use super::fft_processor::INV_U8_SCALE;
#[cfg(target_arch = "x86_64")]
use super::simd;

const LANES: usize = 8;
const RENORM_SAMPLES: u64 = 1 << 16;

pub struct NcoBlock {
    offset_hz: f64,
    sample_rate: f64,
    /// e^{-j phase}, f64 for long-run phase accuracy.
    phasor: Complex<f64>,
    /// e^{-j 2π f / fs}
    step: Complex<f64>,
    /// step^LANES
    block_step: Complex<f64>,
    /// step^0 .. step^{LANES-1} as f32
    lanes: [Complex32; LANES],
    renorm_count: u64,
}

impl NcoBlock {
    pub fn new(offset_hz: f64) -> Self {
        Self {
            offset_hz,
            sample_rate: 0.0,
            phasor: Complex::new(1.0, 0.0),
            step: Complex::new(1.0, 0.0),
            block_step: Complex::new(1.0, 0.0),
            lanes: [Complex32::new(1.0, 0.0); LANES],
            renorm_count: 0,
        }
    }

    pub fn set_offset(&mut self, hz: f64) {
        self.offset_hz = hz;
        if self.sample_rate > 0.0 {
            self.rebuild_step();
        }
    }

    pub fn offset_hz(&self) -> f64 {
        self.offset_hz
    }

    fn rebuild_step(&mut self) {
        let w = 2.0 * PI * self.offset_hz / self.sample_rate;
        // e^{-jw}, matching `out = in * e^{-j phase}`.
        self.step = Complex::new(w.cos(), -w.sin());

        let mut p = Complex::new(1.0f64, 0.0);
        for lane in self.lanes.iter_mut() {
            *lane = Complex32::new(p.re as f32, p.im as f32);
            p *= self.step;
        }
        self.block_step = p;
    }

    #[inline]
    fn renorm(&mut self) {
        self.phasor /= self.phasor.norm();
    }
}

impl ProcessorBlock for NcoBlock {
    fn name(&self) -> &'static str {
        "nco"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> anyhow::Result<()> {
        self.sample_rate = sample_rate;
        self.phasor = Complex::new(1.0, 0.0);
        self.renorm_count = 0;
        self.rebuild_step();
        Ok(())
    }

    fn process_complex(&mut self, input: &[Complex32]) -> Vec<Complex32> {
        let mut out = input.to_vec();
        self.process_complex_into(&mut out);
        out
    }

    fn reset(&mut self) {
        self.phasor = Complex::new(1.0, 0.0);
        self.renorm_count = 0;
    }
}

impl NcoBlock {
    /// Shifts `buf` by the NCO in place. Avoids allocating an output buffer
    /// and a full copy per chunk.
    pub fn process_complex_into(&mut self, buf: &mut [Complex32]) {
        let whole = buf.len() - buf.len() % LANES;

        mix_in_place_run(
            &mut buf[..whole],
            &mut self.phasor,
            self.block_step,
            &self.lanes,
        );

        self.renorm_count += whole as u64;
        if self.renorm_count >= RENORM_SAMPLES {
            self.renorm();
            self.renorm_count = 0;
        }

        let base = Complex32::new(self.phasor.re as f32, self.phasor.im as f32);
        for x in &mut buf[whole..] {
            *x = *x * base;
            self.phasor *= self.step;
        }
    }
}

/// One `LANES`-sample block of the in-place mixer.
#[inline(always)]
fn mix_in_place_portable(
    samples: &mut [Complex32],
    phasor: &mut Complex<f64>,
    block_step: Complex<f64>,
    lanes: &[Complex32; LANES],
) {
    for xs in samples.chunks_exact_mut(LANES) {
        let base = Complex32::new(phasor.re as f32, phasor.im as f32);
        for (x, &lane) in xs.iter_mut().zip(lanes.iter()) {
            *x = *x * (base * lane);
        }
        *phasor *= block_step;
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,fma")]
unsafe fn mix_in_place_avx2(
    samples: &mut [Complex32],
    phasor: &mut Complex<f64>,
    block_step: Complex<f64>,
    lanes: &[Complex32; LANES],
) {
    mix_in_place_portable(samples, phasor, block_step, lanes)
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,avx512vl,avx512dq,avx512bw,fma")]
unsafe fn mix_in_place_avx512(
    samples: &mut [Complex32],
    phasor: &mut Complex<f64>,
    block_step: Complex<f64>,
    lanes: &[Complex32; LANES],
) {
    mix_in_place_portable(samples, phasor, block_step, lanes)
}

#[inline]
fn mix_in_place_run(
    samples: &mut [Complex32],
    phasor: &mut Complex<f64>,
    block_step: Complex<f64>,
    lanes: &[Complex32; LANES],
) {
    #[cfg(target_arch = "x86_64")]
    {
        if simd::avx512() {
            // SAFETY: the CPU reported every feature this copy was built for.
            return unsafe { mix_in_place_avx512(samples, phasor, block_step, lanes) };
        }
        if simd::avx2() {
            // SAFETY: as above.
            return unsafe { mix_in_place_avx2(samples, phasor, block_step, lanes) };
        }
    }
    mix_in_place_portable(samples, phasor, block_step, lanes)
}

/// Fused uint8 -> complex conversion (`(v-127.5)/127.5`).
pub fn convert_u8_iq(raw: &[u8], out: &mut Vec<Complex32>) {
    out.clear();
    out.reserve(raw.len() / 2);
    for pair in raw.chunks_exact(2) {
        out.push(Complex32::new(
            (pair[0] as f32 - 127.5) * INV_U8_SCALE,
            (pair[1] as f32 - 127.5) * INV_U8_SCALE,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shifts_positive_offset_to_dc() {
        let mut nco = NcoBlock::new(1000.0);
        nco.init(48_000.0).unwrap();
        let input: Vec<Complex32> = (0..1024)
            .map(|i| {
                let a = 2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48_000.0;
                Complex32::new(a.cos() as f32, a.sin() as f32)
            })
            .collect();
        let out = nco.process_complex(&input);
        // After mixing down, the signal should be near DC: consecutive samples
        // rotate only slightly.
        let mid = out.len() / 2;
        let prod = out[mid] * out[mid + 1].conj();
        assert!(prod.arg().abs() < 0.2, "residual rotation {}", prod.arg());
    }

    #[test]
    fn retune_is_phase_continuous() {
        let mut nco = NcoBlock::new(0.0);
        nco.init(48_000.0).unwrap();
        let input = vec![Complex32::new(1.0, 0.0); 64];
        let before = nco.process_complex(&input);
        nco.set_offset(1000.0);
        let after = nco.process_complex(&input);
        // No discontinuity larger than a sample step.
        let d = (after[0] - before[63]).norm();
        assert!(d < 0.2, "phase jumped by {d}");
    }
}
