//! Wideband digital downconverter: real samples in, complex baseband out.
//!
//! Built for a direct-sampling front end like the RX-888, which hands over
//! 16-bit *real* samples at the full ADC rate — 64.8 Msps covering 0–32.4 MHz —
//! and has no downconverter of its own. Everything downstream in sdroxide
//! expects complex baseband at a rate a normal DSP chain can carry, so the
//! conversion has to happen here, and it has to be cheap enough to run at
//! 64.8 million samples a second.
//!
//! # How it works
//!
//! A weighted overlap-add (WOLA) analysis filter bank:
//!
//! 1. Take `N` real input samples, advancing `N/2` each block, and apply a Hann
//!    window. Hann at 50 % overlap sums to a constant, which is what makes the
//!    blocks reassemble into a continuous signal.
//! 2. Real FFT of size `N`, giving `N/2 + 1` bins spaced `fs/N` apart.
//! 3. Copy the `M` bins covering the wanted band into a complex buffer. Doing
//!    this — and *only* this — is both the band-pass filter and the
//!    real-to-complex conversion, because the negative-frequency half of the
//!    spectrum is simply never copied. The band edges are tapered so the filter
//!    is not a brick wall, whose impulse response would ring for the length of
//!    the block.
//! 4. Inverse complex FFT of size `M`, and overlap-add the result with hop
//!    `M/2`.
//!
//! The output rate is `fs · M / N`: with `fs = 64.8 MHz`, `N = 8192` and
//! `M = 256` that is 2.025 Msps, which the engine's ordinary [`crate::ddc::Ddc`]
//! then takes down to audio.
//!
//! # Tuning
//!
//! Coarse tuning is the choice of `M` bins, in steps of `fs/N` (7.9 kHz at the
//! default settings). The remainder is a complex mixer on the *output*, running
//! at the low rate where it costs nothing. See [`WbDdc::set_center_hz`].

use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex};
use rustfft::{Fft, FftPlanner};

use crate::Complex32;
use crate::nco::Nco;

/// The centre frequencies a downconverter built with these two rates can
/// land on, as a range: it selects a band directly out of a real FFT's
/// non-negative bins (see the module doc), so it can never centre closer to
/// DC — or closer to Nyquist — than half its own output rate. A free
/// function, not a method, so a caller with no `WbDdc` instance of its own
/// can still compute exactly what one would reach.
///
/// This is *not* the range to publish as a device's own tuning limit — a
/// caller like `sdroxide-fobos`'s `IqSource` tried that and it broke the far
/// more common case, an operator clicking anywhere still inside the current
/// span: that dial needs no retune and is genuinely receivable regardless of
/// where the centre itself is pinned, so the wider Nyquist span is what a
/// `DeviceCaps::freq_ranges_rx` entry wants (see `sdroxide-rx888::band::
/// freq_ranges`'s own identical choice for the identical clamp). This range
/// is for the narrower question [`clamp_center_hz`] answers: where a
/// specific request for the *centre itself* to move here would actually
/// land.
pub fn reachable_range_hz(in_rate_hz: f64, out_rate_hz: f64) -> (f64, f64) {
    let lowest = out_rate_hz / 2.0;
    let highest = (in_rate_hz / 2.0 - out_rate_hz / 2.0).max(lowest);
    (lowest, highest)
}

/// Where a requested centre actually lands — `requested_hz` clamped into
/// [`reachable_range_hz`]. [`WbDdc::set_center_hz`] uses this too, rather
/// than keeping a second copy of the same formula that could drift from
/// this one.
pub fn clamp_center_hz(requested_hz: f64, in_rate_hz: f64, out_rate_hz: f64) -> f64 {
    let (lowest, highest) = reachable_range_hz(in_rate_hz, out_rate_hz);
    requested_hz.clamp(lowest, highest)
}

