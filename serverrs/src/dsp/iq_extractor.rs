//! Narrow sub-band IQ extractor.
//!
//! Mirrors `serverng/internal/dsp/iq_extractor.go`.
//!
//! Pipeline: uint8 -> complex32 -> DC blocker -> noise blanker -> NCO shift
//! -> polyphase decimation (windowed-sinc anti-alias FIR) -> Butterworth LPF
//! -> optional normalization -> int16.

use anyhow::{bail, Result};
use num_complex::Complex32;

use super::block::ProcessorBlock;
use super::dc_block::DcBlocker;
use super::decimate::DecimateBlock;
use super::fft_processor::INV_U8_SCALE;
use super::filter::ButterworthBlock;
use super::nco::NcoBlock;
use super::noise_blanker::NoiseBlanker;

#[derive(Debug, Clone, Copy)]
pub struct IqExtractorConfig {
    /// Dongle rate (e.g. 2_400_000).
    pub input_sample_rate: i32,
    /// Desired rate (e.g. 48_000 for NFM, 240_000 for WFM).
    pub output_sample_rate: i32,
    /// Hz offset from center frequency.
    pub tune_offset: i32,
    /// Enable the IIR DC blocker on raw IQ (default: true).
    pub dc_offset_removal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConvertMode {
    Plain,
    Dc,
    Noise,
    DcNoise,
}

pub struct IqExtractor {
    nco: NcoBlock,
    decimate: DecimateBlock,
    butter: ButterworthBlock,

    noise_blanker: NoiseBlanker,
    dc_blocker: DcBlocker,

    input_rate: i32,
    output_rate: i32,
    factor: i32,
    bandwidth: i32,

    // Output level normalization (disabled by default).
    normalize: bool,
    norm_gain: f32,
    norm_target: f32,
    norm_avg_mag: f32,
    norm_alpha: f32,
    norm_release: f32,
    norm_max_gain: f32,
    norm_min_signal: f32,

    convert_mode: ConvertMode,
    complex_in: Vec<Complex32>,
}

impl IqExtractor {
    /// Creates a new sub-band extractor. Returns an error if the configuration
    /// is invalid.
    pub fn new(cfg: IqExtractorConfig) -> Result<Self> {
        if cfg.input_sample_rate <= 0 {
            bail!(
                "iq_extractor: InputSampleRate must be positive, got {}",
                cfg.input_sample_rate
            );
        }
        if cfg.output_sample_rate <= 0 {
            bail!(
                "iq_extractor: OutputSampleRate must be positive, got {}",
                cfg.output_sample_rate
            );
        }
        if cfg.output_sample_rate > cfg.input_sample_rate {
            bail!(
                "iq_extractor: OutputSampleRate ({}) cannot exceed InputSampleRate ({})",
                cfg.output_sample_rate,
                cfg.input_sample_rate
            );
        }

        let factor = find_decimation_factor(cfg.input_sample_rate, cfg.output_sample_rate);
        let actual_output_rate = cfg.input_sample_rate / factor;

        let mut nco = NcoBlock::new(cfg.tune_offset as f64);
        let mut decimate = DecimateBlock::new(factor as usize);
        let mut butter = ButterworthBlock::new(5000.0);

        nco.init(cfg.input_sample_rate as f64)
            .map_err(|e| anyhow::anyhow!("iq_extractor: pipeline init failed: {e}"))?;
        decimate
            .init(cfg.input_sample_rate as f64)
            .map_err(|e| anyhow::anyhow!("iq_extractor: pipeline init failed: {e}"))?;
        butter
            .init(actual_output_rate as f64)
            .map_err(|e| anyhow::anyhow!("iq_extractor: pipeline init failed: {e}"))?;

        let dc_blocker = DcBlocker::new(cfg.input_sample_rate as f64, 1.0, cfg.dc_offset_removal);

        let mut e = Self {
            nco,
            decimate,
            butter,
            noise_blanker: NoiseBlanker::new(10.0),
            dc_blocker,
            input_rate: cfg.input_sample_rate,
            output_rate: actual_output_rate,
            factor,
            bandwidth: 0,

            normalize: false,
            norm_gain: 1.0,
            norm_target: 0.5,
            norm_avg_mag: 0.0,
            norm_alpha: 0.002,
            norm_release: 0.0002,
            norm_max_gain: 10.0,
            norm_min_signal: 0.001,

            convert_mode: ConvertMode::Plain,
            complex_in: Vec::new(),
        };
        e.update_convert_mode();
        Ok(e)
    }

