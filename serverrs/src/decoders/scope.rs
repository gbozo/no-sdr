//! A small, per-client zoomed spectrum for the foreground decoder pane.
//!
//! The main waterfall FFT is built for the whole dongle span (typically
//! 8192 bins over 2.4 MSPS, ~293 Hz/bin), which is far too coarse to show an
//! FT8 signal inside a 3 kHz window. This processor runs its own NCO + filter
//! + decimator over the raw device stream, then a 512-point FFT centred on the
//! decoder's display span.
//!
//! It is only created when the client explicitly asks for it, so clients that
//! keep the decoder pane closed cost nothing.

use std::time::{Duration, Instant};

use num_complex::Complex32;

use crate::dsp::{Fft, IqExtractor, IqExtractorConfig};
use crate::ws::pack_decoder_scope;

use super::RangeSpec;

/// Fixed dB range of the compact u8 bins. Matches the main waterfall's range.
const MIN_DB: f32 = -130.0;
const MAX_DB: f32 = 0.0;
const BINS: usize = 512;

/// FFT size for the tap that reuses a decoder channel's own extracted IQ.
/// 1024 bins over the channel rate (~12 kHz) gives ~12 Hz/bin; the client
/// receives the 512 bins that cover the requested display span.
const TAP_BINS: usize = 1024;
const TAP_OUT_BINS: usize = 512;

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
        let base_start = dial_hz - input_rate * 0.5;
        let first = ((display.start_hz - base_start) / hz_per_bin).round();
        let first_bin = first
            .max(0.0)
            .min((TAP_BINS - TAP_OUT_BINS) as f64) as usize;
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
            bins: vec![0; TAP_OUT_BINS],
            first_bin,
            start_hz: base_start + first_bin as f64 * hz_per_bin,
            hz_per_bin: hz_per_bin as f32,
            interval: Duration::from_millis(1_000 / fps.clamp(2, 20) as u64),
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
            self.magnitude[i] =
                20.0 * (self.scratch[i].norm() * scale + 1e-12).log10();
        }
        let half = TAP_BINS / 2;
        let range = MAX_DB - MIN_DB;
        for i in 0..TAP_OUT_BINS {
            let shifted = (self.first_bin + i) % TAP_BINS;
            let src = if shifted < half { shifted + half } else { shifted - half };
            let v = ((self.magnitude[src] - MIN_DB) / range * 255.0).clamp(0.0, 255.0);
            self.bins[i] = v as u8;
        }

        self.last_emit = Some(now);
        Some(pack_decoder_scope(
            self.start_hz,
            self.hz_per_bin,
            MIN_DB,
            MAX_DB,
            &self.bins,
        ))
    }
}

pub(crate) struct ScopeProcessor {
    extractor: IqExtractor,
    fft: Fft,
    window: Vec<f32>,
    pcm: Vec<i16>,
    pending: Vec<Complex32>,
    scratch: Vec<Complex32>,
    magnitude: Vec<f32>,
    bins: Vec<u8>,
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
    ) -> Result<Self, String> {
        let requested = display.bandwidth_hz().clamp(200.0, 250_000.0);
        // Ask for a little more than the requested span: the integer
        // decimator rounds to the nearest factor and must not land under it.
        let output_request = (requested * 1.15).ceil() as i32;
        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            output_sample_rate: output_request,
            tune_offset: (display.center_hz() - center_hz).round() as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("decoder scope extractor: {e}"))?;
        extractor.set_bandwidth(requested as i32);

        let actual_rate = extractor.output_sample_rate() as f64;
        let fft = Fft::new(BINS).map_err(|e| format!("decoder scope FFT: {e}"))?;
        let window = (0..BINS)
            .map(|i| {
                let x = std::f32::consts::TAU * i as f32 / (BINS - 1) as f32;
                0.5 - 0.5 * x.cos()
            })
            .collect();

        Ok(Self {
            extractor,
            fft,
            window,
            pcm: Vec::new(),
            pending: Vec::with_capacity(BINS * 2),
            scratch: vec![Complex32::default(); BINS],
            magnitude: vec![MIN_DB; BINS],
            bins: vec![0; BINS],
            start_hz: display.center_hz() - actual_rate * 0.5,
            hz_per_bin: (actual_rate / BINS as f64) as f32,
            interval: Duration::from_millis(1_000 / fps.clamp(2, 20) as u64),
            last_emit: None,
        })
    }

    /// Feed one raw Cu8 chunk. Returns a packed `MSG_DECODER_SCOPE` only when
    /// the output interval has elapsed and enough samples are buffered.
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
        let keep = BINS * 2;
        if self.pending.len() > keep {
            let drop = self.pending.len() - keep;
            self.pending.drain(..drop);
        }
        if self.pending.len() < BINS {
            return None;
        }

        let now = Instant::now();
        if let Some(last) = self.last_emit {
            if now.duration_since(last) < self.interval {
                return None;
            }
        }

        let start = self.pending.len() - BINS;
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
        let scale = 1.0 / (BINS as f32 * 0.5);
        for i in 0..BINS {
            let db = 20.0 * (self.scratch[i].norm() * scale + 1e-12).log10();
            self.magnitude[i] = db;
        }
        let half = BINS / 2;
        let range = MAX_DB - MIN_DB;
        for i in 0..BINS {
            let src = if i < half { i + half } else { i - half };
            let v = ((self.magnitude[src] - MIN_DB) / range * 255.0).clamp(0.0, 255.0);
            self.bins[i] = v as u8;
        }

        self.last_emit = Some(now);
        Some(pack_decoder_scope(
            self.start_hz,
            self.hz_per_bin,
            MIN_DB,
            MAX_DB,
            &self.bins,
        ))
    }
}