/// Fraction of the selected band over which the filter rolls off at each edge.
///
/// A rectangular selection is a brick wall, and a brick wall in frequency is a
/// sinc in time: it rings for the whole block and the ringing folds back as
/// aliasing. Tapering the outermost eighth of the band at each end costs a
/// little usable bandwidth and removes it.
const EDGE_TAPER: f64 = 0.125;

/// Wideband real-to-complex downconverter. See the module documentation.
pub struct WbDdc {
    fft_fwd: Arc<dyn RealToComplex<f32>>,
    fft_inv: Arc<dyn Fft<f32>>,
    /// Input block size.
    n: usize,
    /// Number of bins selected, and the inverse FFT size.
    m: usize,
    in_rate: f64,
    /// Analysis window, `n` long.
    window: Vec<f32>,
    /// Band-edge taper, `m` long.
    taper: Vec<f32>,

    /// Un-consumed input, always fewer than `n` samples at rest.
    inbuf: Vec<f32>,
    /// Scratch for one windowed block.
    block: Vec<f32>,
    /// Forward FFT output, `n/2 + 1` bins.
    spectrum: Vec<Complex32>,
    /// The `m` selected bins / inverse FFT working buffer.
    band: Vec<Complex32>,
    /// Overlap carried from the previous block, `m/2` long.
    tail: Vec<Complex32>,
    scratch_fwd: Vec<Complex32>,
    scratch_inv: Vec<Complex32>,

    /// Centre bin of the selected band. This bin becomes DC of the output.
    kc: usize,
    /// Block counter, for the per-block phase correction.
    blocks: u64,
    /// Residual (sub-bin) tuning, applied at the output rate.
    nco: Nco,
    residual_hz: f64,
    center_hz: f64,
    scale: f32,
}

crate::simd::kernel! {
    /// The analysis window, applied on the way into the forward transform.
    fn apply_window / apply_window_portable / apply_window_avx2 / apply_window_avx512 (
        dst: &mut [f32],
        src: &[f32],
        win: &[f32],
    ) {
        for (b, (x, w)) in dst.iter_mut().zip(src.iter().zip(win)) {
            *b = *x * *w;
        }
    }
}

crate::simd::kernel! {
    /// One contiguous run of the band select: the band-pass and the
    /// real-to-complex conversion both, in one multiply per bin.
    fn select_bins / select_bins_portable / select_bins_avx2 / select_bins_avx512 (
        dst: &mut [Complex32],
        spectrum: &[Complex32],
        taper: &[f32],
    ) {
        for ((b, s), t) in dst.iter_mut().zip(spectrum).zip(taper) {
            *b = s * *t;
        }
    }
}

crate::simd::kernel! {
    /// Emit one hop and keep the next: the second half of this block's inverse
    /// transform becomes the tail the following one is added to.
    fn overlap_add / overlap_add_portable / overlap_add_avx2 / overlap_add_avx512 (
        out: &mut [Complex32],
        first: &[Complex32],
        tail: &mut [Complex32],
        second: &[Complex32],
        gain: f32,
    ) {
        for ((o, v), t) in out.iter_mut().zip(first).zip(tail.iter()) {
            *o = v * gain + t;
        }
        for (t, v) in tail.iter_mut().zip(second) {
            *t = v * gain;
        }
    }
}

