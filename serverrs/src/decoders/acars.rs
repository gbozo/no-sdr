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
    /// The message text, header included.
    pub text: String,
    /// Downlink header: the 4-character message sequence number.
    pub message_no: String,
    /// Downlink header: the 6-character flight id (e.g. `QR048K`).
    pub flight_id: String,
    /// Text after the downlink header (`text` for uplinks).
    pub body: String,
    /// Structured fields recovered from the body and label.
    pub fields: AcarsFields,
    /// Whether the block-check sequence matched.
    pub crc_ok: bool,
}

/// Fields recovered from an ACARS body.
///
/// ACARS itself is only the transport: everything here comes from the airline
/// application text, so each field is best-effort. Labels Q1/Q2/QA..QT and a
/// few numbered ones have fixed layouts (ported from acarsdec's `label.c`);
/// positions and tagged values (`FUEL`, `ACFT`, `ALT`, …) are scanned from the
/// text. Empty means "not present in this message".
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AcarsFields {
    pub origin: Option<String>,
    pub destination: Option<String>,
    pub eta: Option<String>,
    pub gate_out: Option<String>,
    pub wheels_off: Option<String>,
    pub wheels_on: Option<String>,
    pub gate_in: Option<String>,
    pub fuel: Option<String>,
    pub aircraft_type: Option<String>,
    pub altitude: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
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

/// Split a downlink block's text into its 4-character message number, its
/// 6-character flight id and the body.
///
/// Block ids `0`–`9` are downlinks, and their text starts with those ten
/// characters (ARINC 618). Uplinks (letter block ids) carry no such header, so
/// their body is the whole text.
fn split_downlink(block_id: &str, text: &str) -> (String, String, String) {
    let downlink = block_id.as_bytes().first().is_some_and(u8::is_ascii_digit);
    if downlink && text.len() >= 10 {
        let head = &text.as_bytes()[..10];
        if head.iter().all(|b| b.is_ascii_alphanumeric() || *b == b' ') {
            let head = &text[..10];
            return (
                head[..4].trim().to_string(),
                head[4..].trim().to_string(),
                text[10..].trim().to_string(),
            );
        }
    }
    (String::new(), String::new(), text.to_string())
}

/// Value that follows the first of `keys` (case-insensitive, whole word).
/// Used for the free-form application text; only values with a digit are
/// accepted so prose like "FUEL IS LOW" does not become a fuel reading.
fn tagged_value(text: &str, keys: &[&str]) -> Option<String> {
    let upper = text.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    for key in keys {
        let mut from = 0;
        while let Some(rel) = upper[from..].find(key) {
            let at = from + rel;
            let end = at + key.len();
            let word_start = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
            let word_end = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
            if word_start && word_end {
                let mut i = end;
                while i < bytes.len() && matches!(bytes[i], b' ' | b':' | b'=' | b'\t' | b'/') {
                    i += 1;
                }
                let value: String = upper[i..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
                    .collect();
                if !value.is_empty() && value.chars().any(|c| c.is_ascii_digit()) {
                    return Some(value);
                }
            }
            from = end;
            if from >= upper.len() {
                break;
            }
        }
    }
    None
}

/// `LAT N 47.176/LON E 2.943` and its spacing variants.
fn parse_position(text: &str) -> Option<(f64, f64)> {
    let upper = text.to_ascii_uppercase();
    if let (Some(lat_at), Some(lon_at)) = (upper.find("LAT"), upper.find("LON")) {
        if lon_at > lat_at {
            if let (Some(lat), Some(lon)) = (
                parse_coordinate(&upper[lat_at + 3..lon_at], 90.0),
                parse_coordinate(&upper[lon_at + 3..], 180.0),
            ) {
                return Some((lat, lon));
            }
        }
    }
    // ACARS application text often packs the fix without keywords:
    // `N37969E023988` is N 37.969 / E 023.988, as seen in a live AOC report.
    parse_compact_position(&upper)
}

/// `[NS]ddddd[EW]dddddd`, three decimal places, no separators.
fn parse_compact_position(text: &str) -> Option<(f64, f64)> {
    let bytes = text.as_bytes();
    let digits = |slice: &[u8]| -> Option<f64> {
        std::str::from_utf8(slice).ok()?.parse::<f64>().ok()
    };
    let mut i = 0;
    while i + 13 <= bytes.len() {
        let ns = bytes[i];
        let ew = bytes[i + 6];
        if (ns == b'N' || ns == b'S')
            && (ew == b'E' || ew == b'W')
            && bytes[i + 1..i + 6].iter().all(u8::is_ascii_digit)
            && bytes[i + 7..i + 13].iter().all(u8::is_ascii_digit)
        {
            let lat = digits(&bytes[i + 1..i + 6])? / 1000.0;
            let lon = digits(&bytes[i + 7..i + 13])? / 1000.0;
            if lat <= 90.0 && lon <= 180.0 {
                return Some((
                    if ns == b'S' { -lat } else { lat },
                    if ew == b'W' { -lon } else { lon },
                ));
            }
        }
        i += 1;
    }
    None
}

fn parse_coordinate(text: &str, limit: f64) -> Option<f64> {
    let mut chars = text
        .chars()
        .skip_while(|c| c.is_whitespace() || matches!(c, '/' | ',' | ':'));
    let sign = match chars.next()? {
        'N' | 'E' => 1.0,
        'S' | 'W' => -1.0,
        _ => return None,
    };
    let rest: String = chars.collect();
    let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '/' | ':'));
    let number: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let value: f64 = number.parse().ok()?;
    // DDMM.m / DDDMM.m when the integer part is longer than three digits;
    // otherwise decimal degrees, which is what most ACARS position reports
    // use (`LAT N 47.176/LON E 2.943`).
    let value = if number.split('.').next().map_or(0, str::len) > 3 {
        let degrees = (value / 100.0).trunc();
        let minutes = value - degrees * 100.0;
        if minutes >= 60.0 {
            return None;
        }
        degrees + minutes / 60.0
    } else {
        value
    };
    (value <= limit).then_some(sign * value)
}

