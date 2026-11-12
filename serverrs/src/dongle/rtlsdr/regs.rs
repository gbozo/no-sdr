//! Register addressing and the pure arithmetic behind it.
//!
//! Transcribed from osmocom `librtlsdr` `src/librtlsdr.c`.
//!
//! Everything in this module is a pure function of its arguments — no USB, no
//! device state — so all of it is unit-tested on CI without hardware. That is
//! deliberate: these encodings are where a driver silently goes wrong, and a
//! wrong mask here shows up as a mirrored spectrum three modules away.

use crate::dongle::rtlsdr::usb::Block;

// ---- control-transfer addressing ---------------------------------------

/// `wIndex` for a read from `block`.
pub fn read_index(block: Block) -> u16 {
    (block as u16) << 8
}

/// `wIndex` for a write to `block` — the `0x10` bit is the direction flag.
pub fn write_index(block: Block) -> u16 {
    ((block as u16) << 8) | 0x10
}

/// `wValue` for a demodulator register. The demod is addressed differently
/// from the other blocks: the register number moves into the high byte and
/// `0x20` marks it.
pub fn demod_value(addr: u16) -> u16 {
    (addr << 8) | 0x20
}

/// `wIndex` for a demod read — just the page number.
pub fn demod_read_index(page: u8) -> u16 {
    page as u16
}

/// `wIndex` for a demod write.
pub fn demod_write_index(page: u8) -> u16 {
    0x10 | page as u16
}

/// Encode a 1- or 2-byte register value for the wire.
///
/// **16-bit values go out big-endian while [`decode_reg`] assembles reads
/// little-endian.** That asymmetry is not a bug and must not be "fixed": it is
/// how the RTL2832U behaves, and every driver that talks to one does the same.
/// The test below pins it.
pub fn encode_reg(val: u16, len: u16) -> [u8; 2] {
    if len == 1 {
        [(val & 0xff) as u8, 0]
    } else {
        [(val >> 8) as u8, (val & 0xff) as u8]
    }
}

/// Assemble a register read. Little-endian — see [`encode_reg`].
pub fn decode_reg(data: &[u8]) -> u16 {
    match data.len() {
        0 => 0,
        1 => data[0] as u16,
        _ => ((data[1] as u16) << 8) | data[0] as u16,
    }
}

// ---- FIR filter ---------------------------------------------------------

/// Number of taps in the demodulator's decimating FIR.
pub const FIR_LEN: usize = 16;

/// librtlsdr's default FIR taps. The first 8 are 8-bit signed, the last 8 are
/// 12-bit signed.
pub const FIR_DEFAULT: [i32; FIR_LEN] = [
    -54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421,
];

/// Pack 16 taps into the 20 bytes the demod expects at page 1, `0x1c`.
///
/// The second half is the awkward part: 12-bit signed values packed three bytes
/// per two taps. It is the single easiest thing in this crate to get wrong,
/// which is why it is a pure function with a golden-value test.
pub fn pack_fir(taps: &[i32; FIR_LEN]) -> Option<[u8; 20]> {
    let mut fir = [0u8; 20];
    for i in 0..8 {
        let v = taps[i];
        if !(-128..=127).contains(&v) {
            return None;
        }
        fir[i] = v as i8 as u8;
    }
    for i in (0..8).step_by(2) {
        let v0 = taps[8 + i];
        let v1 = taps[8 + i + 1];
        if !(-2048..=2047).contains(&v0) || !(-2048..=2047).contains(&v1) {
            return None;
        }
        let o = 8 + i * 3 / 2;
        fir[o] = (v0 >> 4) as u8;
        fir[o + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) as u8;
        fir[o + 2] = v1 as u8;
    }
    Some(fir)
}

// ---- clocks and rates ---------------------------------------------------

/// Nominal RTL2832U reference crystal.
pub const RTL_XTAL_HZ: f64 = 28_800_000.0;

const TWO_POW_22: f64 = 4_194_304.0;

/// Apply a parts-per-million correction to a nominal frequency.
///
/// Shared with the tuner driver, which corrects its *own* reference the same
/// way — see the note on [`crate::dongle::rtlsdr::rtl2832::Rtl2832::set_ppm`] about the three
/// routes ppm takes into the hardware.
pub use crate::dongle::rtlsdr::r82xx::apply_ppm;

/// Whether the resampler can produce this rate.
///
/// The hardware has a hole between 300 kHz and 900 kHz and a ceiling at
/// 3.2 MHz. Rates outside these windows are rejected by the device, so catch
/// them here where we can say something useful.
pub fn rate_supported(rate_hz: u32) -> bool {
    rate_hz > 225_000 && rate_hz <= 3_200_000 && !(rate_hz > 300_000 && rate_hz <= 900_000)
}