impl WbDdc {
    /// Build a downconverter.
    ///
    /// `n` and `m` must both be powers of two, with `m` smaller than `n` — at
    /// `m = n/2` the output is the entire half-spectrum. The inverse FFT runs
    /// on every block, which is why an arbitrary `m` is not worth supporting.
    pub fn new(in_rate: f64, n: usize, m: usize) -> WbDdc {
        assert!(n >= 64 && n.is_power_of_two(), "block size must be a power of two");
        assert!(m >= 8 && m < n && m.is_power_of_two(), "band size must be a power of two below n");

        let fft_fwd = RealFftPlanner::<f32>::new().plan_fft_forward(n);
        let fft_inv = FftPlanner::<f32>::new().plan_fft_inverse(m);

        // Periodic Hann: sums to a constant under 50 % overlap-add.
        let window: Vec<f32> = (0..n)
            .map(|i| {
                let t = std::f64::consts::TAU * i as f64 / n as f64;
                (0.5 - 0.5 * t.cos()) as f32
            })
            .collect();

        let taper = edge_taper(m, EDGE_TAPER);

        let scratch_fwd = vec![Complex32::default(); fft_fwd.get_scratch_len()];
        let scratch_inv = vec![Complex32::default(); fft_inv.get_inplace_scratch_len()];

        // rustfft and realfft are both unnormalised, so the gain has to be put
        // back by hand. For a real tone of amplitude A:
        //
        //   * Hann windowing has a coherent gain of 0.5, so the tone's positive
        //     frequency bin holds A·n/4.
        //   * The inverse FFT does not divide by m, so one non-zero bin comes
        //     back out at that same magnitude.
        //   * Overlap-adding two 50 %-overlapped Hann blocks sums the window to
        //     1.0, which doubles it again to A·n/2.
        //
        // Dividing by n/2 therefore lands a full-scale real sine on |z| = 1.0,
        // matching what the other backends deliver. Compensating for the Hann
        // gain here as well would be double-counting: the overlap-add has
        // already done it.
        let scale = (2.0 / n as f64) as f32;

        let mut ddc = WbDdc {
            fft_fwd,
            fft_inv,
            n,
            m,
            in_rate,
            window,
            taper,
            inbuf: Vec::with_capacity(n * 2),
            block: vec![0.0; n],
            spectrum: vec![Complex32::default(); n / 2 + 1],
            band: vec![Complex32::default(); m],
            tail: vec![Complex32::default(); m / 2],
            scratch_fwd,
            scratch_inv,
            kc: 0,
            blocks: 0,
            nco: Nco::new(0.0, in_rate * m as f64 / n as f64),
            residual_hz: 0.0,
            center_hz: 0.0,
            scale,
        };
        ddc.set_center_hz(in_rate / 4.0);
        ddc
    }

    /// Output sample rate, in Hz.
    pub fn out_rate(&self) -> f64 {
        self.in_rate * self.m as f64 / self.n as f64
    }

    /// Spacing of the coarse tuning grid, in Hz.
    pub fn bin_hz(&self) -> f64 {
        self.in_rate / self.n as f64
    }

    /// The centre frequency currently selected.
    pub fn center_hz(&self) -> f64 {
        self.center_hz
    }

    /// The usable bandwidth, i.e. the output rate less the tapered edges.
    pub fn usable_bw_hz(&self) -> f64 {
        self.out_rate() * (1.0 - 2.0 * EDGE_TAPER)
    }

    /// Highest centre frequency this converter can reach.
    pub fn max_center_hz(&self) -> f64 {
        self.in_rate / 2.0 - self.out_rate() / 2.0
    }

    /// Tune. Snaps the band selection to the nearest bin and puts the remainder
    /// on the output mixer, so the achieved centre is exact.
    pub fn set_center_hz(&mut self, hz: f64) {
        let hz = clamp_center_hz(hz, self.in_rate, self.out_rate());

        // Centre bin, clamped so the half-width window either side stays inside
        // the real half-spectrum.
        let half = self.m / 2;
        let kc = (hz / self.bin_hz()).round().max(half as f64) as usize;
        let kc = kc.min(self.n / 2 - half);

        let band_center = kc as f64 * self.bin_hz();
        // The mixer runs at the output rate and moves the signal the rest of
        // the way, so the requested frequency is hit exactly rather than to the
        // nearest 7.9 kHz.
        let residual = hz - band_center;

        if kc != self.kc {
            self.kc = kc;
            // The band select is a frequency shift, and a shift by kc bins
            // leaves a phase that depends on where the block starts. Restarting
            // the block count keeps that correction well defined across a
            // retune.
            self.blocks = 0;
        }
        if residual != self.residual_hz {
            self.residual_hz = residual;
            self.nco.set_freq(-residual, self.out_rate());
        }
        self.center_hz = band_center + residual;
    }

