//! AX.25 packet monitor, 1200 baud Bell 202 and 9600 baud G3RUH.
//!
//! Feed it discriminator audio from an NBFM channel. The same modem/deframer
//! path as APRS, but this decoder deliberately does not parse the information
//! field as APRS: it shows every AX.25 frame, its addresses, type, PID, payload
//! and raw bytes. The channel speed is selected with the decoder setting
//! `baud` (1200 default, 9600 for G3RUH).

use num_complex::Complex32;
use sdroxide_ax25::{Deframer, Packet, PacketType};
use serde_json::{json, Value};

use super::afsk::{AfskProfile, AfskRx};
use super::g3ruh::G3ruhRx;
use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, FmMonoDemod};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const AUDIO_RATE: u32 = 48_000;
const CHANNEL_BANDWIDTH_HZ: i32 = 12_500;
const MAX_FRAME_HEX: usize = 4096;
/// AX.25 PID: no layer 3 — the information field is plain text.
const PID_NO_L3: u8 = 0xF0;

enum Modem {
    Afsk(AfskRx),
    G3ruh(G3ruhRx),
}

impl Modem {
    fn process(&mut self, audio: &[f32], out: &mut Vec<bool>) {
        match self {
            Modem::Afsk(m) => m.process(audio, out),
            Modem::G3ruh(m) => m.process(audio, out),
        }
    }

    fn magnitude(&self) -> f32 {
        match self {
            Modem::Afsk(m) => m.magnitude(),
            Modem::G3ruh(m) => m.magnitude(),
        }
    }
}

pub(crate) struct PacketChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: FmMonoDemod,
    resampler: LinearResampler,
    modem: Modem,
    deframer: Deframer,
    results: Vec<Value>,
    pcm: Vec<i16>,
    complex: Vec<Complex32>,
    resampled: Vec<f32>,
    bits: Vec<bool>,
    frames: Vec<Vec<u8>>,
    last_status_ms: i64,
    frames_ok: u32,
    bad_fcs: u32,
    non_ax25: u32,
}

impl PacketChannel {
    pub(crate) fn new(
        cfg: &DecoderConfig,
        center_hz: f64,
        sample_rate: u32,
    ) -> Result<Self, String> {
        let offset = cfg.frequency_hz - center_hz as i64;
        if offset.unsigned_abs() > sample_rate as u64 / 2 {
            return Err(format!(
                "frequency {} is outside the {sample_rate} Hz dongle span around {center_hz}",
                cfg.frequency_hz
            ));
        }

        let mut extractor = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: sample_rate as i32,
            output_sample_rate: (AUDIO_RATE + 200) as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("packet channel extractor: {e}"))?;
        extractor.set_bandwidth(CHANNEL_BANDWIDTH_HZ);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = FmMonoDemod::new(0.0);
        demod
            .init(actual_rate)
            .map_err(|e| format!("packet FM demodulator: {e}"))?;
        demod.set_bandwidth(CHANNEL_BANDWIDTH_HZ as f64);

        let baud = baud_setting(cfg);
        let modem = if baud == 9600 {
            Modem::G3ruh(G3ruhRx::new(AUDIO_RATE as f64))
        } else {
            Modem::Afsk(AfskRx::new(AUDIO_RATE as f64, AfskProfile::Vhf1200))
        };

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
            modem,
            deframer: Deframer::new(),
            results: Vec::new(),
            pcm: Vec::new(),
            complex: Vec::new(),
            resampled: Vec::new(),
            bits: Vec::new(),
            frames: Vec::new(),
            last_status_ms: 0,
            frames_ok: 0,
            bad_fcs: 0,
            non_ax25: 0,
        })
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.results)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now_ms: i64) {
        let mut pcm = std::mem::take(&mut self.pcm);
        self.extractor.process_into(chunk, &mut pcm);
        if !pcm.is_empty() {
            self.complex.clear();
            self.complex.reserve(pcm.len() / 2);
            for pair in pcm.chunks_exact(2) {
                self.complex.push(Complex32::new(
                    pair[0] as f32 / 32768.0,
                    pair[1] as f32 / 32768.0,
                ));
            }

            let audio = self.demod.process(&self.complex);
            let mut resampled = std::mem::take(&mut self.resampled);
            resampled.clear();
            self.resampler.process(&audio, &mut resampled);

            self.bits.clear();
            self.modem.process(&resampled, &mut self.bits);
            self.frames.clear();
            for &bit in &self.bits {
                self.deframer.push_level(bit, &mut self.frames);
            }
            self.bad_fcs += self.deframer.take_discards().len() as u32;
            let mut frames = std::mem::take(&mut self.frames);
            while let Some(frame) = frames.pop() {
                self.handle_frame(&frame, now_ms);
            }
            self.frames = frames;
            self.resampled = resampled;
        }
        self.pcm = pcm;

        if now_ms - self.last_status_ms >= 1_000 {
            self.last_status_ms = now_ms;
            self.results.push(json!({
                "kind": "status",
                "frames": self.frames_ok,
                "badFcs": self.bad_fcs,
                "nonAx25": self.non_ax25,
                "level": self.modem.magnitude(),
                "baud": baud_setting(&self.cfg),
            }));
        }
    }

    fn handle_frame(&mut self, frame: &[u8], now_ms: i64) {
        let packet = match Packet::parse(frame, None) {
            Ok(packet) => packet,
            Err(_) => {
                self.non_ax25 += 1;
                return;
            }
        };

        let from = packet.src().call().to_string();
        let to = packet.dst().call().to_string();
        let via: Vec<String> = packet
            .digipeaters()
            .iter()
            .map(|a| a.call().to_string())
            .collect();
        let (kind, pid, payload) = packet_parts(&packet);
        let text = payload_text(pid, &payload);
        let summary = format!("{from} → {to}  {kind}  {text}");
        let raw = hex::encode(&frame[..frame.len().min(MAX_FRAME_HEX)]);

        self.frames_ok += 1;
        self.results.push(json!({
            "kind": "packet",
            "id": self.cfg.id,
            "mode": self.cfg.mode,
            "text": summary,
            "rfHz": self.cfg.frequency_hz as f64,
            "audioHz": 0.0,
            "snrDb": 0.0,
            "dtSec": 0.0,
            "period": 0,
            "packet": {
                "at": now_ms / 1000,
                "from": from,
                "to": to,
                "via": via,
                "type": kind,
                "pid": pid,
                "payload": text,
                "raw": raw,
                "length": frame.len(),
            },
        }));
    }
}

