//! Server-side demodulation + Opus encoding pipeline.
//!
//! Mirrors `serverng/internal/dongle/opus_pipeline.go`. Used when the client
//! selects an `opus` / `opus-lo` / `opus-hq` IQ codec.

use anyhow::{bail, Result};
use num_complex::Complex32;

use crate::codec::{OpusEncoder, OpusEncoderConfig};
use crate::dsp::Interpolator;
use crate::demod::{
    AmDemod, CquamDemod, CwDemod, Demodulator, FmMonoDemod, FmStereoDemod, RdsDecoder, SamDemod,
    SsbDemod, SsbMode,
};

/// One encoded Opus packet plus optional RDS JSON.
#[derive(Debug, Clone)]
pub struct OpusResult {
    pub packet: Vec<u8>,
    pub samples: usize,
    pub channels: usize,
    /// JSON-encoded `RdsData`, present only on the first packet of a frame
    /// when the RDS snapshot changed.
    pub rds_json: Option<Vec<u8>>,
}

/// Configures the server-side demod + Opus encoding pipeline.
#[derive(Debug, Clone)]
pub struct OpusPipelineConfig {
    pub mode: String,
    /// IQ extractor output rate.
    pub sample_rate: i32,
    /// Opus bitrate (0 = auto based on quality).
    pub bitrate: i32,
    /// `None` = default true; `Some(false)` starts mono from the first frame.
    pub stereo_enabled: Option<bool>,
    pub quality: String,
    /// Opus encoder complexity (0 = server default 5).
    pub complexity: i32,
}

impl Default for OpusPipelineConfig {
    fn default() -> Self {
        Self {
            mode: "nfm".to_string(),
            sample_rate: 48000,
            bitrate: 0,
            stereo_enabled: None,
            quality: "opus".to_string(),
            complexity: 5,
        }
    }
}

const STEREO_HOLD_FRAMES: usize = 10;
const CAPTURE_SECS: usize = 12;

/// Server-side demodulation + Opus encoding.
pub struct OpusPipeline {
    demodulator: Box<dyn Demodulator>,
    encoder: Option<OpusEncoder>,
    mode: String,
    sample_rate: i32,
    channels: usize,
    quality: String,
    closed: bool,

    decim_factor: usize,
    upsample_ratio: f64,
    upsampler: Option<Interpolator>,
    upsample_accum: f64,
    last_sample: f32,

    bandwidth: i32,
    stereo_enabled: bool,
    stereo_hold_counter: usize,
    pending_channels: usize,

    rds_decoder: Option<RdsDecoder>,
    rds_last_json: Option<Vec<u8>>,

    capture_ring: Vec<f32>,
    capture_pos: usize,
    capture_len: usize,
    capture_cap: usize,
    capture_chans: usize,

    /// Reused per-call scratch buffers (no allocation in steady state).
    complex_buf: Vec<Complex32>,
    rate_buf: Vec<f32>,
    pcm_buf: Vec<i16>,
}

