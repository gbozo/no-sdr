//! FFT processor: windowing, FFT, magnitude dB, averaging, rate capping.
//!
//! Mirrors `serverng/internal/dsp/fft_processor.go`.

use std::time::{Duration, Instant};

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
    #[allow(dead_code)]
    sample_rate: i32,
    averaging: f32,
    window_name: String,

    fft: Fft,
    window: Vec<f32>,
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

    min_interval: Duration,
    last_emit: Option<Instant>,
    pending_buf: Vec<f32>,
    pending_n: u32,
}

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

        let mut p = Self {
            fft_size: cfg.fft_size,
            sample_rate: cfg.sample_rate,
            averaging,
            window_name,
            fft,
            window,
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
            ring: vec![0u8; cfg.fft_size * 2 * 4],
            ring_fill: 0,
            samples_need: cfg.fft_size * 2,
            min_interval: Duration::ZERO,
            last_emit: None,
            pending_buf: vec![0.0; cfg.fft_size],
            pending_n: 0,
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
        }
        Ok(p)
    }

    /// Feeds raw uint8 IQ (interleaved I,Q) and returns emitted dB frames.
    pub fn process_iq_data(&mut self, data: &[u8]) -> Vec<Vec<f32>> {
        self.ring.extend_from_slice(data);
        self.ring_fill += data.len();

        let mut emitted = Vec::new();
        let now = Instant::now();
        let mut consumed = 0usize;

        while self.ring_fill - consumed >= self.samples_need {
            self.process_one_frame(consumed);
            consumed += self.samples_need;

            if self.min_interval.is_zero() {
                emitted.push(self.mag_buf.clone());
                continue;
            }

            if self.pending_n == 0 {
                self.pending_buf.copy_from_slice(&self.mag_buf);
                self.pending_n = 1;
            } else {
                self.pending_n += 1;
                let n = self.pending_n as f32;
                for i in 0..self.fft_size {
                    self.pending_buf[i] += (self.mag_buf[i] - self.pending_buf[i]) / n;
                }
            }

            let elapsed = match self.last_emit {
                Some(t) => now.duration_since(t),
                None => self.min_interval,
            };
            if elapsed >= self.min_interval {
                emitted.push(self.pending_buf.clone());
                self.pending_n = 0;
                self.last_emit = Some(now);
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
        for i in 0..fft_size {
            let w = self.window[i];
            let re = (self.ring[offset + i * 2] as f32 - 127.5) * INV_U8_SCALE * w;
            let im = (self.ring[offset + i * 2 + 1] as f32 - 127.5) * INV_U8_SCALE * w;
            self.complex_buf[i] = Complex32::new(re, im);
        }

        self.fft.transform(&mut self.complex_buf);

        let half = fft_size >> 1;
        let mask = fft_size - 1;
        for i in 0..fft_size {
            let src = (i + half) & mask;
            let c = self.complex_buf[src];
            let mut power = c.re * c.re + c.im * c.im;
            if power < 1e-20 {
                power = 1e-20;
            }
            self.mag_buf[i] = fast_log10_power(power) - self.norm_db;
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
                    self.avg_buf[i] = a * self.avg_buf[i] + b * self.mag_buf[i];
                }
            }
            self.mag_buf.copy_from_slice(&self.avg_buf);
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

        self.fft_size = new_size;
        self.fft = fft;
        self.window = window;
        self.samples_need = new_size * 2;
        self.norm_db = self.compute_normalization();

        self.complex_buf = vec![Complex32::default(); new_size];
        self.mag_buf = vec![0.0; new_size];
        self.pending_buf = vec![0.0; new_size];
        self.pending_n = 0;
        self.ring = vec![0u8; new_size * 2 * 4];
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
        self.last_emit = None;
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

    #[test]
    fn triangular_weights_sum_to_one() {
        let w = compute_triangular_weights(5);
        let sum: f32 = w.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6);
        assert!(w[0] > w[4]);
    }
}