/// Copy a fixed 4-character field out of a label body.
fn set_field(dst: &mut Option<String>, body: &[u8], at: usize) {
    if let Some(slice) = body.get(at..at + 4) {
        let text: String = slice.iter().map(|&b| b as char).collect();
        let text = text.trim().to_string();
        if !text.is_empty() {
            *dst = Some(text);
        }
    }
}

/// Fixed-layout OOOI/route labels from acarsdec's `label.c`. The Q-series and
/// the numbered labels that put origin/destination/ETA at stable offsets are
/// covered; airline-private layouts are left to the generic scanners.
fn decode_label(label: &str, body: &str, f: &mut AcarsFields) {
    let b = body.as_bytes();
    match label {
        "Q1" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.gate_out, b, 4);
            set_field(&mut f.wheels_off, b, 8);
            set_field(&mut f.wheels_on, b, 12);
            set_field(&mut f.gate_in, b, 16);
            set_field(&mut f.destination, b, 24);
        }
        "Q2" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.eta, b, 4);
        }
        "QA" | "QH" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.gate_out, b, 4);
        }
        "QB" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.wheels_off, b, 4);
        }
        "QC" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.wheels_on, b, 4);
        }
        "QD" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.gate_in, b, 4);
        }
        "QE" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.gate_out, b, 4);
            set_field(&mut f.destination, b, 8);
        }
        "QF" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.wheels_off, b, 4);
            set_field(&mut f.destination, b, 8);
        }
        "QG" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.gate_out, b, 4);
            set_field(&mut f.gate_in, b, 8);
        }
        "QK" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.wheels_on, b, 4);
            set_field(&mut f.destination, b, 8);
        }
        "QL" => {
            set_field(&mut f.destination, b, 0);
            set_field(&mut f.gate_in, b, 8);
            set_field(&mut f.origin, b, 13);
        }
        "QM" => {
            set_field(&mut f.destination, b, 0);
            set_field(&mut f.origin, b, 8);
        }
        "QN" => {
            set_field(&mut f.destination, b, 4);
            set_field(&mut f.eta, b, 8);
        }
        "QP" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.destination, b, 4);
            set_field(&mut f.gate_out, b, 8);
        }
        "QQ" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.destination, b, 4);
            set_field(&mut f.wheels_off, b, 8);
        }
        "QR" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.destination, b, 4);
            set_field(&mut f.wheels_on, b, 8);
        }
        "QS" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.destination, b, 4);
            set_field(&mut f.gate_in, b, 8);
        }
        "QT" => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.destination, b, 4);
            set_field(&mut f.gate_out, b, 8);
            set_field(&mut f.gate_in, b, 12);
        }
        "12" | "1G" | "83" if b.get(4) == Some(&b',') => {
            set_field(&mut f.origin, b, 0);
            set_field(&mut f.destination, b, 5);
        }
        "2Z" => set_field(&mut f.destination, b, 0),
        "45" if b.first() == Some(&b'A') => set_field(&mut f.destination, b, 1),
        "80" if body.get(6..11) == Some("/DEST") => set_field(&mut f.destination, b, 12),
        "8E" | "8S" if b.get(4) == Some(&b',') => {
            set_field(&mut f.destination, b, 0);
            set_field(&mut f.eta, b, 5);
        }
        "17"
            if body.starts_with("ETA ")
                && b.get(8) == Some(&b',')
                && b.get(13) == Some(&b',') =>
        {
            set_field(&mut f.eta, b, 4);
            set_field(&mut f.origin, b, 9);
            set_field(&mut f.destination, b, 14);
        }
        "21" if b.get(6) == Some(&b',') && b.get(11) == Some(&b',') => {
            set_field(&mut f.origin, b, 7);
            set_field(&mut f.destination, b, 12);
        }
        "33"
            if b.first() == Some(&b',')
                && b.get(20) == Some(&b',')
                && b.get(25) == Some(&b',') =>
        {
            set_field(&mut f.origin, b, 21);
            set_field(&mut f.destination, b, 26);
        }
        "15" if body.starts_with("FST01") => {
            set_field(&mut f.origin, b, 5);
            set_field(&mut f.destination, b, 9);
        }
        "10" if body.starts_with("ARR01") => {
            set_field(&mut f.destination, b, 12);
            set_field(&mut f.eta, b, 16);
        }
        "11" if body.get(13..17) == Some("/DS ") => {
            set_field(&mut f.destination, b, 17);
            if body.get(21..26) == Some("/ETA ") {
                set_field(&mut f.eta, b, 26);
            }
        }
        _ => {}
    }
}