impl OpusPipeline {
    pub fn new(cfg: OpusPipelineConfig) -> Result<Self> {
        if cfg.sample_rate <= 0 {
            bail!(
                "opus_pipeline: SampleRate must be positive, got {}",
                cfg.sample_rate
            );
        }

        let quality = if cfg.quality.is_empty() {
            "opus".to_string()
        } else {
            cfg.quality.clone()
        };
        let mode = if cfg.mode.is_empty() {
            "nfm".to_string()
        } else {
            cfg.mode.clone()
        };

        let mut channels = channels_for_mode(&mode);
        let stereo_enabled = cfg.stereo_enabled.unwrap_or(true);
        if !stereo_enabled {
            channels = 1;
        }

        let bitrate = if cfg.bitrate > 0 {
            cfg.bitrate
        } else {
            bitrate_for_quality(&quality, channels)
        };

        let mut demodulator = create_demod_block(&mode)?;
        demodulator
            .init(cfg.sample_rate as f64)
            .map_err(|e| anyhow::anyhow!("opus_pipeline: demod init failed: {e}"))?;

        let encoder = OpusEncoder::new(OpusEncoderConfig {
            sample_rate: 48000,
            channels: channels as i32,
            bitrate,
            complexity: cfg.complexity,
        })
        .map_err(|e| anyhow::anyhow!("opus_pipeline: encoder creation failed: {e}"))?;

        let mut demod_out_rate = cfg.sample_rate;
        if mode == "wfm" {
            demod_out_rate = 48000;
        }
        let (decim_factor, upsample_ratio) = if demod_out_rate > 48000 {
            ((demod_out_rate / 48000) as usize, 1.0)
        } else if demod_out_rate < 48000 && demod_out_rate > 0 {
            (0, 48000.0 / demod_out_rate as f64)
        } else {
            (1, 1.0)
        };

        let upsampler = if decim_factor == 0 {
            let ratio = 48000.0 / demod_out_rate as f64;
            if ratio.fract().abs() < 1e-9 && ratio >= 2.0 {
                Some(Interpolator::new(ratio as usize))
            } else {
                None
            }
        } else {
            None
        };

        let capture_cap = CAPTURE_SECS * 48000;
        let rds_decoder = if mode == "wfm" {
            Some(RdsDecoder::new(cfg.sample_rate as f64))
        } else {
            None
        };

        Ok(Self {
            demodulator,
            encoder: Some(encoder),
            mode,
            sample_rate: cfg.sample_rate,
            channels,
            quality,
            closed: false,
            decim_factor,
            upsample_ratio,
            upsampler,
            upsample_accum: 0.0,
            last_sample: 0.0,
            bandwidth: 0,
            stereo_enabled,
            stereo_hold_counter: 0,
            pending_channels: 0,
            rds_decoder,
            rds_last_json: None,
            capture_ring: vec![0.0; capture_cap],
            capture_pos: 0,
            capture_len: 0,
            capture_cap,
            capture_chans: 1,
            complex_buf: Vec::new(),
            rate_buf: Vec::new(),
            pcm_buf: Vec::new(),
        })
    }

