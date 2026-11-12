//! Simulated IQ signal generator for demo mode.
//!
//! Ported from the original Go backend.

use std::f64::consts::TAU;
use std::time::Duration;

use async_trait::async_trait;
use rand::Rng;
use tokio::sync::{mpsc, watch};

use super::source::Source;

/// Describes a single simulated signal.
#[derive(Debug, Clone)]
pub struct SignalConfig {
    /// Offset from the centre frequency, in Hz.
    pub offset_hz: f64,
    /// Amplitude in the range 0.0 - 1.0.
    pub amplitude: f64,
    /// `"carrier"`, `"fm"` or `"am"`.
    pub mod_type: String,
    /// Modulation frequency in Hz.
    pub mod_freq: f64,
}

impl Default for SignalConfig {
    fn default() -> Self {
        Self {
            offset_hz: 0.0,
            amplitude: 0.0,
            mod_type: String::new(),
            mod_freq: 0.0,
        }
    }
}

/// Configures the demo signal generator.
#[derive(Debug, Clone, Default)]
pub struct DemoConfig {
    pub sample_rate: i32,
    pub signals: Vec<SignalConfig>,
}

struct SimulatedSignal {
    offset_hz: f64,
    amplitude: f64,
    mod_type: String,
    mod_freq: f64,
    mod_phase: f64,
}

/// Generates simulated IQ data for development without hardware.
pub struct DemoSource {
    sample_rate: i32,
    signals: Vec<SimulatedSignal>,
    phase: f64,
    noise_floor: f64,
}

impl DemoSource {
    /// Creates a demo generator. Uses the default signal set when
    /// `cfg.signals` is empty and 2.4 MSPS when the sample rate is unset.
    pub fn new(cfg: DemoConfig) -> Self {
        let sample_rate = if cfg.sample_rate <= 0 {
            2_400_000
        } else {
            cfg.sample_rate
        };

        let signals = if cfg.signals.is_empty() {
            // Default signals: carrier, FM, and a weak carrier.
            vec![
                SimulatedSignal {
                    offset_hz: 100_000.0,
                    amplitude: 0.8,
                    mod_type: "carrier".to_string(),
                    mod_freq: 0.0,
                    mod_phase: 0.0,
                },
                SimulatedSignal {
                    offset_hz: -200_000.0,
                    amplitude: 0.6,
                    mod_type: "fm".to_string(),
                    mod_freq: 1000.0,
                    mod_phase: 0.0,
                },
                SimulatedSignal {
                    offset_hz: 300_000.0,
                    amplitude: 0.3,
                    mod_type: "carrier".to_string(),
                    mod_freq: 0.0,
                    mod_phase: 0.0,
                },
            ]
        } else {
            cfg.signals
                .into_iter()
                .map(|s| SimulatedSignal {
                    offset_hz: s.offset_hz,
                    amplitude: s.amplitude,
                    mod_type: s.mod_type,
                    mod_freq: s.mod_freq,
                    mod_phase: 0.0,
                })
                .collect()
        };

        Self {
            sample_rate,
            signals,
            phase: 0.0,
            noise_floor: 0.02,
        }
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }

    /// Produces one chunk of uint8 interleaved IQ data.
    fn generate_chunk(&mut self, samples: usize) -> Vec<u8> {
        let mut buf = vec![0u8; samples * 2];
        let inv_sr = 1.0 / f64::from(self.sample_rate);
        let mut rng = rand::thread_rng();

        for i in 0..samples {
            let mut sum_i = 0.0f64;
            let mut sum_q = 0.0f64;

            for sig in self.signals.iter_mut() {
                match sig.mod_type.as_str() {
                    "fm" => {
                        // FM: phase accumulates with frequency deviation
                        // proportional to the modulation.
                        let deviation = 75_000.0; // standard broadcast FM
                        sig.mod_phase += TAU * sig.mod_freq * inv_sr;
                        if sig.mod_phase > TAU {
                            sig.mod_phase -= TAU;
                        }
                        let instant_freq = sig.offset_hz + deviation * sig.mod_phase.sin();
                        self.phase += TAU * instant_freq * inv_sr;

                        sum_i += sig.amplitude * self.phase.cos();
                        sum_q += sig.amplitude * self.phase.sin();
                    }
                    "am" => {
                        // AM: carrier with amplitude modulation.
                        sig.mod_phase += TAU * sig.mod_freq * inv_sr;
                        if sig.mod_phase > TAU {
                            sig.mod_phase -= TAU;
                        }
                        let mod_depth = 0.5;
                        let env = 1.0 + mod_depth * sig.mod_phase.sin();
                        let phase = TAU * sig.offset_hz * i as f64 * inv_sr;
                        sum_i += sig.amplitude * env * phase.cos();
                        sum_q += sig.amplitude * env * phase.sin();
                    }
                    _ => {
                        // "carrier"
                        let phase = TAU * sig.offset_hz * i as f64 * inv_sr;
                        sum_i += sig.amplitude * phase.cos();
                        sum_q += sig.amplitude * phase.sin();
                    }
                }
            }

            // Add Gaussian noise.
            sum_i += self.noise_floor * gaussian(&mut rng);
            sum_q += self.noise_floor * gaussian(&mut rng);

            // Clamp to [-1, 1] and convert to uint8 [0, 255].
            sum_i = sum_i.clamp(-1.0, 1.0);
            sum_q = sum_q.clamp(-1.0, 1.0);

            buf[i * 2] = (127.5 + 127.5 * sum_i) as u8;
            buf[i * 2 + 1] = (127.5 + 127.5 * sum_q) as u8;
        }

        buf
    }
}

fn gaussian(rng: &mut impl Rng) -> f64 {
    // Box-Muller transform; exact sequence differs from Go but the
    // distribution is equivalent.
    let u1 = rng.gen::<f64>().max(1e-12);
    let u2 = rng.gen::<f64>();
    (-2.0 * u1.ln()).sqrt() * (TAU * u2).cos()
}

#[async_trait]
impl Source for DemoSource {
    async fn run(self: Box<Self>, out: mpsc::Sender<Vec<u8>>, cancel: watch::Receiver<bool>) {
        let mut this = *self;
        let samples_per_chunk = (this.sample_rate / 100).max(1) as usize;
        let mut ticker = tokio::time::interval(Duration::from_millis(10));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut cancel = cancel;

        loop {
            tokio::select! {
                _ = cancel.changed() => return,
                _ = ticker.tick() => {
                    let chunk = this.generate_chunk(samples_per_chunk);
                    if out.send(chunk).await.is_err() {
                        return;
                    }
                }
            }
        }
    }

    fn description(&self) -> String {
        format!("demo ({} Hz)", self.sample_rate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sample_rate_and_signals() {
        let mut src = DemoSource::new(DemoConfig::default());
        assert_eq!(src.sample_rate(), 2_400_000);
        let chunk = src.generate_chunk(16);
        assert_eq!(chunk.len(), 32);
    }

    #[test]
    fn custom_sample_rate_and_signals() {
        let mut src = DemoSource::new(DemoConfig {
            sample_rate: 480_000,
            signals: vec![SignalConfig {
                offset_hz: 1000.0,
                amplitude: 0.5,
                mod_type: "carrier".to_string(),
                mod_freq: 0.0,
            }],
        });
        assert_eq!(src.sample_rate(), 480_000);
        let chunk = src.generate_chunk(64);
        assert_eq!(chunk.len(), 128);
        // Signal must be present (not just the 127/128 noise floor).
        assert!(chunk.iter().any(|&v| v != 127 && v != 128));
    }

    #[test]
    fn fm_signal_produces_varying_output() {
        let mut src = DemoSource::new(DemoConfig::default());
        let first = src.generate_chunk(256);
        let second = src.generate_chunk(256);
        assert!(first.iter().any(|&v| v != 127 && v != 128));
        assert_ne!(first, second);
    }
}
