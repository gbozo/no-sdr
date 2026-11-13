//! Turning 12 kHz audio into per-symbol tone energy.
//!
//! Two demodulators, for two different jobs. [`Spectra`] is a coarse,
//! FFT-bin-resolution scan built once per candidate start time and then
//! reused for every tone-spacing variant and every base-frequency hypothesis
//! that candidate is scored against — cheap enough to run across a whole
//! search grid. [`goertzel_power`] is the opposite trade: one frequency,
//! exact rather than bin-snapped, used only to refine and then finally
//! measure the handful of candidates the coarse scan's grid narrows the
//! search down to.

use std::f32::consts::PI;
use std::sync::Arc;

use rustfft::{num_complex::Complex32, Fft, FftPlanner};

use crate::decoders::pi4::spec::N_SYMBOLS;

/// Decode sample rate. Matches [`crate::params::DECODE_RATE`] — everything in
/// this crate that works in 12 kHz audio agrees on it, and PI4's own symbol
/// timing is defined against a 12 kHz clock too (166.667 ms = 2000 samples).
pub const SAMPLE_RATE: f32 = 12_000.0;

/// Samples in one symbol: `12000 * 0.166667`s, exactly — the protocol page is
/// explicit that 2000 samples/symbol at 12 kHz is the deliberate choice
/// ("exactly 360 symbol widths per minute").
pub const SYMBOL_SAMPLES: usize = 2000;

/// FFT bin width of a [`Spectra`] built from one symbol's worth of samples:
/// `SAMPLE_RATE / SYMBOL_SAMPLES`, which is also the symbol rate — the
/// orthogonal, matched-filter bin spacing for this waveform.
pub const BIN_HZ: f32 = SAMPLE_RATE / SYMBOL_SAMPLES as f32;

/// A coarse per-symbol power spectrum, [`BIN_HZ`] resolution, computed once
/// for a candidate start sample and reused across every (variant, base
/// frequency) hypothesis scored against it.
///
/// Hann-windowed. A rectangular window is the exact matched filter for a tone
/// that starts and stops on the symbol boundary, but this stage is not
/// measuring one tone at an alignment already known to be right — it is
/// comparing *competing* hypotheses (four tone-spacing variants, a spread of
/// candidate frequencies) against each other, and a rectangular window's
/// slowly-decaying sidelobes (≈−13 dB, falling off as 1/f) let a strong clean
/// signal's leakage splash across enough of the band that a *wrong* variant
/// can score deceptively well by sheer luck of where its hypothesised tones
/// happen to land in that leakage. Measured directly: unwindowed, a
/// synthesised PI4-80 transmission scored 0.996 under the PI4-96 hypothesis
/// (whose search window overlaps PI4-80's) against only 0.93 at its own true
/// alignment — misidentified as the wrong variant outright. Hann's sidelobes
/// fall away fast enough (≈−32 dB and dropping as 1/f³) that the same signal
/// now scores 0.99999 at its true alignment against PI4-96's best (mis)fit of
/// 0.999.
///
/// That is a narrower margin than it looks, and not one to rely on: on a
/// clean enough signal both scores round to 1.0 outright and the ordering
/// between them is decided by nothing at all. The window is worth keeping —
/// it is what turns a confident misidentification into a tie — but what
/// actually makes the search safe is that
/// [`crate::decoders::pi4::decode`]'s coarse stage no longer asks this statistic to
/// pick a winner across variants at all; see `best_per_variant_at_start`.
/// [`goertzel_power`]'s later refinement pass does not have this problem — it
/// is scoring one already-identified alignment, not choosing between several
/// — so it stays unwindowed, the true matched filter.
pub struct Spectra {
    /// Bins per symbol, covering `0..nbins*BIN_HZ` Hz.
    pub nbins: usize,
    /// `mag2[symbol * nbins + bin]`.
    mag2: Vec<f32>,
}

impl Spectra {
    /// Power in `symbol`'s spectrum at the bin nearest `hz`. Out-of-range
    /// (a hypothesis that has drifted past the top of the covered band)
    /// reads as zero rather than panicking — it will simply never win a
    /// sync-score comparison.
    #[inline]
    pub fn power_near(&self, symbol: usize, hz: f32) -> f32 {
        let bin = (hz / BIN_HZ).round();
        if bin < 0.0 || bin as usize >= self.nbins {
            return 0.0;
        }
        self.mag2[symbol * self.nbins + bin as usize]
    }
}

/// Build a plan for the one FFT size this module ever asks for
/// ([`SYMBOL_SAMPLES`]). A coarse search calls [`compute_spectra`] once per
/// start-time candidate — tens to hundreds of times — and planning is not
/// free, so callers that loop build this once and share it rather than
/// letting [`compute_spectra`] plan its own on every call.
pub fn plan() -> Arc<dyn Fft<f32>> {
    FftPlanner::<f32>::new().plan_fft_forward(SYMBOL_SAMPLES)
}

