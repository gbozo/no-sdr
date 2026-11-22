//! Adaptive range-coded FFT frames.
//!
//! Wire body: `[i16 minDb][i16 maxDb][u32 binCount][range-coded bytes]`.
//! The encoder clamps at the frame median + smooth margin (same shape as
//! `deflate-smooth`), delta-codes the u8 bins, then entropy-codes the residual
//! with an LZMA-style binary range coder and a run-length zero model.
//!
//! The model resets every frame, so frames stay self-contained (clients can
//! join or drop frames without a keyframe).

use anyhow::{bail, Result};

use super::deflate::{clamp_percentile, smooth_margin_db, SMOOTH_PERCENTILE};
use super::fft::compress_fft_into;

pub const MSG_FFT_RANGE: u8 = 0x10;

const PROB_BITS: u32 = 11;
const PROB_INIT: u16 = 1 << (PROB_BITS - 1);
const MOVE_BITS: u32 = 5;
const TREE_SIZE: usize = 0x300;
/// Byte-tree context: top bits of the previous residual (1 = 2 contexts).
pub const BYTE_CTX_BITS: u32 = 1;
pub const BYTE_CONTEXTS: usize = 1 << BYTE_CTX_BITS;
/// Run-length contexts: 16 run buckets × 2 magnitude classes.
pub const ZERO_CONTEXTS: usize = 32;

struct RangeEncoder {
    low: u64,
    range: u32,
    cache: u8,
    cache_size: u64,
    out: Vec<u8>,
}

impl RangeEncoder {
    fn new(capacity: usize) -> Self {
        Self {
            low: 0,
            range: 0xFFFF_FFFF,
            cache: 0,
            cache_size: 1,
            out: Vec::with_capacity(capacity),
        }
    }

    #[inline(always)]
    fn shift_low(&mut self) {
        if (self.low as u32) < 0xFF00_0000 || (self.low >> 32) != 0 {
            let carry = (self.low >> 32) as u8;
            let mut temp = self.cache;
            loop {
                self.out.push(temp.wrapping_add(carry));
                temp = 0xFF;
                self.cache_size -= 1;
                if self.cache_size == 0 {
                    break;
                }
            }
            self.cache = ((self.low as u32) >> 24) as u8;
        }
        self.cache_size += 1;
        self.low = ((self.low as u32) << 8) as u64;
    }

    #[inline(always)]
    fn bit(&mut self, prob: &mut u16, bit: u32) {
        let p = *prob as u32;
        let bound = (self.range >> PROB_BITS) * p;
        if bit == 0 {
            self.range = bound;
            *prob += ((1 << PROB_BITS) - p) as u16 >> MOVE_BITS;
        } else {
            self.low += bound as u64;
            self.range -= bound;
            *prob -= *prob >> MOVE_BITS;
        }
        while self.range < (1 << 24) {
            self.range <<= 8;
            self.shift_low();
        }
    }

    fn finish(mut self) -> Vec<u8> {
        for _ in 0..5 {
            self.shift_low();
        }
        self.out
    }
}

struct RangeDecoder<'a> {
    code: u32,
    range: u32,
    data: &'a [u8],
    pos: usize,
}

impl<'a> RangeDecoder<'a> {
    fn new(data: &'a [u8]) -> Self {
        let mut d = Self { code: 0, range: 0xFFFF_FFFF, data, pos: 0 };
        for _ in 0..5 {
            d.code = (d.code << 8) | d.byte() as u32;
        }
        d
    }

    #[inline(always)]
    fn byte(&mut self) -> u8 {
        let b = if self.pos < self.data.len() {
            self.data[self.pos]
        } else {
            0
        };
        self.pos += 1;
        b
    }

    #[inline(always)]
    fn bit(&mut self, prob: &mut u16) -> u32 {
        let p = *prob as u32;
        let bound = (self.range >> PROB_BITS) * p;
        let bit = if self.code < bound {
            self.range = bound;
            *prob += ((1 << PROB_BITS) - p) as u16 >> MOVE_BITS;
            0
        } else {
            self.code -= bound;
            self.range -= bound;
            *prob -= *prob >> MOVE_BITS;
            1
        };
        while self.range < (1 << 24) {
            self.range <<= 8;
            self.code = (self.code << 8) | self.byte() as u32;
        }
        bit
    }
}

