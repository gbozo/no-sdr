//! The 87-bit information word: 72 payload bits, a 3-bit frame type, a 12-bit
//! CRC.
//!
//! This is the layer directly under the varicode — it knows how the bits are
//! arranged and checksummed, and nothing about what they mean. Interpreting the
//! payload (callsigns, directed commands, free text) is `super::varicode`'s job.
//!
//! ## The 12-character alphabet
//!
//! JS8Call's own message layer hands its encoder twelve characters rather than
//! 72 bits, because that was the cheapest way to move a bit vector across its
//! C++/Fortran boundary (`lib/js8/genjs8.f90:35`, `JS8.cpp`'s `alphabet`). The
//! 64 characters are a base-64 transport encoding of six-bit groups, not text —
//! a JS8 message is not "made of" these characters any more than a JPEG is made
//! of base64. Rust packs the bits directly, but the mapping is kept here because
//! it is the form JS8Call's golden vectors come in.

use mfsk_core::engine::protocol::{DecodeContext, MessageCodec, MessageFields};

use super::crc12::{self, CRC_BITS, MSG_BITS, PAYLOAD_BITS, TYPE_BITS};

/// Information bits in one frame.
pub const INFO_BITS: usize = PAYLOAD_BITS + CRC_BITS;

/// Six-bit transport alphabet, `JS8.cpp`. Exactly 64 characters.
pub const ALPHABET: &[u8; 64] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+";

/// What a JS8 frame carries before the varicode layer interprets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Js8Payload {
    /// The 72 payload bits, one per element.
    pub bits: [u8; MSG_BITS],
    /// The 3-bit `i3bit` field: message *sequencing* flags, not the frame
    /// type. See [`super::frame::Js8Flags`] — the frame type lives in the
    /// first three bits of `bits`.
    pub frame_type: u8,
}

impl Js8Payload {
    /// Build a payload from twelve transport characters. Returns `None` if any
    /// character is outside [`ALPHABET`].
    pub fn from_chars(text: &str, frame_type: u8) -> Option<Self> {
        let chars: Vec<u8> = text.bytes().collect();
        if chars.len() != 12 {
            return None;
        }
        let mut bits = [0u8; MSG_BITS];
        for (i, &c) in chars.iter().enumerate() {
            let word = ALPHABET.iter().position(|&a| a == c)? as u8;
            for j in 0..6 {
                bits[i * 6 + j] = (word >> (5 - j)) & 1;
            }
        }
        Some(Js8Payload { bits, frame_type })
    }

    /// Render the payload back to twelve transport characters.
    pub fn to_chars(self) -> String {
        (0..12)
            .map(|i| {
                let mut word = 0u8;
                for j in 0..6 {
                    word = (word << 1) | self.bits[i * 6 + j];
                }
                ALPHABET[word as usize] as char
            })
            .collect()
    }

    /// Expand to the 87 information bits the FEC encodes, CRC included.
    pub fn to_info(self) -> [u8; INFO_BITS] {
        let mut info = [0u8; INFO_BITS];
        info[..MSG_BITS].copy_from_slice(&self.bits);
        for j in 0..TYPE_BITS {
            info[MSG_BITS + j] = (self.frame_type >> (TYPE_BITS - 1 - j)) & 1;
        }
        let crc = crc12::crc12(&info[..PAYLOAD_BITS]);
        crc12::place(&mut info, crc);
        info
    }

    /// Recover a payload from 87 information bits, rejecting a bad CRC.
    pub fn from_info(info: &[u8]) -> Option<Self> {
        if info.len() < INFO_BITS || !crc12::check(info) {
            return None;
        }
        let mut bits = [0u8; MSG_BITS];
        bits.copy_from_slice(&info[..MSG_BITS]);
        let mut frame_type = 0u8;
        for &bit in &info[MSG_BITS..PAYLOAD_BITS] {
            frame_type = (frame_type << 1) | (bit & 1);
        }
        Some(Js8Payload { bits, frame_type })
    }
}

/// `mfsk-core`'s message-codec seat for JS8.
///
/// Only [`MessageCodec::verify_info`] carries weight: it is what threads the
/// CRC-12 into the FEC's convergence test through `FecOpts::verify_info`, so a
/// parity-valid but wrong codeword keeps iterating instead of being reported.
///
/// [`MessageCodec::pack`] is a courtesy implementation returning `None` —
/// `MessageFields` describes callsigns, a grid and a report, which is FT8's
/// shape and cannot express JS8's directed addressing. Real transmit goes
/// through `super::varicode`, the same relationship `Ft8Modem::pack_message`
/// has with `wsjt77::pack77`.
#[derive(Debug, Default, Clone, Copy)]
pub struct Js8Message;

impl MessageCodec for Js8Message {
    type Unpacked = Js8Payload;

    const PAYLOAD_BITS: u32 = PAYLOAD_BITS as u32;
    const CRC_BITS: u32 = CRC_BITS as u32;

    fn pack(&self, _fields: &MessageFields) -> Option<Vec<u8>> {
        None
    }

    fn unpack(&self, payload: &[u8], _ctx: &DecodeContext) -> Option<Js8Payload> {
        // Callers hand us the CRC-bearing information word.
        Js8Payload::from_info(payload)
    }

    fn verify_info(info: &[u8]) -> bool {
        crc12::check(info)
    }
}

#[cfg(all(test, any()))]
mod tests {
    use super::*;

    #[test]
    fn the_transport_alphabet_is_exactly_six_bits_wide() {
        assert_eq!(ALPHABET.len(), 64);
        let mut sorted = ALPHABET.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 64, "alphabet has a duplicate");
    }

    #[test]
    fn characters_round_trip_through_bits() {
        for text in [
            "0123456789AB",
            "HELLOWORLD12",
            "zzzzzzzzzzzz",
            "-+-+-+-+-+-+",
        ] {
            let p = Js8Payload::from_chars(text, 3).expect("packs");
            assert_eq!(p.to_chars(), text);
        }
    }

    #[test]
    fn a_character_outside_the_alphabet_is_refused() {
        assert!(Js8Payload::from_chars("hello world!", 0).is_none());
        assert!(Js8Payload::from_chars("short", 0).is_none());
    }

    #[test]
    fn info_words_round_trip_and_carry_the_frame_type() {
        for frame_type in 0..8u8 {
            let p = Js8Payload::from_chars("KM4ACKtestin", frame_type).expect("packs");
            let info = p.to_info();
            assert_eq!(info.len(), 87);
            let back = Js8Payload::from_info(&info).expect("verifies");
            assert_eq!(back, p);
            assert_eq!(back.frame_type, frame_type);
        }
    }

    #[test]
    fn a_corrupted_info_word_is_rejected_rather_than_returned() {
        let p = Js8Payload::from_chars("0123456789AB", 4).expect("packs");
        let mut info = p.to_info();
        info[17] ^= 1;
        assert!(Js8Payload::from_info(&info).is_none());
    }
}
