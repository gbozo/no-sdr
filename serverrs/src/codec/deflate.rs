//! Deflate-compressed FFT frames (raw deflate, no zlib wrapper).
//!
//! Ported from the original Go backend.

use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use flate2::write::DeflateEncoder;
use flate2::Compression;

use super::fft::{compress_fft_into, delta_encode};

pub const NOISE_FLOOR_PERCENTILE: usize = 5;
const NOISE_FLOOR_EMA_ALPHA: f64 = 0.05;

/// `deflate-smooth` clamps at the frame median plus this margin.
pub const SMOOTH_PERCENTILE: usize = 50;

static CONFIG_DEFLATE_LEVEL: AtomicU32 = AtomicU32::new(2);
/// f32 bits for the default 2.0 dB smooth margin.
static SMOOTH_MARGIN_BITS: AtomicU32 = AtomicU32::new(0x4000_0000);

/// Deflate level for FFT frames.
///
/// Benchmarks on real 32768-bin FM frames: levels 2-8 are within 0.5 % of each
/// other in size, level 1 is ~60 % larger, and level 9 is ~4 % larger and 2x
/// slower (zlib-rs). Level 2 is the fastest point on that plateau. The admin
/// UI sets the level; `FFT_DEFLATE_LEVEL` (1-9) overrides it for experiments.
pub fn deflate_level() -> u32 {
    fn env_level() -> Option<u32> {
        static ENV: OnceLock<Option<u32>> = OnceLock::new();
        *ENV.get_or_init(|| {
            std::env::var("FFT_DEFLATE_LEVEL")
                .ok()
                .and_then(|v| v.parse::<u32>().ok())
                .filter(|l| (1..=9).contains(l))
        })
    }
    env_level().unwrap_or_else(|| CONFIG_DEFLATE_LEVEL.load(Ordering::Relaxed).clamp(1, 9))
}

pub fn set_deflate_level(level: i32) {
    CONFIG_DEFLATE_LEVEL.store(level.clamp(1, 9) as u32, Ordering::Relaxed);
}

/// dB clamp margin above the frame median for the `deflate-smooth` codec.
pub fn smooth_margin_db() -> f32 {
    f32::from_bits(SMOOTH_MARGIN_BITS.load(Ordering::Relaxed)).clamp(0.0, 20.0)
}

pub fn set_smooth_margin_db(db: f32) {
    if db.is_finite() {
        SMOOTH_MARGIN_BITS.store(db.clamp(0.0, 20.0).to_bits(), Ordering::Relaxed);
    }
}

fn deflate(data: &[u8]) -> Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(deflate_level()));
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

/// Code value at `percentile` from a byte histogram.
fn hist_percentile(hist: &[usize; 256], n: usize, percentile: usize) -> u8 {
    let target = (n * percentile).div_ceil(100);
    let mut cumulative = 0usize;
    for (b, &count) in hist.iter().enumerate() {
        cumulative += count;
        if cumulative >= target {
            return b as u8;
        }
    }
    0
}

/// Clamp every code below the `percentile` (+ `margin_codes`) to the floor.
/// Returns the clamp code. Used by the FFT history burst, which has no EMA
/// state of its own.
pub fn clamp_percentile(frame: &mut [u8], percentile: usize, margin_codes: usize) -> u8 {
    let mut hist = [0usize; 256];
    for &b in frame.iter() {
        hist[b as usize] += 1;
    }
    let floor = (hist_percentile(&hist, frame.len(), percentile) as usize + margin_codes).min(255) as u8;
    for b in frame.iter_mut() {
        if *b < floor {
            *b = floor;
        }
    }
    floor
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

    /// Percentile clamp threshold from the u8 quantized frame, with an
    /// optional extra margin in codes, smoothed by an EMA.
    fn update_clamp_floor(
        &mut self,
        quantized: &[u8],
        percentile: usize,
        margin_codes: usize,
    ) -> u8 {
        let n = quantized.len();
        let mut hist = [0usize; 256];
        for &b in quantized {
            hist[b as usize] += 1;
        }
        let idx = (hist_percentile(&hist, n, percentile) as usize + margin_codes).min(255) as u8;

        if !self.noise_floor_set {
            self.noise_floor_ema = idx as f64;
            self.noise_floor_set = true;
        } else {
            self.noise_floor_ema +=
                NOISE_FLOOR_EMA_ALPHA * (idx as f64 - self.noise_floor_ema);
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

    /// Median-clamped variant used by the `deflate-smooth` codec.
    pub fn encode_payload_smooth(
        &mut self,
        fft: &[f32],
        min_db: f32,
        max_db: f32,
    ) -> Result<Vec<u8>> {
        let body = self.encode_smooth_body(fft, min_db, max_db)?;
        Ok(pack_header(fft.len(), min_db, max_db, &body))
    }

    /// Median-clamped full wire message.
    pub fn encode_message_smooth(
        &mut self,
        msg_type: u8,
        fft: &[f32],
        min_db: f32,
        max_db: f32,
    ) -> Result<Vec<u8>> {
        let body = self.encode_smooth_body(fft, min_db, max_db)?;
        let mut msg = Vec::with_capacity(1 + 8 + body.len());
        msg.push(msg_type);
        msg.extend_from_slice(&pack_header(fft.len(), min_db, max_db, &body));
        Ok(msg)
    }

    fn encode_floor_body(&mut self, fft: &[f32], min_db: f32, max_db: f32) -> Result<Vec<u8>> {
        self.encode_clamped_body(fft, min_db, max_db, NOISE_FLOOR_PERCENTILE, 0.0)
    }

    fn encode_smooth_body(&mut self, fft: &[f32], min_db: f32, max_db: f32) -> Result<Vec<u8>> {
        self.encode_clamped_body(fft, min_db, max_db, SMOOTH_PERCENTILE, smooth_margin_db())
    }

    fn encode_clamped_body(
        &mut self,
        fft: &[f32],
        min_db: f32,
        max_db: f32,
        percentile: usize,
        margin_db: f32,
    ) -> Result<Vec<u8>> {
        let n = fft.len();
        let mut scratch = vec![0u8; n];
        compress_fft_into(fft, min_db, max_db, &mut scratch);
        let range = (max_db - min_db).max(0.001);
        let margin_codes = ((margin_db / range) * 255.0).round().max(0.0) as usize;
        let floor = self.update_clamp_floor(&scratch, percentile, margin_codes);
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

    #[test]
    fn smooth_clamps_above_floor() {
        let fft = vec![-110.0f32; 64];
        let mut floor_enc = FftDeflateEncoder::new(64);
        let mut smooth_enc = FftDeflateEncoder::new(64);
        let floor = floor_enc.encode_payload_floor(&fft, -120.0, -10.0).unwrap();
        let smooth = smooth_enc.encode_payload_smooth(&fft, -120.0, -10.0).unwrap();

        let decode = |payload: &[u8]| {
            let mut dec = DeflateDecoder::new(&payload[8..]);
            let mut raw = Vec::new();
            dec.read_to_end(&mut raw).unwrap();
            super::super::fft::delta_decode(&raw)
        };
        let floor_bins = decode(&floor);
        let smooth_bins = decode(&smooth);
        assert!(
            smooth_bins[0] > floor_bins[0],
            "smooth {} should clamp above floor {}",
            smooth_bins[0],
            floor_bins[0]
        );
    }
}