    /// Demodulates Int16 IQ (interleaved I,Q) and returns Opus packets.
    pub fn process(&mut self, iq_int16: &[i16]) -> Vec<OpusResult> {
        if iq_int16.len() < 2 || self.closed || self.encoder.is_none() {
            return Vec::new();
        }

        let num_samples = iq_int16.len() / 2;
        self.complex_buf.clear();
        self.complex_buf.reserve(num_samples);
        for i in 0..num_samples {
            let i_val = iq_int16[i * 2] as f32 / 32768.0;
            let q_val = iq_int16[i * 2 + 1] as f32 / 32768.0;
            self.complex_buf.push(Complex32::new(i_val, q_val));
        }

        // Demodulate.
        let audio = self.demodulator.process(&self.complex_buf);
        if audio.is_empty() {
            return Vec::new();
        }
        let written = audio.len();

        // RDS from the composite baseband (WFM only).
        let mut rds_json: Option<Vec<u8>> = None;
        if self.mode == "wfm" {
            if let Some(dec) = self.rds_decoder.as_mut() {
                let pilot_ok = self.demodulator.pilot_detected();
                let data = {
                    let composite = self.demodulator.composite().unwrap_or(&[]);
                    let phases = self.demodulator.pilot_phases();
                    if pilot_ok {
                        if let Some(phases) = phases {
                            if phases.len() == composite.len() {
                                dec.process_with_pilot(composite, phases)
                            } else {
                                dec.process(composite)
                            }
                        } else {
                            dec.process(composite)
                        }
                    } else {
                        dec.process(composite)
                    }
                };
                if let Some(data) = data {
                    if let Ok(bytes) = serde_json::to_vec(&data) {
                        if self.rds_last_json.as_deref() != Some(bytes.as_slice()) {
                            rds_json = Some(bytes.clone());
                            self.rds_last_json = Some(bytes);
                        }
                    }
                }
            }
        }

        let demod_is_stereo = self.mode == "wfm" || self.mode == "am-stereo";
        let demod_frames = if demod_is_stereo {
            written / 2
        } else {
            written
        };

        // Stereo/mono encoder hysteresis.
        if !self.stereo_enabled {
            self.pending_channels = 0;
            self.stereo_hold_counter = 0;
            if self.channels != 1 {
                self.channels = 1;
                self.apply_encoder_channels(1);
            }
        } else {
            let need_channels = if demod_is_stereo { 2 } else { 1 };
            if need_channels != self.channels {
                if self.pending_channels != need_channels {
                    self.pending_channels = need_channels;
                    self.stereo_hold_counter = 0;
                } else {
                    self.stereo_hold_counter += 1;
                    if self.stereo_hold_counter >= STEREO_HOLD_FRAMES {
                        self.channels = need_channels;
                        self.apply_encoder_channels(need_channels);
                        self.pending_channels = 0;
                        self.stereo_hold_counter = 0;
                    }
                }
            } else {
                self.pending_channels = 0;
                self.stereo_hold_counter = 0;
            }
        }

        // Rate-convert to 48 kHz. The common WFM stereo case borrows the
        // demodulator output directly; only an actual conversion uses scratch.
        // `rate_buf` is moved out while borrowed so the capture ring below can
        // still be written through `&mut self`.
        let needs_convert = self.decim_factor != 1 || (demod_is_stereo && self.channels == 1);
        let mut scratch = if needs_convert {
            Some(std::mem::take(&mut self.rate_buf))
        } else {
            None
        };
        if let Some(buf) = scratch.as_mut() {
            buf.clear();
            if self.decim_factor == 1 {
                buf.reserve(demod_frames);
                for i in 0..demod_frames {
                    buf.push((audio[i * 2] + audio[i * 2 + 1]) * 0.5);
                }
            } else if self.decim_factor > 1 {
                let out_frames = demod_frames / self.decim_factor;
                buf.reserve(out_frames * self.channels);
                if demod_is_stereo && self.channels == 2 {
                    for i in 0..out_frames {
                        let src = i * self.decim_factor * 2;
                        buf.push(audio[src]);
                        buf.push(audio[src + 1]);
                    }
                } else if demod_is_stereo && self.channels == 1 {
                    for i in 0..out_frames {
                        let src = i * self.decim_factor * 2;
                        buf.push((audio[src] + audio[src + 1]) * 0.5);
                    }
                } else {
                    for i in 0..out_frames {
                        buf.push(audio[i * self.decim_factor]);
                    }
                }
            } else {
                // Upsample (SSB/CW). Use the band-limited polyphase interpolator
                // for integer 2x/4x ratios; fall back to linear otherwise.
                buf.reserve((demod_frames as f64 * self.upsample_ratio) as usize + 4);
                if let Some(up) = self.upsampler.as_mut() {
                    up.process(&audio[..demod_frames], buf);
                } else {
                    let est_out =
                        (demod_frames as f64 * self.upsample_ratio) as usize + 4;
                    for sample in audio.iter().take(demod_frames) {
                        self.upsample_accum += self.upsample_ratio;
                        while self.upsample_accum >= 1.0 && buf.len() < est_out {
                            let frac =
                                (self.upsample_accum - self.upsample_accum.trunc()) as f32;
                            buf.push(self.last_sample + frac * (sample - self.last_sample));
                            self.upsample_accum -= 1.0;
                        }
                        self.last_sample = *sample;
                    }
                }
            }
        }
        let audio_for_opus: &[f32] = scratch.as_deref().unwrap_or(&audio);

        let out_len = audio_for_opus.len();
        if out_len == 0 {
            if let Some(buf) = scratch {
                self.rate_buf = buf;
            }
            return Vec::new();
        }

        // Feed the PCM capture ring buffer (mono downmix).
        self.capture_chans = self.channels;
        let cap = self.capture_cap;
        let mut pos = self.capture_pos;
        if demod_is_stereo && self.channels == 2 {
            let frames = out_len / 2;
            for i in 0..frames {
                self.capture_ring[pos] =
                    (audio_for_opus[i * 2] + audio_for_opus[i * 2 + 1]) * 0.5;
                pos += 1;
                if pos == cap {
                    pos = 0;
                }
            }
            self.capture_len = (self.capture_len + frames).min(cap);
        } else {
            for &sample in audio_for_opus {
                self.capture_ring[pos] = sample;
                pos += 1;
                if pos == cap {
                    pos = 0;
                }
            }
            self.capture_len = (self.capture_len + out_len).min(cap);
        }
        self.capture_pos = pos;

        // float32 → int16 PCM (reused buffer).
        self.pcm_buf.clear();
        self.pcm_buf.reserve(out_len);
        for &sample in audio_for_opus {
            let mut v = sample * 32767.0;
            if v > 32767.0 {
                v = 32767.0;
            } else if v < -32768.0 {
                v = -32768.0;
            }
            self.pcm_buf.push(v as i16);
        }
        if let Some(buf) = scratch {
            self.rate_buf = buf;
        }

        let packets = match self.encoder.as_mut() {
            Some(enc) => enc.encode(&self.pcm_buf),
            None => return Vec::new(),
        };
        let mut results = Vec::with_capacity(packets.len());
        for (i, pkt) in packets.into_iter().enumerate() {
            results.push(OpusResult {
                packet: pkt.data,
                samples: pkt.samples,
                channels: pkt.channels,
                rds_json: if i == 0 { rds_json.clone() } else { None },
            });
        }
        results
    }