/// Resampler ratio for a requested rate, and the rate actually produced.
///
/// The low two bits are masked off and bit 27 is duplicated into bit 28 (the
/// hardware's sign extension), so the achieved rate need not be the requested
/// one. The discrepancy is small — under 0.34 Hz anywhere in the upper window
/// — but callers report the achieved value onward regardless: it costs nothing
/// and there is no reason to add rounding error on top of the crystal
/// tolerance the ppm setting exists to trim.
pub fn resamp_ratio(xtal_hz: f64, rate_hz: u32) -> (u32, f64) {
    let ratio = ((xtal_hz * TWO_POW_22) / rate_hz as f64) as u32 & 0x0fff_fffc;
    let real = ratio | ((ratio & 0x0800_0000) << 1);
    let achieved = (xtal_hz * TWO_POW_22) / real as f64;
    (ratio, achieved)
}

/// The three bytes of the demodulator's DDC frequency, for page 1 `0x19`,
/// `0x1a` and `0x1b`.
///
/// Note the negation: the DDC shifts *down* by the tuner's intermediate
/// frequency, so a positive IF is programmed as a negative offset. Getting the
/// sign wrong mirrors the spectrum about the centre — which looks like a
/// working radio until you try to decode anything.
pub fn if_freq_regs(if_hz: f64, xtal_hz: f64) -> [u8; 3] {
    let v = -((if_hz * TWO_POW_22) / xtal_hz) as i32;
    [
        ((v >> 16) & 0x3f) as u8,
        ((v >> 8) & 0xff) as u8,
        (v & 0xff) as u8,
    ]
}

/// The two bytes of the resampler's frequency correction, for page 1 `0x3e`
/// (high) and `0x3f` (low).
///
/// This is how ppm reaches the *sample clock*. It is separate from — and
/// additional to — the corrected crystal that [`if_freq_regs`] and the tuner
/// PLL are computed from. All three must move together or the correction is
/// only partly applied; [`crate::dongle::rtlsdr::rtl2832::Rtl2832::set_ppm`] is the one place
/// that does so.
pub fn ppm_regs(ppm: i32) -> [u8; 2] {
    let offs = (-ppm as f64 * 16_777_216.0 / 1e6) as i32 as i16;
    [((offs >> 8) & 0x3f) as u8, (offs & 0xff) as u8]
}

#[cfg(test)]
mod tests {
    /// A Blog V4 clocks its tuner from the demodulator's crystal rather than
    /// the R828D's own, so the tuner driver carries its own copy of that
    /// frequency — it cannot reach into this crate for it.
    ///
    /// The two must stay equal. If they drift, a V4's PLL is computed against
    /// one reference while its resampler and DDC use another, and every
    /// frequency is quietly wrong by the ratio.
    #[test]
    fn the_blog_v4_tuner_reference_is_this_demodulators_crystal() {
        assert_eq!(
            super::RTL_XTAL_HZ,
            crate::dongle::rtlsdr::r82xx::driver::BLOG_V4_REF_HZ
        );
    }

    use super::*;

    #[test]
    fn block_indices_match_librtlsdr() {
        assert_eq!(read_index(Block::Demod), 0x0000);
        assert_eq!(write_index(Block::Demod), 0x0010);
        assert_eq!(read_index(Block::Usb), 0x0100);
        assert_eq!(write_index(Block::Usb), 0x0110);
        assert_eq!(read_index(Block::Sys), 0x0200);
        assert_eq!(write_index(Block::Sys), 0x0210);
        assert_eq!(read_index(Block::Iic), 0x0600);
        assert_eq!(write_index(Block::Iic), 0x0610);
    }

    #[test]
    fn demod_addressing() {
        assert_eq!(demod_value(0x01), 0x0120);
        assert_eq!(demod_value(0xb1), 0xb120);
        assert_eq!(demod_read_index(1), 0x0001);
        assert_eq!(demod_write_index(1), 0x0011);
        assert_eq!(demod_write_index(0), 0x0010);
    }

    /// The RTL2832U writes 16-bit registers big-endian and reads them back
    /// little-endian. This is real hardware behaviour, not a transcription
    /// slip. If this test ever fails because someone "corrected" the
    /// endianness, the fix is to revert that change, not to update the test.
    #[test]
    fn sixteen_bit_writes_are_big_endian_but_reads_are_little_endian() {
        assert_eq!(encode_reg(0x1002, 2), [0x10, 0x02]);
        assert_eq!(decode_reg(&[0x10, 0x02]), 0x0210);

        // Single-byte registers are unambiguous and round-trip.
        assert_eq!(encode_reg(0xe8, 1)[0], 0xe8);
        assert_eq!(decode_reg(&[0xe8]), 0x00e8);
    }

