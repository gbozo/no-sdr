//! ACARS — the VHF aircraft datalink, around 130 MHz (issue #436).
//!
//! An AM carrier in the airband carries a 2400-baud MSK signal centred on
//! 1800 Hz (tones 1200/2400 Hz), character-oriented: 7-bit ASCII,
//! least-significant bit first, plus odd parity. A frame is a pre-key of ones,
//! the bit- and character-sync pattern, `SOH`, a header (mode, address,
//! acknowledgement, label, block id), `STX`, up to 220 characters of text,
//! `ETX`/`ETB`, a 16-bit block check sequence and `DEL`.
//!
//! This file is in two layers so the testable part is the one that matters:
//! [`parse_frame`] turns the demodulated bit stream into a message and needs no
//! radio at all, and [`AcarsRx`] turns the demodulated audio into that bit
//! stream.
//!
//! The demodulator follows acarsdec's `msk.c`: a half-sine matched filter, a
//! bit clock, and a loop that tracks the carrier. The fixed-grid integrator
//! it started as only worked on this decoder's own encoder — real audio is not
//! symbol-aligned to the first sample and its carrier is not exactly 1800 Hz,
//! so both have to be recovered. It is checked against an off-air recording of
//! acarsdec's, not only its own encoder.
//!
//! Ported from [acarsdec] — the demodulator from `msk.c`, the block check and
//! the frame layout from `acars.c` (Thierry Leconte, Copyright (c) 2015–2017,
//! GNU Library General Public License version 2). That licence lets a work
//! built on it be distributed under the ordinary GPL, version 2 or later,
//! instead (section 3); this file is, as part of a GPL-3.0-or-later program.
//!
//! [acarsdec]: https://github.com/TLeconte/acarsdec

use num_complex::Complex32;

/// ACARS' audio centre.
pub const CENTER_HZ: f64 = 1800.0;
/// Baud rate.
#[allow(dead_code)]
pub const BAUD: f64 = 2400.0;

/// One decoded ACARS message.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AcarsFrame {
    /// The mode character, as text.
    pub mode: String,
    /// The aircraft address, its padding dots and spaces trimmed.
    pub address: String,
    /// The technical acknowledgement character.
    pub ack: String,
    /// The 2-character label.
    pub label: String,
    /// The block identifier.
    pub block_id: String,
    /// The message text.
    pub text: String,
    /// Whether the block-check sequence matched.
    pub crc_ok: bool,
}

/// What the decoder produces.
#[derive(Debug, Clone, PartialEq)]
pub enum AcarsEvent {
    Message(AcarsFrame),
}

/// Odd parity over the low seven bits, compared with bit 7.
fn parity_ok(b: u8) -> bool {
    (b.count_ones() & 1) == 1
}

/// The ACARS block-check sequence: CRC-16/reflected with polynomial 0x8408 and
/// initial value 0, over the bytes **as received, parity bits included**, from
/// the mode character through `ETX`/`ETB`. The transmitted BCS is this value
/// with its low byte first.
///
/// Not CCITT-FALSE. acarsdec — the reference decoder, and the source of the
/// off-air fixture this is checked against — builds the check this way, and a
/// real frame's bytes verify to zero under it. The VDL2 parser's Kermit CRC is
/// the same reflected polynomial; the difference here is the initial value and
/// that ACARS carries the parity bits into the sum.
fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= u16::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0x8408
            } else {
                crc >> 1
            };
        }
    }
    crc
}

/// Assemble bytes from a bit slice, least-significant bit first, eight bits
/// each — every bit inverted when `invert` is set.
fn bytes_lsb_first(bits: &[u8], invert: bool) -> Vec<u8> {
    let flip = u8::from(invert);
    bits.chunks(8)
        .filter(|c| c.len() == 8)
        .map(|c| {
            c.iter()
                .enumerate()
                .fold(0u8, |b, (i, &v)| b | (((v ^ flip) & 1) << i))
        })
        .collect()
}

