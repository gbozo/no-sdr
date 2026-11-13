//! The PI4 "Next Generation Beacon" protocol: OZ2M / Klaus DJ5HG's
//! specification (<https://rudius.net/oz2m/ngnb/pi4_.htm>), read from source —
//! every constant and every bit-ordering choice below was checked against that
//! page's own worked example (OZ7IGY at 144.471 MHz) rather than assumed from
//! its prose, and [`tests::the_oz7igy_worked_example_matches_the_protocol_page`]
//! is that check kept as a regression test.
//!
//! PI4 is explicitly "based on JT4", and it shows in the FEC: the rate-1/2
//! K=32 convolutional code is the Layland-Lushbaugh pair `0xF2D05351` /
//! `0xE4613C47` that WSPR and JT9 also use — literally the same code, only the
//! message length differs (42 info bits here against WSPR's 50 and JT9's 72).
//! `mfsk-core`'s `fec::conv::fano` module carries that code as a set of
//! functions generic over the bit count rather than as a type hard-wired to
//! WSPR's own shape, so it is reused here directly rather than re-implemented:
//! [`conv_encode`](mfsk_core::fec::conv::fano::conv_encode) and
//! [`fano_decode`](mfsk_core::fec::conv::fano::fano_decode) with
//! [`NBITS`] in place of `ConvFano::NBITS` (81) or `ConvFano232::NBITS` (103)
//! is the whole of it. What is PI4-specific and lives here: the message
//! alphabet and its base-38 packing, the fixed sync vector, and the
//! bit-reversal interleaver.

/// Symbols in one transmission: 146, at 166.667 ms each = 24.333 s.
pub const N_SYMBOLS: usize = 146;

/// Information bits: eight characters from a 38-symbol alphabet packed as one
/// base-38 integer (`38.powi(8)` fits in 42 bits).
pub const INFO_BITS: usize = 42;

/// Shifts the Fano decoder runs over: 42 message bits + the 31-bit zero tail
/// the K=32 code needs to flush. Matches `mfsk_core::fec::ConvFano::NBITS`'s
/// role for WSPR's own 50-bit message.
pub const NBITS: usize = INFO_BITS + 31;

/// Coded bits leaving the convolutional encoder: `2 * NBITS`, one per
/// transmitted symbol.
pub const CODED_BITS: usize = 2 * NBITS;

const _: () = assert!(CODED_BITS == N_SYMBOLS);

/// Characters a PI4 message may use, in the order the protocol numbers them:
/// digits, then capital letters, then space and `/`. `value_of(c)` and
/// `char_of(v)` are the two directions of this table.
pub const CHARSET: &[u8; 38] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /";

/// A character's value in the 38-symbol alphabet, or `None` outside it.
/// Lower-case letters are folded to upper, matching how an operator types a
/// callsign rather than refusing one typed in lower case.
pub fn value_of(c: char) -> Option<u8> {
    let c = c.to_ascii_uppercase();
    CHARSET
        .iter()
        .position(|&b| b as char == c)
        .map(|i| i as u8)
}

/// The character a value from `0..38` stands for. Panics outside that range —
/// every caller here gets its values from a 6-bit-max field the FEC already
/// bounds, so an out-of-range value is a bug upstream, not bad input.
pub fn char_of(v: u8) -> char {
    CHARSET[v as usize] as char
}

/// Pack up to eight characters into the 42-bit `N` the protocol builds by
/// `N = char0; N = N*38 + char1; …; N = N*38 + char7`, space-padding a shorter
/// message on the right exactly as the spec's own packer does. `None` for a
/// message that is too long or that uses a character outside [`CHARSET`].
pub fn pack_message(text: &str) -> Option<u64> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > 8 {
        return None;
    }
    let mut n: u64 = 0;
    for i in 0..8 {
        let v = match chars.get(i) {
            Some(&c) => value_of(c)?,
            None => 36, // space
        };
        n = n * 38 + v as u64;
    }
    Some(n)
}

/// The message `N` packs, trimmed of the trailing space padding
/// [`pack_message`] adds. `n` must be `< 38u64.pow(8)`; the low bits of
/// anything wider are silently taken, which is only ever reached with a
/// decoder-recovered `n` that is already known to fit (see
/// [`crate::decoders::pi4::decode`]).
pub fn unpack_message(mut n: u64) -> String {
    let mut chars = [0u8 as char; 8];
    for i in (0..8).rev() {
        chars[i] = char_of((n % 38) as u8);
        n /= 38;
    }
    chars
        .iter()
        .collect::<String>()
        .trim_end_matches(' ')
        .to_string()
}

