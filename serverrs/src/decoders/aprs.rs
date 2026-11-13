//! APRS — VHF AX.25 Bell 202, 1200 baud.
//!
//! APRS is an FM channel carrying ordinary AX.25 UI frames. The path is:
//! raw Cu8 IQ → `IqExtractor` → NBFM discriminator → 48 kHz audio →
//! Bell 202 AFSK → HDLC/AX.25 → `sdroxide-aprs` information-field parser.
//!
//! The decode is deliberately per-packet rather than a whole-station snapshot:
//! the UI is a traffic table with a map of the latest position, and the
//! information field is what an operator wants to read.

use std::collections::VecDeque;

use num_complex::Complex32;
use sdroxide_aprs::{AprsData, Position};
use sdroxide_ax25::{Deframer, Packet, PacketType};
use serde_json::{json, Map, Value};

use super::afsk::{AfskProfile, AfskRx};
use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, FmMonoDemod};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const AUDIO_RATE: u32 = 48_000;
const CHANNEL_BANDWIDTH_HZ: i32 = 12_500;
const MAX_RECENT: usize = 128;

pub(crate) struct AprsChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: FmMonoDemod,
    resampler: LinearResampler,
    afsk: AfskRx,
    deframer: Deframer,
    results: Vec<Value>,
    pcm: Vec<i16>,
    complex: Vec<Complex32>,
    resampled: Vec<f32>,
    bits: Vec<bool>,
    frames: Vec<Vec<u8>>,
    recent: VecDeque<(String, i64)>,
    last_status_ms: i64,
    frames_ok: u32,
    bad_fcs: u32,
    non_aprs: u32,
}

impl AprsChannel {
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
        .map_err(|e| format!("APRS channel extractor: {e}"))?;
        extractor.set_bandwidth(CHANNEL_BANDWIDTH_HZ);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = FmMonoDemod::new(0.0);
        demod
            .init(actual_rate)
            .map_err(|e| format!("APRS FM demodulator: {e}"))?;

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
            afsk: AfskRx::new(AUDIO_RATE as f64, AfskProfile::Vhf1200),
            deframer: Deframer::new(),
            results: Vec::new(),
            pcm: Vec::new(),
            complex: Vec::new(),
            resampled: Vec::new(),
            bits: Vec::new(),
            frames: Vec::new(),
            recent: VecDeque::new(),
            last_status_ms: 0,
            frames_ok: 0,
            bad_fcs: 0,
            non_aprs: 0,
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
            self.afsk.process(&resampled, &mut self.bits);
            self.frames.clear();
            for &bit in &self.bits {
                self.deframer.push_level(bit, &mut self.frames);
            }
            let discards = self.deframer.take_discards();
            self.bad_fcs += discards.len() as u32;
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
                "nonAprs": self.non_aprs,
                "level": self.afsk.magnitude(),
            }));
        }
    }

    fn handle_frame(&mut self, frame: &[u8], now_ms: i64) {
        let packet = match Packet::parse(frame, None) {
            Ok(packet) => packet,
            Err(_) => {
                self.non_aprs += 1;
                return;
            }
        };
        let PacketType::Ui(ui) = packet.packet_type() else {
            self.non_aprs += 1;
            return;
        };

        let from = packet.src().call().to_string();
        let to = packet.dst().call().to_string();
        let via: Vec<String> = packet
            .digipeaters()
            .iter()
            .map(|a| a.call().to_string())
            .collect();
        let raw = String::from_utf8_lossy(&ui.payload).to_string();
        let fingerprint = format!("{from}|{raw}");
        if self
            .recent
            .iter()
            .any(|(fp, at)| fp == &fingerprint && now_ms - at < 30_000)
        {
            return;
        }
        self.recent.push_back((fingerprint, now_ms));
        while self.recent.len() > MAX_RECENT {
            self.recent.pop_front();
        }

        let at = now_ms / 1000;
        match sdroxide_aprs::parse(&to, &ui.payload) {
            Ok(data) => {
                self.frames_ok += 1;
                let summary = summary(&from, &to, &data);
                let mut aprs = json!({
                    "at": at,
                    "from": from,
                    "to": to,
                    "via": via,
                    "kind": data.kind(),
                    "raw": raw,
                });
                enrich(&mut aprs, &data);
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
                    "aprs": aprs,
                }));
            }
            Err(e) => {
                self.frames_ok += 1;
                self.results.push(json!({
                    "kind": "packet",
                    "id": self.cfg.id,
                    "mode": self.cfg.mode,
                    "text": format!("{from} → {to}: {raw}"),
                    "rfHz": self.cfg.frequency_hz as f64,
                    "audioHz": 0.0,
                    "snrDb": 0.0,
                    "dtSec": 0.0,
                    "period": 0,
                    "aprs": {
                        "at": at,
                        "from": from,
                        "to": to,
                        "via": via,
                        "kind": "unparsed",
                        "raw": raw,
                        "error": e.to_string(),
                    },
                }));
            }
        }
    }
}

