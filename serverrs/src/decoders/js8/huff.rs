//! Huffman free text — the uncompressed data-frame path.
//!
//! JS8 has two ways to carry free text. This one codes each character with a
//! variable-length prefix code weighted to English letter frequency, which
//! averages a little under five bits a character; the other
//! (`super::jsc`) substitutes whole words from a shared dictionary. The
//! transmitter tries both and keeps whichever fits more characters into the
//! frame, so both have to exist for a message to be encoded the way JS8Call
//! would encode it.
//!
//! ## The pad, which is not a length field
//!
//! A frame is a fixed 72 bits and the text rarely ends on that boundary, so the
//! remainder is filled by writing **a single zero followed by all ones**
//! (`varicode.cpp:1726`). A receiver recovers the length by scanning backwards
//! from the end over the ones and discarding the first zero it meets. That is
//! why the packed frames end in runs of `+` — the transport character for
//! `0b111111`.
//!
//! It also means a frame whose data happens to end in ones is indistinguishable
//! from padding unless the zero is present, which is exactly why the zero is
//! written even when the pad would otherwise be empty.

/// `(character, code)` weighted by English letter frequency,
/// `varicode.cpp:158`. Checked against the reference table by
/// `tests/js8_varicode.rs`.
pub const HUFF: &[(char, &str)] = &[
    (' ', "01"),
    ('!', "1011000"),
    ('"', "1010101"),
    ('+', "1100000"),
    ('-', "1100001"),
    ('.', "1110100"),
    ('/', "11101010"),
    ('0', "0010101"),
    ('1', "0010001"),
    ('2', "0001001"),
    ('3', "0000101"),
    ('4', "11110101"),
    ('5', "0000100"),
    ('6', "11110000"),
    ('7', "11101011"),
    ('8', "11110001"),
    ('9', "11110100"),
    ('?', "1011001"),
    ('A', "0011"),
    ('B', "1111001"),
    ('C', "110001"),
    ('D', "111011"),
    ('E', "100"),
    ('F', "001001"),
    ('G', "000101"),
    ('H', "00011"),
    ('I', "11100"),
    ('J', "0010100"),
    ('K', "1100100"),
    ('L', "110011"),
    ('M', "101011"),
    ('N', "10111"),
    ('O', "11111"),
    ('P', "1111011"),
    ('Q', "0010000"),
    ('R', "00000"),
    ('S', "10100"),
    ('T', "1101"),
    ('U', "101101"),
    ('V', "1100101"),
    ('W', "001011"),
    ('X', "1010100"),
    ('Y', "000011"),
    ('Z', "0001000"),
];

/// Payload bits in a frame.
pub const FRAME_BITS: usize = 72;

/// Code for one character, if the table has it.
pub fn code_for(c: char) -> Option<&'static str> {
    let c = c.to_ascii_uppercase();
    HUFF.iter().find(|(k, _)| *k == c).map(|(_, v)| *v)
}

/// True when every character can be Huffman-coded. A message with anything else
/// has to take the dictionary path or be dropped.
pub fn can_encode(text: &str) -> bool {
    text.chars().all(|c| code_for(c).is_some())
}

/// Append `text` to `bits`, stopping before the first character that would not
/// fit. Returns how many characters were consumed.
pub fn encode_into(bits: &mut Vec<u8>, text: &str, capacity: usize) -> usize {
    let mut used = 0;
    for c in text.chars() {
        let Some(code) = code_for(c) else { break };
        if bits.len() + code.len() >= capacity {
            break;
        }
        bits.extend(code.bytes().map(|b| b - b'0'));
        used += 1;
    }
    used
}

/// Fill `bits` out to `FRAME_BITS` with a zero then all ones.
pub fn pad(bits: &mut Vec<u8>) {
    let mut first = true;
    while bits.len() < FRAME_BITS {
        bits.push(u8::from(!first));
        first = false;
    }
}

/// Strip the pad: drop trailing ones and the single zero that precedes them.
///
/// Returns the payload bits. An all-ones tail with no zero means the frame was
/// exactly full, so nothing is removed.
pub fn unpad(bits: &[u8]) -> &[u8] {
    let mut end = bits.len();
    while end > 0 && bits[end - 1] == 1 {
        end -= 1;
    }
    // `end` now indexes the zero that opened the pad, if there was one.
    if end > 0 {
        &bits[..end - 1]
    } else {
        bits
    }
}

