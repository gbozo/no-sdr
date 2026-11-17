//! Per-client secondary spectra for the decoder pane and signal analysis.
//!
//! The main waterfall FFT covers the whole dongle span (typically 8192 bins
//! over 2.4 MSPS, ~293 Hz/bin), which is far too coarse to inspect an FT8
//! signal inside a 3 kHz window. These processors run their own NCO + filter
//! + decimator over the raw device stream, then a small FFT scoped to the
//! decoder bandwidth or the demodulator bandwidth. They are independent of
//! the main waterfall and of each other.
//!
//! Only created when the client explicitly subscribes, so clients that keep
//! both panes closed cost nothing.

use std::time::{Duration, Instant};

use num_complex::Complex32;

use crate::dsp::{Fft, IqExtractor, IqExtractorConfig};
use crate::ws::{pack_analysis_scope, pack_decoder_scope};

use super::RangeSpec;

/// Fixed dB range of the compact u8 bins. Matches the main waterfall's range.
const MIN_DB: f32 = -130.0;
const MAX_DB: f32 = 0.0;
const BINS: usize = 512;

/// Pick the secondary FFT size from the requested span. A fixed 512 bins is
/// fine for narrow modes, but at 200 kHz it would be ~470 Hz/bin — coarser
/// than the main 8192-bin waterfall. Scale up so wide analysis spans still
/// beat the main FFT resolution without sending an unbounded number of bins.
fn secondary_fft_size(span_hz: f64) -> usize {
    if span_hz <= 30_000.0 {
        BINS
    } else if span_hz <= 100_000.0 {
        BINS * 2
    } else {
        BINS * 4
    }
}

/// FFT size for the tap that reuses a decoder channel's own extracted IQ.
/// 1024 bins over the channel rate (~12 kHz) gives ~12 Hz/bin; the client
/// receives only the bins that cover the requested decoder bandwidth.
const TAP_BINS: usize = 1024;
const TAP_OUT_BINS: usize = 512;

/// The RF span an analysis subscription should cover: exactly the demodulator
/// bandwidth, centred on the tuned frequency for DSB modes and one-sided for
/// USB/LSB. Clamped to the dongle span.
pub(crate) fn analysis_range(
    center_hz: f64,
    sample_rate: u32,
    tune_offset: i32,
    mode: &str,
    bandwidth: i32,
) -> RangeSpec {
    let half_dongle = sample_rate.max(1) as f64 * 0.5;
    let tune = center_hz + tune_offset as f64;
    let bw = (bandwidth.max(200) as f64).min(half_dongle * 2.0);
    let (start_hz, end_hz) = match mode {
        "usb" => (tune, tune + bw),
        "lsb" => (tune - bw, tune),
        _ => (tune - bw * 0.5, tune + bw * 0.5),
    };
    RangeSpec {
        start_hz: start_hz.max(center_hz - half_dongle),
        end_hz: end_hz.min(center_hz + half_dongle),
    }
}

/// A cheap scope tap fed with samples the decoder already extracted. Unlike
/// [`ScopeProcessor`], this performs no NCO, filtering or decimation of its
/// own, so it adds essentially only the FFT cost.
pub(crate) struct TapScope {
    fft: Fft,
    window: Vec<f32>,
    pending: Vec<Complex32>,
    scratch: Vec<Complex32>,
    magnitude: Vec<f32>,
    bins: Vec<u8>,
    first_bin: usize,
    out_bins: usize,
    start_hz: f64,
    hz_per_bin: f32,
    interval: Duration,
    last_emit: Option<Instant>,
}

impl TapScope {
    /// `dial_hz` is the channel's NCO centre (the extractor output is centred
    /// there); `display` is the absolute RF span the client wants.
    pub(crate) fn new(
        input_rate: f64,
        dial_hz: f64,
        display: &RangeSpec,
        fps: u32,
    ) -> Result<Self, String> {
        let fft = Fft::new(TAP_BINS).map_err(|e| format!("decoder scope FFT: {e}"))?;
        let hz_per_bin = input_rate / TAP_BINS as f64;
        // Send only the bins covering the decoder's actual bandwidth. The FFT
        // tap still has a full 1024-bin spectrum, but a 3 kHz decoder window is
        // ~256 bins at 12 kHz and does not need the other half.
        let requested = display.bandwidth_hz().clamp(200.0, input_rate * 0.5);
        let out_bins = ((requested / hz_per_bin).ceil() as usize).clamp(8, TAP_OUT_BINS);
        let base_start = dial_hz - input_rate * 0.5;
        let first = ((display.start_hz - base_start) / hz_per_bin).round();
        let first_bin = first.max(0.0).min((TAP_BINS - out_bins) as f64) as usize;
        let window = (0..TAP_BINS)
            .map(|i| {
                let x = std::f32::consts::TAU * i as f32 / (TAP_BINS - 1) as f32;
                0.5 - 0.5 * x.cos()
            })
            .collect();
        Ok(Self {
            fft,
            window,
            pending: Vec::with_capacity(TAP_BINS * 2),
            scratch: vec![Complex32::default(); TAP_BINS],
            magnitude: vec![MIN_DB; TAP_BINS],
            bins: vec![0; out_bins],
            first_bin,
            out_bins,
            start_hz: base_start + first_bin as f64 * hz_per_bin,
            hz_per_bin: hz_per_bin as f32,
            interval: Duration::from_millis(1_000 / fps.clamp(1, 24) as u64),
            last_emit: None,
        })
    }