/// The 42-bit `N` as 42 MSB-first bits, ready for
/// [`mfsk_core::fec::conv::fano::conv_encode`]: packed into bytes with the
/// remaining bits of the last byte and the whole 31-bit tail left zero, which
/// `conv_encode`'s own bit extraction treats as the required zero tail.
pub fn pack_info_bits(n: u64) -> [u8; NBITS.div_ceil(8)] {
    let mut out = [0u8; NBITS.div_ceil(8)];
    for i in 0..INFO_BITS {
        let bit = (n >> (INFO_BITS - 1 - i)) & 1;
        if bit != 0 {
            out[i / 8] |= 1 << (7 - (i % 8));
        }
    }
    out
}

/// The inverse of [`pack_info_bits`] over the recovered message bits: the
/// leading [`INFO_BITS`] bits (MSB-first) as the 42-bit `N`, dropping the
/// 31-bit zero tail.
pub fn unpack_info_bits(bits: &[u8]) -> u64 {
    let mut n: u64 = 0;
    for i in 0..INFO_BITS {
        let bit = (bits[i / 8] >> (7 - (i % 8))) & 1;
        n = (n << 1) | bit as u64;
    }
    n
}

/// The fixed 146-bit pseudorandom synchronisation word, contributed by Klaus
/// DJ5HG for its auto-correlation properties. Bit `n` is the low bit of
/// transmitted symbol `n`: `Symbol[n] = SYNC[n] + 2 * Data[n]`.
#[rustfmt::skip]
pub const SYNC: [u8; N_SYMBOLS] = [
    0,0,1,0,0,1,1,1,1,0,1,0,1,0,1,0,0,1,0,0,0,1,0,0,0,1,1,0,0,1,
    1,1,1,0,0,1,1,1,1,1,0,0,1,1,0,1,1,1,1,0,1,0,1,1,0,1,1,0,1,0,
    0,0,0,0,1,1,1,1,1,0,1,0,1,0,0,0,0,0,1,1,1,1,1,0,1,0,0,1,0,0,
    1,0,1,0,0,0,0,1,0,0,1,1,0,0,0,0,0,1,1,0,0,0,0,1,1,0,0,1,1,1,
    0,1,1,1,0,1,1,0,1,0,1,0,1,0,0,0,0,1,1,1,0,0,0,0,1,1,
];

/// Undo the transmitted bit-reversal interleave: given 146 values indexed by
/// *transmission* order (channel position `n`), return them reordered into
/// *codeword* order (the order [`mfsk_core::fec::conv::fano::conv_encode`]
/// produced them in).
///
/// The forward map (spec pseudocode, and the reference C `PI4MakeSymbols`):
/// scan `i` from 0 to 255, bit-reverse it over 8 bits to get `j`; whenever
/// `j < 146`, the next sequential codeword bit is written to transmitted
/// position `j`. This is the matching gather: same scan, same bit reversal,
/// reading the transmitted array at `j` and writing sequentially — the
/// one-to-one inverse of a permutation applied to itself.
pub fn deinterleave<T: Copy + Default>(channel_order: &[T; N_SYMBOLS]) -> [T; N_SYMBOLS] {
    let mut out = [T::default(); N_SYMBOLS];
    let mut p = 0usize;
    let mut i = 0u16;
    while p < N_SYMBOLS {
        let j = (i as u8).reverse_bits() as usize;
        if j < N_SYMBOLS {
            out[p] = channel_order[j];
            p += 1;
        }
        i += 1;
    }
    out
}

/// The forward interleave — codeword order to transmission (channel) order.
/// The receiver only ever needs [`deinterleave`], its inverse; this direction
/// is what [`encode_symbols_for`] and the encode-side tests need.
pub fn interleave_to_channel<T: Copy + Default>(codeword_order: &[T; N_SYMBOLS]) -> [T; N_SYMBOLS] {
    let mut out = [T::default(); N_SYMBOLS];
    let mut p = 0usize;
    let mut i = 0u16;
    while p < N_SYMBOLS {
        let j = (i as u8).reverse_bits() as usize;
        if j < N_SYMBOLS {
            out[j] = codeword_order[p];
            p += 1;
        }
        i += 1;
    }
    out
}