/// Decode Huffman-coded bits back to text, stopping at the first sequence that
/// is not a valid code.
pub fn decode(bits: &[u8]) -> String {
    let mut out = String::new();
    let mut at = 0usize;
    'outer: while at < bits.len() {
        // Codes are 2..=8 bits and the set is prefix-free, so the first match
        // is the only match.
        for len in 2..=8usize {
            if at + len > bits.len() {
                break;
            }
            let candidate: String = bits[at..at + len]
                .iter()
                .map(|b| char::from(b'0' + b))
                .collect();
            if let Some((c, _)) = HUFF.iter().find(|(_, code)| *code == candidate) {
                out.push(*c);
                at += len;
                continue 'outer;
            }
        }
        break;
    }
    out
}

#[cfg(all(test, any()))]
mod tests {
    use super::*;

    #[test]
    fn the_code_is_prefix_free() {
        // Without this the decoder could not tell where one character ends and
        // the next begins, and would silently produce different text.
        for (a, ca) in HUFF {
            for (b, cb) in HUFF {
                if a != b {
                    assert!(!ca.starts_with(cb), "{ca:?} ({a}) has prefix {cb:?} ({b})");
                }
            }
        }
    }

    #[test]
    fn codes_are_between_two_and_eight_bits() {
        // `decode` scans that range; a longer code would never be found.
        for (c, code) in HUFF {
            assert!(
                (2..=8).contains(&code.len()),
                "{c} has a {}-bit code",
                code.len()
            );
            assert!(code.bytes().all(|b| b == b'0' || b == b'1'), "{c}");
        }
    }

    #[test]
    fn text_round_trips_through_the_codec() {
        // Roughly fourteen characters is all a 72-bit frame holds this way —
        // which is the whole reason the dictionary path exists alongside it.
        for text in ["HELLO WORLD", "73", "GOOD DX", "E", "TEST 123"] {
            let mut bits = Vec::new();
            let used = encode_into(&mut bits, text, FRAME_BITS);
            assert_eq!(used, text.len(), "{text} did not fit");
            assert_eq!(decode(&bits), *text, "{text}");
        }
    }

    #[test]
    fn a_frame_holds_about_fourteen_characters_of_english() {
        // Pins the budget the frame layer plans around. If this moves, the
        // encoder is producing different code lengths than the reference.
        let mut bits = Vec::new();
        let used = encode_into(&mut bits, "CQ CQ CQ DE KN4CRD", FRAME_BITS);
        assert_eq!(used, 14);
    }

    #[test]
    fn padding_round_trips() {
        for text in ["HELLO", "E", "HELLO WORLD"] {
            let mut bits = Vec::new();
            encode_into(&mut bits, text, FRAME_BITS);
            let unpadded = bits.clone();
            pad(&mut bits);
            assert_eq!(bits.len(), FRAME_BITS);
            assert_eq!(unpad(&bits), unpadded.as_slice(), "{text}");
        }
    }

    #[test]
    fn a_frame_that_would_overflow_is_truncated_not_corrupted() {
        // Long messages span several frames; the encoder has to stop cleanly on
        // a character boundary rather than emitting half a code.
        let long = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AND KEEPS RUNNING";
        let mut bits = Vec::new();
        let used = encode_into(&mut bits, long, FRAME_BITS);
        assert!(
            used > 0 && used < long.len(),
            "consumed {used} of {}",
            long.len()
        );
        assert!(bits.len() < FRAME_BITS);
        assert_eq!(
            decode(&bits),
            long[..used],
            "the partial frame must be a prefix"
        );
    }

    #[test]
    fn characters_outside_the_table_stop_the_encoder() {
        assert!(!can_encode("hello, world"));
        assert!(can_encode("HELLO WORLD"));
        let mut bits = Vec::new();
        // The comma is not in the table, so encoding stops before it.
        assert_eq!(encode_into(&mut bits, "AB,CD", FRAME_BITS), 2);
    }

    #[test]
    fn lowercase_is_folded_rather_than_refused() {
        assert_eq!(code_for('e'), code_for('E'));
        let mut bits = Vec::new();
        encode_into(&mut bits, "hello", FRAME_BITS);
        assert_eq!(decode(&bits), "HELLO");
    }
}
