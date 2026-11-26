//! CW (Morse) decoder channel.
//!
//! The operator tunes the decoder to the carrier itself: the extractor pulls a
//! narrow channel around `frequencyHz`, the envelope detector measures the
//! keyed carrier, and [`CwRx`] turns the on/off timing into text. This is
//! deliberately a single-signal decoder; a wideband skimmer needs its own
//! channelizer and tracker and is not built from this channel.
//!
//! Timing follows the standard PARIS convention: a dot is 1.2/WPM seconds,
//! a dash is three dots, gaps inside a character are one dot, characters are
//! separated by three and words by seven. The dot length is learned from the
//! marks themselves so no speed setting is required, although `settings.wpm`
//! can seed the estimate for very slow or very fast stations.

use std::collections::VecDeque;
use std::f32::consts::TAU;

use num_complex::Complex32;
use serde_json::{json, Value};

use crate::config::DecoderConfig;
use crate::dsp::{IqExtractor, IqExtractorConfig};

/// Complex-channel rate after extraction. CW keying needs only a few tens of
/// Hz of envelope bandwidth, so 12 kHz leaves plenty of resolution.
const CW_AUDIO_RATE: u32 = 12_000;
/// Total IF bandwidth around the dial. This is wider than a 500 Hz operating
/// filter so a carrier a few hundred Hz off tune is still captured.
pub(crate) const CW_IF_BANDWIDTH_HZ: i32 = 800;
/// Envelope low-pass cutoff. Fast enough for 60 WPM dots, slow enough to keep
/// noise out of the keying decision.
const ENVELOPE_CUTOFF_HZ: f32 = 80.0;
/// Minimum peak-to-floor separation before the keying detector is armed.
const MIN_SNR_DB: f32 = 9.0;
/// Noise-floor and signal-peak tracking time constants.
///
/// The floor is a two-sided average, not a running minimum: with a wideband
/// noise envelope the occasional near-zero sample would otherwise drag a
/// minimum tracker down by tens of dB and make an idle channel look like a
/// 60 dB carrier. The floor follows downward faster than upward so a fresh
/// band settles quickly; the peak attacks in a few milliseconds and releases
/// slowly enough to hold through word gaps.
const FLOOR_FALL_TAU_SECONDS: f32 = 0.5;
const FLOOR_RISE_TAU_SECONDS: f32 = 3.0;
const PEAK_RISE_TAU_SECONDS: f32 = 0.005;
const PEAK_RELEASE_TAU_SECONDS: f32 = 1.0;
/// Reported keying SNR is capped: beyond this the exact number is meaningless
/// and only makes the status line look broken on a quiet channel.
const MAX_REPORTED_SNR_DB: f32 = 60.0;
/// Ignore marks shorter than this: key clicks and noise spikes.
const MIN_MARK_SECONDS: f32 = 0.004;
/// Auto-speed search range. PARIS dot = 1.2/WPM.
const DEFAULT_WPM: f32 = 20.0;
const MIN_WPM: f32 = 5.0;
const MAX_WPM: f32 = 60.0;
/// Initial calibration window. Key decisions are suppressed while the floor
/// and peak settle; otherwise the first noise burst after tuning looks like a
/// long dash and poisons the speed history.
const WARMUP_SECONDS: f32 = 0.5;

pub(crate) struct CwChannel {
    pub(crate) cfg: DecoderConfig,
    extractor: IqExtractor,
    rx: CwRx,
    results: Vec<Value>,
    pcm: Vec<i16>,
    envelope: Vec<f32>,
    level: f32,
    last_status_ms: i64,
}

