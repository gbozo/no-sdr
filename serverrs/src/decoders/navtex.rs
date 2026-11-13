//! NAVTEX / SITOR-B — 518, 490 and 4209.5 kHz maritime safety broadcasts.
//!
//! Raw Cu8 IQ → channel extractor → USB demodulator → 12 kHz audio →
//! [`NavtexRx`] (CCIR 476, time-diversity FEC) → `ZCZC`/`NNNN` framing.
//!
//! The RF channel is normally tuned in USB with the audio tones around
//! 1700 Hz. The receiver's own AFC tolerates the usual dial arithmetic
//! differences between published NAVTEX tuning instructions.

use std::collections::VecDeque;

use num_complex::Complex32;
use serde_json::{json, Value};

use super::navtex_sitor::NavtexRx;
use super::LinearResampler;
use crate::config::DecoderConfig;
use crate::demod::{Demodulator, SsbDemod, SsbMode};
use crate::dsp::{IqExtractor, IqExtractorConfig};

const AUDIO_RATE: u32 = 12_000;
const CHANNEL_BANDWIDTH_HZ: i32 = 3_000;
const MESSAGE_CAP: usize = 64;
const TEXT_CAP: usize = 8_000;
const BODY_CAP: usize = 20_000;

#[derive(Debug, Clone)]
struct Message {
    station: char,
    kind: char,
    serial: u8,
    text: String,
    at: i64,
    complete: bool,
    lost: u32,
}

pub(crate) struct NavtexChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    demod: SsbDemod,
    resampler: LinearResampler,
    rx: NavtexRx,
    results: Vec<Value>,
    pcm: Vec<i16>,
    complex: Vec<Complex32>,
    resampled: Vec<f32>,
    pending: String,
    text: String,
    live: Option<Message>,
    messages: VecDeque<Message>,
    last_status_ms: i64,
}

impl NavtexChannel {
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
        .map_err(|e| format!("NAVTEX channel extractor: {e}"))?;
        // The extractor cuts at half the requested bandwidth. Keep the full
        // 0–3 kHz USB audio around the 1700 Hz NAVTEX centre.
        extractor.set_bandwidth(CHANNEL_BANDWIDTH_HZ * 2);

        let actual_rate = extractor.output_sample_rate() as f64;
        let mut demod = SsbDemod::new(SsbMode::Usb);
        demod
            .init(actual_rate)
            .map_err(|e| format!("NAVTEX USB demodulator: {e}"))?;
        demod.set_bandwidth(CHANNEL_BANDWIDTH_HZ as f64);