#[inline]
fn byte_context(prev_residual: u8) -> usize {
    (prev_residual >> (8 - BYTE_CTX_BITS)) as usize
}

#[inline(always)]
fn encode_byte(enc: &mut RangeEncoder, probs: &mut [u16], ctx: usize, byte: u8) {
    let base = ctx * TREE_SIZE;
    let mut state = 1usize;
    for i in (0..8).rev() {
        let bit = ((byte >> i) & 1) as u32;
        enc.bit(&mut probs[base + state], bit);
        state = (state << 1) | bit as usize;
    }
}

#[inline(always)]
fn decode_byte(dec: &mut RangeDecoder, probs: &mut [u16], ctx: usize) -> u8 {
    let base = ctx * TREE_SIZE;
    let mut state = 1usize;
    for _ in 0..8 {
        let bit = dec.bit(&mut probs[base + state]);
        state = (state << 1) | bit as usize;
    }
    (state - 0x100) as u8
}

/// Reusable range encoder for the `range` FFT codec.
#[derive(Debug, Clone)]
pub struct FftRangeEncoder {
    scratch: Vec<u8>,
    zero_probs: [u16; ZERO_CONTEXTS],
    byte_probs: [u16; BYTE_CONTEXTS * TREE_SIZE],
}

impl FftRangeEncoder {
    pub fn new(max_bins: usize) -> Self {
        Self {
            scratch: vec![0u8; max_bins],
            zero_probs: [PROB_INIT; ZERO_CONTEXTS],
            byte_probs: [PROB_INIT; BYTE_CONTEXTS * TREE_SIZE],
        }
    }

    /// Encodes a full wire message `[msg_type][header][range-coded]`.
    pub fn encode_message(
        &mut self,
        msg_type: u8,
        fft: &[f32],
        min_db: f32,
        max_db: f32,
    ) -> Result<Vec<u8>> {
        let n = fft.len();
        if self.scratch.len() < n {
            self.scratch.resize(n, 0);
        }
        compress_fft_into(fft, min_db, max_db, &mut self.scratch[..n]);

        let range = (max_db - min_db).max(0.001);
        let margin_codes = ((smooth_margin_db() / range) * 255.0).round().max(0.0) as usize;
        clamp_percentile(&mut self.scratch[..n], SMOOTH_PERCENTILE, margin_codes);

        self.zero_probs.fill(PROB_INIT);
        self.byte_probs.fill(PROB_INIT);

        let mut enc = RangeEncoder::new(n);
        let mut prev_code = 0u8;
        let mut prev_res = 0u8;
        let mut run = 0usize;
        let mut mag_class = 0usize;
        for &code in &self.scratch[..n] {
            let b = code.wrapping_sub(prev_code);
            prev_code = code;
            let zctx = run.min(15) | (mag_class << 4);
            enc.bit(&mut self.zero_probs[zctx], (b == 0) as u32);
            if b != 0 {
                let ctx = byte_context(prev_res);
                encode_byte(&mut enc, &mut self.byte_probs, ctx, b);
                let circ = (b as i16 - 256).unsigned_abs().min(b as u16) as u8;
                mag_class = if circ >= 4 { 1 } else { 0 };
                prev_res = b;
                run = 0;
            } else {
                run += 1;
            }
        }
        let payload = enc.finish();

        let mut msg = Vec::with_capacity(1 + 8 + payload.len());
        msg.push(msg_type);
        msg.extend_from_slice(&((min_db as f64).round() as i16).to_le_bytes());
        msg.extend_from_slice(&((max_db as f64).round() as i16).to_le_bytes());
        msg.extend_from_slice(&(n as u32).to_le_bytes());
        msg.extend_from_slice(&payload);
        Ok(msg)
    }
}

