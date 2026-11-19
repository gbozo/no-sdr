//! FFT processor: windowing, FFT, magnitude dB, averaging, rate capping.
//!
//! Ported from the original Go backend.

use std::time::Duration;

use anyhow::{bail, Result};
use num_complex::Complex32;

use super::fft::Fft;
use super::window::new_window;

/// uint8 IQ -> float32 in [-1, +1]: `(sample - 127.5) / 127.5`.
pub const INV_U8_SCALE: f32 = 1.0 / 127.5;

/// Approximate `10*log10(x)` via IEEE-754 exponent + mantissa polynomial.
pub fn fast_log10_power(x: f32) -> f32 {
    let bits = x.to_bits();
    let exp = ((bits >> 23) as i32) - 127;
    let mantissa_bits = (bits & 0x7F_FFFF) | 0x3F80_0000;
    let m = f32::from_bits(mantissa_bits);
    let log2m = -1.0 + 2.0 * m - 0.5 * m * m;
    const TEN_LOG10_OF_2: f32 = 3.010_299_9;
    (exp as f32 + log2m) * TEN_LOG10_OF_2
}

#[derive(Debug, Clone)]
pub struct FftProcessorConfig {
    pub fft_size: usize,
    pub sample_rate: i32,
    pub window: String,
    /// 0 = no averaging, 0.9 = heavy smoothing (when taps <= 1).
    pub averaging: f32,
    /// 0 or 1 = exponential averaging, 2+ = N-tap weighted moving average.
    pub averaging_taps: usize,
    /// Output frame rate cap (0 = unlimited).
    pub target_fps: i32,
}

impl Default for FftProcessorConfig {
    fn default() -> Self {
        Self {
            fft_size: 4096,
            sample_rate: 2_400_000,
            window: "blackman-harris".to_string(),
            averaging: 0.5,
            averaging_taps: 0,
            target_fps: 30,
        }
    }
}

pub struct FftProcessor {
    fft_size: usize,
    sample_rate: i32,
    averaging: f32,
    window_name: String,

    fft: Fft,
    window: Vec<f32>,
    window_sum: f32,
    norm_db: f32,

    complex_buf: Vec<Complex32>,
    mag_buf: Vec<f32>,
    avg_buf: Vec<f32>,
    avg_init: bool,

    tap_count: usize,
    tap_weights: Vec<f32>,
    tap_history: Vec<Vec<f32>>,
    tap_next: usize,
    tap_filled: bool,

    ring: Vec<u8>,
    ring_fill: usize,
    samples_need: usize,
    /// Requested output rate (0 = unlimited); kept so `resize` can recompute
    /// the window hop.
    target_fps: i32,
    /// Samples advanced between successive windows. Equal to `samples_need`
    /// for non-overlapping windows; smaller when the requested rate is higher
    /// than `sample_rate / fft_size`.
    hop_bytes: usize,
    /// True when frames are emitted on the sample clock (one per window or
    /// hop) instead of through the wall-clock rate gate. Set whenever the
    /// requested rate is at or above `sample_rate / fft_size`.
    data_driven: bool,

    min_interval: Duration,
    /// Input bytes between emitted frames (0 = no rate cap).
    emit_bytes: usize,
    /// Input bytes consumed since the last emit.
    since_emit: usize,
    pending_buf: Vec<f32>,
    pending_n: u32,
    /// Blocks skipped between FFTs once the output rate is capped. A waterfall
    /// at 8–30 fps does not need a transform for every 8192-sample block the
    /// dongle delivers; without this the processor spends a full FFT ~293
    /// times a second to throw most of the results away.
    blocks_per_fft: f64,
    block_accum: f64,
}

/// How many transforms to average into one emitted frame when rate-capped.
///
/// The previous code averaged *every* block between two emit deadlines (often
/// 30+ frames), which looked smooth but spent a full FFT on all of them. At
/// 16 frames the waterfall keeps ~12 dB of noise reduction while the FFT rate
/// drops by roughly an order of magnitude.
const FFT_BURST_FRAMES: f64 = 16.0;