/// Parse a demodulated bit stream into a message, hunting for the start of
/// the frame.
///
/// Returns a frame whose block check matches if the stream holds one, and
/// otherwise the first heading that framed at all, with `crc_ok` false. `None`
/// when nothing frames — the parse is what rejects noise, so a false positive
/// costs a check rather than a phantom message.
#[allow(dead_code)]
pub fn parse_frame(bits: &[u8]) -> Option<AcarsFrame> {
    find_frame(bits).map(|(msg, _)| msg)
}

/// [`parse_frame`], with the bit offset of the frame's `SOH` in `bits`.
///
/// Both polarities are tried. The carrier loop settles with either sign — an
/// MSK phase detector cannot tell the two apart — and a burst demodulated
/// upside down is every bit inverted. acarsdec reads the sign off an inverted
/// SYN and flips its demodulator; reading the window both ways and keeping
/// the block check that matches comes to the same thing. Without it, half the
/// bursts in acarsdec's own recording never framed.
///
/// A heading whose block check matches wins over any that does not, wherever
/// either sits: a coincidental heading read the wrong way up must not hide
/// the real frame read the right way.
fn find_frame(bits: &[u8]) -> Option<(AcarsFrame, usize)> {
    let mut failed = None;
    for invert in [false, true] {
        for shift in 0..8 {
            let Some(aligned) = bits.get(shift..) else {
                break;
            };
            let bytes = bytes_lsb_first(aligned, invert);
            for (i, &b) in bytes.iter().enumerate() {
                // SOH, with odd parity, marks the header.
                if b & 0x7f != 0x01 || !parity_ok(b) {
                    continue;
                }
                if let Some(msg) = parse_from(&bytes[i + 1..]) {
                    let at = shift + 8 * i;
                    if msg.crc_ok {
                        return Some((msg, at));
                    }
                    failed.get_or_insert((msg, at));
                }
            }
        }
    }
    failed
}

/// A received character as text: the parity bit stripped, and anything that is
/// not printable — bar the line breaks and tab a message is laid out with —
/// shown as `·`, so a decode error cannot put a control sequence on somebody's
/// screen. The same rule as the VDL2 parser's.
fn printable(b: u8) -> char {
    match b & 0x7f {
        c @ (b'\r' | b'\n' | b'\t' | 0x20..=0x7e) => c as char,
        _ => '·',
    }
}

/// Parse the header and text that follow `SOH`.
fn parse_from(rest: &[u8]) -> Option<AcarsFrame> {
    // mode(1) address(7) ack(1) label(2) block_id(1) STX-or-ETX(1)
    if rest.len() < 13 {
        return None;
    }
    let ch = printable;
    let ck = |b: u8| -> Option<()> { parity_ok(b).then_some(()) };
    ck(rest[0])?;
    let mode = ch(rest[0]).to_string();
    let mut address = String::new();
    for &b in &rest[1..8] {
        ck(b)?;
        address.push(ch(b));
    }
    ck(rest[8])?;
    // A negative acknowledgement is the NAK control character, written out.
    let ack = match rest[8] & 0x7f {
        0x15 => "NAK".to_string(),
        c => ch(c).to_string(),
    };
    ck(rest[9])?;
    ck(rest[10])?;
    // `_` and DEL is the general-response label, written `_d` by convention.
    let label: String = match (rest[9] & 0x7f, rest[10] & 0x7f) {
        (b'_', 0x7f) => "_d".to_string(),
        (a, b) => [ch(a), ch(b)].iter().collect(),
    };
    ck(rest[11])?;
    let block_id = ch(rest[11]).to_string();
    ck(rest[12])?;
    // STX when text follows, ETX when the block has none — an uplink's
    // acknowledgement or a `_d` general response is only the header. Requiring
    // STX dropped every one of those.
    let mut ended = match rest[12] & 0x7f {
        0x02 => false,
        0x03 => true,
        _ => return None,
    };

    // Text up to ETX/ETB, which carries parity like the rest.
    let mut text = String::new();
    let mut idx = 13;
    while !ended && idx < rest.len().min(13 + 220) {
        let b = rest[idx];
        ck(b)?;
        idx += 1;
        if b & 0x7f == 0x03 || b & 0x7f == 0x17 {
            ended = true;
            break;
        }
        text.push(ch(b));
    }
    if !ended {
        return None;
    }

    // The block check is two unparitied bytes, then DEL.
    if rest.len() < idx + 3 {
        return None;
    }
    // The check runs over the header and text exactly as received — parity and
    // all — from the mode character (the caller skipped SOH) through ETX, and
    // the transmitted BCS carries the low byte first.
    let bcs = u16::from_le_bytes([rest[idx], rest[idx + 1]]);
    let crc_ok = crc16(&rest[..idx]) == bcs;

    Some(AcarsFrame {
        mode,
        // Right-aligned in its seven characters, padded with dots.
        address: address.trim_matches(|c| c == '.' || c == ' ').to_string(),
        ack,
        label,
        block_id,
        text,
        crc_ok,
    })
}

