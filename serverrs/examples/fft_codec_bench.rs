//! Offline FFT encoder benchmark.
//!
//! Replays a raw uint8 IQ capture through the real `FftProcessor`, groups the
//! emitted frames to the profile frame rate, then encodes/decodes each frame
//! with a set of candidate codecs and reports compression, CPU and fidelity.
//!
//! Usage:
//!   cargo run --release --example fft_codec_bench -- <capture.sigmf-data>
//!
//! Env:
//!   BENCH_FFT=32768  BENCH_FPS=12  BENCH_SECONDS=0  BENCH_LEVEL_SWEEP=1

use std::fs;
use std::io::{Read, Write};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;

use serverrs::dsp::{FftProcessor, FftProcessorConfig};

const SAMPLE_RATE: i32 = 2_400_000;
const MIN_DB: f32 = -130.0;
const MAX_DB: f32 = 0.0;
const HEADER_LEN: usize = 8;

#[derive(Clone, Copy, Debug)]
enum RangePolicy {
    /// Fixed lo/hi ladder (current server behaviour).
    Fixed(f32, f32),
    /// lo = smoothed percentile <p>, hi = frame max + 1 dB.
    AdaptLo(f32),
}

#[derive(Clone, Copy, Debug)]
enum Pred {
    None,
    Spatial,
    Temporal,
    TemporalSpatial,
}

#[derive(Clone, Copy, Debug)]
enum Pack {
    Bytes,
    Bits(u8),
    /// Nonuniform 8-bit ladder: code 0 is a dead zone, the next `low_codes`
    /// codes span a narrow band above the noise floor (fine weak-signal
    /// resolution), and the remaining codes span up to the frame peak.
    Piecewise { dead: f32, split_db: f32, low_codes: u8 },
}

#[derive(Clone, Copy, Debug)]
struct Variant {
    name: &'static str,
    range: RangePolicy,
    pred: Pred,
    pack: Pack,
    level: Option<u32>,
    /// (percentile, dead-zone margin dB): clamp bins below floor+margin.
    blank: Option<(u8, f32)>,
}

impl Variant {
    const ALL: &'static [Variant] = &[
        // --- baselines -----------------------------------------------------
        Variant { name: "u8-fixed", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::None, pack: Pack::Bytes, level: None, blank: None },
        Variant { name: "d6-fixed", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: None },
        Variant { name: "d9-fixed", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(9), blank: None },
        Variant { name: "d6-fixed-wide", range: RangePolicy::Fixed(-140.0, 10.0), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: None },
        // --- noise blanking (fixed ladder, like current deflate-floor) -----
        Variant { name: "d6-fixed-blank5", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 0.0)) },
        Variant { name: "d9-fixed-blank5", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(9), blank: Some((5, 0.0)) },
        Variant { name: "d6-fixed-blank5+z3", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 3.0)) },
        Variant { name: "d6-fixed-blank5+z6", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 6.0)) },
        Variant { name: "d6-fixed-blank10+z3", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((10, 3.0)) },
        // --- adaptive dB range (lo = floor, hi = frame max) ----------------
        Variant { name: "d6-adaptmax", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: None },
        Variant { name: "d6-floor5max", range: RangePolicy::AdaptLo(0.05), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: None },
        Variant { name: "d6-adaptmax-blank5", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 0.0)) },
        Variant { name: "d6-adaptmax-blank5+z3", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 3.0)) },
        // --- prediction ----------------------------------------------------
        Variant { name: "d6-fixed+temporal", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Temporal, pack: Pack::Bytes, level: Some(6), blank: None },
        Variant { name: "d6-adaptmax+temporal", range: RangePolicy::AdaptLo(0.005), pred: Pred::Temporal, pack: Pack::Bytes, level: Some(6), blank: None },
        Variant { name: "d6-adaptmax+2d", range: RangePolicy::AdaptLo(0.005), pred: Pred::TemporalSpatial, pack: Pack::Bytes, level: Some(6), blank: None },
        Variant { name: "d6-fixed-blank5+z3+temporal", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Temporal, pack: Pack::Bytes, level: Some(6), blank: Some((5, 3.0)) },
        // --- bit depth -----------------------------------------------------
        Variant { name: "d6-adaptmax-6bit", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Bits(6), level: Some(6), blank: None },
        Variant { name: "d6-adaptmax+2d-6bit", range: RangePolicy::AdaptLo(0.005), pred: Pred::TemporalSpatial, pack: Pack::Bits(6), level: Some(6), blank: None },
        Variant { name: "d6-adaptmax-5bit", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Bits(5), level: Some(6), blank: None },
        Variant { name: "d6-fixed-blank5+z3-6bit", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bits(6), level: Some(6), blank: Some((5, 3.0)) },
        // --- piecewise ladder: dead zone + fine weak band + coarse peaks --
        Variant { name: "pw-d3-s20-l96", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Piecewise { dead: 3.0, split_db: 20.0, low_codes: 96 }, level: Some(6), blank: None },
        Variant { name: "pw-d3-s15-l96", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Piecewise { dead: 3.0, split_db: 15.0, low_codes: 96 }, level: Some(6), blank: None },
        Variant { name: "pw-d3-s25-l96", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Piecewise { dead: 3.0, split_db: 25.0, low_codes: 96 }, level: Some(6), blank: None },
        Variant { name: "pw-d3-s20-l64", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Piecewise { dead: 3.0, split_db: 20.0, low_codes: 64 }, level: Some(6), blank: None },
        Variant { name: "pw-d3-s20-l128", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Piecewise { dead: 3.0, split_db: 20.0, low_codes: 128 }, level: Some(6), blank: None },
        Variant { name: "pw-d5-s25-l96", range: RangePolicy::AdaptLo(0.005), pred: Pred::Spatial, pack: Pack::Piecewise { dead: 5.0, split_db: 25.0, low_codes: 96 }, level: Some(6), blank: None },
        Variant { name: "pw-d3-s20-l96+temporal", range: RangePolicy::AdaptLo(0.005), pred: Pred::Temporal, pack: Pack::Piecewise { dead: 3.0, split_db: 20.0, low_codes: 96 }, level: Some(6), blank: None },
        // --- dead-zone knee + wide ladder + fast levels --------------------
        Variant { name: "d6-fixed-blank5+z4", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 4.0)) },
        Variant { name: "d6-fixed-blank5+z5", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 5.0)) },
        Variant { name: "d6-wide-blank5+z3", range: RangePolicy::Fixed(-140.0, 10.0), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 3.0)) },
        Variant { name: "d6-wide-blank5+z4", range: RangePolicy::Fixed(-140.0, 10.0), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((5, 4.0)) },
        Variant { name: "d6-fixed-blank10+z6", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(6), blank: Some((10, 6.0)) },
        Variant { name: "d2-fixed-blank5+z3", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(2), blank: Some((5, 3.0)) },
        Variant { name: "d3-fixed-blank5+z3", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((5, 3.0)) },
        // --- median-relative noise blanking --------------------------------
        Variant { name: "d3-blank25", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((25, 0.0)) },
        Variant { name: "d3-blank25+z3", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((25, 3.0)) },
        Variant { name: "d3-blank50", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((50, 0.0)) },
        Variant { name: "d3-blank50+z2", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((50, 2.0)) },
        Variant { name: "d3-blank50+z4", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((50, 4.0)) },
        Variant { name: "d3-blank50+z6", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((50, 6.0)) },
        Variant { name: "d3-blank75", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((75, 0.0)) },
        Variant { name: "d3-blank75+z3", range: RangePolicy::Fixed(MIN_DB, MAX_DB), pred: Pred::Spatial, pack: Pack::Bytes, level: Some(3), blank: Some((75, 3.0)) },
    ];
}

#[derive(Default, Clone, Copy)]
struct FrameStats {
    median: f32,
    p05: f32,
    p5: f32,
    p10: f32,
    p25: f32,
    p50: f32,
    p75: f32,
    max: f32,
    /// Fraction of bins more than 6 dB above the median.
    occ6: f32,
}

impl FrameStats {
    fn from_frame(frame: &[f32]) -> Self {
        let mut s = frame.to_vec();
        s.sort_unstable_by(|a, b| a.total_cmp(b));
        let pct = |p: f32| {
            let idx = (((s.len() - 1) as f32) * p).round() as usize;
            s[idx.min(s.len() - 1)]
        };
        let median = pct(0.5);
        let cutoff = median + 6.0;
        let above = s.len() - s.partition_point(|&v| v <= cutoff);
        let occ6 = above as f32 / s.len() as f32;
        Self {
            median,
            p05: pct(0.005),
            p5: pct(0.05),
            p10: pct(0.10),
            p25: pct(0.25),
            p50: pct(0.50),
            p75: pct(0.75),
            max: s[s.len() - 1],
            occ6,
        }
    }
}

struct RangeState {
    lo: f32,
    hi: f32,
    init: bool,
    blank_ema: f32,
    blank_set: bool,
}

impl RangeState {
    fn new() -> Self {
        Self { lo: MIN_DB, hi: MAX_DB, init: false, blank_ema: 0.0, blank_set: false }
    }

    fn update(&mut self, stats: &FrameStats, policy: RangePolicy) -> (i16, i16) {
        let (raw_lo, raw_hi) = match policy {
            RangePolicy::Fixed(lo, hi) => (lo, hi),
            // Use the true frame maximum for hi: percentiles clip wideband FM
            // carriers occupying more than the percentile tail.
            RangePolicy::AdaptLo(p) => {
                let lo = match p {
                    p if p < 0.01 => stats.p05,
                    p if p < 0.08 => stats.p5,
                    _ => stats.p10,
                };
                (lo.floor() - 1.0, stats.max.ceil() + 1.0)
            }
        };
        if !self.init {
            self.lo = raw_lo;
            self.hi = raw_hi;
            self.init = true;
        } else {
            self.lo = if raw_lo <= self.lo { raw_lo } else { (self.lo + 1.0).min(raw_lo) };
            self.hi = if raw_hi >= self.hi { raw_hi } else { (self.hi - 1.0).max(raw_hi) };
        }
        if self.hi - self.lo < 24.0 {
            self.hi = self.lo + 24.0;
        }
        let lo = self.lo.round() as i16;
        let hi = self.hi.round() as i16;
        self.lo = lo as f32;
        self.hi = hi as f32;
        (lo, hi)
    }

