//! FT2 encode: 77-bit message → 103 tones → 12 kHz PCM.
//!
//! Line for line what `mfsk_core::ft4::encode` does — scramble, CRC-14,
//! LDPC(174,91), Gray-mapped tones, GFSK — driven by [`Ft2`]'s constants
//! instead of FT4's, so the only difference in the output is the 24 ms symbol.
//! Mirrors `lib/ft2/genft2.f90` + `lib/ft2/gen_ft2wave.f90`.

use mfsk_core::engine::dsp::gfsk::{synth_f32, synth_i16, GfskCfg};
use mfsk_core::engine::{FecCodec, FrameLayout, ModulationParams};
use mfsk_core::fec::ldpc::crc14;
use mfsk_core::fec::Ldpc174_91;

use super::Ft2;

/// 12 kHz, 288 samples/symbol, BT = 1.0, hmod = 1.0, NSPS/8 cosine ramp.
///
/// `gen_ft2wave.f90` calls `gfsk_pulse(1.0, tt)` and sets `hmod=1.0`, and
/// shapes one ramp symbol each side with a raised cosine — the same shaping
/// FT4 uses, at half the symbol length.
pub const FT2_GFSK: GfskCfg = GfskCfg {
    sample_rate: 12_000.0,
    samples_per_symbol: Ft2::NSPS as usize,
    bt: Ft2::GFSK_BT,
    hmod: Ft2::GFSK_HMOD,
    ramp_samples: Ft2::NSPS as usize / 8,
};

/// Samples in one synthesised burst: 103 × 288 = 29 664 (`NZ` in
/// `ft2_params.f90`).
pub const TONES_OUTPUT_LEN: usize = (Ft2::N_SYMBOLS as usize) * (Ft2::NSPS as usize);

/// Append CRC-14 to the 77 message bits, giving the 91 info bits LDPC encodes.
fn append_crc14(message77: &[u8; 77]) -> [u8; 91] {
    let mut bytes = [0u8; 12];
    for (i, &bit) in message77.iter().enumerate() {
        bytes[i / 8] |= (bit & 1) << (7 - i % 8);
    }
    let crc = crc14(&bytes);
    let mut info = [0u8; 91];
    info[..77].copy_from_slice(message77);
    for (i, slot) in info[77..].iter_mut().enumerate() {
        *slot = ((crc >> (13 - i)) & 1) as u8;
    }
    info
}

/// Encode a 77-bit message into FT2's 103-symbol tone sequence.
///
/// The message is XORed with the scrambling vector *before* the CRC is taken,
/// so the CRC commits to the scrambled bits — `genft2.f90:2` does
/// `msgbits=mod(msgbits+rvec,2)` and only then `encode174_91`. Getting the
/// order wrong yields a codeword the far end decodes cleanly and unpacks as
/// nonsense.
pub fn message_to_tones(message77: &[u8; 77]) -> Vec<u8> {
    let mut scrambled = *message77;
    let rvec = Ft2::INFO_SCRAMBLE_RVEC.expect("FT2 defines a scrambler");
    for (b, &r) in scrambled.iter_mut().zip(rvec) {
        *b = (*b ^ r) & 1;
    }
    let info = append_crc14(&scrambled);
    let mut cw = [0u8; 174];
    Ldpc174_91.encode(&info, &mut cw);
    mfsk_core::engine::tx::codeword_to_itone::<Ft2>(&cw)
}

/// Synthesise a 12 kHz f32 burst at tone offset `f0`. Length is
/// [`TONES_OUTPUT_LEN`].
pub fn tones_to_f32(itone: &[u8], f0: f32, amplitude: f32) -> Vec<f32> {
    debug_assert_eq!(itone.len(), Ft2::N_SYMBOLS as usize);
    synth_f32(itone, f0, amplitude, &FT2_GFSK)
}

/// Synthesise a 12 kHz i16 burst at tone offset `f0`, peaking at
/// `amplitude_i16`. Used by the round-trip tests, which decode from i16.
pub fn tones_to_i16(itone: &[u8], f0: f32, amplitude_i16: i16) -> Vec<i16> {
    debug_assert_eq!(itone.len(), Ft2::N_SYMBOLS as usize);
    synth_i16(itone, f0, amplitude_i16, &FT2_GFSK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mfsk_core::engine::SyncMode;

    #[test]
    fn tone_sequence_has_the_costas_arrays_in_place() {
        let msg = mfsk_core::msg::wsjt77::pack77("CQ", "OE1ABC", "JN88").expect("pack");
        let tones = message_to_tones(&msg);
        assert_eq!(tones.len(), Ft2::N_SYMBOLS as usize);
        assert!(tones.iter().all(|&t| t < 4), "4-FSK: tones are 0..=3");
        let SyncMode::Block(blocks) = Ft2::SYNC_MODE else {
            panic!("FT2 uses block sync")
        };
        for b in blocks {
            let at = b.start_symbol as usize;
            assert_eq!(
                &tones[at..at + b.pattern.len()],
                b.pattern,
                "Costas at {at}"
            );
        }
    }

    #[test]
    fn burst_is_2_52_seconds() {
        let msg = mfsk_core::msg::wsjt77::pack77("CQ", "OE1ABC", "JN88").expect("pack");
        let wave = tones_to_f32(&message_to_tones(&msg), 1500.0, 0.5);
        assert_eq!(wave.len(), TONES_OUTPUT_LEN);
        assert!((wave.len() as f32 / 12_000.0 - 2.472).abs() < 1e-3);
    }
}