    fn apply_encoder_channels(&mut self, channels: usize) {
        let bitrate = bitrate_for_quality(&self.quality, channels);
        if let Some(enc) = self.encoder.as_mut() {
            if enc.set_channels(channels as i32).is_ok() {
                let _ = enc.set_bitrate(bitrate);
            }
        }
    }

    /// Replaces the demodulator.
    pub fn set_mode(&mut self, mode: &str) -> Result<()> {
        let mut new_demod = create_demod_block(mode)?;
        new_demod
            .init(self.sample_rate as f64)
            .map_err(|e| anyhow::anyhow!("opus_pipeline: demod init failed for mode {mode:?}: {e}"))?;

        let mut new_channels = channels_for_mode(mode);
        if !self.stereo_enabled {
            new_channels = 1;
        }
        if new_channels != self.channels {
            let bitrate = bitrate_for_quality(&self.quality, new_channels);
            if let Some(enc) = self.encoder.as_mut() {
                enc.set_channels(new_channels as i32)
                    .map_err(|e| anyhow::anyhow!("opus_pipeline: failed to set channels to {new_channels}: {e}"))?;
                enc.set_bitrate(bitrate).map_err(|e| {
                    anyhow::anyhow!("opus_pipeline: failed to set bitrate to {bitrate}: {e}")
                })?;
            }
            self.channels = new_channels;
        }

        self.demodulator = new_demod;
        self.mode = mode.to_string();
        self.update_sample_rate(self.sample_rate);
        if self.bandwidth > 0 {
            self.demodulator.set_bandwidth(self.bandwidth as f64);
        }

        if mode == "wfm" {
            match self.rds_decoder.as_mut() {
                Some(dec) => dec.reset(),
                None => self.rds_decoder = Some(RdsDecoder::new(self.sample_rate as f64)),
            }
            self.rds_last_json = None;
        } else {
            self.rds_decoder = None;
            self.rds_last_json = None;
        }
        Ok(())
    }

    /// Updates the input sample rate and recomputes rate conversion.
    pub fn update_sample_rate(&mut self, new_rate: i32) {
        self.sample_rate = new_rate;
        let demod_out_rate = if self.mode == "wfm" {
            48000
        } else {
            new_rate
        };
        if demod_out_rate > 48000 {
            self.decim_factor = (demod_out_rate / 48000) as usize;
            self.upsample_ratio = 1.0;
        } else if demod_out_rate < 48000 && demod_out_rate > 0 {
            self.decim_factor = 0;
            self.upsample_ratio = 48000.0 / demod_out_rate as f64;
        } else {
            self.decim_factor = 1;
            self.upsample_ratio = 1.0;
        }
        self.upsample_accum = 0.0;
        self.last_sample = 0.0;
        if self.decim_factor == 0 {
            let ratio = 48000.0 / demod_out_rate as f64;
            self.upsampler = if ratio.fract().abs() < 1e-9 && ratio >= 2.0 {
                Some(Interpolator::new(ratio as usize))
            } else {
                None
            };
        } else {
            self.upsampler = None;
        }
    }

    /// Enables or disables stereo output, forcing mono immediately when disabled.
    pub fn set_stereo(&mut self, stereo: bool) {
        self.stereo_enabled = stereo;
        self.pending_channels = 0;
        self.stereo_hold_counter = 0;
        let mut new_channels = 1;
        if stereo && (self.mode == "wfm" || self.mode == "am-stereo") {
            new_channels = 2;
        }
        if new_channels == self.channels {
            return;
        }
        self.channels = new_channels;
        self.apply_encoder_channels(new_channels);
    }

    pub fn reset(&mut self) {
        self.demodulator.reset();
        if let Some(enc) = self.encoder.as_mut() {
            enc.reset();
        }
        if self.mode == "wfm" {
            self.rds_decoder = Some(RdsDecoder::new(self.sample_rate as f64));
        }
        self.rds_last_json = None;
        self.capture_pos = 0;
        self.capture_len = 0;
        self.upsample_accum = 0.0;
        self.last_sample = 0.0;
        if let Some(up) = self.upsampler.as_mut() {
            up.reset();
        }
    }

