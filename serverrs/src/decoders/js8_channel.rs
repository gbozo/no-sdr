//! JS8 background/foreground decoder.
//!
//! JS8 is a keyboard/messaging mode built on an FT8-like 8-FSK waveform with
//! four speed submodes. The protocol implementation lives under `js8/`
//! (adapted from JS8Call/sdroxide-digi); this file is the channel adapter:
//! raw IQ → USB audio → 12 kHz → UTC slot buffer → decode worker.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use serde_json::{json, Value};

use sdroxide_types::Js8Speed;

use super::js8::assembler::Js8Assembler;
use super::js8::decode::{decode_slot_for, Js8Depth};
use super::{is_js8, LinearResampler, AUDIO_RATE};
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

struct Js8Job {
    audio: Vec<i16>,
    slot_utc: i64,
    speed: Js8Speed,
    depth: Js8Depth,
}

pub(crate) struct Js8Channel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    pcm: Vec<i16>,
    complex: Vec<num_complex::Complex32>,
    resampled: Vec<f32>,
    audio: Vec<i16>,
    slot_len: usize,
    decode_len: usize,
    last_slot: i64,
    last_status: i64,
    level: f32,
    speed: Js8Speed,
    depth: Js8Depth,
    decode_tx: Sender<Js8Job>,
    results: Arc<Mutex<Vec<Value>>>,
    decodes: Arc<AtomicU64>,
}

fn setting_str<'a>(cfg: &'a DecoderConfig, key: &str) -> Option<&'a str> {
    cfg.settings.get(key).and_then(Value::as_str)
}

fn parse_speed(cfg: &DecoderConfig) -> Js8Speed {
    match setting_str(cfg, "speed")
        .unwrap_or("normal")
        .to_ascii_lowercase()
        .as_str()
    {
        "fast" | "js8b" => Js8Speed::Fast,
        "turbo" | "js8c" => Js8Speed::Turbo,
        "slow" | "js8e" => Js8Speed::Slow,
        _ => Js8Speed::Normal,
    }
}

fn parse_depth(cfg: &DecoderConfig) -> Js8Depth {
    match setting_str(cfg, "depth")
        .unwrap_or("bp-osd")
        .to_ascii_lowercase()
        .as_str()
    {
        "bp" | "fast" => Js8Depth::Bp,
        _ => Js8Depth::BpOsd,
    }
}

