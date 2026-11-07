//! Deflate-compressed FFT frames (raw deflate, no zlib wrapper).
//!
//! Mirrors `serverng/internal/codec/deflate.go`.

use std::io::Write;

use anyhow::{Context, Result};
use flate2::write::DeflateEncoder;
use flate2::Compression;

use super::fft::{compress_fft_into, delta_encode};

const NOISE_FLOOR_PERCENTILE: usize = 5;
const NOISE_FLOOR_EMA_ALPHA: f64 = 0.05;

fn deflate(data: &[u8]) -> Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(data).context("flate write")?;
    enc.finish().context("flate close")
}

/// Compresses `[min_db i16][max_db i16][bin_count u32][deflate bytes]`.
pub fn pack_fft_deflate_payload(fft: &[f32], min_db: f32, max_db: f32) -> Result<Vec<u8>> {
    let quantized = super::fft::compress_fft(fft, min_db, max_db);
    let payload = deflate(&delta_encode(&quantized))?;
    Ok(pack_header(fft.len(), min_db, max_db, &payload))
}

/// Compresses a full wire message: `[msg_type][8-byte header][deflate]`.
pub fn pack_fft_deflate_message(
    msg_type: u8,
    fft: &[f32],
    min_db: f32,
    max_db: f32,
) -> Result<Vec<u8>> {
    let quantized = super::fft::compress_fft(fft, min_db, max_db);
    let body = deflate(&delta_encode(&quantized))?;
    let mut msg = Vec::with_capacity(1 + 8 + body.len());
    msg.push(msg_type);
    msg.extend_from_slice(&pack_header(fft.len(), min_db, max_db, &body));
    Ok(msg)
}