impl CwChannel {
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
            output_sample_rate: CW_AUDIO_RATE as i32,
            tune_offset: offset as i32,
            dc_offset_removal: true,
        })
        .map_err(|e| format!("CW channel extractor: {e}"))?;
        extractor.set_bandwidth(CW_IF_BANDWIDTH_HZ);

        let actual_rate = extractor.output_sample_rate() as f64;
        let initial_wpm = cfg
            .settings
            .get("wpm")
            .and_then(Value::as_f64)
            .map(|v| v as f32)
            .unwrap_or(DEFAULT_WPM);

        Ok(Self {
            cfg: cfg.clone(),
            extractor,
            rx: CwRx::new(actual_rate, initial_wpm),
            results: Vec::new(),
            pcm: Vec::new(),
            envelope: Vec::new(),
            level: -120.0,
            last_status_ms: 0,
        })
    }

    pub(crate) fn take_results(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.results)
    }

    pub(crate) fn process_chunk(&mut self, chunk: &[u8], now_ms: i64) {
        let mut pcm = std::mem::take(&mut self.pcm);
        self.extractor.process_into(chunk, &mut pcm);
        if pcm.is_empty() {
            self.pcm = pcm;
            return;
        }

        self.envelope.clear();
        self.envelope.reserve(pcm.len() / 2);
        for pair in pcm.chunks_exact(2) {
            let sample = Complex32::new(pair[0] as f32 / 32768.0, pair[1] as f32 / 32768.0);
            self.envelope.push(sample.norm());
        }

        let text = self.rx.process(&self.envelope);
        self.level = self.rx.level_db();
        self.pcm = pcm;

        if !text.is_empty() {
            self.results.push(json!({
                "kind": "text",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "text": text,
                "rfHz": self.cfg.frequency_hz as f64,
                "audioHz": 0.0,
                "level": self.level,
                "signalBwHz": 100.0,
                "at": now_ms / 1000,
            }));
        }

        if now_ms.saturating_sub(self.last_status_ms) >= 500 {
            self.last_status_ms = now_ms;
            self.results.push(json!({
                "kind": "status",
                "id": self.cfg.id,
                "mode": self.cfg.mode,
                "level": self.level,
                "audioHz": 0.0,
                "listening": true,
                "wpm": self.rx.wpm(),
                "snrDb": self.rx.snr_db(),
            }));
        }
    }
}

/// Streaming Morse receiver over a real envelope signal.
///
/// The detector has two jobs: decide when the carrier is keyed, and turn the
/// resulting mark/gap durations into dots, dashes and spaces. Both are adaptive
/// — the noise floor and signal peak are tracked continuously, and the dot
/// length is learned from the marks — because CW operators send at wildly
/// different speeds and the band is rarely quiet.
pub(crate) struct CwRx {
    sample_rate: f32,
    /// One-pole envelope smoothing coefficient.
    envelope_alpha: f32,
    envelope: f32,
    initialised: bool,
    floor_alpha_down: f32,
    floor_alpha_up: f32,
    peak_alpha_up: f32,
    peak_alpha_down: f32,
    noise_floor_db: f32,
    signal_peak_db: f32,
    level_db: f32,
    snr_db: f32,

    keyed: bool,
    mark_start: i64,
    gap_start: i64,
    gap_active: bool,
    /// True once the current gap has emitted its character/space, so a long
    /// pause cannot repeat them.
    char_done: bool,
    word_done: bool,

    sample: i64,
    warmup_samples: i64,
    warmup_alpha: f32,
    dot_samples: f32,
    /// Recent mark durations. Morse is decoded after the character gap, so the
    /// speed can be estimated from the whole character instead of trusting the
    /// initial 20 WPM guess on its first (possibly dash-length) mark.
    mark_history: VecDeque<f32>,
    /// Mark durations in the character currently being assembled.
    symbol_marks: Vec<f32>,

    /// A space is only emitted after a character in this or a previous chunk.
    chars_since_space: u32,
    /// Sample index of the last emitted character, used to stop the status
    /// line from reporting a bogus speed on an idle channel.
    last_text_sample: i64,
}

