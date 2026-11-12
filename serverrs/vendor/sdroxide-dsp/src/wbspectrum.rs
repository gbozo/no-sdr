//! Full-band power spectrum of a real ADC stream.
//!
//! This exists to give a direct-sampling receiver a panadapter across everything
//! it can see at once — 0–32.4 MHz for an RX-888 at 64.8 Msps — rather than only
//! across the ~2 MHz slice the downconverter is tuned to.
//!
//! # Why not reuse the downconverter's FFT
//!
//! [`crate::wbddc::WbDdc`] already computes a forward FFT of the same stream, so
//! taking its bin magnitudes looks free. It is not usable: overlap-add filtering
//! needs its analysis window chosen for reconstruction, and a display needs one
//! chosen for dynamic range. Borrowing the DDC's bins puts the strongest
//! broadcast carrier's skirts across the whole band and throws away most of what
//! a 16-bit ADC is for.
//!
//! # Why it is nevertheless nearly free
//!
//! A display does not need every sample. At 20 frames a second, averaging eight
//! 8192-point blocks per frame is 160 FFTs a second against the downconverter's
//! ~15 800 — about 1 % of its cost — and it analyses roughly 2 % of the samples
//! that go past. Spectrum analysers have always worked this way; the only thing
//! lost is the ability to catch a signal shorter than a frame.

use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex};

use crate::Complex32;
use crate::window::blackman_harris;

/// Blocks averaged into each emitted frame.
const BLOCKS_PER_FRAME: usize = 8;

/// Full-band spectrum analyser for a real input stream.
pub struct WideSpectrum {
    fft: Arc<dyn RealToComplex<f32>>,
    n: usize,
    in_rate: f64,
    window: Vec<f32>,
    /// `2 / sum(window)`, so a full-scale real sine reads 0 dBFS.
    norm: f32,

    block: Vec<f32>,
    filled: usize,
    spectrum: Vec<Complex32>,
    scratch: Vec<Complex32>,
    /// Accumulated linear power per bin for the frame being built.
    acc: Vec<f32>,
    blocks_in_acc: usize,
    /// The most recent completed frame, in dBFS, ascending in frequency.
    ready: Option<Vec<f32>>,

    /// Input samples still to be skipped before the next block is collected.
    skip: usize,
    /// Samples between the start of one analysed block and the next.
    stride: usize,
}

impl WideSpectrum {
    /// `fps` is the target frame rate; `n` is the FFT size and so sets the
    /// resolution, `in_rate / n` per bin.
    pub fn new(in_rate: f64, n: usize, fps: f64) -> WideSpectrum {
        assert!(n >= 64 && n.is_power_of_two(), "FFT size must be a power of two");
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(n);
        let window = blackman_harris(n);
        let cg: f32 = window.iter().sum();
        let scratch = vec![Complex32::default(); fft.get_scratch_len()];

        // Spread the frame's blocks evenly through the second rather than
        // taking them back to back: a burst of eight adjacent blocks describes
        // 1 ms of the band, not the 50 ms the frame claims to cover.
        let blocks_per_sec = fps * BLOCKS_PER_FRAME as f64;
        let stride = ((in_rate / blocks_per_sec.max(1.0)) as usize).max(n);

        WideSpectrum {
            fft,
            n,
            in_rate,
            window,
            norm: 2.0 / cg.max(1e-9),
            block: vec![0.0; n],
            filled: 0,
            spectrum: vec![Complex32::default(); n / 2 + 1],
            scratch,
            acc: vec![0.0; n / 2 + 1],
            blocks_in_acc: 0,
            ready: None,
            skip: 0,
            stride,
        }
    }

    /// Bins in an emitted frame.
    pub fn bins(&self) -> usize {
        self.n / 2 + 1
    }

    /// Centre and span of the emitted frame, in Hz. A real stream covers DC to
    /// Nyquist, so the centre is a quarter of the sample rate.
    pub fn center_span_hz(&self) -> (f64, f64) {
        (self.in_rate / 4.0, self.in_rate / 2.0)
    }

    /// Feed real samples. Cheap: most are counted and discarded.
    pub fn process(&mut self, input: &[f32]) {
        let mut i = 0;
        while i < input.len() {
            if self.skip > 0 {
                let take = self.skip.min(input.len() - i);
                self.skip -= take;
                i += take;
                continue;
            }
            let want = self.n - self.filled;
            let take = want.min(input.len() - i);
            self.block[self.filled..self.filled + take].copy_from_slice(&input[i..i + take]);
            self.filled += take;
            i += take;
            if self.filled == self.n {
                self.analyse();
                self.filled = 0;
                self.skip = self.stride - self.n;
            }
        }
    }