    fn blank_floor(&mut self, stats: &FrameStats, pct: u8, margin: f32) -> f32 {
        let v = match pct {
            5 => stats.p5,
            10 => stats.p10,
            25 => stats.p25,
            50 => stats.p50,
            75 => stats.p75,
            _ => stats.p5,
        } + margin;
        if !self.blank_set {
            self.blank_ema = v;
            self.blank_set = true;
        } else {
            self.blank_ema += 0.05 * (v - self.blank_ema);
        }
        self.blank_ema
    }
}

fn quantize(frame: &[f32], lo: f32, hi: f32, levels: u32) -> Vec<u8> {
    let span = (hi - lo).max(1.0);
    let max = (levels - 1) as f32;
    frame
        .iter()
        .map(|&v| (((v - lo) / span * max).round()).clamp(0.0, max) as u8)
        .collect()
}

fn dequantize(q: &[u8], lo: f32, hi: f32, levels: u32) -> Vec<f32> {
    let span = hi - lo;
    let max = (levels - 1) as f32;
    q.iter().map(|&c| lo + (c as f32 / max) * span).collect()
}

#[inline]
fn sub_mod(a: u8, b: u8, levels: u32) -> u8 {
    ((a as u32 + levels - b as u32) % levels) as u8
}

#[inline]
fn add_mod(a: u8, b: u8, levels: u32) -> u8 {
    ((a as u32 + b as u32) % levels) as u8
}

fn pack_bits(codes: &[u8], bits: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity((codes.len() * bits).div_ceil(8));
    let mut acc: u32 = 0;
    let mut n = 0usize;
    for &c in codes {
        acc |= (c as u32) << n;
        n += bits;
        while n >= 8 {
            out.push((acc & 0xFF) as u8);
            acc >>= 8;
            n -= 8;
        }
    }
    if n > 0 {
        out.push((acc & 0xFF) as u8);
    }
    out
}

fn unpack_bits(data: &[u8], count: usize, bits: usize) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(count);
    let mask = (1u32 << bits) - 1;
    let mut acc: u32 = 0;
    let mut n = 0usize;
    let mut idx = 0usize;
    while out.len() < count {
        while n < bits {
            if idx >= data.len() {
                bail!("packed payload too short");
            }
            acc |= (data[idx] as u32) << n;
            idx += 1;
            n += 8;
        }
        out.push((acc & mask) as u8);
        acc >>= bits;
        n -= bits;
    }
    Ok(out)
}

fn deflate(data: &[u8], level: u32) -> Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(level));
    enc.write_all(data)?;
    Ok(enc.finish()?)
}

fn inflate(data: &[u8]) -> Result<Vec<u8>> {
    let mut dec = DeflateDecoder::new(data);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)?;
    Ok(out)
}

fn levels_of(v: &Variant) -> u32 {
    match v.pack {
        Pack::Bytes | Pack::Piecewise { .. } => 256,
        Pack::Bits(b) => 1 << b,
    }
}

/// Nonuniform 8-bit ladder. `floor` is the noise-floor estimate (EMA), code 0
/// covers everything below `floor + dead`, codes 1..=low_codes span a narrow
/// band for weak signals, and the rest span up to the frame peak.
fn quantize_piecewise(
    frame: &[f32],
    hi: f32,
    floor: f32,
    dead: f32,
    split_db: f32,
    low_codes: u8,
) -> Vec<u8> {
    let dead_v = floor + dead;
    let split_v = floor + split_db;
    let low = low_codes.max(2) as f32;
    let max = 255.0f32;
    let low_span = (split_v - dead_v).max(0.5);
    let high_span = (hi - split_v).max(0.5);
    frame
        .iter()
        .map(|&v| {
            if v < dead_v {
                0
            } else if v < split_v {
                let n = 1.0 + (v - dead_v) / low_span * (low - 1.0);
                n.round().clamp(1.0, low) as u8
            } else {
                let n = low + 1.0 + (v - split_v) / high_span * (max - low - 1.0);
                n.round().clamp(low + 1.0, max) as u8
            }
        })
        .collect()
}

fn dequantize_piecewise(
    q: &[u8],
    hi: f32,
    floor: f32,
    dead: f32,
    split_db: f32,
    low_codes: u8,
) -> Vec<f32> {
    let dead_v = floor + dead;
    let split_v = floor + split_db;
    let low = low_codes.max(2) as f32;
    let max = 255.0f32;
    let low_span = (split_v - dead_v).max(0.5);
    let high_span = (hi - split_v).max(0.5);
    q.iter()
        .map(|&c| {
            let c = c as f32;
            if c < 0.5 {
                dead_v
            } else if c <= low {
                dead_v + (c - 1.0) / (low - 1.0).max(1.0) * low_span
            } else {
                split_v + (c - low - 1.0) / (max - low - 1.0).max(1.0) * high_span
            }
        })
        .collect()
}

struct Encoded {
    wire: Vec<u8>,
    levels: u32,
    lo: f32,
    hi: f32,
    packed_len: usize,
    zeros: u64,
    abs_sum: u64,
}

fn encode_frame(
    v: &Variant,
    frame: &[f32],
    stats: &FrameStats,
    prev: Option<&[f32]>,
    range: &mut RangeState,
) -> Result<Encoded> {
    let (lo_i, hi_i) = range.update(stats, v.range);
    let (lo, hi) = (lo_i as f32, hi_i as f32);
    let levels = levels_of(v);
    let pw = match v.pack {
        Pack::Piecewise { dead, split_db, low_codes } => Some((dead, split_db, low_codes)),
        _ => None,
    };
    // Rounded immediately: the decoder only sees the i16 in the header.
    let pw_floor = pw.map(|_| range.blank_floor(stats, 5, 0.0).round());

    let mut work: Vec<f32>;
    let src: &[f32] = if let Some((pct, margin)) = v.blank {
        let floor = range.blank_floor(stats, pct, margin);
        work = frame.to_vec();
        for x in work.iter_mut() {
            if *x < floor {
                *x = floor;
            }
        }
        &work
    } else {
        frame
    };

    let quant = |vals: &[f32]| -> Vec<u8> {
        match (pw, pw_floor) {
            (Some((dead, split_db, low_codes)), Some(floor)) => {
                quantize_piecewise(vals, hi, floor, dead, split_db, low_codes)
            }
            _ => quantize(vals, lo, hi, levels),
        }
    };

    let q = quant(src);
    let qp = prev.map(|p| quant(p));

    let mut d = vec![0u8; q.len()];
    match v.pred {
        Pred::None => d.copy_from_slice(&q),
        Pred::Spatial => {
            d[0] = q[0];
            for i in 1..q.len() {
                d[i] = sub_mod(q[i], q[i - 1], levels);
            }
        }
        Pred::Temporal => match &qp {
            Some(qp) => {
                for i in 0..q.len() {
                    d[i] = sub_mod(q[i], qp[i], levels);
                }
            }
            None => d.copy_from_slice(&q),
        },
        Pred::TemporalSpatial => match &qp {
            Some(qp) => {
                let mut e = vec![0u8; q.len()];
                for i in 0..q.len() {
                    e[i] = sub_mod(q[i], qp[i], levels);
                }
                d[0] = e[0];
                for i in 1..q.len() {
                    d[i] = sub_mod(e[i], e[i - 1], levels);
                }
            }
            None => {
                d[0] = q[0];
                for i in 1..q.len() {
                    d[i] = sub_mod(q[i], q[i - 1], levels);
                }
            }
        },
    }

    let zeros = d.iter().filter(|&&x| x == 0).count() as u64;
    let l = levels as i32;
    let abs_sum: u64 = d
        .iter()
        .map(|&x| {
            let v = x as i32;
            v.min(l - v) as u64
        })
        .sum();

    let packed = match v.pack {
        Pack::Bytes | Pack::Piecewise { .. } => d,
        Pack::Bits(b) => pack_bits(&d, b as usize),
    };
    let packed_len = packed.len();
    let payload = match v.level {
        Some(level) => deflate(&packed, level)?,
        None => packed,
    };

    let header_len = if pw.is_some() { 12 } else { 8 };
    let mut wire = Vec::with_capacity(header_len + payload.len());
    wire.extend_from_slice(&lo_i.to_le_bytes());
    wire.extend_from_slice(&hi_i.to_le_bytes());
    wire.extend_from_slice(&(q.len() as u32).to_le_bytes());
    if let (Some((_, split_db, low_codes)), Some(floor)) = (pw, pw_floor) {
        wire.extend_from_slice(&(floor as i16).to_le_bytes());
        wire.push(split_db.round() as u8);
        wire.push(low_codes);
    }
    wire.extend_from_slice(&payload);
    Ok(Encoded { wire, levels, lo, hi, packed_len, zeros, abs_sum })
}

fn decode_frame(v: &Variant, wire: &[u8], prev: Option<&[f32]>, levels: u32) -> Result<Vec<f32>> {
    let header_len = match v.pack {
        Pack::Piecewise { .. } => 12,
        _ => HEADER_LEN,
    };
    if wire.len() < header_len {
        bail!("short frame");
    }
    let lo = i16::from_le_bytes([wire[0], wire[1]]) as f32;
    let hi = i16::from_le_bytes([wire[2], wire[3]]) as f32;
    let bins = u32::from_le_bytes([wire[4], wire[5], wire[6], wire[7]]) as usize;
    let pw = match v.pack {
        Pack::Piecewise { dead, .. } => {
            let floor = i16::from_le_bytes([wire[8], wire[9]]) as f32;
            Some((dead, wire[10] as f32, wire[11], floor))
        }
        _ => None,
    };
    let payload = &wire[header_len..];

    let raw = match v.level {
        Some(_) => inflate(payload)?,
        None => payload.to_vec(),
    };
    let d = match v.pack {
        Pack::Bytes | Pack::Piecewise { .. } => raw,
        Pack::Bits(b) => unpack_bits(&raw, bins, b as usize)?,
    };
    if d.len() != bins {
        bail!("decoded {} residuals, expected {bins}", d.len());
    }

    let quant = |vals: &[f32]| -> Vec<u8> {
        match pw {
            Some((dead, split_db, low_codes, floor)) => {
                quantize_piecewise(vals, hi, floor, dead, split_db, low_codes)
            }
            None => quantize(vals, lo, hi, levels),
        }
    };
    let qp = prev.map(|p| quant(p));
    let mut q = vec![0u8; bins];
    match v.pred {
        Pred::None => q.copy_from_slice(&d),
        Pred::Spatial => {
            q[0] = d[0];
            for i in 1..bins {
                q[i] = add_mod(q[i - 1], d[i], levels);
            }
        }
        Pred::Temporal => match &qp {
            Some(qp) => {
                for i in 0..bins {
                    q[i] = add_mod(qp[i], d[i], levels);
                }
            }
            None => q.copy_from_slice(&d),
        },
        Pred::TemporalSpatial => match &qp {
            Some(qp) => {
                let mut e = vec![0u8; bins];
                e[0] = d[0];
                for i in 1..bins {
                    e[i] = add_mod(e[i - 1], d[i], levels);
                }
                for i in 0..bins {
                    q[i] = add_mod(qp[i], e[i], levels);
                }
            }
            None => {
                q[0] = d[0];
                for i in 1..bins {
                    q[i] = add_mod(q[i - 1], d[i], levels);
                }
            }
        },
    }
    Ok(match pw {
        Some((dead, split_db, low_codes, floor)) => {
            dequantize_piecewise(&q, hi, floor, dead, split_db, low_codes)
        }
        None => dequantize(&q, lo, hi, levels),
    })
}