    #[test]
    fn fir_default_packs_to_expected_bytes() {
        let fir = pack_fir(&FIR_DEFAULT).expect("default taps are in range");
        // First 8 taps, straight int8.
        assert_eq!(&fir[..8], &[0xca, 0xdc, 0xd7, 0xd8, 0xe0, 0xf2, 0x0e, 0x35]);
        // Last 8 taps, 12-bit signed, three bytes per pair:
        //   101 = 0x065, 156 = 0x09c -> 0x06, 0x50 | 0x0, 0x9c
        assert_eq!(&fir[8..11], &[0x06, 0x50, 0x9c]);
        //   215 = 0x0d7, 273 = 0x111 -> 0x0d, 0x70 | 0x1, 0x11
        assert_eq!(&fir[11..14], &[0x0d, 0x71, 0x11]);
        //   327 = 0x147, 372 = 0x174 -> 0x14, 0x70 | 0x1, 0x74
        assert_eq!(&fir[14..17], &[0x14, 0x71, 0x74]);
        //   404 = 0x194, 421 = 0x1a5 -> 0x19, 0x40 | 0x1, 0xa5
        assert_eq!(&fir[17..20], &[0x19, 0x41, 0xa5]);
    }

    #[test]
    fn fir_rejects_out_of_range_taps() {
        let mut taps = FIR_DEFAULT;
        taps[0] = 200; // beyond int8
        assert!(pack_fir(&taps).is_none());

        let mut taps = FIR_DEFAULT;
        taps[15] = 4096; // beyond int12
        assert!(pack_fir(&taps).is_none());
    }

    #[test]
    fn rate_windows_match_the_hardware() {
        // Below the floor, in the hole, and above the ceiling.
        assert!(!rate_supported(225_000));
        assert!(!rate_supported(500_000));
        assert!(!rate_supported(900_000));
        assert!(!rate_supported(3_200_001));
        // The two usable windows.
        assert!(rate_supported(225_001));
        assert!(rate_supported(250_000));
        assert!(rate_supported(300_000));
        assert!(rate_supported(900_001));
        assert!(rate_supported(2_400_000));
        assert!(rate_supported(3_200_000));
    }

    #[test]
    fn resampler_ratio_is_exact_at_2400k() {
        // 28.8e6 * 2^22 / 2.4e6 = 50331648 = 0x03000000, already 4-aligned and
        // below the bit-27 branch.
        let (ratio, achieved) = resamp_ratio(RTL_XTAL_HZ, 2_400_000);
        assert_eq!(ratio, 0x0300_0000);
        assert!((achieved - 2_400_000.0).abs() < 1e-6, "achieved {achieved}");
    }

    /// Every rate offered in the UI must come out of the resampler as the rate
    /// asked for. That is not automatic — the ratio is truncated to a multiple
    /// of 4 — it is a property of the specific rates chosen against a 28.8 MHz
    /// reference. If someone adds a rate to `SAMPLE_RATES` that the hardware
    /// can only approximate, this test says so before a user finds it as a
    /// frequency error.
    #[test]
    fn every_offered_rate_is_representable() {
        for rate in crate::dongle::rtlsdr::config::RtlSdrConfig::SAMPLE_RATES {
            assert!(
                rate_supported(rate as u32),
                "{rate} Hz is outside the resampler's windows"
            );
            let (_, achieved) = resamp_ratio(RTL_XTAL_HZ, rate as u32);
            assert!(
                (achieved - rate).abs() < 0.01,
                "offered rate {rate} Hz is only reachable as {achieved} Hz"
            );
        }
    }

    /// A rate the hardware can only approximate must report what it actually
    /// produced rather than what was asked for.
    ///
    /// The error is small — 0.34 Hz is the worst case anywhere in the upper
    /// window, about 0.1 ppm — so this is a correctness point, not a dramatic
    /// one: it is the same order as the crystal tolerance the ppm field exists
    /// to trim, and there is no reason to add to it by rounding.
    #[test]
    fn inexact_rate_reports_what_the_hardware_produces() {
        let (_, achieved) = resamp_ratio(RTL_XTAL_HZ, 1_000_000);
        assert!(
            (achieved - 1_000_000.0).abs() > 1e-6,
            "1.0 Msps is not exactly representable, so it should not report as exact"
        );
        assert!(
            (achieved - 1_000_000.0).abs() < 1.0,
            "but it should be close: {achieved}"
        );
    }