impl CwRx {
    pub(crate) fn new(sample_rate: f64, initial_wpm: f32) -> Self {
        let sample_rate = sample_rate.max(1.0) as f32;
        let wpm = initial_wpm.clamp(MIN_WPM, MAX_WPM);
        let dot_samples = (1.2 / wpm * sample_rate).clamp(
            seconds_to_samples(MIN_MARK_SECONDS, sample_rate),
            seconds_to_samples(1.2 / MIN_WPM, sample_rate),
        );
        Self {
            sample_rate,
            envelope_alpha: 1.0 - (-TAU * ENVELOPE_CUTOFF_HZ / sample_rate).exp(),
            envelope: 0.0,
            initialised: false,
            floor_alpha_down: 1.0 - (-1.0 / (FLOOR_FALL_TAU_SECONDS * sample_rate)).exp(),
            floor_alpha_up: 1.0 - (-1.0 / (FLOOR_RISE_TAU_SECONDS * sample_rate)).exp(),
            peak_alpha_up: 1.0 - (-1.0 / (PEAK_RISE_TAU_SECONDS * sample_rate)).exp(),
            peak_alpha_down: 1.0 - (-1.0 / (PEAK_RELEASE_TAU_SECONDS * sample_rate)).exp(),
            noise_floor_db: -120.0,
            signal_peak_db: -120.0,
            level_db: -120.0,
            snr_db: 0.0,
            keyed: false,
            mark_start: 0,
            gap_start: 0,
            gap_active: false,
            char_done: false,
            word_done: false,
            sample: 0,
            warmup_samples: (WARMUP_SECONDS * sample_rate) as i64,
            warmup_alpha: 1.0 - (-1.0 / (0.15 * sample_rate)).exp(),
            dot_samples,
            mark_history: VecDeque::with_capacity(32),
            symbol_marks: Vec::with_capacity(16),
            chars_since_space: 0,
            last_text_sample: 0,
        }
    }

    /// Feed a block of envelope samples and return any newly decoded text.
    pub(crate) fn process(&mut self, envelope: &[f32]) -> String {
        let mut text = String::new();
        for &sample in envelope {
            self.step(sample, &mut text);
        }
        text
    }

    pub(crate) fn level_db(&self) -> f32 {
        self.level_db
    }

    pub(crate) fn snr_db(&self) -> f32 {
        self.snr_db
    }

    pub(crate) fn wpm(&self) -> f32 {
        // A speed estimate only means something while text is being decoded.
        // Noise transitions can otherwise drag the estimate to the clamp and
        // the status line reports 60 WPM on an empty channel.
        if self.dot_samples <= 0.0
            || (self.sample - self.last_text_sample) as f32 > 3.0 * self.sample_rate
        {
            0.0
        } else {
            1.2 * self.sample_rate / self.dot_samples
        }
    }