#[derive(Default)]
struct PeakBucket {
    sum_err: f64,
    count: u64,
}

struct Metrics {
    frames: u64,
    wire_bytes: u64,
    packed_bytes: u64,
    bins: u64,
    zeros: u64,
    abs_sum: u64,
    enc_us: u64,
    dec_us: u64,
    sum_sq: f64,
    max_err: f32,
    clip_bins: u64,
    err_hist: [u64; 41],
    err_overflow: u64,
    weak: PeakBucket,
    medium: PeakBucket,
    strong: PeakBucket,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            frames: 0,
            wire_bytes: 0,
            packed_bytes: 0,
            bins: 0,
            zeros: 0,
            abs_sum: 0,
            enc_us: 0,
            dec_us: 0,
            sum_sq: 0.0,
            max_err: 0.0,
            clip_bins: 0,
            err_hist: [0u64; 41],
            err_overflow: 0,
            weak: PeakBucket::default(),
            medium: PeakBucket::default(),
            strong: PeakBucket::default(),
        }
    }
}

fn run_variant(v: &Variant, frames: &[Vec<f32>], stats: &[FrameStats]) -> Result<Metrics> {
    let mut m = Metrics::default();
    let mut range = RangeState::new();
    let mut prev: Option<Vec<f32>> = None;

    for (fi, frame) in frames.iter().enumerate() {
        let st = &stats[fi];

        let t = Instant::now();
        let enc = encode_frame(v, frame, st, prev.as_deref(), &mut range)?;
        m.enc_us += t.elapsed().as_micros() as u64;
        m.wire_bytes += enc.wire.len() as u64;
        m.packed_bytes += enc.packed_len as u64;
        m.zeros += enc.zeros;
        m.abs_sum += enc.abs_sum;
        m.bins += frame.len() as u64;

        let t = Instant::now();
        let dec = decode_frame(v, &enc.wire, prev.as_deref(), enc.levels)?;
        m.dec_us += t.elapsed().as_micros() as u64;
        m.frames += 1;

        for (&orig, &got) in frame.iter().zip(dec.iter()) {
            let err = (orig - got).abs();
            m.sum_sq += (err as f64) * (err as f64);
            if err > m.max_err {
                m.max_err = err;
            }
            if err < 10.0 {
                m.err_hist[(err * 4.0) as usize] += 1;
            } else {
                m.err_overflow += 1;
            }
            if orig > enc.hi || orig < enc.lo {
                m.clip_bins += 1;
            }
        }

        // Weak/medium/strong local peaks above the frame median.
        let floor = st.median;
        for i in 1..frame.len() - 1 {
            let val = frame[i];
            if val > frame[i - 1] && val >= frame[i + 1] && val > floor + 3.0 {
                let snr = val - floor;
                let err = (dec[i] - val).abs() as f64;
                let bucket = if snr < 10.0 {
                    &mut m.weak
                } else if snr < 20.0 {
                    &mut m.medium
                } else {
                    &mut m.strong
                };
                bucket.sum_err += err;
                bucket.count += 1;
            }
        }

        prev = Some(dec);
    }
    Ok(m)
}

/// Orthonormal DCT-II matrix (row `k`, column `i`).
fn dct_matrix(n: usize) -> Vec<f32> {
    let mut m = vec![0.0f32; n * n];
    for k in 0..n {
        let s = if k == 0 {
            (1.0 / n as f32).sqrt()
        } else {
            (2.0 / n as f32).sqrt()
        };
        for i in 0..n {
            m[k * n + i] =
                s * (std::f32::consts::PI * (i as f32 + 0.5) * k as f32 / n as f32).cos();
        }
    }
    m
}

/// Orthonormal DST-II matrix (row `k`, column `i`).
fn dst_matrix(n: usize) -> Vec<f32> {
    let mut m = vec![0.0f32; n * n];
    for k in 0..n {
        let s = (2.0 / n as f32).sqrt();
        for i in 0..n {
            m[k * n + i] =
                s * (std::f32::consts::PI * (i as f32 + 0.5) * (k as f32 + 1.0) / n as f32).sin();
        }
    }
    m
}

/// Per-block mean + quantized DCT coefficients (i16 LE).
fn encode_dct(q: &[u8], block: usize, step: f32, mat: &[f32]) -> Vec<u8> {
    let n = block;
    let mut out = Vec::with_capacity(q.len() * 2 + q.len() / n);
    let mut r = vec![0.0f32; n];
    for chunk in q.chunks_exact(n) {
        let base = (chunk.iter().map(|&v| v as f32).sum::<f32>() / n as f32).round();
        for i in 0..n {
            r[i] = chunk[i] as f32 - base;
        }
        out.push(base.clamp(0.0, 255.0) as u8);
        for k in 0..n {
            let mut c = 0.0f32;
            for i in 0..n {
                c += mat[k * n + i] * r[i];
            }
            let qc = (c / step).round().clamp(-32768.0, 32767.0) as i16;
            out.extend_from_slice(&qc.to_le_bytes());
        }
    }
    out
}

fn decode_dct(
    data: &[u8],
    bins: usize,
    block: usize,
    step: f32,
    mat: &[f32],
    lo: f32,
    hi: f32,
) -> Vec<f32> {
    let n = block;
    let mut q = vec![0u8; bins];
    let mut coef = vec![0.0f32; n];
    let mut pos = 0usize;
    for b in 0..(bins / n) {
        let base = data[pos] as f32;
        pos += 1;
        for k in 0..n {
            let c = i16::from_le_bytes([data[pos], data[pos + 1]]) as f32;
            coef[k] = c * step;
            pos += 2;
        }
        for i in 0..n {
            let mut s = 0.0f32;
            for k in 0..n {
                s += mat[k * n + i] * coef[k];
            }
            q[b * n + i] = (base + s).round().clamp(0.0, 255.0) as u8;
        }
    }
    dequantize(&q, lo, hi, 256)
}

#[derive(Clone, Copy)]
enum Basis {
    Dct,
    Dst,
}

