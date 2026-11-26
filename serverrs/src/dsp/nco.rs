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
/// Number of frequency steps used to glide from the old offset to the new one.
/// Each step is phase-continuous, so the result is a short, smooth sweep
/// instead of an instantaneous frequency jump.
const RAMP_SEGMENTS: u32 = 16;

pub struct NcoBlock {
    /// Final (target) offset, in Hz.
    offset_hz: f64,
    /// Offset currently applied, in Hz. Differs from `offset_hz` while a
    /// smooth retune is in progress.
    current_hz: f64,
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

    // Smooth-retune state. The ramp is a small number of phase-continuous
    // fixed-frequency segments; only the segment boundaries recompute lanes
    // (no per-sample trig on the hot path).
    ramp_from_hz: f64,
    ramp_segments_done: u32,
    ramp_seg_samples: usize,
    ramp_seg_remaining: usize,
}

impl NcoBlock {
    pub fn new(offset_hz: f64) -> Self {
        Self {
            offset_hz,
            current_hz: offset_hz,
            sample_rate: 0.0,
            phasor: Complex::new(1.0, 0.0),
            step: Complex::new(1.0, 0.0),
            block_step: Complex::new(1.0, 0.0),
            lanes: [Complex32::new(1.0, 0.0); LANES],
            renorm_count: 0,
            ramp_from_hz: offset_hz,
            ramp_segments_done: RAMP_SEGMENTS,
            ramp_seg_samples: 0,
            ramp_seg_remaining: 0,
        }
    }

    /// Jumps to `hz` immediately. The phase is preserved, so this is
    /// continuous at the sample level.
    pub fn set_offset(&mut self, hz: f64) {
        self.offset_hz = hz;
        self.current_hz = hz;
        self.ramp_segments_done = RAMP_SEGMENTS;
        self.ramp_seg_remaining = 0;
        if self.sample_rate > 0.0 {
            self.rebuild_step();
        }
    }

    /// Glides from the current offset to `hz` over `ramp_samples` input
    /// samples. Used on user retune so the frequency change is a short sweep
    /// rather than a step at the demodulator input.
    pub fn set_offset_smooth(&mut self, hz: f64, ramp_samples: usize) {
        if ramp_samples == 0 || self.sample_rate <= 0.0 {
            self.set_offset(hz);
            return;
        }
        self.offset_hz = hz;
        self.ramp_from_hz = self.current_hz;
        self.ramp_segments_done = 0;
        self.ramp_seg_samples = (ramp_samples / RAMP_SEGMENTS as usize).max(LANES);
        self.ramp_seg_remaining = self.ramp_seg_samples;
        self.apply_ramp_step();
    }

    pub fn offset_hz(&self) -> f64 {
        self.offset_hz
    }

    fn rebuild_step(&mut self) {
        self.rebuild_for(self.offset_hz);
    }

    fn rebuild_for(&mut self, hz: f64) {
        let w = 2.0 * PI * hz / self.sample_rate;
        // e^{-jw}, matching `out = in * e^{-j phase}`.
        self.step = Complex::new(w.cos(), -w.sin());

        let mut p = Complex::new(1.0f64, 0.0);
        for lane in self.lanes.iter_mut() {
            *lane = Complex32::new(p.re as f32, p.im as f32);
            p *= self.step;
        }
        self.block_step = p;
    }

    /// Computes the fixed step for the segment that is about to run.
    fn apply_ramp_step(&mut self) {
        let done = self.ramp_segments_done + 1;
        let hz = if done >= RAMP_SEGMENTS {
            self.offset_hz
        } else {
            let t = done as f64 / RAMP_SEGMENTS as f64;
            self.ramp_from_hz + (self.offset_hz - self.ramp_from_hz) * t
        };
        self.current_hz = hz;
        self.rebuild_for(hz);
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
        self.current_hz = self.offset_hz;
        self.ramp_segments_done = RAMP_SEGMENTS;
        self.ramp_seg_remaining = 0;
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
        self.current_hz = self.offset_hz;
        self.ramp_segments_done = RAMP_SEGMENTS;
        self.ramp_seg_remaining = 0;
    }
}

impl NcoBlock {
    /// Shifts `buf` by the NCO in place. Avoids allocating an output buffer
    /// and a full copy per chunk.
    pub fn process_complex_into(&mut self, buf: &mut [Complex32]) {
        if self.ramp_seg_remaining > 0 || self.ramp_segments_done < RAMP_SEGMENTS {
            self.process_ramped(buf);
        } else {
            self.mix_fast(buf);
        }
    }

    /// Runs a smooth retune: a handful of phase-continuous fixed-frequency
    /// segments, then the regular fast path for the remainder of the buffer.
    fn process_ramped(&mut self, buf: &mut [Complex32]) {
        let mut pos = 0;
        while pos < buf.len() {
            if self.ramp_seg_remaining == 0 {
                self.ramp_segments_done += 1;
                if self.ramp_segments_done >= RAMP_SEGMENTS {
                    // Ramp finished — snap to the exact target and use the
                    // normal mixer for the rest of this chunk.
                    self.ramp_segments_done = RAMP_SEGMENTS;
                    self.current_hz = self.offset_hz;
                    self.rebuild_step();
                    self.mix_fast(&mut buf[pos..]);
                    return;
                }
                self.ramp_seg_remaining = self.ramp_seg_samples;
                self.apply_ramp_step();
            }
            let n = self.ramp_seg_remaining.min(buf.len() - pos);
            self.mix_fast(&mut buf[pos..pos + n]);
            self.ramp_seg_remaining -= n;
            pos += n;
        }
    }

    /// Existing block-wise mixer for a fixed offset.
    fn mix_fast(&mut self, buf: &mut [Complex32]) {
        if buf.is_empty() {
            return;
        }
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

        // Tail shorter than one lane block: advance the phasor per sample so
        // the partial block stays phase-correct. (A single shared phase here
        // caused a small phase jump whenever a chunk was not a multiple of 8.)
        for x in &mut buf[whole..] {
            let base = Complex32::new(self.phasor.re as f32, self.phasor.im as f32);
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

    #[test]
    fn smooth_retune_is_phase_continuous_and_hits_target() {
        let mut nco = NcoBlock::new(0.0);
        nco.init(48_000.0).unwrap();
        let mut buf = vec![Complex32::new(1.0, 0.0); 4096];
        nco.process_complex_into(&mut buf);
        nco.set_offset_smooth(1000.0, 960);
        assert_eq!(nco.offset_hz(), 1000.0);
        // Largest sample-to-sample phase step must stay bounded: the ramp is a
        // glide, not a jump.
        let mut prev = buf[4095];
        let mut max_step = 0.0f32;
        let mut max_idx = 0usize;
        let mut out = vec![Complex32::new(1.0, 0.0); 4096];
        nco.process_complex_into(&mut out);
        for (i, s) in out.iter().enumerate() {
            let d = (*s - prev).norm();
            if d > max_step {
                max_step = d;
                max_idx = i;
            }
            prev = *s;
        }
        assert!(max_step < 0.2, "max phase step {max_step} at {max_idx}");
        // Once the ramp is done, the NCO must sit on the requested offset.
        let probe = nco.process_complex(&vec![Complex32::new(1.0, 0.0); 64]);
        let rot = probe[32] * probe[33].conj();
        let expected = 2.0 * std::f64::consts::PI * 1000.0 / 48_000.0;
        let got = rot.arg() as f64;
        assert!((got - expected).abs() < 0.01, "offset {got} != {expected}");
    }
}