    /// Processes raw uint8 IQ (interleaved I,Q) and returns int16 IQ
    /// (interleaved I,Q). Returns an empty vector when the input is empty.
    pub fn process(&mut self, raw_iq: &[u8]) -> Vec<i16> {
        if raw_iq.len() < 2 {
            return Vec::new();
        }
        let num_samples = raw_iq.len() / 2;

        self.complex_in.clear();
        self.complex_in.reserve(num_samples);

        match self.convert_mode {
            ConvertMode::Plain => convert_only(raw_iq, num_samples, &mut self.complex_in),
            ConvertMode::Dc => convert_dc(
                raw_iq,
                num_samples,
                &mut self.complex_in,
                &mut self.dc_blocker,
            ),
            ConvertMode::Noise => convert_noise(
                raw_iq,
                num_samples,
                &mut self.complex_in,
                &mut self.noise_blanker,
            ),
            ConvertMode::DcNoise => convert_dc_noise(
                raw_iq,
                num_samples,
                &mut self.complex_in,
                &mut self.dc_blocker,
                &mut self.noise_blanker,
            ),
        }

        let mut stage = self.nco.process_complex(&self.complex_in);
        if !stage.is_empty() {
            stage = self.decimate.process_complex(&stage);
        }
        if !stage.is_empty() {
            stage = self.butter.process_complex(&stage);
        }
        if stage.is_empty() {
            return Vec::new();
        }

        if self.normalize {
            for s in stage.iter_mut() {
                let mag = (s.re * s.re + s.im * s.im).sqrt();
                self.norm_avg_mag += self.norm_alpha * (mag - self.norm_avg_mag);
                if self.norm_avg_mag > self.norm_min_signal {
                    let mut desired_gain = self.norm_target / self.norm_avg_mag;
                    if desired_gain > self.norm_max_gain {
                        desired_gain = self.norm_max_gain;
                    }
                    if desired_gain > self.norm_gain {
                        self.norm_gain += (desired_gain - self.norm_gain) * self.norm_alpha;
                    } else {
                        self.norm_gain += (desired_gain - self.norm_gain) * self.norm_release;
                    }
                }
                s.re *= self.norm_gain;
                s.im *= self.norm_gain;
            }
        }

        let mut out = Vec::with_capacity(stage.len() * 2);
        for s in &stage {
            out.push(clamp_to_int16(s.re * 32767.0));
            out.push(clamp_to_int16(s.im * 32767.0));
        }
        out
    }

    pub fn set_normalization_enabled(&mut self, enabled: bool) {
        self.normalize = enabled;
        if !enabled {
            self.norm_gain = 1.0;
            self.norm_avg_mag = 0.0;
        }
    }

    pub fn normalization_enabled(&self) -> bool {
        self.normalize
    }

    pub fn set_tune_offset(&mut self, hz: i32) {
        self.nco.set_offset(hz as f64);
    }

    /// Changes the output rate at runtime, rebuilding the decimator and
    /// reinitializing the rate-dependent stages.
    pub fn set_output_sample_rate(&mut self, rate: i32) {
        if rate <= 0 || rate > self.input_rate {
            return;
        }

        let factor = find_decimation_factor(self.input_rate, rate);
        let actual_rate = self.input_rate / factor;
        self.factor = factor;
        self.output_rate = actual_rate;

        let mut decimate = DecimateBlock::new(factor as usize);
        let _ = decimate.init(self.input_rate as f64);
        if self.bandwidth > 0 {
            decimate.set_bandwidth(self.bandwidth);
        }
        self.decimate = decimate;

        // Equivalent to rebuilding the pipeline: reinitialize the rate-dependent
        // stages at their (unchanged) rates.
        let _ = self.nco.init(self.input_rate as f64);
        let _ = self.butter.init(self.output_rate as f64);
    }

    /// Sets the RF filter bandwidth in Hz. `0` reverts to Nyquist defaults.
    pub fn set_bandwidth(&mut self, hz: i32) {
        if hz <= 0 {
            self.bandwidth = 0;
            self.decimate.set_bandwidth(0);
            self.butter.set_cutoff(self.output_rate as f64 * 0.45);
        } else {
            self.bandwidth = hz;
            self.decimate.set_bandwidth(hz);
            self.butter.set_cutoff(hz as f64 / 2.0);
        }
    }