/// Maximum window overlap factor when a profile requests more frames per
/// second than `sample_rate / fft_size`. The hop is clamped to at least
/// `fft_size / MAX_OVERLAP`, so a misconfigured rate cannot spend unbounded
/// CPU on redundant transforms.
const MAX_OVERLAP: usize = 16;

impl FftProcessor {
    pub fn new(cfg: FftProcessorConfig) -> Result<Self> {
        if cfg.fft_size < 4 || !cfg.fft_size.is_power_of_two() {
            bail!("fft_processor: fftSize must be a power of 2 and >= 4");
        }
        let window_name = if cfg.window.is_empty() {
            "blackman-harris".to_string()
        } else {
            cfg.window
        };
        let averaging = cfg.averaging.clamp(0.0, 1.0);
        let fft = Fft::new(cfg.fft_size)?;
        let window = new_window(&window_name, cfg.fft_size)?;
        let window_sum: f32 = window.iter().sum();

        let mut p = Self {
            fft_size: cfg.fft_size,
            sample_rate: cfg.sample_rate,
            averaging,
            window_name,
            fft,
            window,
            window_sum,
            norm_db: 0.0,
            complex_buf: vec![Complex32::default(); cfg.fft_size],
            mag_buf: vec![0.0; cfg.fft_size],
            avg_buf: Vec::new(),
            avg_init: false,
            tap_count: 0,
            tap_weights: Vec::new(),
            tap_history: Vec::new(),
            tap_next: 0,
            tap_filled: false,
            ring: Vec::with_capacity(cfg.fft_size * 2 * 4),
            ring_fill: 0,
            samples_need: cfg.fft_size * 2,
            target_fps: cfg.target_fps,
            hop_bytes: cfg.fft_size * 2,
            data_driven: false,
            min_interval: Duration::ZERO,
            emit_bytes: 0,
            since_emit: 0,
            pending_buf: vec![0.0; cfg.fft_size],
            pending_n: 0,
            blocks_per_fft: 1.0,
            block_accum: 0.0,
        };
        p.norm_db = p.compute_normalization();

        if cfg.averaging_taps > 1 {
            p.tap_count = cfg.averaging_taps;
            p.tap_weights = compute_triangular_weights(cfg.averaging_taps);
            p.tap_history = vec![vec![0.0; cfg.fft_size]; cfg.averaging_taps];
            p.tap_next = 0;
            p.tap_filled = false;
        } else if cfg.averaging > 0.0 {
            p.avg_buf = vec![0.0; cfg.fft_size];
            p.avg_init = false;
        }

        if cfg.target_fps > 0 {
            p.min_interval = Duration::from_secs_f64(1.0 / cfg.target_fps as f64);
            // Blocks delivered per emit interval, divided by the number of
            // transforms we are willing to average. At least one block is
            // transformed per call even for very small FFTs.
            if cfg.sample_rate > 0 {
                let per_emit = cfg.sample_rate as f64 / cfg.target_fps as f64 / cfg.fft_size as f64;
                p.blocks_per_fft = (per_emit / FFT_BURST_FRAMES).max(1.0);
            }
        }
        p.block_accum = p.blocks_per_fft;
        p.recompute_hop();
        Ok(p)
    }

    /// Natural maximum frame rate: one non-overlapping window per `fft_size`
    /// input samples.
    fn natural_max_fps(&self) -> f64 {
        if self.sample_rate > 0 {
            self.sample_rate as f64 / self.fft_size as f64
        } else {
            f64::INFINITY
        }
    }

