//! Mono audio resampler (rubato) for the small channel-rate → audio-rate
//! ratio corrections (e.g. 50 kHz → 48 kHz).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, PolynomialDegree, Resampler};

use crate::Complex32;

const CHUNK: usize = 1024;

pub struct MonoResampler {
    inner: Async<f32>,
    pending: Vec<f32>,
}

impl MonoResampler {
    /// `None` when the rates already match (within 0.01 Hz).
    pub fn new(in_rate: f64, out_rate: f64) -> Option<Self> {
        if (in_rate - out_rate).abs() < 0.01 {
            return None;
        }
        let inner = Async::new_poly(
            out_rate / in_rate,
            1.1,
            PolynomialDegree::Septic,
            CHUNK,
            1,
            FixedAsync::Input,
        )
        .expect("resampler construction");
        Some(MonoResampler { inner, pending: Vec::new() })
    }

    /// Feed input samples; appends resampled output to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.pending.extend_from_slice(input);
        while self.pending.len() >= CHUNK {
            let adapter = InterleavedSlice::new(&self.pending[..CHUNK], 1, CHUNK).expect("adapter");
            let produced = self.inner.process(&adapter, None).expect("resample");
            out.extend_from_slice(&produced.take_data());
            self.pending.drain(..CHUNK);
        }
    }
}

/// Stereo audio resampler: L/R as a 2-channel interleaved stream so both
/// channels share exact timing (independent mono resamplers would be free to
/// drift apart by a sample and smear the stereo image).
pub struct StereoResampler {
    inner: Async<f32>,
    pending: Vec<f32>, // interleaved L,R
}

impl StereoResampler {
    /// `None` when the rates already match (within 0.01 Hz).
    pub fn new(in_rate: f64, out_rate: f64) -> Option<Self> {
        if (in_rate - out_rate).abs() < 0.01 {
            return None;
        }
        let inner = Async::new_poly(
            out_rate / in_rate,
            1.1,
            PolynomialDegree::Septic,
            CHUNK,
            2,
            FixedAsync::Input,
        )
        .expect("resampler construction");
        Some(StereoResampler { inner, pending: Vec::new() })
    }

    /// Feed interleaved L/R samples; appends interleaved L/R output to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.pending.extend_from_slice(input);
        while self.pending.len() >= CHUNK * 2 {
            let adapter =
                InterleavedSlice::new(&self.pending[..CHUNK * 2], 2, CHUNK).expect("adapter");
            let produced = self.inner.process(&adapter, None).expect("resample");
            out.extend_from_slice(&produced.take_data());
            self.pending.drain(..CHUNK * 2);
        }
    }
}

/// Complex-valued resampler: I/Q as a 2-channel interleaved stream so both
/// components share exact timing.
///
/// This one runs at I/Q rates — the HD Radio decoder's is three quarters of a
/// million samples a second — so it does not allocate per chunk: output goes
/// into a buffer kept between calls, and the consumed input is shifted out of
/// `pending` once per call rather than once per chunk.
pub struct ComplexResampler {
    inner: Async<f32>,
    pending: Vec<f32>, // interleaved re,im
    produced: Vec<f32>,
}

impl ComplexResampler {
    /// `None` when the rates already match (within 0.01 Hz).
    pub fn new(in_rate: f64, out_rate: f64) -> Option<Self> {
        if (in_rate - out_rate).abs() < 0.01 {
            return None;
        }
        let inner = Async::new_poly(
            out_rate / in_rate,
            4.0,
            PolynomialDegree::Septic,
            CHUNK,
            2,
            FixedAsync::Input,
        )
        .expect("resampler construction");
        let produced = vec![0.0; inner.output_frames_max() * 2];
        Some(ComplexResampler { inner, pending: Vec::new(), produced })
    }

    pub fn push(&mut self, input: &[Complex32], out: &mut Vec<Complex32>) {
        self.pending.reserve(input.len() * 2);
        for z in input {
            self.pending.push(z.re);
            self.pending.push(z.im);
        }
        let mut consumed = 0;
        while self.pending.len() - consumed >= CHUNK * 2 {
            let adapter =
                InterleavedSlice::new(&self.pending[consumed..consumed + CHUNK * 2], 2, CHUNK)
                    .expect("adapter");
            let frames = self.produced.len() / 2;
            let mut into =
                InterleavedSlice::new_mut(&mut self.produced, 2, frames).expect("adapter");
            let (_, written) =
                self.inner.process_into_buffer(&adapter, &mut into, None).expect("resample");
            out.extend(
                self.produced[..written * 2].chunks_exact(2).map(|p| Complex32::new(p[0], p[1])),
            );
            consumed += CHUNK * 2;
        }
        self.pending.drain(..consumed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How the input is split across calls changes nothing about the output:
    /// the chunks carried over in `pending`, and the ones consumed in the middle
    /// of a call, have to be the same ones either way.
    #[test]
    fn a_complex_stream_resamples_the_same_whatever_the_block_size() {
        let input: Vec<Complex32> = (0..20_000)
            .map(|n| {
                let t = n as f32 * 0.013;
                Complex32::new(t.cos(), (t * 1.7).sin())
            })
            .collect();
        let mut whole = ComplexResampler::new(1_000_000.0, 744_187.5).unwrap();
        let mut once = Vec::new();
        whole.push(&input, &mut once);

        let mut split = ComplexResampler::new(1_000_000.0, 744_187.5).unwrap();
        let mut pieces = Vec::new();
        for block in input.chunks(333) {
            split.push(block, &mut pieces);
        }
        assert!(!once.is_empty());
        assert_eq!(once, pieces);
        // 19 whole chunks of 1024 in 20 000 samples, each at the rate ratio.
        let expected = (19.0 * 1024.0 * 744_187.5 / 1_000_000.0) as usize;
        assert!(once.len().abs_diff(expected) <= 19, "{} vs {expected}", once.len());
    }
}