fn run_basis(
    frames: &[Vec<f32>],
    stats: &[FrameStats],
    block: usize,
    step: f32,
    blank: Option<(u8, f32)>,
    basis: Basis,
) -> Result<Metrics> {
    let mat = match basis {
        Basis::Dct => dct_matrix(block),
        Basis::Dst => dst_matrix(block),
    };
    let mut m = Metrics::default();

    for (fi, frame) in frames.iter().enumerate() {
        if frame.len() % block != 0 {
            bail!("frame length {} not divisible by block {block}", frame.len());
        }
        let st = &stats[fi];

        let t = Instant::now();
        let mut work: Vec<f32>;
        let src: &[f32] = if let Some((pct, margin)) = blank {
            let base = match pct {
                5 => st.p5,
                10 => st.p10,
                25 => st.p25,
                50 => st.p50,
                75 => st.p75,
                _ => st.p5,
            };
            let floor = base + margin;
            work = frame.clone();
            for v in work.iter_mut() {
                if *v < floor {
                    *v = floor;
                }
            }
            &work
        } else {
            frame
        };
        let q = quantize(src, MIN_DB, MAX_DB, 256);
        let packed = encode_dct(&q, block, step, &mat);
        let payload = deflate(&packed, 2)?;
        let mut wire = Vec::with_capacity(12 + payload.len());
        wire.extend_from_slice(&(MIN_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(MAX_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        wire.extend_from_slice(&(block as u16).to_le_bytes());
        wire.extend_from_slice(&(step as u16).to_le_bytes());
        wire.extend_from_slice(&payload);
        m.enc_us += t.elapsed().as_micros() as u64;
        m.wire_bytes += wire.len() as u64;
        m.packed_bytes += packed.len() as u64;
        m.bins += frame.len() as u64;

        let t = Instant::now();
        let raw = inflate(&payload)?;
        let dec = decode_dct(&raw, frame.len(), block, step, &mat, MIN_DB, MAX_DB);
        m.dec_us += t.elapsed().as_micros() as u64;
        m.frames += 1;

        for (&orig, &got) in frame.iter().zip(dec.iter()) {
            let err = (orig - got).abs();
            m.sum_sq += (err as f64) * (err as f64);
            if err > m.max_err {
                m.max_err = err;
            }
            if err < 10.0 {
                m.err_hist[(err * 4.0) as usize] += 1;
            } else {
                m.err_overflow += 1;
            }
        }

        let floor = st.median;
        for i in 1..frame.len() - 1 {
            let val = frame[i];
            if val > frame[i - 1] && val >= frame[i + 1] && val > floor + 3.0 {
                let snr = val - floor;
                let err = (dec[i] - val).abs() as f64;
                let bucket = if snr < 10.0 {
                    &mut m.weak
                } else if snr < 20.0 {
                    &mut m.medium
                } else {
                    &mut m.strong
                };
                bucket.sum_err += err;
                bucket.count += 1;
            }
        }
    }
    Ok(m)
}

/// In-place orthonormal Haar forward transform, `levels` deep.
fn haar_forward(block: &mut [f32], levels: usize) {
    let n = block.len();
    let inv = std::f32::consts::FRAC_1_SQRT_2;
    let mut tmp = vec![0.0f32; n];
    let mut len = n;
    for _ in 0..levels {
        let half = len / 2;
        if half == 0 {
            break;
        }
        for i in 0..half {
            let x = block[2 * i];
            let y = block[2 * i + 1];
            tmp[i] = (x + y) * inv;
            tmp[half + i] = (x - y) * inv;
        }
        block[..len].copy_from_slice(&tmp[..len]);
        len = half;
    }
}

fn haar_inverse(block: &mut [f32], levels: usize) {
    let n = block.len();
    let inv = std::f32::consts::FRAC_1_SQRT_2;
    let mut tmp = vec![0.0f32; n];
    for level in (0..levels).rev() {
        let len = n >> level;
        let half = len / 2;
        if half == 0 {
            continue;
        }
        for i in 0..half {
            let l = block[i];
            let h = block[half + i];
            tmp[2 * i] = (l + h) * inv;
            tmp[2 * i + 1] = (l - h) * inv;
        }
        block[..len].copy_from_slice(&tmp[..len]);
    }
}

fn encode_haar(q: &[u8], block: usize, levels: usize, step: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(q.len() * 2);
    let mut buf = vec![0.0f32; block];
    for chunk in q.chunks_exact(block) {
        for i in 0..block {
            buf[i] = chunk[i] as f32;
        }
        haar_forward(&mut buf, levels);
        for &c in buf.iter() {
            let qc = (c / step).round().clamp(-32768.0, 32767.0) as i16;
            out.extend_from_slice(&qc.to_le_bytes());
        }
    }
    out
}

fn decode_haar(
    data: &[u8],
    bins: usize,
    block: usize,
    levels: usize,
    step: f32,
    lo: f32,
    hi: f32,
) -> Vec<f32> {
    let mut q = vec![0u8; bins];
    let mut buf = vec![0.0f32; block];
    let mut pos = 0usize;
    for b in 0..(bins / block) {
        for v in buf.iter_mut() {
            *v = i16::from_le_bytes([data[pos], data[pos + 1]]) as f32 * step;
            pos += 2;
        }
        haar_inverse(&mut buf, levels);
        for i in 0..block {
            q[b * block + i] = buf[i].round().clamp(0.0, 255.0) as u8;
        }
    }
    dequantize(&q, lo, hi, 256)
}

fn run_haar(
    frames: &[Vec<f32>],
    stats: &[FrameStats],
    block: usize,
    levels: usize,
    step: f32,
    blank: Option<(u8, f32)>,
) -> Result<Metrics> {
    let mut m = Metrics::default();
    for (fi, frame) in frames.iter().enumerate() {
        if frame.len() % block != 0 {
            bail!("frame length {} not divisible by block {block}", frame.len());
        }
        let st = &stats[fi];

        let t = Instant::now();
        let mut work: Vec<f32>;
        let src: &[f32] = if let Some((pct, margin)) = blank {
            let base = match pct {
                5 => st.p5,
                10 => st.p10,
                25 => st.p25,
                50 => st.p50,
                75 => st.p75,
                _ => st.p5,
            };
            let floor = base + margin;
            work = frame.clone();
            for v in work.iter_mut() {
                if *v < floor {
                    *v = floor;
                }
            }
            &work
        } else {
            frame
        };
        let q = quantize(src, MIN_DB, MAX_DB, 256);
        let packed = encode_haar(&q, block, levels, step);
        let payload = deflate(&packed, 2)?;
        let mut wire = Vec::with_capacity(12 + payload.len());
        wire.extend_from_slice(&(MIN_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(MAX_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        wire.extend_from_slice(&(block as u16).to_le_bytes());
        wire.extend_from_slice(&(levels as u8).to_le_bytes());
        wire.push(0);
        wire.extend_from_slice(&payload);
        m.enc_us += t.elapsed().as_micros() as u64;
        m.wire_bytes += wire.len() as u64;
        m.packed_bytes += packed.len() as u64;
        m.bins += frame.len() as u64;

        let t = Instant::now();
        let raw = inflate(&payload)?;
        let dec = decode_haar(&raw, frame.len(), block, levels, step, MIN_DB, MAX_DB);
        m.dec_us += t.elapsed().as_micros() as u64;
        m.frames += 1;

        for (&orig, &got) in frame.iter().zip(dec.iter()) {
            let err = (orig - got).abs();
            m.sum_sq += (err as f64) * (err as f64);
            if err > m.max_err {
                m.max_err = err;
            }
            if err < 10.0 {
                m.err_hist[(err * 4.0) as usize] += 1;
            } else {
                m.err_overflow += 1;
            }
        }
        let floor = st.median;
        for i in 1..frame.len() - 1 {
            let val = frame[i];
            if val > frame[i - 1] && val >= frame[i + 1] && val > floor + 3.0 {
                let snr = val - floor;
                let err = (dec[i] - val).abs() as f64;
                let bucket = if snr < 10.0 {
                    &mut m.weak
                } else if snr < 20.0 {
                    &mut m.medium
                } else {
                    &mut m.strong
                };
                bucket.sum_err += err;
                bucket.count += 1;
            }
        }
    }
    Ok(m)
}

// ---------------------------------------------------------------------------
// Adaptive range coder (LZMA-style) for residual bytes.
// ---------------------------------------------------------------------------

const RC_PROB_BITS: u32 = 11;
const RC_PROB_INIT: u16 = 1 << (RC_PROB_BITS - 1);
const RC_MOVE_BITS: u32 = 5;
const RC_TREE_SIZE: usize = 0x300;

struct RangeEncoder {
    low: u64,
    range: u32,
    cache: u8,
    cache_size: u64,
    out: Vec<u8>,
}

impl RangeEncoder {
    fn new(capacity: usize) -> Self {
        Self { low: 0, range: 0xFFFF_FFFF, cache: 0, cache_size: 1, out: Vec::with_capacity(capacity) }
    }

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

    fn bit(&mut self, prob: &mut u16, bit: u32) {
        let p = *prob as u32;
        let bound = (self.range >> RC_PROB_BITS) * p;
        if bit == 0 {
            self.range = bound;
            *prob += ((1 << RC_PROB_BITS) - p) as u16 >> RC_MOVE_BITS;
        } else {
            self.low += bound as u64;
            self.range -= bound;
            *prob -= *prob >> RC_MOVE_BITS;
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

    fn symbol(&mut self, cum: u32, freq: u32, total: u32) {
        let r = self.range / total;
        self.low += (cum as u64) * (r as u64);
        self.range = r * freq;
        while self.range < (1 << 24) {
            self.range <<= 8;
            self.shift_low();
        }
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

    fn byte(&mut self) -> u8 {
        let b = if self.pos < self.data.len() { self.data[self.pos] } else { 0 };
        self.pos += 1;
        b
    }

    fn bit(&mut self, prob: &mut u16) -> u32 {
        let p = *prob as u32;
        let bound = (self.range >> RC_PROB_BITS) * p;
        let bit = if self.code < bound {
            self.range = bound;
            *prob += ((1 << RC_PROB_BITS) - p) as u16 >> RC_MOVE_BITS;
            0
        } else {
            self.code -= bound;
            self.range -= bound;
            *prob -= *prob >> RC_MOVE_BITS;
            1
        };
        while self.range < (1 << 24) {
            self.range <<= 8;
            self.code = (self.code << 8) | self.byte() as u32;
        }
        bit
    }

    fn symbol_value(&self, total: u32) -> u32 {
        let r = self.range / total;
        (self.code / r).min(total - 1)
    }

    fn symbol(&mut self, cum: u32, freq: u32, total: u32) {
        let r = self.range / total;
        self.code -= cum * r;
        self.range = r * freq;
        while self.range < (1 << 24) {
            self.range <<= 8;
            self.code = (self.code << 8) | self.byte() as u32;
        }
    }
}

#[inline]
fn rc_context(prev: u8, ctx_bits: u32) -> usize {
    if ctx_bits == 0 {
        0
    } else {
        (prev >> (8 - ctx_bits)) as usize
    }
}

fn rc_encode_byte(enc: &mut RangeEncoder, probs: &mut [u16], ctx: usize, byte: u8) {
    let base = ctx * RC_TREE_SIZE;
    let mut state = 1usize;
    for i in (0..8).rev() {
        let bit = ((byte >> i) & 1) as u32;
        enc.bit(&mut probs[base + state], bit);
        state = (state << 1) | bit as usize;
    }
}

fn rc_decode_byte(dec: &mut RangeDecoder, probs: &mut [u16], ctx: usize) -> u8 {
    let base = ctx * RC_TREE_SIZE;
    let mut state = 1usize;
    for _ in 0..8 {
        let bit = dec.bit(&mut probs[base + state]);
        state = (state << 1) | bit as usize;
    }
    (state - 0x100) as u8
}

fn run_rc(
    frames: &[Vec<f32>],
    stats: &[FrameStats],
    blank: Option<(u8, f32)>,
    ctx_bits: u32,
    persistent: bool,
) -> Result<Metrics> {
    let contexts = 1usize << ctx_bits;
    let mut enc_probs = vec![RC_PROB_INIT; contexts * RC_TREE_SIZE];
    let mut dec_probs = vec![RC_PROB_INIT; contexts * RC_TREE_SIZE];
    let mut prev_enc = 0u8;
    let mut prev_dec = 0u8;
    let mut m = Metrics::default();

    for (fi, frame) in frames.iter().enumerate() {
        if !persistent {
            enc_probs.fill(RC_PROB_INIT);
            dec_probs.fill(RC_PROB_INIT);
            prev_enc = 0;
            prev_dec = 0;
        }
        let st = &stats[fi];

        let t = Instant::now();
        let mut clamped: Vec<f32>;
        let src: &[f32] = if let Some((pct, margin)) = blank {
            let base = match pct {
                5 => st.p5,
                10 => st.p10,
                25 => st.p25,
                50 => st.p50,
                75 => st.p75,
                _ => st.p5,
            };
            let floor = base + margin;
            clamped = frame.clone();
            for v in clamped.iter_mut() {
                if *v < floor {
                    *v = floor;
                }
            }
            &clamped
        } else {
            frame
        };
        let q = quantize(src, MIN_DB, MAX_DB, 256);
        let mut d = vec![0u8; q.len()];
        d[0] = q[0];
        for i in 1..q.len() {
            d[i] = q[i].wrapping_sub(q[i - 1]);
        }
        let mut enc = RangeEncoder::new(q.len());
        for &b in d.iter() {
            let ctx = rc_context(prev_enc, ctx_bits);
            rc_encode_byte(&mut enc, &mut enc_probs, ctx, b);
            prev_enc = b;
        }
        let payload = enc.finish();
        let mut wire = Vec::with_capacity(8 + payload.len());
        wire.extend_from_slice(&(MIN_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(MAX_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(q.len() as u32).to_le_bytes());
        wire.extend_from_slice(&payload);
        m.enc_us += t.elapsed().as_micros() as u64;
        m.wire_bytes += wire.len() as u64;
        m.bins += q.len() as u64;
        m.frames += 1;

        let t = Instant::now();
        let mut dec = RangeDecoder::new(&payload);
        let mut d2 = vec![0u8; q.len()];
        for i in 0..q.len() {
            let ctx = rc_context(prev_dec, ctx_bits);
            d2[i] = rc_decode_byte(&mut dec, &mut dec_probs, ctx);
            prev_dec = d2[i];
        }
        if d2 != d {
            bail!("range coder round-trip mismatch");
        }
        let mut q2 = vec![0u8; q.len()];
        q2[0] = d2[0];
        for i in 1..q2.len() {
            q2[i] = q2[i - 1].wrapping_add(d2[i]);
        }
        let dec_frame = dequantize(&q2, MIN_DB, MAX_DB, 256);
        m.dec_us += t.elapsed().as_micros() as u64;

        for (&orig, &got) in frame.iter().zip(dec_frame.iter()) {
            let err = (orig - got).abs();
            m.sum_sq += (err as f64) * (err as f64);
            if err > m.max_err {
                m.max_err = err;
            }
            if err < 10.0 {
                m.err_hist[(err * 4.0) as usize] += 1;
            } else {
                m.err_overflow += 1;
            }
        }
        let floor = st.median;
        for i in 1..frame.len() - 1 {
            let val = frame[i];
            if val > frame[i - 1] && val >= frame[i + 1] && val > floor + 3.0 {
                let snr = val - floor;
                let err = (dec_frame[i] - val).abs() as f64;
                let bucket = if snr < 10.0 {
                    &mut m.weak
                } else if snr < 20.0 {
                    &mut m.medium
                } else {
                    &mut m.strong
                };
                bucket.sum_err += err;
                bucket.count += 1;
            }
        }
    }
    Ok(m)
}

fn mag_class_of(b: u8, classes: usize) -> usize {
    let circ = (b as i16 - 256).unsigned_abs().min(b as u16) as usize;
    match classes {
        2 => usize::from(circ >= 4),
        4 => match circ {
            0..=1 => 0,
            2..=3 => 1,
            4..=15 => 2,
            _ => 3,
        },
        8 => match circ {
            0 => 0,
            1 => 1,
            2 => 2,
            3..=4 => 3,
            5..=8 => 4,
            9..=16 => 5,
            17..=32 => 6,
            _ => 7,
        },
        _ => 0,
    }
}

#[derive(Clone, Copy)]
enum MarginMode {
    Fixed(f32),
    Auto,
}

fn auto_margin(st: &FrameStats) -> f32 {
    // Quiet frames (low occupancy) clamp harder; busy frames keep detail.
    let t = ((st.occ6 - 0.14) / (0.23 - 0.14)).clamp(0.0, 1.0);
    6.0 - 4.0 * t
}

fn run_rc_run(
    frames: &[Vec<f32>],
    stats: &[FrameStats],
    blank: Option<(u8, f32)>,
    byte_ctx_bits: u32,
    mag_classes: usize,
    regions: usize,
    margin_mode: MarginMode,
) -> Result<Metrics> {
    let byte_contexts = 1usize << byte_ctx_bits;
    let bins = frames.first().map(|f| f.len()).unwrap_or(0);
    let region_map: Vec<usize> = (0..bins).map(|i| i * regions / bins.max(1)).collect();
    let mut zero_probs = vec![RC_PROB_INIT; 16 * mag_classes * regions];
    let mut byte_probs = vec![RC_PROB_INIT; byte_contexts * RC_TREE_SIZE];
    let mut m = Metrics::default();

    for (fi, frame) in frames.iter().enumerate() {
        zero_probs.fill(RC_PROB_INIT);
        byte_probs.fill(RC_PROB_INIT);
        let st = &stats[fi];

        let t = Instant::now();
        let mut clamped: Vec<f32>;
        let src: &[f32] = if let Some((pct, _)) = blank {
            let base = match pct {
                5 => st.p5,
                10 => st.p10,
                25 => st.p25,
                50 => st.p50,
                75 => st.p75,
                _ => st.p5,
            };
            let margin_db = match margin_mode {
                MarginMode::Fixed(v) => v,
                MarginMode::Auto => auto_margin(st),
            };
            let floor = base + margin_db;
            clamped = frame.clone();
            for v in clamped.iter_mut() {
                if *v < floor {
                    *v = floor;
                }
            }
            &clamped
        } else {
            frame
        };
        let q = quantize(src, MIN_DB, MAX_DB, 256);
        let mut d = vec![0u8; q.len()];
        d[0] = q[0];
        for i in 1..q.len() {
            d[i] = q[i].wrapping_sub(q[i - 1]);
        }

        let mut enc = RangeEncoder::new(q.len());
        let mut run = 0usize;
        let mut prev = 0u8;
        let mut mag_class = 0usize;
        for (i, &b) in d.iter().enumerate() {
            let zctx = (region_map[i] * mag_classes + mag_class) * 16 + run.min(15);
            enc.bit(&mut zero_probs[zctx], (b == 0) as u32);
            if b != 0 {
                let ctx = rc_context(prev, byte_ctx_bits);
                rc_encode_byte(&mut enc, &mut byte_probs, ctx, b);
                mag_class = mag_class_of(b, mag_classes);
                prev = b;
                run = 0;
            } else {
                run += 1;
            }
        }
        let payload = enc.finish();
        let mut wire = Vec::with_capacity(8 + payload.len());
        wire.extend_from_slice(&(MIN_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(MAX_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(q.len() as u32).to_le_bytes());
        wire.extend_from_slice(&payload);
        m.enc_us += t.elapsed().as_micros() as u64;
        m.wire_bytes += wire.len() as u64;
        m.bins += q.len() as u64;
        m.frames += 1;

        let t = Instant::now();
        zero_probs.fill(RC_PROB_INIT);
        byte_probs.fill(RC_PROB_INIT);
        let mut dec = RangeDecoder::new(&payload);
        let mut d2 = vec![0u8; q.len()];
        let mut run = 0usize;
        let mut prev = 0u8;
        let mut mag_class = 0usize;
        for (i, out) in d2.iter_mut().enumerate() {
            let zctx = (region_map[i] * mag_classes + mag_class) * 16 + run.min(15);
            let is_zero = dec.bit(&mut zero_probs[zctx]) == 1;
            if is_zero {
                *out = 0;
                run += 1;
            } else {
                let ctx = rc_context(prev, byte_ctx_bits);
                let b = rc_decode_byte(&mut dec, &mut byte_probs, ctx);
                *out = b;
                mag_class = mag_class_of(b, mag_classes);
                prev = b;
                run = 0;
            }
        }
        if d2 != d {
            let pos = d.iter().zip(d2.iter()).position(|(a, b)| a != b).unwrap_or(0);
            bail!(
                "run-coder round-trip mismatch at {pos}: enc {} dec {}",
                d[pos],
                d2[pos]
            );
        }
        let mut q2 = vec![0u8; q.len()];
        q2[0] = d2[0];
        for i in 1..q2.len() {
            q2[i] = q2[i - 1].wrapping_add(d2[i]);
        }
        let dec_frame = dequantize(&q2, MIN_DB, MAX_DB, 256);
        m.dec_us += t.elapsed().as_micros() as u64;

        for (&orig, &got) in frame.iter().zip(dec_frame.iter()) {
            let err = (orig - got).abs();
            m.sum_sq += (err as f64) * (err as f64);
            if err > m.max_err {
                m.max_err = err;
            }
            if err < 10.0 {
                m.err_hist[(err * 4.0) as usize] += 1;
            } else {
                m.err_overflow += 1;
            }
        }
        let floor = st.median;
        for i in 1..frame.len() - 1 {
            let val = frame[i];
            if val > frame[i - 1] && val >= frame[i + 1] && val > floor + 3.0 {
                let snr = val - floor;
                let err = (dec_frame[i] - val).abs() as f64;
                let bucket = if snr < 10.0 {
                    &mut m.weak
                } else if snr < 20.0 {
                    &mut m.medium
                } else {
                    &mut m.strong
                };
                bucket.sum_err += err;
                bucket.count += 1;
            }
        }
    }
    Ok(m)
}

struct ByteModel {
    counts: [u16; 256],
    fen: [u32; 257],
    total: u32,
}

impl ByteModel {
    fn new() -> Self {
        let mut m = Self { counts: [0u16; 256], fen: [0u32; 257], total: 0 };
        for s in 1..256 {
            m.counts[s] = 1;
            m.total += 1;
            let mut j = s + 1;
            while j < 257 {
                m.fen[j] += 1;
                j += j & j.wrapping_neg();
            }
        }
        m
    }

    fn prefix(&self, mut i: usize) -> u32 {
        let mut s = 0u32;
        while i > 0 {
            s += self.fen[i];
            i -= i & i.wrapping_neg();
        }
        s
    }

    fn find(&self, mut value: u32) -> usize {
        let mut pos = 0usize;
        let mut bit = 256usize;
        while bit > 0 {
            let next = pos + bit;
            if next <= 256 && self.fen[next] <= value {
                pos = next;
                value -= self.fen[next];
            }
            bit >>= 1;
        }
        pos.min(255)
    }

    fn add(&mut self, s: usize, delta: u32) {
        self.counts[s] += delta as u16;
        self.total += delta;
        let mut j = s + 1;
        while j < 257 {
            self.fen[j] += delta;
            j += j & j.wrapping_neg();
        }
        if self.total > (1 << 15) {
            self.rescale();
        }
    }

    fn rescale(&mut self) {
        self.fen = [0u32; 257];
        self.total = 0;
        for s in 0..256 {
            if self.counts[s] > 0 {
                self.counts[s] = (self.counts[s] / 2).max(1);
                let c = self.counts[s] as u32;
                self.total += c;
                let mut j = s + 1;
                while j < 257 {
                    self.fen[j] += c;
                    j += j & j.wrapping_neg();
                }
            }
        }
    }
}

fn run_rc_byte(
    frames: &[Vec<f32>],
    stats: &[FrameStats],
    blank: Option<(u8, f32)>,
    byte_ctx_bits: u32,
) -> Result<Metrics> {
    let contexts = 1usize << byte_ctx_bits;
    let mut zero_probs = [RC_PROB_INIT; 32];
    let mut models: Vec<ByteModel> = (0..contexts).map(|_| ByteModel::new()).collect();
    let mut m = Metrics::default();

    for (fi, frame) in frames.iter().enumerate() {
        zero_probs.fill(RC_PROB_INIT);
        for model in models.iter_mut() {
            *model = ByteModel::new();
        }
        let st = &stats[fi];

        let t = Instant::now();
        let mut clamped: Vec<f32>;
        let src: &[f32] = if let Some((pct, margin)) = blank {
            let base = match pct {
                5 => st.p5,
                10 => st.p10,
                25 => st.p25,
                50 => st.p50,
                75 => st.p75,
                _ => st.p5,
            };
            let floor = base + margin;
            clamped = frame.clone();
            for v in clamped.iter_mut() {
                if *v < floor {
                    *v = floor;
                }
            }
            &clamped
        } else {
            frame
        };
        let q = quantize(src, MIN_DB, MAX_DB, 256);
        let mut d = vec![0u8; q.len()];
        d[0] = q[0];
        for i in 1..q.len() {
            d[i] = q[i].wrapping_sub(q[i - 1]);
        }

        let mut enc = RangeEncoder::new(q.len());
        let mut run = 0usize;
        let mut prev = 0u8;
        let mut mag_class = 0usize;
        for &b in d.iter() {
            let zctx = run.min(15) | (mag_class << 4);
            enc.bit(&mut zero_probs[zctx], (b == 0) as u32);
            if b != 0 {
                let ctx = rc_context(prev, byte_ctx_bits);
                let model = &mut models[ctx];
                let sym = b as usize;
                let cum = model.prefix(sym);
                let freq = model.counts[sym] as u32;
                enc.symbol(cum, freq, model.total);
                model.add(sym, 1);
                mag_class = mag_class_of(b, 2);
                prev = b;
                run = 0;
            } else {
                run += 1;
            }
        }
        let payload = enc.finish();
        let mut wire = Vec::with_capacity(8 + payload.len());
        wire.extend_from_slice(&(MIN_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(MAX_DB as i16).to_le_bytes());
        wire.extend_from_slice(&(q.len() as u32).to_le_bytes());
        wire.extend_from_slice(&payload);
        m.enc_us += t.elapsed().as_micros() as u64;
        m.wire_bytes += wire.len() as u64;
        m.bins += q.len() as u64;
        m.frames += 1;

        let t = Instant::now();
        zero_probs.fill(RC_PROB_INIT);
        for model in models.iter_mut() {
            *model = ByteModel::new();
        }
        let mut dec = RangeDecoder::new(&payload);
        let mut d2 = vec![0u8; q.len()];
        let mut run = 0usize;
        let mut prev = 0u8;
        let mut mag_class = 0usize;
        for out in d2.iter_mut() {
            let zctx = run.min(15) | (mag_class << 4);
            let is_zero = dec.bit(&mut zero_probs[zctx]) == 1;
            if is_zero {
                *out = 0;
                run += 1;
            } else {
                let ctx = rc_context(prev, byte_ctx_bits);
                let model = &mut models[ctx];
                let value = dec.symbol_value(model.total);
                let sym = model.find(value);
                let cum = model.prefix(sym);
                let freq = model.counts[sym] as u32;
                dec.symbol(cum, freq, model.total);
                model.add(sym, 1);
                *out = sym as u8;
                mag_class = mag_class_of(sym as u8, 2);
                prev = sym as u8;
                run = 0;
            }
        }
        if d2 != d {
            bail!("byte-model round-trip mismatch");
        }
        let mut q2 = vec![0u8; q.len()];
        q2[0] = d2[0];
        for i in 1..q2.len() {
            q2[i] = q2[i - 1].wrapping_add(d2[i]);
        }
        let dec_frame = dequantize(&q2, MIN_DB, MAX_DB, 256);
        m.dec_us += t.elapsed().as_micros() as u64;

        for (&orig, &got) in frame.iter().zip(dec_frame.iter()) {
            let err = (orig - got).abs();
            m.sum_sq += (err as f64) * (err as f64);
            if err > m.max_err {
                m.max_err = err;
            }
            if err < 10.0 {
                m.err_hist[(err * 4.0) as usize] += 1;
            } else {
                m.err_overflow += 1;
            }
        }
        let floor = st.median;
        for i in 1..frame.len() - 1 {
            let val = frame[i];
            if val > frame[i - 1] && val >= frame[i + 1] && val > floor + 3.0 {
                let snr = val - floor;
                let err = (dec_frame[i] - val).abs() as f64;
                let bucket = if snr < 10.0 {
                    &mut m.weak
                } else if snr < 20.0 {
                    &mut m.medium
                } else {
                    &mut m.strong
                };
                bucket.sum_err += err;
                bucket.count += 1;
            }
        }
    }
    Ok(m)
}

fn frame_mode(frame: &[u8]) -> u8 {
    let mut hist = [0usize; 256];
    for &b in frame {
        hist[b as usize] += 1;
    }
    let mut best = 0usize;
    let mut best_count = 0usize;
    for (b, &c) in hist.iter().enumerate() {
        if c > best_count {
            best_count = c;
            best = b;
        }
    }
    best as u8
}

fn decimate_history_frames(frames: &[Vec<f32>], history_bins: usize, margin_db: f32) -> Vec<Vec<u8>> {
    let ratio = frames[0].len() / history_bins;
    let margin_codes = ((margin_db / (MAX_DB - MIN_DB)) * 255.0).round().max(0.0) as usize;
    let mut out = Vec::with_capacity(frames.len());
    for frame in frames {
        let mut codes = Vec::with_capacity(history_bins);
        for j in 0..history_bins {
            let start = j * ratio;
            let end = ((j + 1) * ratio).min(frame.len());
            let mut max = f32::NEG_INFINITY;
            for &v in &frame[start..end] {
                if v > max {
                    max = v;
                }
            }
            let norm = ((max - MIN_DB) / (MAX_DB - MIN_DB)).clamp(0.0, 1.0);
            codes.push((norm * 255.0) as u8);
        }
        // Clamp at median + margin, matching the server's history path.
        let mut hist = [0usize; 256];
        for &c in &codes {
            hist[c as usize] += 1;
        }
        let target = (codes.len() * 50).div_ceil(100);
        let mut cum = 0usize;
        let mut median = 0u8;
        for (b, &c) in hist.iter().enumerate() {
            cum += c;
            if cum >= target {
                median = b as u8;
                break;
            }
        }
        let floor = (median as usize + margin_codes).min(255) as u8;
        for c in codes.iter_mut() {
            if *c < floor {
                *c = floor;
            }
        }
        out.push(codes);
    }
    out
}

/// Encodes a history burst. `temporal`: 0 = baseline, 1 = temporal zero
/// context, 2 = temporal zero + byte-tree context.
fn encode_history_stream(frames: &[Vec<u8>], temporal: u8) -> usize {
    let bins = frames[0].len();
    let zero_contexts = match temporal {
        0 => 32,
        1 | 2 => 96,
        3 => 16 * 2 * 8,
        _ => 32,
    };
    let byte_contexts = if temporal == 2 { 3 } else { 2 };
    let mut zero_probs = vec![RC_PROB_INIT; zero_contexts];
    let mut byte_probs = vec![RC_PROB_INIT; byte_contexts * RC_TREE_SIZE];
    let mut enc = RangeEncoder::new(frames.len() * bins);

    let mut prev_frame: Vec<u8> = vec![0u8; bins];
    let mut prev_mode = 0u8;
    let mut has_prev = false;
    let mut prev_res = 0u8;
    let mut run = 0usize;
    let mut mag_class = 0usize;

    for frame in frames {
        let mut prev_code = 0u8;
        for (i, &code) in frame.iter().enumerate() {
            let b = code.wrapping_sub(prev_code);
            prev_code = code;
            let pclass = if has_prev {
                if temporal == 3 {
                    (prev_frame[i].saturating_sub(prev_mode) / 8).min(7) as usize
                } else if prev_frame[i] <= prev_mode {
                    0
                } else if prev_frame[i] <= prev_mode.saturating_add(8) {
                    1
                } else {
                    2
                }
            } else {
                0
            };
            let zctx = if temporal == 0 {
                run.min(15) | (mag_class << 4)
            } else {
                (pclass * 2 + mag_class) * 16 + run.min(15)
            };
            enc.bit(&mut zero_probs[zctx], (b == 0) as u32);
            if b != 0 {
                let ctx = if temporal == 2 {
                    pclass
                } else {
                    (prev_res >> 7) as usize
                };
                rc_encode_byte(&mut enc, &mut byte_probs, ctx, b);
                mag_class = mag_class_of(b, 2);
                prev_res = b;
                run = 0;
            } else {
                run += 1;
            }
        }
        prev_frame.copy_from_slice(frame);
        prev_mode = frame_mode(frame);
        has_prev = true;
    }
    enc.finish().len()
}

fn percentile_err(hist: &[u64; 41], overflow: u64, total: u64, p: f64) -> f32 {
    let target = (total as f64 * p) as u64;
    let mut cum = 0u64;
    for (i, &c) in hist.iter().enumerate() {
        cum += c;
        if cum >= target {
            return (i as f32 + 1.0) * 0.25;
        }
    }
    if overflow > 0 { 10.0 } else { 0.0 }
}

fn group_average(frames: &[Vec<f32>], group: usize, bins: usize) -> Vec<Vec<f32>> {
    let mut out = Vec::new();
    for chunk in frames.chunks(group) {
        let mut acc = vec![0.0f32; bins];
        for f in chunk {
            for (a, v) in acc.iter_mut().zip(f.iter()) {
                *a += *v;
            }
        }
        let inv = 1.0 / chunk.len() as f32;
        for a in acc.iter_mut() {
            *a *= inv;
        }
        out.push(acc);
    }
    out
}

fn print_transform_row(block: usize, levels: usize, step: f32, m: &Metrics) {
    let nf = m.frames as f64;
    let bpf = m.wire_bytes as f64 / nf;
    let pack_bpf = m.packed_bytes as f64 / nf;
    let ratio = m.bins as f64 / m.wire_bytes as f64;
    let enc_us = m.enc_us as f64 / nf;
    let dec_us = m.dec_us as f64 / nf;
    let rmse = (m.sum_sq / m.bins as f64).sqrt();
    let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
    let bucket = |b: &PeakBucket| {
        if b.count == 0 {
            "-".to_string()
        } else {
            format!("{:.2}", b.sum_err / b.count as f64)
        }
    };
    println!(
        "| {block} | {levels} | {step:.0} | {:.0} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.3} | {:.2} | {:.2} | {} | {} | {} |",
        bpf, pack_bpf, ratio, enc_us, dec_us, rmse, p99, m.max_err,
        bucket(&m.weak), bucket(&m.medium), bucket(&m.strong)
    );
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn main() -> Result<()> {
    let path = std::env::args().nth(1).context("usage: fft_codec_bench <capture.sigmf-data>")?;
    let fft_size = env_usize("BENCH_FFT", 32768);
    let fps = env_usize("BENCH_FPS", 12).max(1);
    let seconds = env_usize("BENCH_SECONDS", 0);

    let mut iq = fs::read(&path).with_context(|| format!("read {path}"))?;
    if seconds > 0 {
        let want = (SAMPLE_RATE as usize * seconds * 2).min(iq.len());
        iq.truncate(want);
    }
    let capture_secs = iq.len() as f64 / (SAMPLE_RATE as f64 * 2.0);

    println!("# FFT encoder benchmark");
    println!();
    println!("- capture: `{}`", path);
    println!("- IQ: {:.1} MB, {:.2} s @ {} MSPS", iq.len() as f64 / 1e6, capture_secs, SAMPLE_RATE as f64 / 1e6);
    println!("- FFT: {fft_size} bins, profile {fps} fps, natural {:.2} fps", SAMPLE_RATE as f64 / fft_size as f64);

    let cfg = FftProcessorConfig {
        fft_size,
        sample_rate: SAMPLE_RATE,
        window: "blackman-harris".to_string(),
        averaging: 0.5,
        averaging_taps: 0,
        target_fps: 0,
    };
    let mut proc = FftProcessor::new(cfg)?;
    let t0 = Instant::now();
    let mut raw_frames: Vec<Vec<f32>> = Vec::new();
    for chunk in iq.chunks(16 * 1024) {
        raw_frames.extend(proc.process_iq_data(chunk));
    }
    let fft_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let natural = SAMPLE_RATE as f64 / fft_size as f64;
    let group = ((natural / fps as f64).round() as usize).max(1);
    let frames = group_average(&raw_frames, group, fft_size);
    let stats: Vec<FrameStats> = frames.iter().map(|f| FrameStats::from_frame(f)).collect();
    println!(
        "- frames: {} raw windows, grouped x{} -> {} benchmark frames; FFT replay {:.0} ms",
        raw_frames.len(), group, frames.len(), fft_ms
    );
    println!();

    if std::env::var("BENCH_LEVEL_SWEEP").is_ok() {
        let f = &frames[0];
        let q = quantize(f, MIN_DB, MAX_DB, 256);
        let mut d = vec![0u8; q.len()];
        d[0] = q[0];
        for i in 1..q.len() {
            d[i] = q[i].wrapping_sub(q[i - 1]);
        }
        print!("- level sweep (frame 0, {} B input):", d.len());
        for level in 1..=9u32 {
            let out = deflate(&d, level)?;
            print!(" L{}={} B", level, out.len());
        }
        println!();
        println!();
    }

    if std::env::var("BENCH_SWEEP_LEVELS").is_ok() {
        println!("- full-frame level sweep (fixed ladder, blank p5 +3 dB, spatial delta):");
        println!();
        println!("| level | B/f | ratio | enc us/f | srv CPU% @{fps} | zero% |");
        println!("|---|---:|---:|---:|---:|---:|");
        for level in 1..=9u32 {
            let v = Variant {
                name: "sweep",
                range: RangePolicy::Fixed(MIN_DB, MAX_DB),
                pred: Pred::Spatial,
                pack: Pack::Bytes,
                level: Some(level),
                blank: Some((5, 3.0)),
            };
            let m = run_variant(&v, &frames, &stats)?;
            let nf = m.frames as f64;
            let bpf = m.wire_bytes as f64 / nf;
            let ratio = m.bins as f64 / m.wire_bytes as f64;
            let enc_us = m.enc_us as f64 / nf;
            let cpu = enc_us * fps as f64 / 1e6 * 100.0;
            let zero = m.zeros as f64 / m.bins as f64 * 100.0;
            println!("| {level} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.0} |", bpf, ratio, enc_us, cpu, zero);
        }
        println!();
    }

    println!("| variant | B/f | pack B/f | ratio | KB/s @{fps} | zero% | |d| | enc us/f | dec us/f | CPU% | RMSE | p99 | max | clip | weak d | med d | strong d |");
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");

    for v in Variant::ALL {
        let m = run_variant(v, &frames, &stats)?;
        if m.frames == 0 {
            continue;
        }
        let nf = m.frames as f64;
        let bpf = m.wire_bytes as f64 / nf;
        let pack_bpf = m.packed_bytes as f64 / nf;
        let ratio = m.bins as f64 / m.wire_bytes as f64;
        let kbps = bpf * fps as f64 / 1024.0;
        let zero_pct = m.zeros as f64 / m.bins as f64 * 100.0;
        let mean_d = m.abs_sum as f64 / m.bins as f64;
        let enc_us = m.enc_us as f64 / nf;
        let dec_us = m.dec_us as f64 / nf;
        let cpu = enc_us * fps as f64 / 1e6 * 100.0;
        let rmse = (m.sum_sq / m.bins as f64).sqrt();
        let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
        let bucket = |b: &PeakBucket| {
            if b.count == 0 { "-".to_string() } else { format!("{:.2}", b.sum_err / b.count as f64) }
        };
        println!(
            "| {} | {:.0} | {:.0} | {:.2}:1 | {:.0} | {:.0} | {:.2} | {:.1} | {:.1} | {:.1} | {:.3} | {:.2} | {:.2} | {} | {} | {} | {} |",
            v.name, bpf, pack_bpf, ratio, kbps, zero_pct, mean_d, enc_us, dec_us, cpu, rmse, p99, m.max_err,
            m.clip_bins, bucket(&m.weak), bucket(&m.medium), bucket(&m.strong)
        );
    }

    if std::env::var("BENCH_DCT").is_ok() {
        println!();
        println!("### Block DCT (u8 codes, orthonormal DCT-II, i16 coefficients, deflate level 2)");
        println!();
        println!("| block | step | B/f | pack B/f | ratio | enc us/f | dec us/f | RMSE | p99 | max | weak | med | strong |");
        println!("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for block in [32usize, 64, 128, 256] {
            for step in [1.0f32, 2.0, 4.0, 8.0] {
                let m = run_basis(&frames, &stats, block, step, None, Basis::Dct)?;
                let nf = m.frames as f64;
                let bpf = m.wire_bytes as f64 / nf;
                let pack_bpf = m.packed_bytes as f64 / nf;
                let ratio = m.bins as f64 / m.wire_bytes as f64;
                let enc_us = m.enc_us as f64 / nf;
                let dec_us = m.dec_us as f64 / nf;
                let rmse = (m.sum_sq / m.bins as f64).sqrt();
                let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
                let bucket = |b: &PeakBucket| {
                    if b.count == 0 { "-".to_string() } else { format!("{:.2}", b.sum_err / b.count as f64) }
                };
                println!(
                    "| {block} | {step:.0} | {:.0} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.3} | {:.2} | {:.2} | {} | {} | {} |",
                    bpf, pack_bpf, ratio, enc_us, dec_us, rmse, p99, m.max_err,
                    bucket(&m.weak), bucket(&m.medium), bucket(&m.strong)
                );
            }
        }
        println!();
        println!("DCT coefficients are quantized by `step` in u8-code units (1 code = 0.51 dB).");
        println!("`pack B/f` is the pre-deflate coefficient stream (i16 per coefficient).");
    }

    if std::env::var("BENCH_DCT_BLANK").is_ok() {
        println!();
        println!("### Block DCT after median blanking (clamp p50 + 2 dB, then DCT)");
        println!();
        println!("| block | step | B/f | pack B/f | ratio | enc us/f | dec us/f | RMSE | p99 | max | weak | med | strong |");
        println!("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for block in [32usize, 64, 128] {
            for step in [1.0f32, 2.0, 4.0] {
                let m = run_basis(&frames, &stats, block, step, Some((50, 2.0)), Basis::Dct)?;
                let nf = m.frames as f64;
                let bpf = m.wire_bytes as f64 / nf;
                let pack_bpf = m.packed_bytes as f64 / nf;
                let ratio = m.bins as f64 / m.wire_bytes as f64;
                let enc_us = m.enc_us as f64 / nf;
                let dec_us = m.dec_us as f64 / nf;
                let rmse = (m.sum_sq / m.bins as f64).sqrt();
                let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
                let bucket = |b: &PeakBucket| {
                    if b.count == 0 { "-".to_string() } else { format!("{:.2}", b.sum_err / b.count as f64) }
                };
                println!(
                    "| {block} | {step:.0} | {:.0} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.3} | {:.2} | {:.2} | {} | {} | {} |",
                    bpf, pack_bpf, ratio, enc_us, dec_us, rmse, p99, m.max_err,
                    bucket(&m.weak), bucket(&m.medium), bucket(&m.strong)
                );
            }
        }
        println!();
        println!("Reference: delta + p50+2 dB clamp (no DCT) is 7589 B/f, 4.32:1, weak 0.13.");
    }

    if std::env::var("BENCH_DST").is_ok() {
        println!();
        println!("### Block DST-II (u8 codes, orthonormal, i16 coefficients, deflate level 2)");
        println!();
        println!("| block | step | B/f | pack B/f | ratio | enc us/f | dec us/f | RMSE | p99 | max | weak | med | strong |");
        println!("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for block in [32usize, 64, 128] {
            for step in [2.0f32, 4.0] {
                let m = run_basis(&frames, &stats, block, step, None, Basis::Dst)?;
                let nf = m.frames as f64;
                let bpf = m.wire_bytes as f64 / nf;
                let pack_bpf = m.packed_bytes as f64 / nf;
                let ratio = m.bins as f64 / m.wire_bytes as f64;
                let enc_us = m.enc_us as f64 / nf;
                let dec_us = m.dec_us as f64 / nf;
                let rmse = (m.sum_sq / m.bins as f64).sqrt();
                let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
                let bucket = |b: &PeakBucket| {
                    if b.count == 0 { "-".to_string() } else { format!("{:.2}", b.sum_err / b.count as f64) }
                };
                println!(
                    "| {block} | {step:.0} | {:.0} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.3} | {:.2} | {:.2} | {} | {} | {} |",
                    bpf, pack_bpf, ratio, enc_us, dec_us, rmse, p99, m.max_err,
                    bucket(&m.weak), bucket(&m.medium), bucket(&m.strong)
                );
            }
        }
    }

    if std::env::var("BENCH_HAAR").is_ok() {
        println!();
        println!("### Multilevel block Haar (u8 codes, orthonormal, i16 coefficients, deflate level 2)");
        println!();
        println!("| block | levels | step | B/f | pack B/f | ratio | enc us/f | dec us/f | RMSE | p99 | max | weak | med | strong |");
        println!("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for block in [64usize, 128, 256] {
            for levels in [3usize, 5] {
                for step in [2.0f32, 4.0] {
                    let m = run_haar(&frames, &stats, block, levels, step, None)?;
                    print_transform_row(block, levels, step, &m);
                }
            }
        }
    }

    if std::env::var("BENCH_HAAR_BLANK").is_ok() {
        println!();
        println!("### Multilevel Haar after median blanking (p50 + 2 dB)");
        println!();
        println!("| block | levels | step | B/f | pack B/f | ratio | enc us/f | dec us/f | RMSE | p99 | max | weak | med | strong |");
        println!("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for block in [64usize, 128, 256] {
            for levels in [3usize, 5] {
                for step in [2.0f32, 4.0] {
                    let m = run_haar(&frames, &stats, block, levels, step, Some((50, 2.0)))?;
                    print_transform_row(block, levels, step, &m);
                }
            }
        }
        println!();
        println!("Reference: delta + p50+2 dB clamp (no transform) is 7589 B/f, 4.32:1, weak 0.13.");
    }

    if std::env::var("BENCH_RC").is_ok() {
        println!();
        println!("### Adaptive range coder (spatial delta residual, p50+2 dB clamp, order-N byte contexts)");
        println!();
        println!("| ctx bits | contexts | persist | B/f | ratio | enc us/f | dec us/f | RMSE | p99 | weak | med | strong |");
        println!("|---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for ctx_bits in [0u32, 4, 8] {
            for persistent in [false, true] {
                let m = run_rc(&frames, &stats, Some((50, 2.0)), ctx_bits, persistent)?;
                let nf = m.frames as f64;
                let bpf = m.wire_bytes as f64 / nf;
                let ratio = m.bins as f64 / m.wire_bytes as f64;
                let enc_us = m.enc_us as f64 / nf;
                let dec_us = m.dec_us as f64 / nf;
                let rmse = (m.sum_sq / m.bins as f64).sqrt();
                let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
                let bucket = |b: &PeakBucket| {
                    if b.count == 0 { "-".to_string() } else { format!("{:.2}", b.sum_err / b.count as f64) }
                };
                println!(
                    "| {} | {} | {} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.3} | {:.2} | {} | {} | {} |",
                    ctx_bits,
                    1usize << ctx_bits,
                    if persistent { "yes" } else { "no" },
                    bpf, ratio, enc_us, dec_us, rmse, p99,
                    bucket(&m.weak), bucket(&m.medium), bucket(&m.strong)
                );
            }
        }
        println!();
        println!("Reference: deflate delta + p50+2 dB clamp is 7589 B/f, 4.32:1, 568 us/f enc, weak 0.13.");
        println!();
        println!("### Zero-run range coder (run-length zero model + byte tree)");
        println!();
        println!("| margin | byte ctx bits | mag classes | regions | B/f | ratio | enc us/f | dec us/f | RMSE | p99 | weak | med | strong |");
        println!("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for (margin, ctx_bits, mag_classes, regions) in [
            (2.0f32, 0u32, 2usize, 1usize),
            (2.0, 0, 4, 1),
            (2.0, 0, 8, 1),
            (2.0, 0, 2, 4),
            (2.0, 0, 4, 4),
            (2.0, 0, 2, 8),
            (4.0, 0, 2, 1),
            (6.0, 0, 2, 1),
            (-1.0, 0, 2, 1),
        ] {
            let mode = if margin < 0.0 {
                MarginMode::Auto
            } else {
                MarginMode::Fixed(margin)
            };
            let m = run_rc_run(&frames, &stats, Some((50, 0.0)), ctx_bits, mag_classes, regions, mode)?;
            let nf = m.frames as f64;
            let bpf = m.wire_bytes as f64 / nf;
            let ratio = m.bins as f64 / m.wire_bytes as f64;
            let enc_us = m.enc_us as f64 / nf;
            let dec_us = m.dec_us as f64 / nf;
            let rmse = (m.sum_sq / m.bins as f64).sqrt();
            let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
            let bucket = |b: &PeakBucket| {
                if b.count == 0 { "-".to_string() } else { format!("{:.2}", b.sum_err / b.count as f64) }
            };
            let label = if margin < 0.0 {
                "auto".to_string()
            } else {
                format!("{margin:.1}")
            };
            println!(
                "| {label} | {} | {} | {} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.3} | {:.2} | {} | {} | {} |",
                ctx_bits, mag_classes, regions, bpf, ratio, enc_us, dec_us, rmse, p99,
                bucket(&m.weak), bucket(&m.medium), bucket(&m.strong)
            );
        }

        println!();
        println!("### Direct 256-symbol zero-run model (Fenwick byte model, margin 2 dB)");
        println!();
        println!("| byte ctx bits | B/f | ratio | enc us/f | dec us/f | RMSE | p99 | weak |");
        println!("|---:|---:|---:|---:|---:|---:|---:|---:|");
        for ctx_bits in [0u32, 1, 8] {
            let m = run_rc_byte(&frames, &stats, Some((50, 2.0)), ctx_bits)?;
            let nf = m.frames as f64;
            let bpf = m.wire_bytes as f64 / nf;
            let ratio = m.bins as f64 / m.wire_bytes as f64;
            let enc_us = m.enc_us as f64 / nf;
            let dec_us = m.dec_us as f64 / nf;
            let rmse = (m.sum_sq / m.bins as f64).sqrt();
            let p99 = percentile_err(&m.err_hist, m.err_overflow, m.bins, 0.99);
            let weak = if m.weak.count == 0 {
                "-".to_string()
            } else {
                format!("{:.2}", m.weak.sum_err / m.weak.count as f64)
            };
            println!(
                "| {} | {:.0} | {:.2}:1 | {:.1} | {:.1} | {:.3} | {:.2} | {} |",
                ctx_bits, bpf, ratio, enc_us, dec_us, rmse, p99, weak
            );
        }
    }

    if std::env::var("BENCH_HIST_RC").is_ok() {
        let hbins = env_usize("BENCH_HIST_BINS", 4096);
        let hist = decimate_history_frames(&frames, hbins, 5.0);
        let raw = hbins * hist.len();
        println!();
        println!("### History range coder: temporal context (margin 5 dB, {hbins} bins x {} frames)", hist.len());
        println!();
        println!("| model | bytes | B/frame | ratio | enc ms |");
        println!("|---|---:|---:|---:|---:|");
        for (name, temporal) in [
            ("baseline", 0u8),
            ("temporal zero", 1),
            ("temporal zero+byte", 2),
            ("temporal 8-class", 3),
        ] {
            let t = Instant::now();
            let bytes = encode_history_stream(&hist, temporal);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            println!(
                "| {name} | {bytes} | {:.0} | {:.2}:1 | {:.1} |",
                bytes as f64 / hist.len() as f64,
                raw as f64 / bytes as f64,
                ms
            );
        }
    }

    if std::env::var("BENCH_OCC").is_ok() {
        let mut occs = Vec::new();
        let mut weaks = Vec::new();
        let mut spreads = Vec::new();
        for (frame, st) in frames.iter().zip(stats.iter()) {
            let med = st.median;
            let occ = frame.iter().filter(|&&v| v > med + 6.0).count() as f64 / frame.len() as f64;
            let weak = frame
                .iter()
                .filter(|&&v| v > med + 3.0 && v <= med + 9.0)
                .count() as f64
                / frame.len() as f64;
            occs.push(occ);
            weaks.push(weak);
            spreads.push((st.max - med) as f64);
        }
        let summarize = |name: &str, v: &mut Vec<f64>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
            println!(
                "- {name}: min {:.4} p25 {:.4} p50 {:.4} p75 {:.4} max {:.4}",
                v[0],
                p(0.25),
                p(0.5),
                p(0.75),
                v[v.len() - 1]
            );
        };
        println!();
        println!("### Frame occupancy distribution");
        summarize("occupied (> median+6 dB)", &mut occs);
        summarize("weak band (median+3..+9 dB)", &mut weaks);
        summarize("peak-to-median (dB)", &mut spreads);
    }

    println!();
    println!("Notes: ratio is against the u8 bin stream (1 byte/bin). pack B/f is the pre-deflate");
    println!("payload size. zero% / |d| describe the residual stream. clip counts bins above the");
    println!("ladder hi (hard clipping). weak/med/strong are mean abs dB error at local peaks");
    println!("3+ dB above the frame median, bucketed by peak SNR (<10, 10-20, >=20 dB).");

    if std::env::var("BENCH_TONE_TEST").is_ok() {
        println!();
        println!("### Weak-tone survival");
        println!();
        println!("Single-bin tone injected at frame median + SNR (dB) after the encoder has");
        println!("settled on the preceding frames. Value is the recovered error (dB); positive");
        println!("means the dead zone lifted the tone, negative means it was attenuated.");
        println!();
        let snrs = [3.0f32, 6.0, 9.0, 12.0, 15.0, 20.0];
        print!("| variant |");
        for s in snrs {
            print!(" +{s:.0} dB |");
        }
        println!();
        print!("|---|");
        for _ in snrs {
            print!("---:|");
        }
        println!();

        for v in Variant::ALL {
            let mut range = RangeState::new();
            let mut prev: Option<Vec<f32>> = None;
            let settle = 20.min(frames.len());
            for i in 0..settle {
                let enc = encode_frame(v, &frames[i], &stats[i], prev.as_deref(), &mut range)?;
                let dec = decode_frame(v, &enc.wire, prev.as_deref(), enc.levels)?;
                prev = Some(dec);
            }
            let idx = 20.min(frames.len() - 1);
            let med = stats[idx].median;
            let mut f = frames[idx].clone();
            let mut bins = Vec::new();
            for (k, s) in snrs.iter().enumerate() {
                let bin = 2000 + k * 4000;
                f[bin] = med + *s;
                bins.push(bin);
            }
            let enc = encode_frame(v, &f, &stats[idx], prev.as_deref(), &mut range)?;
            let dec = decode_frame(v, &enc.wire, prev.as_deref(), enc.levels)?;
            print!("| {} |", v.name);
            for (k, s) in snrs.iter().enumerate() {
                let err = dec[bins[k]] - (med + *s);
                print!(" {:+.2} |", err);
            }
            println!();
        }
    }
    Ok(())
}