    /// Recompute the emission clock for the current target rate.
    ///
    /// `emit_bytes` is the input distance between emitted frames, so the rate
    /// is sample-clocked and exact at any target (a wall-clock gate quantized
    /// 12 fps down to 10.5 because the interval was compared against 73 fps
    /// window arrivals). At or above `sample_rate / fft_size` the window hop
    /// also shrinks so windows overlap; below it, windows are processed at the
    /// normal stride and several are averaged into each emitted frame.
    fn recompute_hop(&mut self) {
        self.data_driven = false;
        self.hop_bytes = self.samples_need;
        self.emit_bytes = 0;
        self.since_emit = 0;
        if self.target_fps <= 0 || self.sample_rate <= 0 {
            return;
        }
        let requested = self.target_fps as f64;
        let emit_samples = (self.sample_rate as f64 / requested).round().max(1.0) as usize;
        self.emit_bytes = emit_samples * 2;
        // Emit the first available window immediately, then on the sample clock.
        self.since_emit = self.emit_bytes;

        if requested + 1.0 < self.natural_max_fps() {
            return;
        }
        let min_hop = (self.fft_size / MAX_OVERLAP).max(1);
        let hop = emit_samples.clamp(min_hop, self.fft_size);
        self.data_driven = true;
        self.hop_bytes = hop * 2;
    }

    /// Feeds raw uint8 IQ (interleaved I,Q) and returns emitted dB frames.
    pub fn process_iq_data(&mut self, data: &[u8]) -> Vec<Vec<f32>> {
        self.ring.extend_from_slice(data);
        self.ring_fill += data.len();

        let mut emitted = Vec::new();
        let mut consumed = 0usize;

        while self.ring_fill - consumed >= self.samples_need {
            // Sample-clocked emission: the hop defines the rate, so every
            // window is emitted and no wall-clock gate is involved.
            if self.data_driven {
                self.process_one_frame(consumed);
                consumed += self.hop_bytes;
                emitted.push(self.mag_buf.clone());
                continue;
            }

            // Rate cap: most blocks exist only to keep the ring fed. Spend a
            // transform on one in every `blocks_per_fft` and let the pending
            // average smooth the emitted frame. Skipped blocks still advance
            // the emission clock so the output rate stays exact.
            let mut transformed = true;
            if self.blocks_per_fft > 1.0 {
                self.block_accum += 1.0;
                if self.block_accum < self.blocks_per_fft {
                    transformed = false;
                } else {
                    self.block_accum -= self.blocks_per_fft;
                }
            }

            if transformed {
                self.process_one_frame(consumed);
                if self.emit_bytes == 0 {
                    emitted.push(self.mag_buf.clone());
                    consumed += self.samples_need;
                    continue;
                }
                if self.pending_n == 0 {
                    self.pending_buf.copy_from_slice(&self.mag_buf);
                    self.pending_n = 1;
                } else {
                    self.pending_n += 1;
                    let inv_n = 1.0 / self.pending_n as f32;
                    let pending = &mut self.pending_buf;
                    let mag = &self.mag_buf;
                    for i in 0..self.fft_size {
                        pending[i] += (mag[i] - pending[i]) * inv_n;
                    }
                }
            }

            consumed += self.samples_need;
            self.since_emit += self.samples_need;
            if self.emit_bytes > 0 && self.since_emit >= self.emit_bytes {
                if self.pending_n > 0 {
                    emitted.push(self.pending_buf.clone());
                    self.pending_n = 0;
                    // Keep the remainder so fractional windows per emit do not
                    // drift the average rate.
                    self.since_emit -= self.emit_bytes;
                } else if self.since_emit >= self.emit_bytes * 2 {
                    // No transform landed in this interval; keep one interval
                    // of credit instead of accumulating a burst.
                    self.since_emit = self.emit_bytes;
                }
            }
        }

        if consumed > 0 {
            self.ring.drain(..consumed);
            self.ring_fill -= consumed;
        }
        emitted
    }