/// Build a [`Spectra`] covering `0..max_hz` for the 146 symbols starting at
/// `start_sample` of `audio`. Missing samples past the end of `audio` (a
/// start time near the end of the buffer) read as silence rather than
/// panicking, so a candidate near the search window's edge is merely a weak
/// one, not a crash.
pub fn compute_spectra(
    fft: &dyn Fft<f32>,
    audio: &[f32],
    start_sample: i64,
    max_hz: f32,
) -> Spectra {
    let nbins = ((max_hz / BIN_HZ).ceil() as usize + 1).min(SYMBOL_SAMPLES / 2);
    let mut mag2 = vec![0.0f32; N_SYMBOLS * nbins];
    let mut buf = vec![Complex32::new(0.0, 0.0); SYMBOL_SAMPLES];
    let window = hann_window();

    for sym in 0..N_SYMBOLS {
        let base = start_sample + (sym * SYMBOL_SAMPLES) as i64;
        for (k, c) in buf.iter_mut().enumerate() {
            let idx = base + k as i64;
            let s = if idx >= 0 {
                audio.get(idx as usize).copied().unwrap_or(0.0)
            } else {
                0.0
            };
            *c = Complex32::new(s * window[k], 0.0);
        }
        fft.process(&mut buf);
        for bin in 0..nbins {
            mag2[sym * nbins + bin] = buf[bin].norm_sqr();
        }
    }
    Spectra { nbins, mag2 }
}

/// A periodic Hann window over [`SYMBOL_SAMPLES`] — see [`Spectra`]'s doc
/// comment for why the coarse scan needs one and the refinement pass does
/// not.
fn hann_window() -> [f32; SYMBOL_SAMPLES] {
    std::array::from_fn(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / SYMBOL_SAMPLES as f32).cos()))
}

/// The Goertzel algorithm: power at one exact frequency over one symbol's
/// samples, without being limited to FFT bin spacing. `samples` need not be
/// exactly [`SYMBOL_SAMPLES`] long (the refinement stage below passes the
/// whole padded window's worth in some callers), and `start_sample` may run
/// past the end of `audio` or before its start, both read as silence.
pub fn goertzel_power(
    audio: &[f32],
    start_sample: i64,
    n: usize,
    sample_rate: f32,
    hz: f32,
) -> f32 {
    let k = hz / sample_rate * n as f32;
    let w = 2.0 * PI * k / n as f32;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for i in 0..n {
        let idx = start_sample + i as i64;
        let x = if idx >= 0 {
            audio.get(idx as usize).copied().unwrap_or(0.0)
        } else {
            0.0
        };
        let s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    let real = s1 - s2 * w.cos();
    let imag = s2 * w.sin();
    real * real + imag * imag
}

/// [`goertzel_power`] at each of a symbol's four candidate tones for a given
/// tone-0 frequency and spacing — the primitive the refinement stage and the
/// final soft-metric extraction both build on.
pub fn symbol_tone_powers(
    audio: &[f32],
    start_sample: i64,
    symbol: usize,
    tone0_hz: f32,
    spacing_hz: f32,
) -> [f32; 4] {
    let base = start_sample + (symbol * SYMBOL_SAMPLES) as i64;
    std::array::from_fn(|t| {
        goertzel_power(
            audio,
            base,
            SYMBOL_SAMPLES,
            SAMPLE_RATE,
            tone0_hz + t as f32 * spacing_hz,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pure tone at an exact bin frequency lands almost entirely in that
    /// bin — the sanity check that `compute_spectra`'s indexing (symbol
    /// stride, bin stride) is not transposed or off by one.
    #[test]
    fn a_pure_tone_concentrates_in_its_own_bin() {
        let target_bin = 100usize;
        let hz = target_bin as f32 * BIN_HZ;
        let n = SYMBOL_SAMPLES * N_SYMBOLS;
        let audio: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * hz * i as f32 / SAMPLE_RATE).sin())
            .collect();
        let spectra = compute_spectra(plan().as_ref(), &audio, 0, 3000.0);
        let at_target = spectra.mag2[target_bin];
        let at_neighbour = spectra.mag2[target_bin + 5];
        assert!(
            at_target > at_neighbour * 50.0,
            "{at_target} vs {at_neighbour}"
        );
    }

    /// Goertzel at the tone's own frequency must dominate Goertzel three tone
    /// spacings away — the four-tone discrimination the whole decoder rests
    /// on.
    #[test]
    fn goertzel_discriminates_the_four_pi4_tones() {
        let spacing = 234.375f32;
        let tone0 = 682.8125f32;
        let sent_tone = 2usize;
        let hz = tone0 + sent_tone as f32 * spacing;
        let n = SYMBOL_SAMPLES;
        let audio: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * hz * i as f32 / SAMPLE_RATE).sin())
            .collect();
        let powers = symbol_tone_powers(&audio, 0, 0, tone0, spacing);
        let winner = (0..4)
            .max_by(|&a, &b| powers[a].partial_cmp(&powers[b]).unwrap())
            .unwrap();
        assert_eq!(winner, sent_tone, "{powers:?}");
    }
}