/// The ACARS demodulator: real audio in, bits out.
///
/// Ported from acarsdec's `msk.c`: the mixer runs off a VCO whose phase is
/// corrected by a PI carrier loop, the symbol decision is a half-sine matched
/// filter read at the bit clock's fractional position, and the clock itself is
/// the VCO phase crossing 3π/2 — so it tracks a real signal's timing and
/// frequency rather than assuming both.
///
/// What comes out are the data bits themselves, as acarsdec's `putbit` takes
/// them: the alternating-arm MSK decision leaves no line code to undo. The
/// sign is the loop's to choose, which is why [`parse_frame`] reads both.
pub struct AcarsRx {
    /// Audio rate, for the VCO's centre-frequency step.
    rate: f32,
    /// Matched filter length in samples: one 1200 Hz half-cycle.
    bitlen: usize,
    /// Oversampling of the filter table.
    over: usize,
    /// Half-sine matched filter, `bitlen * over + 1` taps.
    mflt: Vec<f32>,
    /// The last `bitlen` mixed samples, newest overwriting oldest.
    inb: Vec<Complex32>,
    inb_idx: usize,
    /// VCO phase (the carrier) and the bit-clock accumulator.
    phi: f32,
    clk: f32,
    /// PI carrier loop: frequency and phase corrections.
    df: f32,
    dphi: f32,
    /// Symbols emitted: selects the I/Q arm and the two-symbol sign flip.
    symbols: u32,
    /// Bits since the last framing attempt, trimmed to a sane maximum.
    bits: Vec<u8>,
    /// Bits dropped off the front of `bits` since the start, so a position in
    /// the window can be named in the stream as a whole.
    consumed: u64,
    /// Where in the stream the last failed heading sat. The window steps past
    /// one a byte at a time, so the same heading is found again after every
    /// byte until it has gone; this is how it is counted once.
    last_bad: Option<u64>,
    /// Smoothed audio level, for the panel's meter.
    level: f32,
    /// Frames decoded with a good block check, and frames whose check failed.
    frames: u64,
    bad: u64,
}

impl AcarsRx {
    pub fn new(_rate: f64) -> Self {
        // acarsdec runs its demodulator at one fixed rate (12.5 kHz today) and
        // averages its input down to it. This implementation is fed exactly
        // 12 kHz by the channel extractor; the constants below are fixed rather
        // than re-derived per rate — re-derived, 48 kHz decoded nothing.
        let demod_rate = 12_000.0f64;
        let over = 240usize;
        let bitlen = (demod_rate / 1200.0).ceil().max(1.0) as usize;
        let mut mflt = vec![0.0f32; bitlen * over + 1];
        for (i, h) in mflt.iter_mut().enumerate() {
            *h = (std::f32::consts::PI * 1200.0 * i as f32 / demod_rate as f32 / over as f32).sin();
        }
        AcarsRx {
            rate: demod_rate as f32,
            bitlen,
            over,
            mflt,
            inb: vec![Complex32::default(); bitlen],
            inb_idx: 0,
            phi: 0.0,
            clk: 0.0,
            df: 0.0,
            dphi: 0.0,
            symbols: 0,
            bits: Vec::new(),
            consumed: 0,
            last_bad: None,
            level: 0.0,
            frames: 0,
            bad: 0,
        }
    }