    /// Feed real samples and append complex baseband to `out`.
    ///
    /// `out` is appended to, not cleared, so a caller can accumulate across
    /// several calls.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<Complex32>) {
        let produced_from = out.len();
        self.inbuf.extend_from_slice(input);

        let hop = self.n / 2;
        let out_hop = self.m / 2;

        // Walk the buffer with an index and compact it once at the end.
        //
        // Draining the hop inside the loop is the obvious way to write this and
        // it is quadratic: a 256 KiB transfer is 32 blocks, and each drain
        // memmoves everything still unread — on the order of 16 MB of pointless
        // copying per transfer.
        let mut pos = 0usize;
        while pos + self.n <= self.inbuf.len() {
            apply_window(&mut self.block, &self.inbuf[pos..pos + self.n], &self.window);

            self.fft_fwd
                .process_with_scratch(&mut self.block, &mut self.spectrum, &mut self.scratch_fwd)
                .expect("wbddc: forward FFT buffer sizes are fixed at construction");

            // Band select: the only filtering there is, and the step that drops
            // the negative frequencies.
            //
            // The inverse FFT reads its input in FFT order, so the *centre* bin
            // has to land at index 0 and the bins below it wrap to the top half.
            // Copying the band contiguously instead looks plausible and puts
            // every signal half an output bandwidth off frequency.
            //
            // Two straight runs rather than a wrap test and an index
            // computation per bin: the centre bin and those above it fill the
            // first half of the inverse FFT's input, the ones below it the
            // second. Both runs are contiguous in the spectrum and in the
            // taper, which is what lets the copy widen — this loop runs `m`
            // times per block and sixteen thousand blocks a second on an
            // RX-888. `set_center_hz` clamps `kc` to `half ..= n/2 - half`, so
            // neither run can leave the half-spectrum.
            let half = self.m / 2;
            let kc = self.kc;
            let (band_lo, band_hi) = self.band.split_at_mut(half);
            let (taper_lo, taper_hi) = self.taper.split_at(half);
            select_bins(band_lo, &self.spectrum[kc..kc + half], taper_lo);
            select_bins(band_hi, &self.spectrum[kc - half..kc], taper_hi);

            self.fft_inv.process_with_scratch(&mut self.band, &mut self.scratch_inv);

            // Shifting the spectrum down by kc bins is a modulation by
            // exp(-j2π·kc·n/N). Between blocks n advances by the hop N/2, so
            // successive blocks pick up exp(-jπ·kc) = (-1)^kc. Without undoing
            // it, an odd kc inverts every other block and the output is chopped
            // up at the block rate.
            let flip = self.kc % 2 == 1 && self.blocks % 2 == 1;
            let sign = if flip { -1.0 } else { 1.0 };
            let gain = self.scale * sign;

            // Overlap-add: first half joins the tail kept from last time, second
            // half becomes the new tail.
            let (first, second) = self.band.split_at(out_hop);
            let at = out.len();
            out.resize(at + out_hop, Complex32::default());
            overlap_add(&mut out[at..], first, &mut self.tail[..out_hop], second, gain);

            pos += hop;
            self.blocks += 1;
        }
        if pos > 0 {
            self.inbuf.drain(..pos);
        }

        // Sub-bin tuning, applied at the output rate where it is 32 times
        // cheaper than it would have been on the input.
        if self.residual_hz != 0.0 {
            self.nco.mix_in_place(&mut out[produced_from..]);
        }
    }
}