fn parse_report(
    label: &str,
    block_id: &str,
    text: &str,
) -> (String, String, String, AcarsFields) {
    let (message_no, flight_id, body) = split_downlink(block_id, text);
    let mut fields = AcarsFields::default();
    decode_label(label, &body, &mut fields);
    if let Some((lat, lon)) = parse_position(&body) {
        fields.latitude = Some(lat);
        fields.longitude = Some(lon);
    }
    if fields.fuel.is_none() {
        fields.fuel = tagged_value(
            &body,
            &["FUEL ON BOARD", "BLOCK FUEL", "TRIP FUEL", "FOB", "FOD", "FUEL"],
        );
    }
    if fields.aircraft_type.is_none() {
        fields.aircraft_type = tagged_value(
            &body,
            &["AIRCRAFT TYPE", "ACFT TYPE", "TYPE", "ACFT", "A/C", "EQPT", "EQUIP"],
        );
    }
    if fields.altitude.is_none() {
        fields.altitude = tagged_value(&body, &["FLIGHT LEVEL", "ALTITUDE", "ALT", "FL"]);
    }
    if fields.eta.is_none() {
        fields.eta = tagged_value(&body, &["ETA"]);
    }
    (message_no, flight_id, body, fields)
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
    let (message_no, flight_id, body, fields) = parse_report(&label, &block_id, &text);

    Some(AcarsFrame {
        mode,
        // Right-aligned in its seven characters, padded with dots.
        address: address.trim_matches(|c| c == '.' || c == ' ').to_string(),
        ack,
        label,
        block_id,
        text,
        message_no,
        flight_id,
        body,
        fields,
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
    /// VCO phase (the carrier) and the bit-clock accumulator. acarsdec keeps
    /// these in `double`; f32 accumulators drift over a long burst and move the
    /// matched-filter read.
    phi: f64,
    clk: f64,
    /// PI carrier loop: integrated frequency and phase corrections.
    df: f64,
    dphi: f64,
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
    pub fn new(rate: f64) -> Self {
        // acarsdec runs its demodulator at 12.5 kHz. That is not arbitrary:
        // at 12 kHz a symbol is exactly 5 samples and `clk` lands precisely on
        // the 3π/2 trigger, so a rounding difference fires the bit clock one
        // sample early and every matched-filter read is off by a sample —
        // clean bursts then never frame. 12.5 kHz gives a non-integer 5.2083
        // samples per symbol and the trigger is unambiguous.
        let demod_rate = if rate > 0.0 { rate } else { 12_500.0 };
        // acarsdec's MFLTOVER: 240 sub-samples per input sample.
        let over = 240usize;
        let bitlen = (demod_rate / 1200.0).ceil().max(1.0) as usize;
        let mut mflt = vec![0.0f32; bitlen * over + 1];
        // The half wave of a 1200 Hz sine: the matched filter acarsdec uses.
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

        // acarsdec's PI carrier loop, with the gains scaled by the filter
        // length (`PLLKi`/`PLLKp`). The legacy acarsdec used a one-pole loop
        // (`PLLG`/`PLLC`); the receiver here follows the current code.
        let ki = 71e-7 / self.bitlen as f64;
        let kp = 60e-3 / self.bitlen as f64;
        let tau = std::f64::consts::TAU;
        let bit_clock = 1.5 * std::f64::consts::PI;

        let n = audio.len();

        for k in 0..n {
            let sample = audio[k];
            // VCO frequency: the 1800 Hz centre plus the loop's correction.
            let s = tau * CENTER_HZ / self.rate as f64 + self.dphi;

            self.clk += s;
            if self.clk > bit_clock {
                self.clk -= bit_clock;

                // The matched filter, read at the clock's fractional position.
                let mut o = (self.over as f64 * (self.clk / s)) as usize;
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
                    let vo = v.im as f64;
                    (vo, if vo >= 0.0 { -(v.re as f64) } else { v.re as f64 })
                } else {
                    let vo = v.re as f64;
                    (vo, if vo >= 0.0 { v.im as f64 } else { -(v.im as f64) })
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
            self.inb[self.inb_idx] = Complex32::from_polar(1.0, -self.phi as f32) * sample;
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
            ..Default::default()
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
            ..Default::default()
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
        let mut rx = AcarsRx::new(12_500.0);
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

    /// Downlink text starts with a 4-character message number and a
    /// 6-character flight id; the body is what follows (ARINC 618).
    #[test]
    fn downlink_header_separates_message_number_and_flight() {
        let (no, fid, body) = split_downlink("6", "S81AQR048K0EV233638VS/");
        assert_eq!(no, "S81A");
        assert_eq!(fid, "QR048K");
        assert_eq!(body, "0EV233638VS/");

        let (no, fid, body) = split_downlink("A", "PLAIN UPLINK TEXT");
        assert!(no.is_empty());
        assert!(fid.is_empty());
        assert_eq!(body, "PLAIN UPLINK TEXT");
    }

    #[test]
    fn position_reports_yield_coordinates() {
        assert_eq!(
            parse_position("LAT N 47.176/LON E 2.943"),
            Some((47.176, 2.943))
        );
        assert_eq!(
            parse_position("POS LAT S33.5 LON W070.25 END"),
            Some((-33.5, -70.25))
        );
        // DDMM.m / DDDMM.m form.
        let (lat, lon) = parse_position("LAT N4732.1/LON E00256.4").expect("ddmm position");
        assert!((lat - 47.535).abs() < 1e-9, "lat {lat}");
        assert!((lon - 2.94).abs() < 1e-9, "lon {lon}");
        assert_eq!(parse_position("no coordinates here"), None);
        // Compact application-text form seen live (SX-DVS AOC report).
        assert_eq!(
            parse_position("N37969E02398819360256P006240013"),
            Some((37.969, 23.988))
        );
        assert_eq!(parse_position("S33500W070250"), Some((-33.5, -70.25)));
    }

    #[test]
    fn tagged_values_and_downlink_header_fill_the_fields() {
        let (no, fid, body, fields) = parse_report(
            "H1",
            "1",
            "S81AQR048KFUEL 12.3T ACFT B77W ALT FL350 ETA 1234",
        );
        assert_eq!(no, "S81A");
        assert_eq!(fid, "QR048K");
        assert_eq!(body, "FUEL 12.3T ACFT B77W ALT FL350 ETA 1234");
        assert_eq!(fields.fuel.as_deref(), Some("12.3T"));
        assert_eq!(fields.aircraft_type.as_deref(), Some("B77W"));
        assert_eq!(fields.altitude.as_deref(), Some("FL350"));
        assert_eq!(fields.eta.as_deref(), Some("1234"));
    }

    /// Q1 carries origin, the four OOOI times and destination at fixed
    /// offsets (acarsdec `label_q1`).
    #[test]
    fn q1_label_fills_route_and_times() {
        let mut fields = AcarsFields::default();
        decode_label("Q1", "EGLL1200121514301445XXXXKJFK", &mut fields);
        assert_eq!(fields.origin.as_deref(), Some("EGLL"));
        assert_eq!(fields.gate_out.as_deref(), Some("1200"));
        assert_eq!(fields.wheels_off.as_deref(), Some("1215"));
        assert_eq!(fields.wheels_on.as_deref(), Some("1430"));
        assert_eq!(fields.gate_in.as_deref(), Some("1445"));
        assert_eq!(fields.destination.as_deref(), Some("KJFK"));
    }

    /// The whole path: encoded frame → parser → structured fields.
    #[test]
    fn a_downlink_frame_exposes_position_and_fields() {
        let msg = AcarsFrame {
            mode: "2".into(),
            address: ".A7-BHT".into(),
            ack: " ".into(),
            label: "16".into(),
            block_id: "1".into(),
            text: "S81AQR048KFUEL 12.3T LAT N 47.176/LON E 2.943".into(),
            crc_ok: true,
            ..Default::default()
        };
        let got = parse_frame(&encode(&msg)).expect("a frame");
        assert_eq!(got.flight_id, "QR048K");
        assert_eq!(got.body, "FUEL 12.3T LAT N 47.176/LON E 2.943");
        assert_eq!(got.fields.fuel.as_deref(), Some("12.3T"));
        assert_eq!(got.fields.latitude, Some(47.176));
        assert_eq!(got.fields.longitude, Some(2.943));
    }


    /// A burst of MSK audio built from the same bits the encoder writes:
    /// 2400 baud, 1200 Hz for a zero and 2400 Hz for a one, each bit starting
    /// from zero phase. Tones are evaluated at the real sample times, so the
    /// non-integer samples-per-bit of 12.5 kHz is handled correctly.
    fn msk_audio(bits: &[u8], rate: f64) -> Vec<f32> {
        let samples_per_bit = rate / BAUD;
        let total = (bits.len() as f64 * samples_per_bit).round() as usize;
        let mut out = Vec::with_capacity(total);
        for k in 0..total {
            let position = k as f64 / samples_per_bit;
            let bit = bits.get(position.floor() as usize).copied().unwrap_or(0);
            let tone = if bit != 0 { 2400.0 } else { 1200.0 };
            let phase = std::f64::consts::TAU * tone * (position - position.floor()) / BAUD;
            out.push((0.6 * phase.sin()) as f32);
        }
        out
    }

    /// The demodulator must lock to a clean synthesized burst. When this fails,
    /// the wire path above is not at fault: the MSK receiver itself is.
    #[test]
    fn the_demodulator_reads_synthesized_msk_audio() {
        for invert in [false, true] {
            let mut bits = encode(&sample());
            // A real burst is followed by idle, not cut off at the last bit:
            // the demod's one-symbol latency would otherwise leave the final
            // DEL byte short and the parser rightly refuses the block.
            bits.extend(std::iter::repeat_n(1, 64));
            let mut audio = msk_audio(&bits, 12_500.0);
            // The carrier loop settles with either sign, so an upside-down
            // burst must decode too (acarsdec sees both in the wild).
            if invert {
                audio.iter_mut().for_each(|sample| *sample = -*sample);
            }
            let mut rx = AcarsRx::new(12_500.0);
            let mut events = Vec::new();
            for chunk in audio.chunks(120) {
                rx.process(chunk, &mut events);
            }
            let texts: Vec<String> = events
                .iter()
                .map(|AcarsEvent::Message(m)| m.text.clone())
                .collect();
            assert!(
                texts.iter().any(|t| t == "HELLO FROM ACARS"),
                "synthesized MSK burst did not decode (invert={invert}): frames={} bad={} level={:.3} texts={texts:?}",
                rx.frames(),
                rx.bad(),
                rx.level()
            );
        }
    }
}