    fn step(&mut self, magnitude: f32, text: &mut String) {
        let now = self.sample;
        self.sample += 1;

        // Seed the smoother with the first real sample; starting from zero
        // would make a strong carrier look like a 100 dB transient and hold
        // the peak tracker up for seconds.
        if self.initialised {
            self.envelope += self.envelope_alpha * (magnitude.max(0.0) - self.envelope);
        } else {
            self.envelope = magnitude.max(0.0);
        }
        let db = 20.0 * (self.envelope.max(1e-9)).log10();
        self.level_db = db;

        if !self.initialised {
            self.initialised = true;
            self.noise_floor_db = db;
            self.signal_peak_db = db;
        } else {
            // Both trackers are two-sided averages with asymmetric time
            // constants. A running minimum for the floor is unusable here:
            // one near-zero noise sample would drag it down and inflate the
            // reported SNR by tens of dB.
            if db < self.noise_floor_db {
                self.noise_floor_db += self.floor_alpha_down * (db - self.noise_floor_db);
            } else {
                self.noise_floor_db += self.floor_alpha_up * (db - self.noise_floor_db);
            }
            if db > self.signal_peak_db {
                self.signal_peak_db += self.peak_alpha_up * (db - self.signal_peak_db);
            } else {
                self.signal_peak_db += self.peak_alpha_down * (db - self.signal_peak_db);
            }
            if self.sample < self.warmup_samples {
                // Settle the floor quickly while no key decisions are made.
                self.noise_floor_db += self.warmup_alpha * (db - self.noise_floor_db);
            }
        }
        if self.sample == self.warmup_samples {
            // Drop any startup noise peak; from here the peak tracks the
            // current signal or noise level.
            self.signal_peak_db = db;
        }

        let snr = (self.signal_peak_db - self.noise_floor_db).max(0.0);
        self.snr_db = snr.min(MAX_REPORTED_SNR_DB);
        if self.sample < self.warmup_samples {
            return;
        }
        let armed = snr >= MIN_SNR_DB;
        // Slice near the halfway point of the keyed envelope in *linear*
        // amplitude. A low threshold shifts the rising edge later and the
        // falling edge earlier, stretching every mark and shortening every
        // gap; the 50% crossings are where a symmetric envelope filter
        // preserves the original timing. The 10% window is the hysteresis.
        let floor_lin = 10.0_f32.powf(self.noise_floor_db * 0.05);
        let peak_lin = 10.0_f32.powf(self.signal_peak_db * 0.05);
        let span = (peak_lin - floor_lin).max(0.0);
        let on_threshold = floor_lin + 0.55 * span;
        let off_threshold = floor_lin + 0.45 * span;

        if !armed {
            // Do not decode noise. Drop any partial character; the speed
            // estimate is kept so a signal returning at the same speed
            // resumes cleanly.
            self.keyed = false;
            self.gap_active = false;
            self.symbol_marks.clear();
            self.char_done = true;
            self.word_done = true;
            return;
        }

        if !self.keyed {
            // Resolve the preceding gap before a new mark starts. At high
            // speed the next character can begin before the previous one was
            // flushed sample-by-sample; using the mark history here means the
            // gap is judged against the speed just learned from that
            // character, not the initial 20 WPM guess.
            if self.gap_active {
                let gap = (now - self.gap_start) as f32;
                if !self.char_done && gap > 2.0 * self.dot_samples {
                    self.flush_character(text);
                    self.char_done = true;
                }
                if self.char_done && !self.word_done && gap > 5.0 * self.dot_samples {
                    self.flush_space(text);
                    self.word_done = true;
                }
            }

            if self.envelope >= on_threshold {
                self.keyed = true;
                self.mark_start = now;
                self.gap_active = false;
                self.char_done = false;
                self.word_done = false;
            }
            return;
        }

        if self.envelope <= off_threshold {
            // Key up: classify the completed mark and start the gap clock.
            self.keyed = false;
            self.gap_start = now;
            self.gap_active = true;
            let mark = (now - self.mark_start) as f32;
            self.push_mark(mark);
        }
    }

    fn push_mark(&mut self, mark: f32) {
        let min_mark = seconds_to_samples(MIN_MARK_SECONDS, self.sample_rate);
        if mark < min_mark {
            return;
        }

        self.symbol_marks.push(mark);
        self.mark_history.push_back(mark);
        if self.mark_history.len() > 32 {
            self.mark_history.pop_front();
        }
        self.update_dot();
    }