    /// Bit 27 is duplicated into bit 28 by the hardware, so any ratio with that
    /// bit set produces a rate the naive formula does not predict. Rates at the
    /// bottom of the range are where this bites.
    #[test]
    fn resampler_ratio_sign_extension_branch() {
        let (ratio, achieved) = resamp_ratio(RTL_XTAL_HZ, 250_000);
        assert_ne!(
            ratio & 0x0800_0000,
            0,
            "250 kHz should exercise the bit-27 branch"
        );
        let real = ratio | ((ratio & 0x0800_0000) << 1);
        assert_ne!(real, ratio, "the duplicated bit must change the divisor");
        assert!(achieved > 0.0);
    }

    #[test]
    fn ppm_scales_the_crystal() {
        assert_eq!(apply_ppm(RTL_XTAL_HZ, 0), RTL_XTAL_HZ);
        assert!((apply_ppm(RTL_XTAL_HZ, 100) - 28_802_880.0).abs() < 1e-6);
        assert!((apply_ppm(RTL_XTAL_HZ, -100) - 28_797_120.0).abs() < 1e-6);
    }

    /// What direct sampling above the ADC's Nyquist limit rides on — the
    /// reason 17 m and 15 m are reachable at all on a V3 (issue #179).
    ///
    /// The DDC's word is a 22-bit two's complement fraction of the crystal, so
    /// it spans ±14.4 MHz and a dial above that wraps into the negative half.
    /// Sampling puts the wanted signal at exactly `dial - 28.8 MHz`, so the
    /// wrap *is* the tuning: it lands on the second Nyquist zone's image of the
    /// band, the right way up, and nothing downstream has to be told.
    #[test]
    fn a_dial_above_nyquist_wraps_onto_its_own_alias() {
        /// The frequency the programmed word really represents.
        fn programmed_hz(r: [u8; 3]) -> f64 {
            let raw = ((r[0] as i32) << 16) | ((r[1] as i32) << 8) | r[2] as i32;
            let signed = if raw & (1 << 21) != 0 {
                raw - (1 << 22)
            } else {
                raw
            };
            -(signed as f64) * RTL_XTAL_HZ / TWO_POW_22
        }

        // Below Nyquist the word is the dial itself.
        let lsb = RTL_XTAL_HZ / TWO_POW_22;
        for dial in [1_840_000.0, 7_074_000.0, 14_074_000.0] {
            let got = programmed_hz(if_freq_regs(dial, RTL_XTAL_HZ));
            assert!(
                (got - dial).abs() <= lsb,
                "{dial} Hz programmed as {got} Hz"
            );
        }
        // Above it, the alias — 17 m, 15 m and 12 m, the bands with no tuner
        // under them.
        for dial in [18_100_000.0, 21_074_000.0, 24_915_000.0] {
            let want = dial - RTL_XTAL_HZ;
            let got = programmed_hz(if_freq_regs(dial, RTL_XTAL_HZ));
            assert!(got < 0.0, "{dial} Hz must fold into the negative half");
            assert!(
                (got - want).abs() <= lsb,
                "{dial} Hz aliases to {want} Hz, programmed {got}"
            );
        }
    }

    #[test]
    fn if_freq_regs_negate_and_mask() {
        // The R82xx's default 3.57 MHz low IF.
        // -(3.57e6 * 2^22 / 28.8e6) = -519918 = 0xfff81112, with the top byte
        // masked to 6 bits.
        assert_eq!(if_freq_regs(3_570_000.0, RTL_XTAL_HZ), [0x38, 0x11, 0x12]);
        // The 8 MHz filter's 4.57 MHz IF, for the same reason.
        assert_eq!(if_freq_regs(4_570_000.0, RTL_XTAL_HZ), [0x35, 0xd8, 0x2e]);
        // Zero IF (a hypothetical zero-IF tuner, or direct sampling at DC)
        // programs a zero offset.
        assert_eq!(if_freq_regs(0.0, RTL_XTAL_HZ), [0x00, 0x00, 0x00]);
        // The top byte is always masked to 6 bits.
        for hz in [1e6, 3.57e6, 4.57e6, 14e6] {
            assert_eq!(if_freq_regs(hz, RTL_XTAL_HZ)[0] & 0xc0, 0);
        }
    }

    #[test]
    fn ppm_regs_sign_and_mask() {
        assert_eq!(ppm_regs(0), [0x00, 0x00]);
        // +ppm is written as a negative offset, and vice versa.
        let pos = ppm_regs(50);
        let neg = ppm_regs(-50);
        assert_ne!(pos, neg);
        assert_eq!(neg, [0x03, 0x46]); // +50 ppm of 2^24 = 838, 0x0346
                                       // The high byte is masked to 6 bits at every magnitude we offer.
        for ppm in [-200, -100, -1, 1, 100, 200] {
            assert_eq!(ppm_regs(ppm)[0] & 0xc0, 0, "ppm {ppm}");
        }
    }
}
