//! Opus encoder wrapper.
//!
//! Enabled with the `opus` cargo feature. Without it, construction fails and
//! `OPUS_AVAILABLE` is false (mirrors the Go `opus_stub.go` build tag split).

use anyhow::{bail, Result};

pub const OPUS_AVAILABLE: bool = cfg!(feature = "opus");

#[derive(Debug, Clone, Copy)]
pub struct OpusEncoderConfig {
    pub sample_rate: i32,
    pub channels: i32,
    pub bitrate: i32,
    /// 0 means "use default" (5).
    pub complexity: i32,
}

impl Default for OpusEncoderConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 1,
            bitrate: 32000,
            complexity: 5,
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpusPacket {
    pub data: Vec<u8>,
    /// PCM samples per channel represented by this packet.
    pub samples: usize,
    pub channels: usize,
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

#[cfg(feature = "opus")]
mod imp {
    use super::*;
    use opus::{Application, Bitrate, Channels};

    pub struct OpusEncoder {
        encoder: opus::Encoder,
        channels: i32,
        sample_rate: i32,
        bitrate: i32,
        complexity: i32,
        frame_size: usize,
        pcm_buf: Vec<i16>,
        pcm_pos: usize,
    }

    fn channels_enum(channels: i32) -> Channels {
        if channels == 2 {
            Channels::Stereo
        } else {
            Channels::Mono
        }
    }

    impl OpusEncoder {
        pub fn new(cfg: OpusEncoderConfig) -> Result<Self> {
            if cfg.sample_rate != 48000 {
                bail!("opus: sample rate must be 48000, got {}", cfg.sample_rate);
            }
            if !(1..=2).contains(&cfg.channels) {
                bail!("opus: channels must be 1 or 2, got {}", cfg.channels);
            }
            if cfg.bitrate <= 0 {
                bail!("opus: bitrate must be positive, got {}", cfg.bitrate);
            }
            let complexity = cfg.complexity.clamp(0, 10); // 0 = fastest
            let mut encoder = opus::Encoder::new(
                cfg.sample_rate as u32,
                channels_enum(cfg.channels),
                Application::Audio,
            )?;
            encoder.set_bitrate(Bitrate::Bits(cfg.bitrate))?;
            encoder.set_complexity(complexity)?;
            let frame_size = 2880; // 60 ms @ 48 kHz
            Ok(Self {
                encoder,
                channels: cfg.channels,
                sample_rate: cfg.sample_rate,
                bitrate: cfg.bitrate,
                complexity,
                frame_size,
                pcm_buf: vec![0i16; frame_size * cfg.channels as usize],
                pcm_pos: 0,
            })
        }

        pub fn encode(&mut self, pcm: &[i16]) -> Vec<OpusPacket> {
            let mut packets = Vec::new();
            let frame_samples = self.frame_size * self.channels as usize;
            let mut pos = 0usize;
            let mut out = vec![0u8; 4000];
            while pos < pcm.len() {
                let space = frame_samples - self.pcm_pos;
                let avail = pcm.len() - pos;
                let n = space.min(avail);
                self.pcm_buf[self.pcm_pos..self.pcm_pos + n]
                    .copy_from_slice(&pcm[pos..pos + n]);
                self.pcm_pos += n;
                pos += n;
                if self.pcm_pos >= frame_samples {
                    if let Ok(encoded) = self.encoder.encode(&self.pcm_buf[..frame_samples], &mut out)
                    {
                        if encoded > 0 {
                            packets.push(OpusPacket {
                                data: out[..encoded].to_vec(),
                                samples: self.frame_size,
                                channels: self.channels as usize,
                            });
                        }
                    }
                    self.pcm_pos = 0;
                }
            }
            packets
        }

        pub fn set_bitrate(&mut self, bps: i32) -> Result<()> {
            self.encoder.set_bitrate(Bitrate::Bits(bps))?;
            self.bitrate = bps;
            Ok(())
        }

        pub fn set_channels(&mut self, channels: i32) -> Result<()> {
            if !(1..=2).contains(&channels) {
                bail!("opus: channels must be 1 or 2, got {channels}");
            }
            if channels == self.channels {
                return Ok(());
            }
            let mut encoder = opus::Encoder::new(
                self.sample_rate as u32,
                channels_enum(channels),
                Application::Audio,
            )?;
            encoder.set_bitrate(Bitrate::Bits(self.bitrate))?;
            encoder.set_complexity(self.complexity)?;
            self.encoder = encoder;
            self.channels = channels;
            self.pcm_buf = vec![0i16; self.frame_size * channels as usize];
            self.pcm_pos = 0;
            Ok(())
        }

        pub fn reset(&mut self) {
            self.pcm_pos = 0;
            if let Ok(mut encoder) = opus::Encoder::new(
                self.sample_rate as u32,
                channels_enum(self.channels),
                Application::Audio,
            ) {
                let _ = encoder.set_bitrate(Bitrate::Bits(self.bitrate));
                let _ = encoder.set_complexity(self.complexity);
                self.encoder = encoder;
            }
        }

        pub fn set_complexity(&mut self, mut complexity: i32) -> Result<()> {
            complexity = complexity.clamp(0, 10);
            self.encoder.set_complexity(complexity)?;
            self.complexity = complexity;
            Ok(())
        }

        pub fn close(&mut self) {
            self.pcm_pos = 0;
            self.pcm_buf.clear();
        }

        pub fn frame_size(&self) -> usize {
            self.frame_size
        }

        pub fn channels(&self) -> i32 {
            self.channels
        }
    }
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

#[cfg(not(feature = "opus"))]
mod imp {
    use super::*;

    pub struct OpusEncoder;

    impl OpusEncoder {
        pub fn new(_cfg: OpusEncoderConfig) -> Result<Self> {
            bail!("opus: not compiled in (build with --features opus)")
        }

        pub fn encode(&mut self, _pcm: &[i16]) -> Vec<OpusPacket> {
            Vec::new()
        }

        pub fn set_bitrate(&mut self, _bps: i32) -> Result<()> {
            bail!("opus: not compiled in")
        }

        pub fn set_channels(&mut self, _channels: i32) -> Result<()> {
            bail!("opus: not compiled in")
        }

        pub fn reset(&mut self) {}

        pub fn set_complexity(&mut self, _complexity: i32) -> Result<()> {
            bail!("opus: not compiled in")
        }

        pub fn close(&mut self) {}

        pub fn frame_size(&self) -> usize {
            2880
        }

        pub fn channels(&self) -> i32 {
            1
        }
    }
}

pub use imp::OpusEncoder;