    /// Returns up to `secs` seconds of the most recent decoded mono 48 kHz PCM.
    pub fn capture_pcm(&self, secs: i32) -> Vec<f32> {
        let mut want = (secs.max(0) as usize) * 48000;
        if want > self.capture_cap {
            want = self.capture_cap;
        }
        let mut avail = self.capture_len;
        if avail > want {
            avail = want;
        }
        if avail == 0 {
            return Vec::new();
        }
        let start = (self.capture_pos + self.capture_cap - avail) % self.capture_cap;
        (0..avail)
            .map(|i| self.capture_ring[(start + i) % self.capture_cap])
            .collect()
    }

    pub fn close(&mut self) {
        if let Some(enc) = self.encoder.as_mut() {
            enc.close();
        }
        self.encoder = None;
        self.closed = true;
    }

    pub fn mode(&self) -> &str {
        &self.mode
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn sample_rate(&self) -> i32 {
        self.sample_rate
    }

    pub fn quality(&self) -> &str {
        &self.quality
    }

    /// Updates the encoder bitrate.
    pub fn set_bitrate(&mut self, bitrate: i32) {
        if let Some(enc) = self.encoder.as_mut() {
            let _ = enc.set_bitrate(bitrate);
        }
    }

    /// Forwards a bandwidth hint to the demodulator and remembers it.
    pub fn set_bandwidth(&mut self, hz: i32) {
        self.bandwidth = hz;
        self.demodulator.set_bandwidth(hz as f64);
    }
}

fn create_demod_block(mode: &str) -> Result<Box<dyn Demodulator>> {
    let d: Box<dyn Demodulator> = match mode {
        "wfm" => Box::new(FmStereoDemod::new(50e-6)),
        "nfm" => Box::new(FmMonoDemod::new(75e-6)),
        "am" => Box::new(AmDemod::default()),
        "am-stereo" => Box::new(CquamDemod::default()),
        "sam" => Box::new(SamDemod::default()),
        "usb" => Box::new(SsbDemod::new(SsbMode::Usb)),
        "lsb" => Box::new(SsbDemod::new(SsbMode::Lsb)),
        "cw" => Box::new(CwDemod::new(700.0)),
        "raw" => Box::new(FmMonoDemod::new(75e-6)),
        _ => bail!("opus_pipeline: unsupported mode {mode:?}"),
    };
    Ok(d)
}

/// Output channel count for a demodulation mode.
pub fn channels_for_mode(mode: &str) -> usize {
    match mode {
        "wfm" | "am-stereo" => 2,
        _ => 1,
    }
}

/// Opus bitrate for a quality tier and channel count.
pub fn bitrate_for_quality(quality: &str, channels: usize) -> i32 {
    match quality {
        "opus-hq" => {
            if channels == 2 {
                192000
            } else {
                128000
            }
        }
        "opus-lo" => {
            if channels == 2 {
                32000
            } else {
                16000
            }
        }
        _ => {
            if channels == 2 {
                64000
            } else {
                32000
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitrate_tiers_match_go() {
        assert_eq!(bitrate_for_quality("opus", 1), 32000);
        assert_eq!(bitrate_for_quality("opus", 2), 64000);
        assert_eq!(bitrate_for_quality("opus-hq", 1), 128000);
        assert_eq!(bitrate_for_quality("opus-hq", 2), 192000);
        assert_eq!(bitrate_for_quality("opus-lo", 1), 16000);
        assert_eq!(bitrate_for_quality("opus-lo", 2), 32000);
    }

    #[test]
    fn channels_per_mode() {
        assert_eq!(channels_for_mode("wfm"), 2);
        assert_eq!(channels_for_mode("am-stereo"), 2);
        assert_eq!(channels_for_mode("nfm"), 1);
        assert_eq!(channels_for_mode("usb"), 1);
    }

    #[test]
    fn rejects_bad_sample_rate() {
        let result = OpusPipeline::new(OpusPipelineConfig {
            sample_rate: 0,
            ..Default::default()
        });
        match result {
            Ok(_) => panic!("expected an error"),
            Err(err) => assert!(err.to_string().contains("SampleRate must be positive")),
        }
    }
}