/// A raised-cosine band-edge taper, in **FFT order**.
///
/// Index 0 is DC of the output band and index `m/2` is the band edge, so the
/// taper is flat at both ends of the array and rolls off in the middle — the
/// mirror image of how it would look laid out by frequency. `frac` is the
/// fraction of the half-band over which it rolls off.
fn edge_taper(m: usize, frac: f64) -> Vec<f32> {
    let half = (m / 2) as f64;
    let edge = (half * frac * 2.0).round().max(1.0);
    (0..m)
        .map(|i| {
            // Distance from DC in bins, following the FFT's wrap-around.
            let off = if i < m / 2 { i as f64 } else { m as f64 - i as f64 };
            let from_edge = half - off;
            if from_edge >= edge {
                1.0
            } else {
                let t = (from_edge.max(0.0) + 0.5) / edge;
                (0.5 - 0.5 * (std::f64::consts::PI * t.min(1.0)).cos()) as f32
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 64.8e6;
    const N: usize = 8192;
    const M: usize = 256;

    /// A real tone, generated from the definition rather than from anything the
    /// converter does, so the test cannot agree with a broken implementation.
    fn real_tone(freq: f64, amp: f32, n: usize, fs: f64) -> Vec<f32> {
        (0..n)
            .map(|i| (amp as f64 * (std::f64::consts::TAU * freq * i as f64 / fs).cos()) as f32)
            .collect()
    }

    /// Estimate the dominant frequency and amplitude of a complex sequence by
    /// direct DFT search, independent of the converter's own FFT usage.
    fn dominant(x: &[Complex32], fs: f64) -> (f64, f32) {
        let n = x.len();
        let mut best = (0.0, 0.0f32);
        // Coarse scan over the full complex band, then refine.
        let scan = |lo: f64, hi: f64, steps: usize, best: &mut (f64, f32)| {
            for s in 0..=steps {
                let f = lo + (hi - lo) * s as f64 / steps as f64;
                let mut acc = Complex32::default();
                for (i, v) in x.iter().enumerate() {
                    let ph = -std::f64::consts::TAU * f * i as f64 / fs;
                    acc += *v * Complex32::new(ph.cos() as f32, ph.sin() as f32);
                }
                let mag = acc.norm() / n as f32;
                if mag > best.1 {
                    *best = (f, mag);
                }
            }
        };
        scan(-fs / 2.0, fs / 2.0, 400, &mut best);
        let step = fs / 400.0;
        scan(best.0 - step, best.0 + step, 200, &mut best);
        best
    }

    #[test]
    fn output_rate_and_grid_are_what_the_geometry_says() {
        let d = WbDdc::new(FS, N, M);
        assert!((d.out_rate() - 2_025_000.0).abs() < 1.0);
        assert!((d.bin_hz() - FS / 8192.0).abs() < 1e-6);
        assert!(d.usable_bw_hz() < d.out_rate());
    }

    #[test]
    fn a_tone_on_the_bin_grid_lands_at_dc() {
        let mut d = WbDdc::new(FS, N, M);
        // Pick a centre that is an exact multiple of the bin spacing so the
        // residual mixer is not involved at all.
        let bin = 1200usize;
        let center = bin as f64 * FS / N as f64;
        d.set_center_hz(center);
        assert_eq!(d.residual_hz, 0.0, "chosen centre should need no residual");

        let x = real_tone(center, 0.5, N * 12, FS);
        let mut out = Vec::new();
        d.process(&x, &mut out);
        assert!(out.len() > 256, "expected output, got {}", out.len());

        // Skip the first block, which is still filling the overlap.
        let tail = &out[M..];
        let (f, a) = dominant(tail, d.out_rate());
        assert!(f.abs() < 2000.0, "tone landed at {f:.0} Hz, not DC");
        assert!((a - 0.5).abs() < 0.05, "amplitude {a:.3}, expected ~0.5");
    }

    #[test]
    fn an_offset_tone_lands_at_the_offset() {
        let mut d = WbDdc::new(FS, N, M);
        let bin = 1200usize;
        let center = bin as f64 * FS / N as f64;
        d.set_center_hz(center);

        let offset = 300_000.0;
        let x = real_tone(center + offset, 0.5, N * 12, FS);
        let mut out = Vec::new();
        d.process(&x, &mut out);

        let (f, _) = dominant(&out[M..], d.out_rate());
        assert!((f - offset).abs() < 5000.0, "tone at {f:.0} Hz, expected {offset:.0}");
    }

    /// The widest geometry the converter accepts: half the block, so the
    /// output *is* the half-spectrum. The centre pins at fs/4 whatever the
    /// tune asks for, and a tone anywhere in the digitised band appears at its
    /// true offset from fs/4.
    #[test]
    fn the_full_nyquist_geometry_covers_the_whole_band() {
        let mut d = WbDdc::new(FS, N, N / 2);
        assert!((d.out_rate() - FS / 2.0).abs() < 1.0);
        d.set_center_hz(1_000_000.0);
        assert!((d.center_hz() - FS / 4.0).abs() < 1.0, "centre must pin at fs/4");

        let tone = 27_000_000.0;
        let x = real_tone(tone, 0.5, N * 8, FS);
        let mut out = Vec::new();
        d.process(&x, &mut out);

        let (f, a) = dominant(&out[N / 2..], d.out_rate());
        assert!((f - (tone - FS / 4.0)).abs() < 20_000.0, "tone at {f:.0} Hz");
        assert!((a - 0.5).abs() < 0.06, "amplitude {a:.3}, expected ~0.5");
    }

    /// The negative-frequency image must not come back. A real input has energy
    /// at both +f and -f; selecting only positive bins is what makes the output
    /// analytic, and getting it wrong shows up as a mirror image that sounds
    /// like an inverted sideband.
    #[test]
    fn the_negative_frequency_image_is_rejected() {
        let mut d = WbDdc::new(FS, N, M);
        let bin = 1200usize;
        let center = bin as f64 * FS / N as f64;
        d.set_center_hz(center);

        let offset = 300_000.0;
        let x = real_tone(center + offset, 0.5, N * 12, FS);
        let mut out = Vec::new();
        d.process(&x, &mut out);
        let tail = &out[M..];

        // Energy at +offset versus at -offset.
        let power_at = |f: f64| -> f32 {
            let mut acc = Complex32::default();
            for (i, v) in tail.iter().enumerate() {
                let ph = -std::f64::consts::TAU * f * i as f64 / d.out_rate();
                acc += *v * Complex32::new(ph.cos() as f32, ph.sin() as f32);
            }
            acc.norm() / tail.len() as f32
        };
        let wanted = power_at(offset);
        let image = power_at(-offset);
        assert!(
            wanted > image * 50.0,
            "image rejection only {:.1} dB (wanted {wanted:.4}, image {image:.4})",
            20.0 * (wanted / image.max(1e-12)).log10()
        );
    }

    /// The regression this file's `flip` exists for. With an odd `k0` and no
    /// per-block correction every other block is inverted, which halves the
    /// recovered amplitude and sprays energy at the block rate. Testing an odd
    /// and an even `k0` side by side is what makes the bug visible.
    #[test]
    fn an_odd_bin_offset_stays_phase_continuous() {
        let mut amps = Vec::new();
        for bin in [1200usize, 1201] {
            let mut d = WbDdc::new(FS, N, M);
            let center = bin as f64 * FS / N as f64;
            d.set_center_hz(center);
            assert_eq!(d.kc % 2, bin % 2, "kc parity should follow the chosen bin");

            let x = real_tone(center, 0.5, N * 12, FS);
            let mut out = Vec::new();
            d.process(&x, &mut out);
            let (f, a) = dominant(&out[M..], d.out_rate());
            assert!(f.abs() < 2000.0, "bin {bin}: tone at {f:.0} Hz, not DC");
            amps.push(a);
        }
        let (even, odd) = (amps[0], amps[1]);
        assert!(
            (even - odd).abs() < 0.05,
            "odd bin offset lost amplitude: even {even:.3} vs odd {odd:.3}"
        );
    }

    #[test]
    fn tuning_is_exact_after_the_residual_mixer() {
        let mut d = WbDdc::new(FS, N, M);
        // Deliberately between bins.
        let want = 10_000_000.0 + 1234.0;
        d.set_center_hz(want);
        assert!((d.center_hz() - want).abs() < 1.0, "centre {} vs {want}", d.center_hz());
        assert!(d.residual_hz.abs() > 0.0, "expected a residual for an off-grid centre");
    }

    #[test]
    fn tuning_is_clamped_inside_the_real_half_spectrum() {
        let mut d = WbDdc::new(FS, N, M);
        d.set_center_hz(0.0);
        assert!(d.center_hz() > 0.0);
        d.set_center_hz(FS);
        assert!(d.center_hz() < FS / 2.0);
    }

    /// A caller with no `WbDdc` of its own — `sdroxide-fobos`'s `IqSource`,
    /// whose DDC instances live on a separate thread — has to be able to
    /// predict exactly where a real instance would land, or the UI's own
    /// pan/zoom state drifts away from what the receiver actually reports:
    /// this is the bug a mismatched clamp caused on real hardware (dragging
    /// the panadapter's view below the reachable floor kept scrolling the
    /// frequency axis while the spectrum itself stayed pinned at the true,
    /// clamped centre). `clamp_center_hz` has to agree with the real thing
    /// bit-for-bit, across and outside the reachable range, not just roughly.
    #[test]
    fn clamp_center_hz_matches_a_real_wbddc_exactly() {
        let mut d = WbDdc::new(FS, N, M);
        for want in [0.0, FS / 4.0, FS / 2.0 - 1.0, FS / 2.0, FS, -FS] {
            d.set_center_hz(want);
            let predicted = clamp_center_hz(want, FS, d.out_rate());
            assert!(
                (d.center_hz() - predicted).abs() < 1.0,
                "requested {want}: real WbDdc landed on {}, clamp_center_hz predicted {predicted}",
                d.center_hz()
            );
        }
    }

    /// Real bug, real numbers: 80 Msps in / 2.5 Msps out (a Fobos HF port at
    /// its old default bandwidth) reached exactly 1.25 MHz down to nothing
    /// closer. A range that instead published `(0, ...)`, as
    /// `sdroxide-fobos`'s own capability report once did, let the engine ask
    /// for anything down to 0 Hz — the source corrected it a frame later, but
    /// the dial visibly flashed to whatever was actually requested first.
    /// Publishing this range instead is what makes the engine refuse the ask
    /// before it ever reaches the source.
    #[test]
    fn reachable_range_hz_matches_the_820_khz_bug_report() {
        assert_eq!(reachable_range_hz(80_000_000.0, 2_500_000.0), (1_250_000.0, 38_750_000.0));
    }

    /// The taper is in FFT order, so it is flat at DC (index 0, and index m-1
    /// which is one bin below DC) and rolls off at the band edge (index m/2).
    /// Laying it out the other way round is a silent way to filter out the
    /// middle of the band and keep the edges.
    #[test]
    fn the_edge_taper_is_flat_at_dc_and_rolls_off_at_the_band_edge() {
        let t = edge_taper(256, 0.125);
        assert_eq!(t.len(), 256);
        assert!(t[0] > 0.999, "DC should be untouched, got {}", t[0]);
        assert!(t[255] > 0.999, "the bin just below DC too, got {}", t[255]);
        assert!(t[128] < 0.2, "the band edge should be tapered, got {}", t[128]);
        // Symmetric about DC.
        for i in 1..128 {
            assert!((t[i] - t[256 - i]).abs() < 1e-6, "asymmetric at {i}");
        }
        // Monotonically falling from DC out to the edge.
        for i in 1..=128 {
            assert!(t[i] <= t[i - 1] + 1e-6, "not monotonic at {i}");
        }
    }
}