fn summary(from: &str, _to: &str, data: &AprsData) -> String {
    match data {
        AprsData::Position(p) => format!(
            "{from}  {:.5}, {:.5}{}",
            p.pos.lat,
            p.pos.lon,
            if p.comment.is_empty() {
                String::new()
            } else {
                format!("  {}", p.comment)
            }
        ),
        AprsData::Object { name, pos, .. } => format!(
            "{from}  object {name}  {:.5}, {:.5}",
            pos.pos.lat, pos.pos.lon
        ),
        AprsData::Item { name, pos, .. } => format!(
            "{from}  item {name}  {:.5}, {:.5}",
            pos.pos.lat, pos.pos.lon
        ),
        AprsData::Message(m) => format!("{from} → {}: {}", m.addressee, m.text),
        AprsData::Status(s) => format!("{from} status: {s}"),
        AprsData::Weather(_) => format!("{from} weather"),
        AprsData::Telemetry(_) => format!("{from} telemetry"),
        AprsData::Query(q) => format!("{from} query: {q}"),
        AprsData::Grid { grid, comment, .. } => format!("{from} grid {grid} {comment}")
            .trim_end()
            .to_string(),
    }
}

fn enrich(value: &mut Value, data: &AprsData) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if let Some(pos) = data.position() {
        add_position(object, pos);
    }
    match data {
        AprsData::Message(m) => {
            object.insert(
                "message".into(),
                json!({
                    "addressee": m.addressee,
                    "text": m.text,
                    "id": m.id,
                    "replyAck": m.reply_ack,
                    "messageKind": m.kind.label(),
                }),
            );
        }
        AprsData::Object { name, live, pos } => {
            object.insert("object".into(), json!({"name": name, "live": live}));
            add_position(object, pos);
        }
        AprsData::Item { name, live, pos } => {
            object.insert("item".into(), json!({"name": name, "live": live}));
            add_position(object, pos);
        }
        AprsData::Status(text) | AprsData::Query(text) => {
            object.insert("status".into(), json!(text));
        }
        AprsData::Weather(w) => {
            object.insert(
                "weather".into(),
                serde_json::to_value(w).unwrap_or(Value::Null),
            );
        }
        AprsData::Telemetry(t) => {
            object.insert(
                "telemetry".into(),
                json!({
                    "seq": t.seq,
                    "analog": t.analog,
                    "digital": t.digital,
                    "comment": t.comment,
                }),
            );
        }
        AprsData::Grid { grid, comment, .. } => {
            object.insert("grid".into(), json!(grid));
            object.insert("comment".into(), json!(comment));
        }
        AprsData::Position(_) => {}
    }
}

fn add_position(object: &mut Map<String, Value>, p: &Position) {
    object.insert("lat".into(), json!(p.pos.lat));
    object.insert("lon".into(), json!(p.pos.lon));
    object.insert("ambiguity".into(), json!(p.pos.ambiguity));
    object.insert("symbol".into(), json!(p.symbol.text()));
    object.insert("courseDeg".into(), json!(p.course_deg));
    object.insert("speedKn".into(), json!(p.speed_kn));
    object.insert("altitudeM".into(), json!(p.altitude_m));
    object.insert("comment".into(), json!(p.comment));
    if let Some(w) = p.weather {
        object.insert(
            "weather".into(),
            serde_json::to_value(w).unwrap_or(Value::Null),
        );
    }
    if let Some(ts) = p.timestamp {
        object.insert(
            "timestamp".into(),
            json!({
                "day": ts.day,
                "hour": ts.hour,
                "minute": ts.minute,
                "second": ts.second,
                "zulu": ts.zulu,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DecoderConfig {
        DecoderConfig {
            id: "aprs-14439".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "aprs".into(),
            frequency_hz: 144_390_000,
            bandwidth_hz: 12_500,
            settings: Default::default(),
        }
    }

    #[test]
    fn channel_builds_inside_the_span() {
        assert!(AprsChannel::new(&cfg(), 144_390_000.0, 2_400_000).is_ok());
    }

    #[test]
    fn channel_rejects_frequency_outside_the_span() {
        assert!(AprsChannel::new(&cfg(), 100_000_000.0, 2_400_000).is_err());
    }

    #[test]
    fn parses_a_position_information_field() {
        let data = sdroxide_aprs::parse("APRS", b"!4903.50N/07201.75W-Test position")
            .expect("parse APRS position");
        assert!(matches!(data, AprsData::Position(_)));
        assert!(data.position().is_some());
    }
}