    /// Estimate the dot length from recent marks.
    ///
    /// Sorting the last few durations and splitting at the largest ratio
    /// separates the dot cluster from the dash cluster without caring which
    /// symbol came first. A single cluster is left alone (it might be all
    /// dashes), except when every mark is much faster than the current guess.
    fn update_dot(&mut self) {
        let mut durations: Vec<f32> = self.mark_history.iter().copied().collect();
        if durations.is_empty() {
            return;
        }
        durations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let min_dot = seconds_to_samples(1.2 / MAX_WPM, self.sample_rate);
        let max_dot = seconds_to_samples(1.2 / MIN_WPM, self.sample_rate);

        if durations.len() == 1 {
            let only = durations[0];
            if only < 0.5 * self.dot_samples {
                self.dot_samples = only.clamp(min_dot, max_dot);
            } else if only > 2.5 * self.dot_samples {
                // A lone very long mark is almost certainly a dash at a
                // slower speed; three dots is a better starting point.
                self.dot_samples = (only / 3.0).clamp(min_dot, max_dot);
            }
            return;
        }

        let mut split = 0;
        let mut best_ratio = 1.0_f32;
        for index in 1..durations.len() {
            let ratio = durations[index] / durations[index - 1].max(1.0);
            if ratio > best_ratio {
                best_ratio = ratio;
                split = index;
            }
        }

        if best_ratio >= 1.8 && split > 0 {
            let lower = &durations[..split];
            let median = lower[lower.len() / 2];
            self.dot_samples = median.clamp(min_dot, max_dot);
        } else {
            let median = durations[durations.len() / 2];
            if median < 0.6 * self.dot_samples {
                self.dot_samples = median.clamp(min_dot, max_dot);
            }
        }
    }

    fn flush_character(&mut self, text: &mut String) {
        if self.symbol_marks.is_empty() {
            return;
        }

        let dot = self.dot_samples.max(1.0);
        let mut code = String::with_capacity(self.symbol_marks.len());
        for &mark in &self.symbol_marks {
            code.push(if mark / dot >= 1.9 { '-' } else { '.' });
        }
        if let Some(character) = morse_char(&code) {
            text.push(character);
            self.chars_since_space = self.chars_since_space.saturating_add(1);
            self.last_text_sample = self.sample;
        }
        self.symbol_marks.clear();
    }

    fn flush_space(&mut self, text: &mut String) {
        if self.chars_since_space > 0 {
            text.push(' ');
            self.chars_since_space = 0;
        }
    }
}

fn seconds_to_samples(seconds: f32, sample_rate: f32) -> f32 {
    (seconds * sample_rate).max(1.0)
}