    fn process_one_frame(&mut self, offset: usize) {
        let fft_size = self.fft_size;

        // Remove the tuner's zero-IF DC/LO spike before windowing. A plain
        // sample mean is not enough: after applying the window a constant
        // offset still leaves `sum(x*w) - mean*sum(w)`, which is exactly the
        // broad centre spike users see. Use the window-weighted mean so the
        // transformed DC component is zero.
        let mut weighted_re = 0.0f64;
        let mut weighted_im = 0.0f64;
        for i in 0..fft_size {
            let w = self.window[i] as f64;
            weighted_re += (self.ring[offset + i * 2] as f64 - 127.5) * (INV_U8_SCALE as f64) * w;
            weighted_im +=
                (self.ring[offset + i * 2 + 1] as f64 - 127.5) * (INV_U8_SCALE as f64) * w;
        }
        let inv_window_sum = 1.0 / self.window_sum as f64;
        let dc_re = (weighted_re * inv_window_sum) as f32;
        let dc_im = (weighted_im * inv_window_sum) as f32;

        for i in 0..fft_size {
            let w = self.window[i];
            let re = ((self.ring[offset + i * 2] as f32 - 127.5) * INV_U8_SCALE - dc_re) * w;
            let im = ((self.ring[offset + i * 2 + 1] as f32 - 127.5) * INV_U8_SCALE - dc_im) * w;
            self.complex_buf[i] = Complex32::new(re, im);
        }

        self.fft.transform(&mut self.complex_buf);

        let half = fft_size >> 1;
        // DC-centred output: bins [half..N) come first, then [0..half).
        // Two contiguous loops let the compiler vectorise this without the
        // per-bin modulo/mask that the original wraparound loop required.
        {
            let (first, second) = self.mag_buf.split_at_mut(half);
            for i in 0..half {
                let c = self.complex_buf[half + i];
                let power = (c.re * c.re + c.im * c.im).max(1e-20);
                first[i] = fast_log10_power(power) - self.norm_db;
            }
            for i in 0..half {
                let c = self.complex_buf[i];
                let power = (c.re * c.re + c.im * c.im).max(1e-20);
                second[i] = fast_log10_power(power) - self.norm_db;
            }
        }

        if self.tap_count > 1 {
            self.apply_multi_tap_average();
        } else if self.averaging > 0.0 {
            if !self.avg_init {
                self.avg_buf.copy_from_slice(&self.mag_buf);
                self.avg_init = true;
            } else {
                let a = self.averaging;
                let b = 1.0 - a;
                for i in 0..fft_size {
                    let v = a * self.avg_buf[i] + b * self.mag_buf[i];
                    self.avg_buf[i] = v;
                    self.mag_buf[i] = v;
                }
            }
        }
    }

    fn apply_multi_tap_average(&mut self) {
        let fft_size = self.fft_size;
        if !self.tap_filled {
            for j in 0..self.tap_count {
                self.tap_history[j].copy_from_slice(&self.mag_buf);
            }
            self.tap_filled = true;
            self.tap_next = 0;
        }
        self.tap_history[self.tap_next].copy_from_slice(&self.mag_buf);

        for i in 0..fft_size {
            let mut sum = 0.0f32;
            for j in 0..self.tap_count {
                let idx = (self.tap_next + self.tap_count - j) % self.tap_count;
                sum += self.tap_weights[j] * self.tap_history[idx][i];
            }
            self.mag_buf[i] = sum;
        }
        self.tap_next = (self.tap_next + 1) % self.tap_count;
    }

    /// Changes FFT size at runtime (profile switch).
    pub fn resize(&mut self, new_size: usize) -> Result<()> {
        if new_size < 4 || !new_size.is_power_of_two() {
            bail!("fft_processor: newSize must be a power of 2 and >= 4");
        }
        let fft = Fft::new(new_size)?;
        let window = new_window(&self.window_name, new_size)?;
        let window_sum: f32 = window.iter().sum();

        self.fft_size = new_size;
        self.fft = fft;
        self.window = window;
        self.window_sum = window_sum;
        self.samples_need = new_size * 2;
        self.recompute_hop();
        self.norm_db = self.compute_normalization();
        self.blocks_per_fft = if self.min_interval.is_zero() {
            1.0
        } else {
            (self.sample_rate as f64 * self.min_interval.as_secs_f64()
                / new_size as f64
                / FFT_BURST_FRAMES)
                .max(1.0)
        };
        self.block_accum = 0.0;

        self.complex_buf = vec![Complex32::default(); new_size];
        self.mag_buf = vec![0.0; new_size];
        self.pending_buf = vec![0.0; new_size];
        self.pending_n = 0;
        self.ring = Vec::with_capacity(new_size * 2 * 4);
        self.ring_fill = 0;

        if self.tap_count > 1 {
            self.tap_history = vec![vec![0.0; new_size]; self.tap_count];
            self.tap_next = 0;
            self.tap_filled = false;
            self.avg_buf.clear();
            self.avg_init = false;
        } else if self.averaging > 0.0 {
            self.avg_buf = vec![0.0; new_size];
            self.avg_init = false;
        } else {
            self.avg_buf.clear();
            self.avg_init = false;
        }
        Ok(())
    }