    pub(crate) fn push(&mut self, input: &[Complex32]) -> Option<Vec<u8>> {
        if input.is_empty() {
            return None;
        }
        self.pending.extend_from_slice(input);
        let keep = TAP_BINS * 2;
        if self.pending.len() > keep {
            let drop = self.pending.len() - keep;
            self.pending.drain(..drop);
        }
        if self.pending.len() < TAP_BINS {
            return None;
        }
        let now = Instant::now();
        if let Some(last) = self.last_emit {
            if now.duration_since(last) < self.interval {
                return None;
            }
        }

        let start = self.pending.len() - TAP_BINS;
        for (dst, src) in self.scratch.iter_mut().zip(&self.pending[start..]) {
            *dst = *src;
        }
        self.pending.drain(..start);
        for (sample, w) in self.scratch.iter_mut().zip(&self.window) {
            *sample *= *w;
        }
        self.fft.transform(&mut self.scratch);

        let scale = 1.0 / (TAP_BINS as f32 * 0.5);
        for i in 0..TAP_BINS {
            self.magnitude[i] = 20.0 * (self.scratch[i].norm() * scale + 1e-12).log10();
        }
        let half = TAP_BINS / 2;
        let range = MAX_DB - MIN_DB;
        for i in 0..self.out_bins {
            let shifted = (self.first_bin + i) % TAP_BINS;
            let src = if shifted < half {
                shifted + half
            } else {
                shifted - half
            };
            let v = ((self.magnitude[src] - MIN_DB) / range * 255.0).clamp(0.0, 255.0);
            self.bins[i] = v as u8;
        }

        self.last_emit = Some(now);
        Some(pack_decoder_scope(
            self.start_hz,
            self.hz_per_bin,
            MIN_DB,
            MAX_DB,
            &self.bins[..self.out_bins],
        ))
    }
}

pub(crate) struct ScopeProcessor {
    extractor: IqExtractor,
    fft: Fft,
    fft_size: usize,
    window: Vec<f32>,
    pcm: Vec<i16>,
    pending: Vec<Complex32>,
    scratch: Vec<Complex32>,
    magnitude: Vec<f32>,
    bins: Vec<u8>,
    first_bin: usize,
    out_bins: usize,
    analysis: bool,
    start_hz: f64,
    hz_per_bin: f32,
    interval: Duration,
    last_emit: Option<Instant>,
}

impl ScopeProcessor {
    /// Build a processor for `display` (absolute RF span) inside a dongle
    /// window centred on `center_hz`.
    pub(crate) fn new(
        center_hz: f64,
        sample_rate: u32,
        display: &RangeSpec,
        fps: u32,
        analysis: bool,
    ) -> Result<Self, String> {
        let max_span = (sample_rate as f64 * 0.9).clamp(200.0, 250_000.0);
        let requested = display.bandwidth_hz().clamp(200.0, max_span);
        // Ask for a little more than the requested span: the integer
        // decimator rounds to the nearest factor and must not land under it.
        let output_request = ((requested * 1.15).ceil() as i32).min(sample_rate as i32);
        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            output_sample_rate: output_request,
            tune_offset: (display.center_hz() - center_hz).round() as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("secondary scope extractor: {e}"))?;
        extractor.set_bandwidth(requested as i32);

        let actual_rate = extractor.output_sample_rate() as f64;
        let fft_size = secondary_fft_size(requested);
        let hz_per_bin = actual_rate / fft_size as f64;
        let base_start = display.center_hz() - actual_rate * 0.5;
        // Trim the FFT output to the requested span. The extractor may have
        // produced a slightly wider rate to cover it; sending the whole FFT
        // would waste bytes and make the UI span disagree with the bandwidth.
        let out_bins = ((requested / hz_per_bin).ceil() as usize).clamp(8, fft_size);
        let first = ((display.start_hz - base_start) / hz_per_bin).round();
        let first_bin = first.max(0.0).min((fft_size - out_bins) as f64) as usize;
        let fft = Fft::new(fft_size).map_err(|e| format!("secondary scope FFT: {e}"))?;
        let window = (0..fft_size)
            .map(|i| {
                let x = std::f32::consts::TAU * i as f32 / (fft_size - 1) as f32;
                0.5 - 0.5 * x.cos()
            })
            .collect();