    pub fn bandwidth(&self) -> i32 {
        self.bandwidth
    }

    /// Clears all DSP state.
    pub fn reset(&mut self) {
        self.nco.reset();
        self.decimate.reset();
        self.butter.reset();
        self.noise_blanker.reset();
        self.dc_blocker.reset();
        self.norm_gain = 1.0;
        self.norm_avg_mag = 0.0;
    }

    pub fn set_nb_enabled(&mut self, enabled: bool) {
        self.noise_blanker.set_enabled(enabled);
        self.update_convert_mode();
    }

    pub fn set_nb_threshold(&mut self, t: f32) {
        self.noise_blanker.set_threshold(t);
    }

    pub fn nb_enabled(&self) -> bool {
        self.noise_blanker.is_enabled()
    }

    pub fn set_dc_offset_removal(&mut self, enabled: bool) {
        self.dc_blocker.set_enabled(enabled);
        self.update_convert_mode();
    }

    pub fn dc_offset_removal_enabled(&self) -> bool {
        self.dc_blocker.is_enabled()
    }

    pub fn output_sample_rate(&self) -> i32 {
        self.output_rate
    }

    pub fn input_sample_rate(&self) -> i32 {
        self.input_rate
    }

    pub fn decimation_factor(&self) -> i32 {
        self.factor
    }

    /// Butterworth cutoff currently in use (tests/diagnostics).
    pub fn butterworth_cutoff(&self) -> f64 {
        self.butter.cutoff_hz()
    }

    fn update_convert_mode(&mut self) {
        self.convert_mode = match (self.dc_blocker.is_enabled(), self.noise_blanker.is_enabled()) {
            (true, true) => ConvertMode::DcNoise,
            (true, false) => ConvertMode::Dc,
            (false, true) => ConvertMode::Noise,
            (false, false) => ConvertMode::Plain,
        };
    }
}

fn convert_only(raw_iq: &[u8], num_samples: usize, out: &mut Vec<Complex32>) {
    for i in 0..num_samples {
        let i_val = (raw_iq[i * 2] as f32 - 127.5) * INV_U8_SCALE;
        let q_val = (raw_iq[i * 2 + 1] as f32 - 127.5) * INV_U8_SCALE;
        out.push(Complex32::new(i_val, q_val));
    }
}

fn convert_dc(
    raw_iq: &[u8],
    num_samples: usize,
    out: &mut Vec<Complex32>,
    dc: &mut DcBlocker,
) {
    for i in 0..num_samples {
        let i_val = (raw_iq[i * 2] as f32 - 127.5) * INV_U8_SCALE;
        let q_val = (raw_iq[i * 2 + 1] as f32 - 127.5) * INV_U8_SCALE;
        let (i_val, q_val) = dc.apply_sample(i_val, q_val);
        out.push(Complex32::new(i_val, q_val));
    }
}

fn convert_noise(
    raw_iq: &[u8],
    num_samples: usize,
    out: &mut Vec<Complex32>,
    nb: &mut NoiseBlanker,
) {
    for i in 0..num_samples {
        let i_val = (raw_iq[i * 2] as f32 - 127.5) * INV_U8_SCALE;
        let q_val = (raw_iq[i * 2 + 1] as f32 - 127.5) * INV_U8_SCALE;
        let (i_val, q_val) = nb.apply_sample(i_val, q_val);
        out.push(Complex32::new(i_val, q_val));
    }
}

fn convert_dc_noise(
    raw_iq: &[u8],
    num_samples: usize,
    out: &mut Vec<Complex32>,
    dc: &mut DcBlocker,
    nb: &mut NoiseBlanker,
) {
    for i in 0..num_samples {
        let i_val = (raw_iq[i * 2] as f32 - 127.5) * INV_U8_SCALE;
        let q_val = (raw_iq[i * 2 + 1] as f32 - 127.5) * INV_U8_SCALE;
        let (i_val, q_val) = dc.apply_sample(i_val, q_val);
        let (i_val, q_val) = nb.apply_sample(i_val, q_val);
        out.push(Complex32::new(i_val, q_val));
    }
}

/// Picks the integer decimation factor whose output rate is closest to
/// `target_rate`.
pub fn find_decimation_factor(input_rate: i32, target_rate: i32) -> i32 {
    if target_rate >= input_rate {
        return 1;
    }

    let ideal_factor = input_rate as f64 / target_rate as f64;
    let floor_factor = (ideal_factor.floor() as i32).max(1);
    let ceil_factor = (ideal_factor.ceil() as i32).max(1);

    let floor_rate = input_rate as f64 / floor_factor as f64;
    let ceil_rate = input_rate as f64 / ceil_factor as f64;

    let floor_diff = (floor_rate - target_rate as f64).abs();
    let ceil_diff = (ceil_rate - target_rate as f64).abs();

    if ceil_diff < floor_diff {
        ceil_factor
    } else {
        floor_factor
    }
}

/// Clamps a float sample to the int16 range (truncating toward zero, like Go).
pub fn clamp_to_int16(v: f32) -> i16 {
    if v >= 32767.0 {
        32767
    } else if v <= -32768.0 {
        -32768
    } else {
        v as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone_iq(freq: f64, rate: f64, n: usize, amp: f32) -> Vec<u8> {
        let mut raw = Vec::with_capacity(n * 2);
        for i in 0..n {
            let a = 2.0 * std::f64::consts::PI * freq * i as f64 / rate;
            let i_val = 127.5 + 127.5 * amp * a.cos() as f32;
            let q_val = 127.5 + 127.5 * amp * a.sin() as f32;
            raw.push(i_val.round().clamp(0.0, 255.0) as u8);
            raw.push(q_val.round().clamp(0.0, 255.0) as u8);
        }
        raw
    }

    fn rms_i16(v: &[i16]) -> f64 {
        (v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>() / v.len() as f64).sqrt()
    }

    #[test]
    fn validates_rates() {
        assert!(IqExtractor::new(IqExtractorConfig {
            input_sample_rate: 0,
            output_sample_rate: 48_000,
            tune_offset: 0,
            dc_offset_removal: true,
        })
        .is_err());
        assert!(IqExtractor::new(IqExtractorConfig {
            input_sample_rate: 48_000,
            output_sample_rate: 96_000,
            tune_offset: 0,
            dc_offset_removal: true,
        })
        .is_err());
    }

    #[test]
    fn selects_nearest_decimation_factor() {
        assert_eq!(find_decimation_factor(2_400_000, 48_000), 50);
        assert_eq!(find_decimation_factor(2_400_000, 240_000), 10);
        assert_eq!(find_decimation_factor(2_400_000, 3_000_000), 1);
    }

    #[test]
    fn extracts_passband_tone() {
        let mut e = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: 240_000,
            output_sample_rate: 48_000,
            tune_offset: 0,
            dc_offset_removal: true,
        })
        .unwrap();
        assert_eq!(e.decimation_factor(), 5);

        let raw = tone_iq(5_000.0, 240_000.0, 48_000, 0.5);
        let out = e.process(&raw);
        // ~48000/5 samples in, minus filter group delay.
        assert!((out.len() as i64 / 2 - 9600).abs() < 50, "{}", out.len() / 2);
        assert!(rms_i16(&out[2000..]) > 2000.0, "{}", rms_i16(&out[2000..]));
    }