/// Decodes a range-coded FFT body (header already stripped) into u8 codes.
///
/// Used by tests; the browser has the matching TypeScript decoder.
pub fn decode_codes(payload: &[u8], bins: usize) -> Result<Vec<u8>> {
    if payload.len() < 5 {
        bail!("range payload too short");
    }
    let mut zero_probs = [PROB_INIT; ZERO_CONTEXTS];
    let mut byte_probs = [PROB_INIT; BYTE_CONTEXTS * TREE_SIZE];
    let mut dec = RangeDecoder::new(payload);
    let mut codes = vec![0u8; bins];
    let mut prev_res = 0u8;
    let mut run = 0usize;
    let mut mag_class = 0usize;
    let mut prev_code = 0u8;
    for code in codes.iter_mut() {
        let zctx = run.min(15) | (mag_class << 4);
        let is_zero = dec.bit(&mut zero_probs[zctx]) == 1;
        let b = if is_zero {
            run += 1;
            0u8
        } else {
            let ctx = byte_context(prev_res);
            let b = decode_byte(&mut dec, &mut byte_probs, ctx);
            let circ = (b as i16 - 256).unsigned_abs().min(b as u16) as u8;
            mag_class = if circ >= 4 { 1 } else { 0 };
            prev_res = b;
            run = 0;
            b
        };
        prev_code = prev_code.wrapping_add(b);
        *code = prev_code;
    }
    Ok(codes)
}

/// Encodes an FFT-history burst: per-frame delta (reset at each frame) over
/// the flat decimated frame stream. The probability model persists across the
/// whole burst, so there is no per-frame model reset.
pub fn encode_history(codes: &[u8], frame_bins: usize) -> Vec<u8> {
    assert!(frame_bins > 0);
    let mut zero_probs = [PROB_INIT; ZERO_CONTEXTS];
    let mut byte_probs = [PROB_INIT; BYTE_CONTEXTS * TREE_SIZE];
    let mut enc = RangeEncoder::new(codes.len());
    let mut prev_res = 0u8;
    let mut run = 0usize;
    let mut mag_class = 0usize;
    for frame in codes.chunks(frame_bins) {
        let mut prev_code = 0u8;
        for &code in frame {
            let b = code.wrapping_sub(prev_code);
            prev_code = code;
            let zctx = run.min(15) | (mag_class << 4);
            enc.bit(&mut zero_probs[zctx], (b == 0) as u32);
            if b != 0 {
                let ctx = byte_context(prev_res);
                encode_byte(&mut enc, &mut byte_probs, ctx, b);
                let circ = (b as i16 - 256).unsigned_abs().min(b as u16) as u8;
                mag_class = if circ >= 4 { 1 } else { 0 };
                prev_res = b;
                run = 0;
            } else {
                run += 1;
            }
        }
    }
    enc.finish()
}