fn baud_setting(cfg: &DecoderConfig) -> u32 {
    let value = cfg
        .settings
        .get("baud")
        .or_else(|| cfg.settings.get("speed"));
    match value {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(1200) as u32,
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(1200),
        _ => 1200,
    }
}

fn packet_parts(packet: &Packet) -> (&'static str, u8, Vec<u8>) {
    match packet.packet_type() {
        PacketType::Ui(ui) => ("UI", ui.pid, ui.payload.clone()),
        PacketType::Iframe(f) => ("I", f.pid, f.payload.clone()),
        PacketType::Sabm(_) => ("SABM", 0, Vec::new()),
        PacketType::Sabme(_) => ("SABME", 0, Vec::new()),
        PacketType::Ua(_) => ("UA", 0, Vec::new()),
        PacketType::Dm(_) => ("DM", 0, Vec::new()),
        PacketType::Disc(_) => ("DISC", 0, Vec::new()),
        PacketType::Rr(_) => ("RR", 0, Vec::new()),
        PacketType::Rnr(_) => ("RNR", 0, Vec::new()),
        PacketType::Rej(_) => ("REJ", 0, Vec::new()),
        PacketType::Srej(_) => ("SREJ", 0, Vec::new()),
        PacketType::Frmr(_) => ("FRMR", 0, Vec::new()),
        PacketType::Xid(_) => ("XID", 0, Vec::new()),
        PacketType::Test(t) => ("TEST", 0, t.payload.clone()),
    }
}

fn payload_text(pid: u8, payload: &[u8]) -> String {
    if payload.is_empty() {
        return String::new();
    }
    if pid == PID_NO_L3
        && payload
            .iter()
            .all(|b| *b == b'\r' || *b == b'\n' || *b == b'\t' || (0x20..=0x7e).contains(b))
    {
        String::from_utf8_lossy(payload).trim_end().to_string()
    } else {
        hex::encode(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(baud: u32) -> DecoderConfig {
        let mut cfg = DecoderConfig {
            id: "packet-test".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "packet".into(),
            frequency_hz: 145_010_000,
            bandwidth_hz: 12_500,
            ..DecoderConfig::default()
        };
        cfg.settings.insert("baud".into(), serde_json::json!(baud));
        cfg
    }

    #[test]
    fn builds_1200_and_9600_channels_inside_the_span() {
        let c = PacketChannel::new(&config(1200), 145_000_000.0, 2_400_000).expect("1200");
        assert_eq!(baud_setting(&c.cfg), 1200);
        let c = PacketChannel::new(&config(9600), 145_000_000.0, 2_400_000).expect("9600");
        assert_eq!(baud_setting(&c.cfg), 9600);
    }

    #[test]
    fn rejects_a_frequency_outside_the_span() {
        assert!(PacketChannel::new(&config(1200), 100_000_000.0, 2_400_000).is_err());
    }

    #[test]
    fn formats_text_and_binary_payloads() {
        assert_eq!(payload_text(PID_NO_L3, b"hello\r"), "hello");
        assert_eq!(payload_text(0xcf, &[0x01, 0x02]), "0102");
    }
}