    pub fn reset(&mut self) {
        self.ring_fill = 0;
        self.ring.clear();
        self.pending_n = 0;
        self.since_emit = self.emit_bytes;
        self.block_accum = self.blocks_per_fft;
        self.avg_init = false;
        self.avg_buf.fill(0.0);
        if self.tap_count > 1 {
            self.tap_next = 0;
            self.tap_filled = false;
            for h in &mut self.tap_history {
                h.fill(0.0);
            }
        }
    }

    pub fn fft_size(&self) -> usize {
        self.fft_size
    }

    fn compute_normalization(&self) -> f32 {
        let fft_norm = 20.0 * (self.fft_size as f64).log10();
        let window_sum: f64 = self.window.iter().map(|&v| v as f64).sum();
        let coherent_gain = window_sum / self.fft_size as f64;
        let window_correction_db = 20.0 * coherent_gain.log10();
        (fft_norm + window_correction_db) as f32
    }
}

/// Triangular weights summing to 1 (newest frame first).
pub fn compute_triangular_weights(n: usize) -> Vec<f32> {
    let sum = (n * (n + 1) / 2) as f32;
    (0..n).map(|i| (n - i) as f32 / sum).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approximate_log_is_monotonic() {
        // Matches Go's fastLog10Power approximation (bit-exact formula).
        let mut prev = f32::NEG_INFINITY;
        let mut x = 1e-12f32;
        while x < 1e12 {
            let got = fast_log10_power(x);
            assert!(got >= prev - 1e-4, "{x}: {got} < {prev}");
            assert!((got - 10.0 * x.log10()).abs() < 2.0, "{x}: {got}");
            prev = got;
            x *= 10.0;
        }
    }

    #[test]
    fn emits_at_target_fps() {
        let cfg = FftProcessorConfig {
            fft_size: 256,
            sample_rate: 2_400_000,
            target_fps: 10,
            averaging: 0.0,
            ..Default::default()
        };
        let mut p = FftProcessor::new(cfg).unwrap();
        // One second of IQ at 256-sample frames = ~9375 frames, capped to ~10.
        let chunk = vec![128u8; 512 * 200];
        let frames = p.process_iq_data(&chunk);
        assert!(!frames.is_empty());
        assert!(frames.len() <= 20, "got {}", frames.len());
        assert_eq!(frames[0].len(), 256);
    }

    #[test]
    fn no_rate_cap_emits_every_frame() {
        let cfg = FftProcessorConfig {
            fft_size: 64,
            sample_rate: 2_400_000,
            target_fps: 0,
            averaging: 0.0,
            ..Default::default()
        };
        let mut p = FftProcessor::new(cfg).unwrap();
        let frames = p.process_iq_data(&vec![128u8; 64 * 2 * 5]);
        assert_eq!(frames.len(), 5);
    }

    /// A constant DC offset creates a broad spike at the centre of the
    /// waterfall (the window's main lobe). It must be removed without
    /// notching a real tone elsewhere in the passband.
    #[test]
    fn dc_spike_is_removed_without_notching_a_tone() {
        let cfg = FftProcessorConfig {
            fft_size: 256,
            sample_rate: 2_400_000,
            target_fps: 0,
            averaging: 0.0,
            ..Default::default()
        };
        let mut p = FftProcessor::new(cfg).unwrap();
        let mut data = Vec::with_capacity(256 * 2);
        for i in 0..256 {
            let phase = std::f64::consts::TAU * 32.0 * i as f64 / 256.0;
            let re = 127.5 + 60.0 + 50.0 * phase.cos();
            let im = 127.5 + 60.0 + 50.0 * phase.sin();
            data.push(re.clamp(0.0, 255.0).round() as u8);
            data.push(im.clamp(0.0, 255.0).round() as u8);
        }
        let frames = p.process_iq_data(&data);
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        let centre = frame[128];
        let tone = frame[128 + 32];
        assert!(
            tone > centre + 20.0,
            "tone {tone:.1} dB, centre {centre:.1} dB"
        );
    }

    #[test]
    fn rate_cap_reduces_transforms_per_emitted_frame() {
        let cfg = FftProcessorConfig {
            fft_size: 8192,
            sample_rate: 2_400_000,
            target_fps: 8,
            averaging: 0.0,
            ..Default::default()
        };
        let p = FftProcessor::new(cfg.clone()).unwrap();
        // 2.4 MSPS / 8 fps / 8192 bins = 36.6 blocks per emitted frame. With
        // a 16-frame average that is one transform every ~2.3 blocks, not one
        // transform per block (293/s) for an 8 fps output.
        assert!(
            p.blocks_per_fft > 2.0 && p.blocks_per_fft < 3.0,
            "blocks_per_fft = {}",
            p.blocks_per_fft
        );

        let uncapped = FftProcessor::new(FftProcessorConfig {
            target_fps: 0,
            ..cfg
        })
        .unwrap();
        assert_eq!(uncapped.blocks_per_fft, 1.0);
    }

    #[test]
    fn overlapping_windows_exceed_natural_rate() {
        let cfg = FftProcessorConfig {
            fft_size: 1024,
            sample_rate: 48_000,
            target_fps: 200, // natural max = 46.9 fps
            averaging: 0.0,
            ..Default::default()
        };
        let mut p = FftProcessor::new(cfg).unwrap();
        assert!(p.data_driven, "expected sample-clock emission");
        assert_eq!(p.hop_bytes, ((48_000f64 / 200f64).round() as usize) * 2);

        // One second of IQ should yield ~200 windows, not ~47.
        let frames = p.process_iq_data(&vec![128u8; 48_000 * 2]);
        assert!(
            (190..=200).contains(&frames.len()),
            "got {} frames",
            frames.len()
        );
        assert_eq!(frames[0].len(), 1024);
    }

    #[test]
    fn sample_clocked_rate_is_exact() {
        // 48 kHz, 1024 bins, 12 fps: windows arrive at 46.875/s.
        let cfg = FftProcessorConfig {
            fft_size: 1024,
            sample_rate: 48_000,
            target_fps: 12,
            averaging: 0.0,
            ..Default::default()
        };
        let mut p = FftProcessor::new(cfg).unwrap();
        let frames = p.process_iq_data(&vec![128u8; 48_000 * 2]); // 1 s
        assert!((11..=13).contains(&frames.len()), "got {}", frames.len());
    }

    #[test]
    fn natural_rate_emits_every_window() {
        let cfg = FftProcessorConfig {
            fft_size: 1024,
            sample_rate: 48_000, // natural = 46.875 fps
            target_fps: 46,      // integer floor of the natural rate
            averaging: 0.0,
            ..Default::default()
        };
        let mut p = FftProcessor::new(cfg).unwrap();
        assert!(p.data_driven);
        assert_eq!(p.hop_bytes, p.samples_need);

        let frames = p.process_iq_data(&vec![128u8; 48_000 * 2]);
        // One frame per window; the old wall-clock gate produced ~23 here.
        assert_eq!(frames.len(), 46);
    }

    #[test]
    fn no_overlap_below_natural_rate() {
        let cfg = FftProcessorConfig {
            fft_size: 1024,
            sample_rate: 48_000,
            target_fps: 20,
            averaging: 0.0,
            ..Default::default()
        };
        let p = FftProcessor::new(cfg).unwrap();
        assert!(!p.data_driven);
        assert_eq!(p.hop_bytes, p.samples_need);
    }

    #[test]
    fn triangular_weights_sum_to_one() {
        let w = compute_triangular_weights(5);
        let sum: f32 = w.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6);
        assert!(w[0] > w[4]);
    }
}