/// ITU Morse code for the printable character set. Unknown sequences are
/// dropped rather than printed as `?`: on a noisy channel that would turn the
/// log into a stream of punctuation, and a missed character is less damaging
/// than a fabricated one.
fn morse_char(code: &str) -> Option<char> {
    Some(match code {
        ".-" => 'A',
        "-..." => 'B',
        "-.-." => 'C',
        "-.." => 'D',
        "." => 'E',
        "..-." => 'F',
        "--." => 'G',
        "...." => 'H',
        ".." => 'I',
        ".---" => 'J',
        "-.-" => 'K',
        ".-.." => 'L',
        "--" => 'M',
        "-." => 'N',
        "---" => 'O',
        ".--." => 'P',
        "--.-" => 'Q',
        ".-." => 'R',
        "..." => 'S',
        "-" => 'T',
        "..-" => 'U',
        "...-" => 'V',
        ".--" => 'W',
        "-..-" => 'X',
        "-.--" => 'Y',
        "--.." => 'Z',
        "-----" => '0',
        ".----" => '1',
        "..---" => '2',
        "...--" => '3',
        "....-" => '4',
        "....." => '5',
        "-...." => '6',
        "--..." => '7',
        "---.." => '8',
        "----." => '9',
        ".-.-.-" => '.',
        "--..--" => ',',
        "..--.." => '?',
        ".----." => '\'',
        "-.-.--" => '!',
        "-..-." => '/',
        "-.--." => '(',
        "-.--.-" => ')',
        ".-..." => '&',
        "---..." => ':',
        "-.-.-." => ';',
        "-...-" => '=',
        ".-.-." => '+',
        "-....-" => '-',
        "..--.-" => '_',
        ".-..-." => '"',
        "...-..-" => '$',
        ".--.-." => '@',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f32 = 12_000.0;

    fn encode(text: &str) -> Vec<&'static str> {
        text.chars()
            .filter_map(|character| {
                let upper = character.to_ascii_uppercase();
                MORSE
                    .iter()
                    .find(|(c, _)| *c == upper)
                    .map(|(_, code)| *code)
            })
            .collect()
    }

    /// ITU table in the direction needed by the test generator.
    const MORSE: &[(char, &str)] = &[
        ('A', ".-"),
        ('B', "-..."),
        ('C', "-.-."),
        ('D', "-.."),
        ('E', "."),
        ('F', "..-."),
        ('G', "--."),
        ('H', "...."),
        ('I', ".."),
        ('J', ".---"),
        ('K', "-.-"),
        ('L', ".-.."),
        ('M', "--"),
        ('N', "-."),
        ('O', "---"),
        ('P', ".--."),
        ('Q', "--.-"),
        ('R', ".-."),
        ('S', "..."),
        ('T', "-"),
        ('U', "..-"),
        ('V', "...-"),
        ('W', ".--"),
        ('X', "-..-"),
        ('Y', "-.--"),
        ('Z', "--.."),
        ('0', "-----"),
        ('1', ".----"),
        ('2', "..---"),
        ('3', "...--"),
        ('4', "....-"),
        ('5', "....."),
        ('6', "-...."),
        ('7', "--..."),
        ('8', "---.."),
        ('9', "----."),
    ];

    fn test_noise(seed: &mut u32) -> f32 {
        *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (*seed >> 8) as f32 / 16_777_216.0 - 0.5
    }

    /// Keyed envelope at a known speed. Additive noise approximates the
    /// magnitude noise left after the narrow IF and envelope filter.
    fn keyed_envelope(text: &str, wpm: f32, noise: f32) -> Vec<f32> {
        keyed_envelope_at(text, wpm, noise, FS)
    }

    fn keyed_envelope_at(text: &str, wpm: f32, noise: f32, sample_rate: f32) -> Vec<f32> {
        let dot = (1.2 / wpm * sample_rate).round().max(2.0) as usize;
        let mut samples = Vec::new();

        // A receiver is normally already running when a station starts. Give
        // the noise-floor/peak tracker half a second of silence so a burst
        // beginning exactly at sample zero does not hide behind the initial
        // SNR estimate.
        samples.extend(std::iter::repeat(0.0).take((sample_rate * 0.5) as usize));

        let push_gap = |samples: &mut Vec<f32>, units: usize| {
            samples.extend(std::iter::repeat(0.0).take(units * dot));
        };

        for (word_index, word) in text.split(' ').filter(|word| !word.is_empty()).enumerate() {
            if word_index > 0 {
                push_gap(&mut samples, 7);
            }
            let codes = encode(word);
            for (character_index, code) in codes.iter().enumerate() {
                for (symbol_index, symbol) in code.chars().enumerate() {
                    let units = if symbol == '-' { 3 } else { 1 };
                    samples.extend(std::iter::repeat(1.0).take(units * dot));
                    if symbol_index + 1 < code.chars().count() {
                        push_gap(&mut samples, 1);
                    }
                }
                if character_index + 1 < codes.len() {
                    push_gap(&mut samples, 3);
                }
            }
        }

        push_gap(&mut samples, 3);
        samples.extend(std::iter::repeat(0.0).take((sample_rate * 2.0) as usize));

        let mut seed = 0x1234_5678;
        for sample in &mut samples {
            *sample = (*sample + test_noise(&mut seed).abs() * 2.0 * noise).max(0.0);
        }
        samples
    }

    #[test]
    fn decodes_morse_at_several_speeds() {
        for wpm in [5.0_f32, 12.0, 20.0, 35.0, 55.0, 60.0] {
            let envelope = keyed_envelope("CQ TEST", wpm, 0.05);
            let mut rx = CwRx::new(FS as f64, DEFAULT_WPM);
            let text = rx.process(&envelope);
            if (wpm - 20.0).abs() < 0.1 {
                println!(
                    "20 text={text:?} dot={} marks={:?}",
                    rx.dot_samples, rx.mark_history
                );
            }
            assert!(
                text.contains("CQ") && text.contains("TEST"),
                "{wpm} WPM decoded {text:?}"
            );
        }
    }

    #[test]
    fn learns_a_speed_far_from_the_default() {
        let envelope = keyed_envelope("PARIS", 55.0, 0.03);
        let mut rx = CwRx::new(FS as f64, DEFAULT_WPM);
        let text = rx.process(&envelope);
        assert!(text.contains("PARIS"), "decoded {text:?}");
        assert!((rx.wpm() - 55.0).abs() < 8.0, "estimated {} WPM", rx.wpm());
    }

    #[test]
    fn empty_channel_stays_silent() {
        let mut seed = 0xdead_beef;
        let noise: Vec<f32> = (0..(FS * 5.0) as usize)
            .map(|_| test_noise(&mut seed).abs() * 0.1)
            .collect();
        let mut rx = CwRx::new(FS as f64, DEFAULT_WPM);
        let text = rx.process(&noise);
        assert!(text.chars().count() < 4, "noise decoded as {text:?}");
    }

    #[test]
    fn builds_through_the_decoder_dispatch() {
        let cfg = DecoderConfig {
            id: "cw-test".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "cw".to_string(),
            frequency_hz: 7_030_000,
            bandwidth_hz: 500,
            retention_days: 0,
            settings: Default::default(),
        };
        assert!(crate::decoders::supported_mode("cw"));
        let channel =
            crate::decoders::build_channel(&cfg, 7_000_000.0, 2_400_000).expect("CW channel");
        assert!(matches!(channel, crate::decoders::Channel::Cw(_)));

        let window = crate::decoders::window_spec("cw", 7_030_000.0, 7_000_000.0, 2_400_000);
        assert_eq!(window.window_kind, "cw");
        assert_eq!(window.window.center_hz(), 7_030_000.0);
        assert_eq!(window.expected_audio_hz, 0.0);
        assert!(!window.scope);
    }

    #[test]
    fn channel_decodes_keyed_iq() {
        let sample_rate = 48_000.0_f32;
        let envelope = keyed_envelope_at("CQ TEST", 20.0, 0.0, sample_rate);
        let mut raw = Vec::with_capacity(envelope.len() * 4);
        for (index, amplitude) in envelope.iter().enumerate() {
            let phase = std::f32::consts::TAU * 250.0 * index as f32 / sample_rate;
            // The extractor consumes the device's uint8 IQ stream (127.5 is
            // zero), not signed 16-bit audio.
            let i = (127.5 + amplitude * phase.cos() * 0.6 * 127.5).round() as u8;
            let q = (127.5 + amplitude * phase.sin() * 0.6 * 127.5).round() as u8;
            raw.push(i);
            raw.push(q);
        }

        let cfg = DecoderConfig {
            id: "cw-iq".to_string(),
            enabled: true,
            dongle_id: "d1".to_string(),
            mode: "cw".to_string(),
            frequency_hz: 7_000_250,
            bandwidth_hz: 500,
            retention_days: 0,
            settings: Default::default(),
        };
        let mut channel =
            CwChannel::new(&cfg, 7_000_000.0, sample_rate as u32).expect("CW channel");
        let mut now_ms = 0;
        for chunk in raw.chunks(4_800) {
            channel.process_chunk(chunk, now_ms);
            now_ms += 100;
        }
        let text: String = channel
            .take_results()
            .iter()
            .filter(|event| event["kind"] == "text")
            .filter_map(|event| event["text"].as_str())
            .collect();
        assert!(
            text.contains("CQ") && text.contains("TEST"),
            "channel decoded {text:?}"
        );
    }

    #[test]
    fn character_table_is_complete() {
        for (character, code) in MORSE {
            assert_eq!(morse_char(code), Some(*character), "code {code}");
        }
        assert_eq!(morse_char("......."), None);
    }
}