        let mut rx = NavtexRx::new(AUDIO_RATE as f64);
        if setting_bool(&cfg.settings, "reverse") {
            rx.set_reverse(true);
        }
        if let Some(v) = setting_bool_opt(&cfg.settings, "afc") {
            rx.set_afc(v);
        }

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            demod,
            resampler: LinearResampler::new(actual_rate, AUDIO_RATE as f64),
            rx,
            results: Vec::new(),
            pcm: Vec::new(),
            complex: Vec::new(),
            resampled: Vec::new(),
            pending: String::new(),
            text: String::new(),
            live: None,
            messages: VecDeque::new(),
            last_status_ms: 0,
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
            let text = self.rx.process(&resampled);
            if !text.is_empty() {
                self.pending.push_str(&text);
                self.frame(now_ms / 1000);
            }
            self.resampled = resampled;
        }
        self.pcm = pcm;

        if now_ms - self.last_status_ms >= 1_000 {
            self.last_status_ms = now_ms;
            let (direct, repaired, lost) = self.rx.counts();
            self.results.push(json!({
                "kind": "status",
                "inSync": self.rx.in_sync(),
                "level": self.rx.magnitude(),
                "reverse": self.rx.reverse(),
                "direct": direct,
                "repaired": repaired,
                "lost": lost,
                "messages": self.messages.len(),
                "live": self.live.as_ref().map(message_json),
            }));
        }
    }

    fn frame(&mut self, at: i64) {
        let taken = std::mem::take(&mut self.pending);
        for ch in taken.chars() {
            match self.live.as_mut() {
                None => {
                    self.text.push(ch);
                    if self.text.len() > TEXT_CAP {
                        let cut = self.text.len() - TEXT_CAP;
                        self.text.drain(..cut);
                    }
                    if self.text.ends_with("ZCZC") {
                        self.live = Some(Message {
                            station: '?',
                            kind: '?',
                            serial: 0,
                            text: String::new(),
                            at,
                            complete: false,
                            lost: 0,
                        });
                    }
                }
                Some(msg) => {
                    if ch == '*' {
                        msg.lost += 1;
                    }
                    msg.text.push(ch);
                    if msg.station == '?' {
                        let head: Vec<char> =
                            msg.text.chars().filter(|c| !c.is_whitespace()).collect();
                        if head.len() >= 4 {
                            msg.station = head[0];
                            msg.kind = head[1];
                            msg.serial = head[2..4]
                                .iter()
                                .collect::<String>()
                                .parse::<u8>()
                                .unwrap_or(0);
                            msg.text.clear();
                        }
                    }
                    if msg.text.ends_with("NNNN") {
                        msg.text.truncate(msg.text.len() - 4);
                        msg.complete = true;
                        self.close();
                    } else if msg.text.len() > BODY_CAP {
                        self.close();
                    }
                }
            }
        }
    }

    fn close(&mut self) {
        let Some(msg) = self.live.take() else { return };
        if msg.station == '?' {
            return;
        }
        let key = (msg.station, msg.kind, msg.serial);
        if let Some(idx) = self
            .messages
            .iter()
            .position(|m| (m.station, m.kind, m.serial) == key)
        {
            let held = &self.messages[idx];
            let better = (msg.complete && !held.complete)
                || (msg.complete == held.complete && msg.lost < held.lost);
            if better {
                let at = held.at;
                let mut updated = msg;
                updated.at = at;
                self.messages[idx] = updated.clone();
                self.push_message(updated);
            }
            return;
        }

        self.push_message(msg.clone());
        self.messages.push_back(msg);
        while self.messages.len() > MESSAGE_CAP {
            self.messages.pop_front();
        }
    }

    fn push_message(&mut self, msg: Message) {
        self.results.push(json!({
            "kind": "message",
            "id": self.cfg.id,
            "mode": self.cfg.mode,
            "text": format!(
                "{} {} {:02}  {}",
                msg.station,
                msg.kind,
                msg.serial,
                msg.text.lines().next().unwrap_or("")
            ),
            "rfHz": self.cfg.frequency_hz as f64,
            "audioHz": 1700.0,
            "snrDb": 0.0,
            "dtSec": 0.0,
            "period": 0,
            "navtex": message_json(&msg),
        }));
    }
}

fn message_json(msg: &Message) -> Value {
    json!({
        "at": msg.at,
        "station": msg.station.to_string(),
        "subject": msg.kind.to_string(),
        "serial": msg.serial,
        "text": msg.text,
        "complete": msg.complete,
        "lost": msg.lost,
    })
}

fn setting_bool(map: &serde_json::Map<String, Value>, key: &str) -> bool {
    setting_bool_opt(map, key).unwrap_or(false)
}

fn setting_bool_opt(map: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DecoderConfig {
        DecoderConfig {
            id: "navtex-518".into(),
            enabled: true,
            dongle_id: "d1".into(),
            mode: "navtex".into(),
            frequency_hz: 518_000,
            bandwidth_hz: 3_000,
            settings: serde_json::Map::new(),
        }
    }

    #[test]
    fn channel_builds_inside_span() {
        assert!(NavtexChannel::new(&cfg(), 518_000.0, 48_000).is_ok());
    }

    #[test]
    fn channel_rejects_outside_span() {
        assert!(NavtexChannel::new(&cfg(), 400_000.0, 48_000).is_err());
    }

    #[test]
    fn frames_a_complete_message() {
        let mut channel = NavtexChannel::new(&cfg(), 518_000.0, 48_000).unwrap();
        channel
            .pending
            .push_str("ZCZC AB12\r\nTEST WARNING\r\nNNNN");
        channel.frame(1_700_000_000);
        let event = channel
            .results
            .iter()
            .find(|v| v["kind"] == "message")
            .expect("message event");
        assert_eq!(event["navtex"]["station"], "A");
        assert_eq!(event["navtex"]["subject"], "B");
        assert_eq!(event["navtex"]["serial"], 12);
        assert_eq!(event["navtex"]["complete"], true);
        assert!(event["navtex"]["text"]
            .as_str()
            .unwrap()
            .contains("TEST WARNING"));
    }
}