/// Decodes an FFT-history range burst into flat u8 codes.
pub fn decode_history_codes(
    payload: &[u8],
    frame_count: usize,
    frame_bins: usize,
) -> Result<Vec<u8>> {
    if payload.len() < 5 {
        bail!("range payload too short");
    }
    let mut zero_probs = [PROB_INIT; ZERO_CONTEXTS];
    let mut byte_probs = [PROB_INIT; BYTE_CONTEXTS * TREE_SIZE];
    let mut dec = RangeDecoder::new(payload);
    let mut out = vec![0u8; frame_count * frame_bins];
    let mut prev_res = 0u8;
    let mut run = 0usize;
    let mut mag_class = 0usize;
    for f in 0..frame_count {
        let mut prev_code = 0u8;
        for i in 0..frame_bins {
            let zctx = run.min(15) | (mag_class << 4);
            let is_zero = dec.bit(&mut zero_probs[zctx]) == 1;
            let b = if is_zero {
                run += 1;
                0u8
            } else {
                let ctx = byte_context(prev_res);
                let b = decode_byte(&mut dec, &mut byte_probs, ctx);
                let circ = (b as i16 - 256).unsigned_abs().min(b as u16) as u8;
                mag_class = if circ >= 4 { 1 } else { 0 };
                prev_res = b;
                run = 0;
                b
            };
            prev_code = prev_code.wrapping_add(b);
            out[f * frame_bins + i] = prev_code;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_frame(n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let x = (i as f32 * 12.9898).sin() * 43758.5453;
                let noise = (x - x.floor()) * 6.0;
                let mut v = -110.0 + noise;
                if i % 997 == 0 {
                    v += 25.0;
                }
                v
            })
            .collect()
    }

    #[test]
    fn round_trips_codes() {
        let n = 4096;
        let fft = sample_frame(n);
        let mut enc = FftRangeEncoder::new(n);
        let msg = enc.encode_message(MSG_FFT_RANGE, &fft, -130.0, 0.0).unwrap();
        assert_eq!(msg[0], MSG_FFT_RANGE);
        let bins = u32::from_le_bytes([msg[5], msg[6], msg[7], msg[8]]) as usize;
        assert_eq!(bins, n);
        let codes = decode_codes(&msg[9..], n).unwrap();

        // Expected codes: quantize + clamp at median + smooth margin.
        let mut expected = vec![0u8; n];
        super::super::fft::compress_fft_into(&fft, -130.0, 0.0, &mut expected);
        let range = 130.0f32;
        let margin_codes = ((smooth_margin_db() / range) * 255.0).round().max(0.0) as usize;
        clamp_percentile(&mut expected, SMOOTH_PERCENTILE, margin_codes);
        assert_eq!(codes, expected);
    }

    #[test]
    fn round_trips_random_payload() {
        // Drive the coder through many symbol patterns.
        let n = 2048;
        let mut data = vec![0u8; n];
        let mut seed = 0x1234_5678u32;
        for v in data.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *v = if seed % 5 == 0 { (seed >> 24) as u8 } else { 0 };
        }
        let mut enc = RangeEncoder::new(n);
        let mut zero_probs = [PROB_INIT; ZERO_CONTEXTS];
        let mut byte_probs = [PROB_INIT; BYTE_CONTEXTS * TREE_SIZE];
        let mut prev_res = 0u8;
        let mut run = 0usize;
        let mut mag_class = 0usize;
        for &b in &data {
            let zctx = run.min(15) | (mag_class << 4);
            enc.bit(&mut zero_probs[zctx], (b == 0) as u32);
            if b != 0 {
                let ctx = byte_context(prev_res);
                encode_byte(&mut enc, &mut byte_probs, ctx, b);
                let circ = (b as i16 - 256).unsigned_abs().min(b as u16) as u8;
                mag_class = if circ >= 4 { 1 } else { 0 };
                prev_res = b;
                run = 0;
            } else {
                run += 1;
            }
        }
        let payload = enc.finish();

        let mut zero_probs = [PROB_INIT; ZERO_CONTEXTS];
        let mut byte_probs = [PROB_INIT; BYTE_CONTEXTS * TREE_SIZE];
        let mut dec = RangeDecoder::new(&payload);
        let mut out = Vec::with_capacity(n);
        let mut prev_res = 0u8;
        let mut run = 0usize;
        let mut mag_class = 0usize;
        for _ in 0..n {
            let zctx = run.min(15) | (mag_class << 4);
            let is_zero = dec.bit(&mut zero_probs[zctx]) == 1;
            let b = if is_zero {
                run += 1;
                0
            } else {
                let ctx = byte_context(prev_res);
                let b = decode_byte(&mut dec, &mut byte_probs, ctx);
                let circ = (b as i16 - 256).unsigned_abs().min(b as u16) as u8;
                mag_class = if circ >= 4 { 1 } else { 0 };
                prev_res = b;
                run = 0;
                b
            };
            out.push(b);
        }
        assert_eq!(out, data);
    }

    #[test]
    fn history_round_trips() {
        let bins = 64usize;
        let frames = 8usize;
        let mut data = vec![0u8; bins * frames];
        for f in 0..frames {
            for i in 0..bins {
                data[f * bins + i] = ((f * 7 + i * 3) % 200) as u8;
            }
        }
        let payload = encode_history(&data, bins);
        let out = decode_history_codes(&payload, frames, bins).unwrap();
        assert_eq!(out, data);
    }
}