        Ok(Self {
            extractor,
            fft,
            fft_size,
            window,
            pcm: Vec::new(),
            pending: Vec::with_capacity(fft_size * 2),
            scratch: vec![Complex32::default(); fft_size],
            magnitude: vec![MIN_DB; fft_size],
            bins: vec![0; out_bins],
            first_bin,
            out_bins,
            analysis,
            start_hz: base_start + first_bin as f64 * hz_per_bin,
            hz_per_bin: hz_per_bin as f32,
            interval: Duration::from_millis(1_000 / fps.clamp(1, 24) as u64),
            last_emit: None,
        })
    }

    /// Feed one raw Cu8 chunk. Returns a packed scope frame only when the
    /// output interval has elapsed and enough samples are buffered. The
    /// message type is `MSG_DECODER_SCOPE` or `MSG_ANALYSIS_SCOPE` depending
    /// on the subscription that built this processor.
    pub(crate) fn process(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        self.extractor.process_into(chunk, &mut self.pcm);
        if self.pcm.len() < 4 {
            return None;
        }
        self.pending.reserve(self.pcm.len() / 2);
        for pair in self.pcm.chunks_exact(2) {
            self.pending.push(Complex32::new(
                pair[0] as f32 / 32768.0,
                pair[1] as f32 / 32768.0,
            ));
        }

        // Keep the newest two FFT windows. The chunk rate is much higher than
        // the scope rate, so dropping the oldest samples is intentional.
        let keep = self.fft_size * 2;
        if self.pending.len() > keep {
            let drop = self.pending.len() - keep;
            self.pending.drain(..drop);
        }
        if self.pending.len() < self.fft_size {
            return None;
        }

        let now = Instant::now();
        if let Some(last) = self.last_emit {
            if now.duration_since(last) < self.interval {
                return None;
            }
        }

        let start = self.pending.len() - self.fft_size;
        for (dst, src) in self.scratch.iter_mut().zip(&self.pending[start..]) {
            *dst = *src;
        }
        self.pending.drain(..start);
        for (sample, w) in self.scratch.iter_mut().zip(&self.window) {
            *sample *= *w;
        }
        self.fft.transform(&mut self.scratch);

        // rustfft is unnormalised. fftshift puts DC in the middle, then the
        // bins run ascending from `start_hz`.
        let scale = 1.0 / (self.fft_size as f32 * 0.5);
        for i in 0..self.fft_size {
            let db = 20.0 * (self.scratch[i].norm() * scale + 1e-12).log10();
            self.magnitude[i] = db;
        }
        let half = self.fft_size / 2;
        let range = MAX_DB - MIN_DB;
        for i in 0..self.out_bins {
            let shifted = self.first_bin + i;
            let src = if shifted < half {
                shifted + half
            } else {
                shifted - half
            };
            let v = ((self.magnitude[src] - MIN_DB) / range * 255.0).clamp(0.0, 255.0);
            self.bins[i] = v as u8;
        }

        self.last_emit = Some(now);
        let bins = &self.bins[..self.out_bins];
        Some(if self.analysis {
            pack_analysis_scope(self.start_hz, self.hz_per_bin, MIN_DB, MAX_DB, bins)
        } else {
            pack_decoder_scope(self.start_hz, self.hz_per_bin, MIN_DB, MAX_DB, bins)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_range_matches_mode_sidedness() {
        let usb = analysis_range(14_000_000.0, 2_400_000, 1_000, "usb", 3_000);
        assert_eq!(usb.start_hz, 14_001_000.0);
        assert_eq!(usb.end_hz, 14_004_000.0);

        let lsb = analysis_range(14_000_000.0, 2_400_000, -1_000, "lsb", 3_000);
        assert_eq!(lsb.start_hz, 13_996_000.0);
        assert_eq!(lsb.end_hz, 13_999_000.0);

        let am = analysis_range(14_000_000.0, 2_400_000, 2_000, "am", 6_000);
        assert_eq!(am.start_hz, 13_999_000.0);
        assert_eq!(am.end_hz, 14_005_000.0);
    }

    #[test]
    fn analysis_range_is_clamped_to_dongle_span() {
        let r = analysis_range(14_000_000.0, 2_400_000, 1_199_000, "usb", 3_000);
        assert_eq!(r.end_hz, 14_000_000.0 + 1_200_000.0);
    }
}