fn pack_header(bins: usize, min_db: f32, max_db: f32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&((min_db as f64).round() as i16).to_le_bytes());
    out.extend_from_slice(&((max_db as f64).round() as i16).to_le_bytes());
    out.extend_from_slice(&(bins as u32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

/// Reusable FFT deflate encoder (pools scratch buffer and noise-floor EMA).
#[derive(Debug, Clone)]
pub struct FftDeflateEncoder {
    scratch: Vec<u8>,
    noise_floor_ema: f64,
    noise_floor_set: bool,
}

impl FftDeflateEncoder {
    pub fn new(max_bins: usize) -> Self {
        Self {
            scratch: vec![0u8; max_bins],
            noise_floor_ema: 0.0,
            noise_floor_set: false,
        }
    }

    pub fn reset(&mut self) {
        // Go resets the flate writer; flate2 creates one per call so nothing to do.
    }

    fn quantize(&mut self, fft: &[f32], min_db: f32, max_db: f32) -> &[u8] {
        let n = fft.len();
        if self.scratch.len() < n {
            self.scratch.resize(n, 0);
        }
        compress_fft_into(fft, min_db, max_db, &mut self.scratch[..n]);
        &self.scratch[..n]
    }

    fn update_noise_floor(&mut self, quantized: &[u8]) -> u8 {
        let n = quantized.len();
        let mut hist = [0usize; 256];
        for &b in quantized {
            hist[b as usize] += 1;
        }
        let target = (n * NOISE_FLOOR_PERCENTILE).div_ceil(100);
        let mut cumulative = 0usize;
        let mut percentile_idx = 0u8;
        for (b, &count) in hist.iter().enumerate() {
            cumulative += count;
            if cumulative >= target {
                percentile_idx = b as u8;
                break;
            }
        }

        if !self.noise_floor_set {
            self.noise_floor_ema = percentile_idx as f64;
            self.noise_floor_set = true;
        } else {
            self.noise_floor_ema +=
                NOISE_FLOOR_EMA_ALPHA * (percentile_idx as f64 - self.noise_floor_ema);
        }
        let idx = (self.noise_floor_ema + 0.5) as i32;
        idx.clamp(0, 255) as u8
    }

    /// Deflates one frame (returns raw deflate bytes).
    pub fn encode(&mut self, fft: &[f32], min_db: f32, max_db: f32) -> Result<Vec<u8>> {
        let quantized = self.quantize(fft, min_db, max_db);
        deflate(&delta_encode(quantized))
    }

    /// Encodes and packs `[i16 min][i16 max][u32 bins][deflate]`.
    pub fn encode_payload(&mut self, fft: &[f32], min_db: f32, max_db: f32) -> Result<Vec<u8>> {
        let body = self.encode(fft, min_db, max_db)?;
        Ok(pack_header(fft.len(), min_db, max_db, &body))
    }

    /// Encodes a full wire message `[msg_type][header][deflate]`.
    pub fn encode_message(
        &mut self,
        msg_type: u8,
        fft: &[f32],
        min_db: f32,
        max_db: f32,
    ) -> Result<Vec<u8>> {
        let body = self.encode(fft, min_db, max_db)?;
        let mut msg = Vec::with_capacity(1 + 8 + body.len());
        msg.push(msg_type);
        msg.extend_from_slice(&pack_header(fft.len(), min_db, max_db, &body));
        Ok(msg)
    }

    /// Noise-floor clamped variant used by the `deflate-floor` codec.
    pub fn encode_payload_floor(
        &mut self,
        fft: &[f32],
        min_db: f32,
        max_db: f32,
    ) -> Result<Vec<u8>> {
        let body = self.encode_floor_body(fft, min_db, max_db)?;
        Ok(pack_header(fft.len(), min_db, max_db, &body))
    }

    /// Noise-floor clamped full wire message.
    pub fn encode_message_floor(
        &mut self,
        msg_type: u8,
        fft: &[f32],
        min_db: f32,
        max_db: f32,
    ) -> Result<Vec<u8>> {
        let body = self.encode_floor_body(fft, min_db, max_db)?;
        let mut msg = Vec::with_capacity(1 + 8 + body.len());
        msg.push(msg_type);
        msg.extend_from_slice(&pack_header(fft.len(), min_db, max_db, &body));
        Ok(msg)
    }

    fn encode_floor_body(&mut self, fft: &[f32], min_db: f32, max_db: f32) -> Result<Vec<u8>> {
        let n = fft.len();
        let mut scratch = vec![0u8; n];
        compress_fft_into(fft, min_db, max_db, &mut scratch);
        let floor = self.update_noise_floor(&scratch);
        // Clamp + delta encode in place (mirrors Go's in-place pass).
        for b in scratch.iter_mut() {
            if *b < floor {
                *b = floor;
            }
        }
        for i in (1..n).rev() {
            scratch[i] = scratch[i].wrapping_sub(scratch[i - 1]);
        }
        deflate(&scratch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    #[test]
    fn payload_round_trips() {
        let fft: Vec<f32> = (0..1024)
            .map(|i| -100.0 + (i as f32 * 0.1).sin() * 20.0)
            .collect();
        let payload = pack_fft_deflate_payload(&fft, -120.0, -10.0).unwrap();
        assert_eq!(payload.len() > 8, true);
        assert_eq!(i16::from_le_bytes([payload[0], payload[1]]), -120);
        assert_eq!(i16::from_le_bytes([payload[2], payload[3]]), -10);
        assert_eq!(
            u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]),
            1024
        );
        let mut dec = DeflateDecoder::new(&payload[8..]);
        let mut raw = Vec::new();
        dec.read_to_end(&mut raw).unwrap();
        let bins = super::super::fft::delta_decode(&raw);
        assert_eq!(bins.len(), 1024);
    }

    #[test]
    fn floor_clamps_low_bins() {
        let mut enc = FftDeflateEncoder::new(64);
        let fft = vec![-110.0f32; 64];
        let payload = enc.encode_payload_floor(&fft, -120.0, -10.0).unwrap();
        let mut dec = DeflateDecoder::new(&payload[8..]);
        let mut raw = Vec::new();
        dec.read_to_end(&mut raw).unwrap();
        let bins = super::super::fft::delta_decode(&raw);
        assert!(bins[0] > 0);
    }
}