/// Convolutionally encode a 42-bit message value `n` (see [`pack_message`])
/// into its 146 coded bits, in codeword (pre-interleave) order — over
/// `mfsk-core`'s generic conv encoder, the same one WSPR and JT9 use with
/// different dimensions (see this module's doc comment).
pub fn encode_coded_bits(n: u64) -> [u8; CODED_BITS] {
    let info = pack_info_bits(n);
    let mut coded = [0u8; CODED_BITS];
    mfsk_core::fec::conv::fano::conv_encode(&info, NBITS, &mut coded);
    coded
}

/// The 146 transmitted symbols (tone indices `0..=3`) a message value `n`
/// produces: convolutional encode, interleave, merge with [`SYNC`] — the
/// spec's `PI4MakeSymbols` in full. [`crate::decoders::pi4::decode`] calls this to
/// re-encode a candidate decode for [`crate::decoders::pi4::decode::fit_of`]; tests use
/// it (via [`encode_reference`]) for the worked-example regression check and
/// to build synthetic test signals.
pub fn encode_symbols_for(n: u64) -> [u8; N_SYMBOLS] {
    let coded = encode_coded_bits(n);
    let interleaved = interleave_to_channel(&coded);
    let mut symbols = [0u8; N_SYMBOLS];
    for i in 0..N_SYMBOLS {
        symbols[i] = SYNC[i] | (interleaved[i] << 1);
    }
    symbols
}

/// [`encode_symbols_for`] from a message string rather than a raw `N`.
pub fn encode_reference(text: &str) -> Option<[u8; N_SYMBOLS]> {
    Some(encode_symbols_for(pack_message(text)?))
}

/// The four beacon-spacing variants the "Next Generation Beacon" platform
/// defines, named as the protocol page names them. `K` sets the tone spacing:
/// `K * 12000 / 2048` Hz.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// 1 kHz beacon channels.
    Pi4,
    /// 2 kHz beacon channels, narrower tone spacing.
    Pi4_80,
    /// 2 or 3 kHz beacon channels.
    Pi4_96,
    /// 3 kHz beacon channels, the widest tone spacing.
    Pi4_120,
}

impl Variant {
    pub const ALL: [Variant; 4] = [
        Variant::Pi4,
        Variant::Pi4_80,
        Variant::Pi4_96,
        Variant::Pi4_120,
    ];

    const fn k(self) -> u32 {
        match self {
            Variant::Pi4 => 40,
            Variant::Pi4_80 => 80,
            Variant::Pi4_96 => 96,
            Variant::Pi4_120 => 120,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Variant::Pi4 => "PI4",
            Variant::Pi4_80 => "PI4-80",
            Variant::Pi4_96 => "PI4-96",
            Variant::Pi4_120 => "PI4-120",
        }
    }

    /// Spacing between adjacent tones, Hz: `K * 12000 / 2048`.
    pub fn tone_spacing_hz(self) -> f32 {
        self.k() as f32 * 12_000.0 / 2048.0
    }