    /// Smoothed audio level, 0-1-ish.
    pub fn level(&self) -> f32 {
        self.level
    }

    /// Frames decoded with a good block check.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Frames whose block check failed.
    pub fn bad(&self) -> u64 {
        self.bad
    }

    /// Consume audio, appending any messages found.
    pub fn process(&mut self, audio: &[f32], out: &mut Vec<AcarsEvent>) {
        let ms = audio.iter().map(|s| s * s).sum::<f32>() / audio.len().max(1) as f32;
        self.level += 0.3 * (ms.sqrt() - self.level);

        // The carrier loop's integral and proportional gains, applied once per
        // symbol. A PI loop, where current acarsdec uses a one-pole filter
        // (`PLLG`/`PLLC`); with these, every burst in acarsdec's recording
        // locks. The symbol rate is fixed, so they are per-symbol constants and
        // must not be scaled by the input rate — that made an engine-fed
        // 48 kHz signal far too slow to lock.
        let ki = 71e-7 / 10.0;
        let kp = 60e-3 / 10.0;
        let tau = std::f32::consts::TAU;
        let bit_clock = 1.5 * std::f32::consts::PI;

        let n = audio.len();

        for k in 0..n {
            let sample = audio[k];
            // VCO frequency: the 1800 Hz centre plus the loop's correction.
            let s = tau * CENTER_HZ as f32 / self.rate + self.dphi;

            self.clk += s;
            if self.clk > bit_clock {
                self.clk -= bit_clock;

                // The matched filter, read at the clock's fractional position.
                let mut o = (self.over as f32 * (self.clk / s)) as usize;
                if o > self.over {
                    o = self.over;
                }
                let mut v = Complex32::new(0.0, 0.0);
                for j in 0..self.bitlen {
                    let tap = self.mflt[o + j * self.over];
                    v += self.inb[(j + self.inb_idx) % self.bitlen] * tap;
                }
                // Normalise, so the decision is a sign and not a level.
                let v = v / (v.norm() + 1e-8);

                let (vo, dphi) = if self.symbols & 1 == 1 {
                    let vo = v.im;
                    (vo, if vo >= 0.0 { -v.re } else { v.re })
                } else {
                    let vo = v.re;
                    (vo, if vo >= 0.0 { v.im } else { -v.im })
                };
                let bit = if self.symbols & 2 != 0 { -vo } else { vo };
                self.push_bit(bit > 0.0, out);
                self.symbols = self.symbols.wrapping_add(1);

                // The PI controller: frequency integrates the error, phase is
                // its output plus a proportional term.
                self.df += ki * dphi;
                self.dphi = self.df + kp * dphi;
            }

            self.phi += s;
            if self.phi >= tau {
                self.phi -= tau;
            }
            // Mix down by the VCO, newest sample into the circular buffer.
            self.inb[self.inb_idx] = Complex32::from_polar(1.0, -self.phi) * sample;
            self.inb_idx = (self.inb_idx + 1) % self.bitlen;
        }
    }

    /// One demodulated bit: buffer it, and try to frame once a byte is in.
    ///
    /// A heading whose block check fails is counted once and stepped past, not
    /// thrown away with the rest of the buffer: on real audio there are several
    /// SOH-shaped coincidences per burst, and clearing on the first of them
    /// discards the real frame sitting behind it. Only a frame that checks out
    /// is emitted and clears the window.
    fn push_bit(&mut self, bit: bool, out: &mut Vec<AcarsEvent>) {
        if self.bits.len() < 8 * 512 {
            self.bits.push(u8::from(bit));
        }
        if self.bits.len() % 8 != 0 || self.bits.len() < 8 * 32 {
            return;
        }
        match find_frame(&self.bits) {
            Some((msg, _)) if msg.crc_ok => {
                self.frames += 1;
                out.push(AcarsEvent::Message(msg));
                self.drop_bits(self.bits.len());
            }
            Some((_, at)) => {
                let at = self.consumed + at as u64;
                if self.last_bad != Some(at) {
                    self.bad += 1;
                    self.last_bad = Some(at);
                }
                self.drop_bits(8);
            }
            None if self.bits.len() > 8 * 480 => self.drop_bits(8 * 40),
            None => {}
        }
    }