    #[test]
    fn dc_removal_suppresses_constant_offset() {
        let mut e = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: 240_000,
            output_sample_rate: 48_000,
            tune_offset: 0,
            dc_offset_removal: true,
        })
        .unwrap();
        let raw = vec![200u8; 2_400_000 * 2];
        let out = e.process(&raw);
        assert!(rms_i16(&out[out.len() - 10_000..]) < 50.0, "{}", rms_i16(&out[out.len() - 10_000..]));
    }

    #[test]
    fn bandwidth_sets_butterworth_cutoff() {
        let mut e = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: 240_000,
            output_sample_rate: 48_000,
            tune_offset: 0,
            dc_offset_removal: false,
        })
        .unwrap();
        e.set_bandwidth(10_000);
        assert!((e.butterworth_cutoff() - 5000.0).abs() < 1e-9);
        e.set_bandwidth(0);
        assert!((e.butterworth_cutoff() - 48_000.0 * 0.45).abs() < 1e-9);
    }

    #[test]
    fn toggles_dc_and_noise_blanker() {
        let mut e = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: 240_000,
            output_sample_rate: 48_000,
            tune_offset: 0,
            dc_offset_removal: true,
        })
        .unwrap();
        assert!(e.dc_offset_removal_enabled());
        assert!(!e.nb_enabled());
        e.set_nb_enabled(true);
        assert!(e.nb_enabled());
        e.set_dc_offset_removal(false);
        assert!(!e.dc_offset_removal_enabled());
    }
}