    /// Tone 0's audio frequency under the listening convention the beacon
    /// network itself recommends: dial tuned so the CW identification (and
    /// the unmodulated carrier that follows it) sits at 800 Hz audio, which
    /// keeps the CW decoder off the same frequency as a PI4 tone. Tone 0 then
    /// sits half a tone-spacing below that: `800 - 0.5 * spacing`.
    ///
    /// This is what a [`crate::decoders::pi4::decode`] search centres on first — not a
    /// blind scan of the whole passband — because it is where the signal
    /// actually is for an operator following the convention, which is nearly
    /// everyone who has ever pointed a receiver at one of these beacons.
    pub fn conventional_tone0_hz(self) -> f32 {
        800.0 - 0.5 * self.tone_spacing_hz()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Source encoding, straight from the protocol page: "OZ7IGY" padded to
    /// eight characters packs to 2 851 949 862 724.
    #[test]
    fn source_encoding_matches_the_published_worked_example() {
        assert_eq!(pack_message("OZ7IGY"), Some(2_851_949_862_724));
        assert_eq!(pack_message("OZ7IGY  "), Some(2_851_949_862_724));
    }

    #[test]
    fn unpack_is_the_inverse_of_pack_after_trimming_padding() {
        let n = pack_message("OZ7IGY").unwrap();
        assert_eq!(unpack_message(n), "OZ7IGY");
        // A full eight characters round-trips with nothing to trim.
        let n = pack_message("PE1ITR/B").unwrap();
        assert_eq!(unpack_message(n), "PE1ITR/B");
    }

    #[test]
    fn a_message_longer_than_eight_characters_is_refused() {
        assert_eq!(pack_message("123456789"), None);
    }

    #[test]
    fn a_character_outside_the_alphabet_is_refused() {
        assert_eq!(pack_message("OZ7IGY!"), None);
    }

    /// The end-to-end regression test: every stage of OZ7IGY's 144.471 MHz
    /// transmission, exactly as the protocol page's own worked example gives
    /// it — convolutionally encoded data, interleaved data, and the 146
    /// symbols. If any constant or bit order in this module ever drifts from
    /// the spec, this is what catches it.
    #[test]
    fn the_oz7igy_worked_example_matches_the_protocol_page() {
        #[rustfmt::skip]
        let want_symbols: [u8; N_SYMBOLS] = [
            2,0,1,0,0,3,3,3,3,2,3,2,1,2,1,2,0,3,2,2,0,3,2,2,0,1,1,0,0,1,
            3,1,3,0,2,1,1,3,3,1,2,0,1,3,2,1,3,3,3,2,1,2,3,1,2,1,1,0,3,2,
            0,2,0,0,1,3,3,1,3,2,3,2,3,0,2,0,0,2,1,3,3,3,1,2,3,0,0,3,0,2,
            3,2,1,0,2,0,2,1,0,0,1,1,0,2,0,2,2,3,3,2,2,2,2,3,1,0,0,1,3,3,
            0,1,3,1,2,1,3,0,3,0,3,0,1,2,2,0,2,3,1,3,2,0,0,2,1,1,
        ];
        let got = encode_reference("OZ7IGY").expect("OZ7IGY is a valid message");
        assert_eq!(got, want_symbols);
    }

    /// The receiver's half of the same round trip: deinterleaving the
    /// worked-example's transmitted data must recover its convolutionally
    /// encoded data, bit for bit.
    #[test]
    fn deinterleave_recovers_the_published_convolutional_output() {
        #[rustfmt::skip]
        let conv: [u8; N_SYMBOLS] = [
            1,1,0,1,1,0,0,1,1,1,1,1,1,1,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0,1,
            0,1,1,0,0,0,1,0,1,1,1,0,1,0,0,0,1,0,1,0,1,0,1,1,1,1,1,1,1,0,
            1,0,1,1,0,0,0,1,1,1,1,0,1,0,0,1,0,0,1,0,1,1,1,1,1,0,0,1,0,1,
            0,0,1,1,1,1,0,1,0,0,0,1,0,1,0,1,0,0,1,0,0,0,0,0,0,1,1,1,0,1,
            1,0,1,1,0,1,1,0,1,0,1,0,1,1,1,0,1,1,1,1,1,1,0,0,0,0,
        ];
        #[rustfmt::skip]
        let interleaved: [u8; N_SYMBOLS] = [
            1,0,0,0,0,1,1,1,1,1,1,1,0,1,0,1,0,1,1,1,0,1,1,1,0,0,0,0,0,0,
            1,0,1,0,1,0,0,1,1,0,1,0,0,1,1,0,1,1,1,1,0,1,1,0,1,0,0,0,1,1,
            0,1,0,0,0,1,1,0,1,1,1,1,1,0,1,0,0,1,0,1,1,1,0,1,1,0,0,1,0,1,
            1,1,0,0,1,0,1,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1,1,1,0,0,0,0,1,1,
            0,0,1,0,1,0,1,0,1,0,1,0,0,1,1,0,1,1,0,1,1,0,0,1,0,0,
        ];
        assert_eq!(deinterleave(&interleaved), conv);
    }

    #[test]
    fn tone_spacings_match_the_protocol_table() {
        assert!((Variant::Pi4.tone_spacing_hz() - 234.375).abs() < 1e-3);
        assert!((Variant::Pi4_80.tone_spacing_hz() - 468.75).abs() < 1e-3);
        assert!((Variant::Pi4_96.tone_spacing_hz() - 562.5).abs() < 1e-3);
        assert!((Variant::Pi4_120.tone_spacing_hz() - 703.125).abs() < 1e-3);
    }

    /// "In the baseband regime the nominal CW carrier is 800 Hz thus the
    /// nominal Tone0 is 682.8125 Hz" — the protocol page's own figure for the
    /// standard PI4 variant.
    #[test]
    fn conventional_tone0_matches_the_protocol_page() {
        assert!((Variant::Pi4.conventional_tone0_hz() - 682.8125).abs() < 1e-3);
    }

    #[test]
    fn charset_round_trips_every_value() {
        for v in 0..38u8 {
            assert_eq!(value_of(char_of(v)), Some(v));
        }
        // Typed in lower case, as an operator would.
        assert_eq!(value_of('a'), value_of('A'));
    }
}