    /// Drop `n` bits off the front of the window.
    fn drop_bits(&mut self, n: usize) {
        self.bits.drain(..n);
        self.consumed += n as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a frame's data bits from a message, the way the demodulator hands
    /// them over: a pre-key of ones, sync, SOH, header, STX, text, ETX, BCS,
    /// DEL, each character 7 bits LSB-first plus odd parity.
    pub(super) fn encode(msg: &AcarsFrame) -> Vec<u8> {
        let mut bytes: Vec<u8> = Vec::new();
        let ch = |c: char| -> u8 {
            let d = (c as u8) & 0x7f;
            d | if (d.count_ones() & 1) == 0 { 0x80 } else { 0 }
        };
        // Bit sync and character sync, then SOH.
        for c in ['+', '*'] {
            bytes.push(ch(c));
        }
        for _ in 0..2 {
            bytes.push(0x16);
        }
        bytes.push(ch('\u{1}'));
        bytes.push(ch(msg.mode.chars().next().unwrap_or('2')));
        for c in msg.address.chars().take(7) {
            bytes.push(ch(c));
        }
        for _ in 0..(7 - msg.address.chars().count().min(7)) {
            bytes.push(ch(' '));
        }
        bytes.push(ch(msg.ack.chars().next().unwrap_or(' ')));
        for c in msg.label.chars().take(2) {
            bytes.push(ch(c));
        }
        bytes.push(ch(msg.block_id.chars().next().unwrap_or(' ')));
        // A block with no text goes straight from the header to ETX.
        if !msg.text.is_empty() {
            bytes.push(ch('\u{2}'));
            for c in msg.text.chars() {
                bytes.push(ch(c));
            }
        }
        bytes.push(ch('\u{3}'));

        // The BCS covers the mode character through ETX as transmitted, parity
        // included, and goes out low byte first.
        let bcs = crc16(&bytes[5..]);
        bytes.push((bcs & 0xff) as u8);
        bytes.push((bcs >> 8) as u8);
        bytes.push(0x7f);

        let mut bits: Vec<u8> = vec![1; 16 * 8]; // pre-key of ones
        for byte in bytes {
            bits.extend((0..8).map(|i| (byte >> i) & 1));
        }
        bits
    }

    fn sample() -> AcarsFrame {
        AcarsFrame {
            mode: "2".into(),
            address: ".N12345".into(),
            ack: " ".into(),
            label: "H1".into(),
            block_id: "1".into(),
            text: "HELLO FROM ACARS".into(),
            crc_ok: true,
        }
    }

    #[test]
    fn a_frame_round_trips_through_the_parser() {
        let msg = sample();
        let bits = encode(&msg);
        let got = parse_frame(&bits).expect("a frame");
        assert_eq!(got.address, "N12345", "the padding dot is not part of it");
        assert_eq!(got.label, "H1");
        assert_eq!(got.text, "HELLO FROM ACARS");
        assert!(got.crc_ok, "the block check must verify");
    }

    /// A block with no text has ETX where STX would be. acarsdec's recording
    /// has one (an uplink `_d` to LN-DYY), and it was the frame this decoder
    /// missed at either polarity.
    #[test]
    fn a_frame_with_no_text_ends_its_header_with_etx() {
        let msg = AcarsFrame {
            mode: "2".into(),
            address: ".LN-DYY".into(),
            ack: "5".into(),
            label: "_\u{7f}".into(),
            block_id: "A".into(),
            text: String::new(),
            crc_ok: true,
        };
        let got = parse_frame(&encode(&msg)).expect("a header-only frame");
        assert_eq!(
            got.label, "_d",
            "the general-response label, as it is written"
        );
        assert!(got.text.is_empty());
        assert!(got.crc_ok, "the block check covers the header and ETX");
    }

    /// The carrier loop can settle with either sign, which turns every bit
    /// over. The frame must decode the same either way up.
    #[test]
    fn an_inverted_bit_stream_still_decodes() {
        let bits: Vec<u8> = encode(&sample()).iter().map(|b| b ^ 1).collect();
        let got = parse_frame(&bits).expect("a frame read upside down");
        assert_eq!(got.text, "HELLO FROM ACARS");
        assert!(got.crc_ok);
    }

    /// A heading that frames but fails its check, ahead of a good frame in the
    /// same window, must not be what comes back.
    #[test]
    fn a_failed_heading_does_not_hide_a_good_frame_behind_it() {
        let mut bad = encode(&sample());
        // Two bits of the first text character: parity still holds, so the
        // heading frames, and only the block check can tell. The text starts
        // after 16 bytes of pre-key and 18 of sync and header.
        let text = (16 + 18) * 8;
        bad[text] ^= 1;
        bad[text + 1] ^= 1;
        let only = parse_frame(&bad).expect("the damaged frame still frames");
        assert!(!only.crc_ok);
        let mut good = sample();
        good.text = "SECOND".into();
        bad.extend(encode(&good));
        let got = parse_frame(&bad).expect("a frame");
        assert!(got.crc_ok, "the frame that checks out wins");
        assert_eq!(got.text, "SECOND");
    }

    /// One damaged frame is one failed block: the window steps past it a byte
    /// at a time and finds the same heading again after every byte, which
    /// counted it once per byte until it drained out.
    #[test]
    fn a_failed_heading_is_counted_once() {
        let mut bits = encode(&sample());
        let text = (16 + 18) * 8;
        bits[text] ^= 1;
        bits[text + 1] ^= 1;
        bits.extend(std::iter::repeat_n(1, 8 * 400));
        let mut rx = AcarsRx::new(12_000.0);
        let mut out = Vec::new();
        for b in bits {
            rx.push_bit(b == 1, &mut out);
        }
        assert!(out.is_empty(), "nothing that fails its check is emitted");
        assert_eq!(rx.bad(), 1);
    }

    /// Nothing that is not printable reaches the screen as itself: a NAK is
    /// spelled out, and any other control character becomes a dot.
    #[test]
    fn control_characters_are_shown_not_sent() {
        let mut msg = sample();
        msg.ack = "\u{15}".into();
        msg.text = "A\u{1b}[2JB\r\nC".into();
        let got = parse_frame(&encode(&msg)).expect("a frame");
        assert_eq!(got.ack, "NAK");
        assert_eq!(
            got.text, "A·[2JB\r\nC",
            "the escape is gone, the line break kept"
        );
        assert!(got.crc_ok);
    }

    #[test]
    fn a_corrupt_block_check_is_reported_not_hidden() {
        let mut bits = encode(&sample());
        // Flip a text bit; the CRC must catch it.
        let n = bits.len();
        bits[n / 2] ^= 1;
        match parse_frame(&bits) {
            Some(m) => assert!(!m.crc_ok, "a corrupted frame must not claim a good check"),
            None => {}
        }
    }

    #[test]
    fn noise_yields_no_message() {
        // A pseudo-random stream should not produce a frame with a good check.
        let mut x = 0x12345678u32;
        let bits: Vec<u8> = (0..4000)
            .map(|_| {
                x = x.wrapping_mul(1664525).wrapping_add(1013904223);
                ((x >> 16) & 1) as u8
            })
            .collect();
        assert!(
            parse_frame(&bits).is_none(),
            "noise must not fabricate a frame"
        );
    }

    /// The block check is the reflected CRC-16 with initial value 0 — the same
    /// form as CRC-16/KERMIT, whose check value for "123456789" is 0x2189.
    /// CCITT-FALSE would give 0x29B1 and does not verify real frames.
    #[test]
    fn the_block_check_is_the_reflected_crc() {
        assert_eq!(crc16(b"123456789"), 0x2189);
    }
}