    fn analyse(&mut self) {
        for (b, w) in self.block.iter_mut().zip(&self.window) {
            *b *= *w;
        }
        self.fft
            .process_with_scratch(&mut self.block, &mut self.spectrum, &mut self.scratch)
            .expect("wbspectrum: buffer sizes are fixed at construction");

        for (a, x) in self.acc.iter_mut().zip(&self.spectrum) {
            let m = x.norm() * self.norm;
            *a += m * m;
        }
        self.blocks_in_acc += 1;

        if self.blocks_in_acc >= BLOCKS_PER_FRAME {
            let inv = 1.0 / self.blocks_in_acc as f32;
            let out: Vec<f32> = self.acc.iter().map(|p| 10.0 * (p * inv + 1e-20).log10()).collect();
            self.ready = Some(out);
            self.acc.iter_mut().for_each(|p| *p = 0.0);
            self.blocks_in_acc = 0;
        }
    }

    /// Take the most recent completed frame, if one is waiting.
    ///
    /// Latest-wins: a consumer that falls behind skips frames rather than
    /// building a backlog, which is the right behaviour for a display.
    pub fn take(&mut self) -> Option<Vec<f32>> {
        self.ready.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 64.8e6;
    const N: usize = 8192;

    fn tone(freq: f64, amp: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (amp as f64 * (std::f64::consts::TAU * freq * i as f64 / FS).cos()) as f32)
            .collect()
    }

    /// Feed enough samples for one frame, allowing for the stride between
    /// analysed blocks.
    fn frame_of(ws: &mut WideSpectrum, freq: f64, amp: f32) -> Vec<f32> {
        for _ in 0..(BLOCKS_PER_FRAME + 1) {
            let chunk = tone(freq, amp, ws.stride);
            ws.process(&chunk);
            if let Some(f) = ws.take() {
                return f;
            }
        }
        panic!("no frame produced");
    }

    #[test]
    fn the_frame_spans_dc_to_nyquist() {
        let ws = WideSpectrum::new(FS, N, 20.0);
        let (c, s) = ws.center_span_hz();
        assert!((c - 16.2e6).abs() < 1.0);
        assert!((s - 32.4e6).abs() < 1.0);
        assert_eq!(ws.bins(), N / 2 + 1);
    }

    #[test]
    fn a_full_scale_tone_reads_about_zero_dbfs() {
        let mut ws = WideSpectrum::new(FS, N, 20.0);
        // Put the tone exactly on a bin so no scalloping loss is involved.
        let bin = 1000usize;
        let f = bin as f64 * FS / N as f64;
        let frame = frame_of(&mut ws, f, 1.0);
        let peak = frame.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(peak.abs() < 0.5, "full-scale tone read {peak:.2} dBFS");
    }

    #[test]
    fn a_tone_lands_in_the_bin_it_belongs_in() {
        let mut ws = WideSpectrum::new(FS, N, 20.0);
        let bin = 2345usize;
        let f = bin as f64 * FS / N as f64;
        let frame = frame_of(&mut ws, f, 0.5);
        let peak_bin =
            frame.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap().0;
        assert_eq!(peak_bin, bin, "tone at {f:.0} Hz landed in bin {peak_bin}");
    }

    #[test]
    fn halving_the_amplitude_costs_six_db() {
        let bin = 1500usize;
        let f = bin as f64 * FS / N as f64;
        let mut a = WideSpectrum::new(FS, N, 20.0);
        let mut b = WideSpectrum::new(FS, N, 20.0);
        let pa = frame_of(&mut a, f, 1.0)[bin];
        let pb = frame_of(&mut b, f, 0.5)[bin];
        assert!((pa - pb - 6.02).abs() < 0.2, "{pa:.2} vs {pb:.2} dBFS");
    }

    /// The Blackman-Harris window is the entire reason this analyser exists
    /// rather than reusing the downconverter's bins, so its sidelobe
    /// suppression is worth asserting: a rectangular window would leave the
    /// noise floor around -13 dB below the carrier here.
    #[test]
    fn a_strong_carrier_does_not_smear_across_the_band() {
        let mut ws = WideSpectrum::new(FS, N, 20.0);
        let bin = 1000usize;
        let f = bin as f64 * FS / N as f64;
        let frame = frame_of(&mut ws, f, 1.0);
        // Well away from the carrier, everything should be far down.
        let far: Vec<f32> = frame
            .iter()
            .enumerate()
            .filter(|(i, _)| i.abs_diff(bin) > 50)
            .map(|(_, v)| *v)
            .collect();
        let worst = far.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(worst < -80.0, "sidelobes reached {worst:.1} dBFS");
    }

    #[test]
    fn most_samples_are_skipped_rather_than_analysed() {
        let ws = WideSpectrum::new(FS, N, 20.0);
        // 20 fps x 8 blocks = 160 blocks/s of 8192 samples out of 64.8 M.
        assert!(ws.stride > N * 40, "stride {} is too short to be cheap", ws.stride);
        let analysed = 160.0 * N as f64 / FS;
        assert!(analysed < 0.03, "analysing {:.1}% of samples", analysed * 100.0);
    }

    #[test]
    fn a_frame_is_only_offered_once() {
        let mut ws = WideSpectrum::new(FS, N, 20.0);
        let _ = frame_of(&mut ws, 5e6, 0.5);
        assert!(ws.take().is_none(), "the same frame came back twice");
    }
}