fn parse_groups(cfg: &DecoderConfig) -> Vec<String> {
    cfg.settings
        .get("myGroups")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

impl Js8Channel {
    pub(crate) fn take_results(&self) -> Vec<Value> {
        std::mem::take(&mut *self.results.lock())
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now: i64) {
        let mut pcm = std::mem::take(&mut self.pcm);
        self.extractor.process_into(chunk, &mut pcm);
        if pcm.is_empty() {
            self.pcm = pcm;
            return;
        }

        self.complex.clear();
        self.complex.reserve(pcm.len() / 2);
        for pair in pcm.chunks_exact(2) {
            self.complex.push(num_complex::Complex32::new(
                pair[0] as f32 / 32768.0,
                pair[1] as f32 / 32768.0,
            ));
        }
        let audio = self.demod.process(&self.complex);
        let mut resampled = std::mem::take(&mut self.resampled);
        resampled.clear();
        self.resampler.process(&audio, &mut resampled);
        if !resampled.is_empty() {
            let sum2: f32 = resampled.iter().map(|s| s * s).sum();
            self.level = 10.0 * (sum2 / resampled.len() as f32 + 1e-12).log10();
        }
        self.append_audio(&resampled, now);
        self.resampled = resampled;
        self.pcm = pcm;

        if now.saturating_sub(self.last_status) >= 500_000_000 {
            self.last_status = now;
            self.results.lock().push(json!({
                "kind": "status",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "speed": self.speed.label().to_ascii_lowercase(),
                "period": self.speed.slot_s() as i64,
                "level": self.level,
                "decodes": self.decodes.load(Ordering::Relaxed),
                "listening": true,
            }));
        }
    }

    fn append_audio(&mut self, audio: &[f32], now: i64) {
        let slot_ns = (self.speed.slot_s() * 1_000_000_000.0) as i64;
        let slot = now / slot_ns.max(1);
        if self.last_slot == 0 {
            self.last_slot = slot;
        } else if slot != self.last_slot {
            if self.audio.len() >= self.decode_len {
                let start = self.audio.len() - self.decode_len;
                let _ = self.decode_tx.send(Js8Job {
                    audio: self.audio[start..].to_vec(),
                    slot_utc: self.last_slot * self.speed.slot_s() as i64,
                    speed: self.speed,
                    depth: self.depth,
                });
            }
            self.audio.clear();
            self.last_slot = slot;
        }

        for sample in audio {
            self.audio
                .push((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16);
        }
        let keep = self.slot_len + AUDIO_RATE as usize;
        if self.audio.len() > keep {
            let excess = self.audio.len() - keep;
            self.audio.drain(..excess);
        }
    }
}

fn decode_worker(
    cfg: DecoderConfig,
    speed: Js8Speed,
    results: Arc<Mutex<Vec<Value>>>,
    decodes: Arc<AtomicU64>,
    rx: mpsc::Receiver<Js8Job>,
) {
    let mut assembler = Js8Assembler::new(setting_str(&cfg, "myCall").unwrap_or(""));
    assembler.set_my_groups(parse_groups(&cfg));

    while let Ok(job) = rx.recv() {
        let found = decode_slot_for(job.speed, &job.audio, job.depth);
        for decode in &found {
            if let Some(message) = assembler.push(decode, job.slot_utc) {
                decodes.fetch_add(1, Ordering::Relaxed);
                results.lock().push(json!({
                    "kind": "message",
                    "id": cfg.id,
                    "mode": cfg.mode,
                    "text": message.text,
                    "rfHz": cfg.frequency_hz as f64 + message.audio_hz as f64,
                    "audioHz": message.audio_hz,
                    "snrDb": message.snr_db,
                    "period": message.first_slot_utc,
                    "js8": {
                        "from": message.from,
                        "to": message.to,
                        "cmd": message.cmd,
                        "text": message.text,
                        "snrDb": message.snr_db,
                        "audioHz": message.audio_hz,
                        "firstSlotUtc": message.first_slot_utc,
                        "lastSlotUtc": message.last_slot_utc,
                        "frames": message.frames,
                        "complete": message.complete,
                        "toMe": message.to_me,
                        "speed": message.speed.label().to_ascii_lowercase(),
                    }
                }));
            }
        }
        if !found.is_empty() {
            let heard: Vec<Value> = assembler
                .heard()
                .iter()
                .map(|(call, slot)| json!({"call": call, "lastSlotUtc": slot}))
                .collect();
            results.lock().push(json!({
                "kind": "status",
                "id": cfg.id,
                "mode": cfg.mode,
                "speed": speed.label().to_ascii_lowercase(),
                "period": speed.slot_s() as i64,
                "heard": heard,
                "decodes": decodes.load(Ordering::Relaxed),
                "listening": true,
            }));
        }
    }
}

pub(crate) fn build_channel(
    cfg: &DecoderConfig,
    center_hz: f64,
    sample_rate: u32,
) -> Result<Js8Channel, String> {
    if !is_js8(&cfg.mode) {
        return Err(format!("unsupported mode {}", cfg.mode));
    }
    let offset = cfg.frequency_hz - center_hz as i64;
    if offset.unsigned_abs() > sample_rate as u64 / 2 {
        return Err(format!(
            "frequency {} is outside the {sample_rate} Hz dongle span around {center_hz}",
            cfg.frequency_hz
        ));
    }

    let speed = parse_speed(cfg);
    let depth = parse_depth(cfg);
    let mut extractor = IqExtractor::new(IqExtractorConfig {
        input_sample_rate: sample_rate as i32,
        output_sample_rate: (AUDIO_RATE + 200) as i32,
        tune_offset: offset as i32,
        dc_offset_removal: true,
    })
    .map_err(|e| format!("channel extractor: {e}"))?;
    extractor.set_bandwidth(6000);
    let actual_rate = extractor.output_sample_rate() as f64;
    let mut demod = SsbDemod::new(SsbMode::Usb);
    demod
        .init(actual_rate)
        .map_err(|e| format!("USB demodulator: {e}"))?;
    demod.set_bandwidth(3000.0);

    let slot_len = (speed.slot_s() * AUDIO_RATE as f64) as usize;
    let decode_len = (speed.decode_window_s() * AUDIO_RATE as f64) as usize;
    let (decode_tx, decode_rx) = mpsc::channel();
    let results = Arc::new(Mutex::new(Vec::new()));
    let decodes = Arc::new(AtomicU64::new(0));
    let worker_cfg = cfg.clone();
    let worker_results = Arc::clone(&results);
    let worker_decodes = Arc::clone(&decodes);
    thread::Builder::new()
        .name(format!("js8-{}", cfg.id))
        .spawn(move || decode_worker(worker_cfg, speed, worker_results, worker_decodes, decode_rx))
        .map_err(|e| format!("JS8 decode worker: {e}"))?;

    Ok(Js8Channel {
        cfg: cfg.clone(),
        extractor,
        demod,
        resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
        pcm: Vec::new(),
        complex: Vec::new(),
        resampled: Vec::new(),
        audio: Vec::with_capacity(slot_len + AUDIO_RATE as usize),
        slot_len,
        decode_len,
        last_slot: 0,
        last_status: 0,
        level: -120.0,
        speed,
        depth,
        decode_tx,
        results,
        decodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js8_speed_and_depth_settings() {
        let mut cfg = DecoderConfig {
            mode: "js8".into(),
            ..Default::default()
        };
        assert_eq!(parse_speed(&cfg), Js8Speed::Normal);
        cfg.settings.insert("speed".into(), json!("turbo"));
        assert_eq!(parse_speed(&cfg), Js8Speed::Turbo);
        assert_eq!(parse_depth(&cfg), Js8Depth::BpOsd);
        cfg.settings.insert("depth".into(), json!("bp"));
        assert_eq!(parse_depth(&cfg), Js8Depth::Bp);
    }

    #[test]
    fn decodes_a_synthetic_js8_frame() {
        use crate::decoders::js8::{message::Js8Payload, modem};

        let payload = Js8Payload::from_chars("KM4ACKtestin", 4).expect("JS8 payload");
        let frame = modem::encode_frame_12k(Js8Speed::Normal, payload, 1500.0, 0.5);
        let mut slot = vec![0i16; 180_000];
        let start = modem::start_offset_samples(Js8Speed::Normal);
        for (dst, src) in slot[start..].iter_mut().zip(frame.iter()) {
            *dst = (src * 28_000.0) as i16;
        }

        let found = decode_slot_for(Js8Speed::Normal, &slot, Js8Depth::Bp);
        assert!(!found.is_empty(), "synthetic JS8 frame did not decode");
        assert_eq!(found[0].payload.to_chars(), "KM4ACKtestin");
    }

    #[test]
    fn channel_builds_at_js8_frequency() {
        let cfg = DecoderConfig {
            id: "js8-test".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "js8".into(),
            frequency_hz: 7_078_000,
            bandwidth_hz: 3_000,
            ..Default::default()
        };
        assert!(build_channel(&cfg, 7_078_000.0, 2_400_000).is_ok());
        assert!(build_channel(&cfg, 14_000_000.0, 2_400_000).is_err());
    }
}
