//! Constant tables for the R820T/R820T2/R828D, transcribed verbatim from
//! osmocom `librtlsdr` `src/tuner_r82xx.c` and `src/librtlsdr.c` at commit
//! `84195f169f5b4b7dc06a10efb1e210d02b49e51c`.
//!
//! Nothing here is derived or simplified. If a value looks wrong, check it
//! against that commit rather than against intuition — several of these are
//! empirical (the gain steps were measured on a Racal 6103E test set, not
//! computed) and the tracking-filter table is silicon-specific.

/// The shadow register file starts at R5 and covers 30 registers (R5..R34).
pub const REG_SHADOW_START: u8 = 5;
pub const NUM_REGS: usize = 30;

/// Chip revision written to R19[5:0] during initialisation.
pub const VER_NUM: u8 = 49;

/// Initial register values, starting at [`REG_SHADOW_START`]. Only 27 values
/// are specified upstream; the remaining three registers initialise to zero.
pub const INIT_ARRAY: [u8; NUM_REGS] = [
    0x83, 0x32, 0x75, // R5  to R7
    0xc0, 0x40, 0xd6, 0x6c, // R8  to R11
    0xf5, 0x63, 0x75, 0x68, // R12 to R15
    0x6c, 0x83, 0x80, 0x00, // R16 to R19
    0x0f, 0x00, 0xc0, 0x30, // R20 to R23
    0x48, 0xcc, 0x60, 0x00, // R24 to R27
    0x54, 0xae, 0x4a, 0xc0, // R28 to R31
    0x00, 0x00, 0x00, // R32 to R34 (not specified upstream)
];

/// One entry of the tracking-filter / mux table, selected by LO frequency.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // the 20 pF and 10 pF caps belong to crystal-load modes
                    // rtlsdr never selects; kept so the table matches upstream
                    // row for row and can be diffed against it.
pub struct FreqRange {
    /// Lower bound of the range, in MHz.
    pub freq_mhz: u32,
    pub open_d: u8,
    pub rf_mux_ploy: u8,
    pub tf_c: u8,
    pub xtal_cap20p: u8,
    pub xtal_cap10p: u8,
    pub xtal_cap0p: u8,
}

/// The tracking-filter table. 21 entries — note the 450 MHz and 650 MHz rows,
/// which are easy to miss when reading the upstream source by eye.
pub const FREQ_RANGES: [FreqRange; 21] = [
    FreqRange {
        freq_mhz: 0,
        open_d: 0x08,
        rf_mux_ploy: 0x02,
        tf_c: 0xdf,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 50,
        open_d: 0x08,
        rf_mux_ploy: 0x02,
        tf_c: 0xbe,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 55,
        open_d: 0x08,
        rf_mux_ploy: 0x02,
        tf_c: 0x8b,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 60,
        open_d: 0x08,
        rf_mux_ploy: 0x02,
        tf_c: 0x7b,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 65,
        open_d: 0x08,
        rf_mux_ploy: 0x02,
        tf_c: 0x69,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 70,
        open_d: 0x08,
        rf_mux_ploy: 0x02,
        tf_c: 0x58,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 75,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x44,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 80,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x44,
        xtal_cap20p: 0x02,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 90,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x34,
        xtal_cap20p: 0x01,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 100,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x34,
        xtal_cap20p: 0x01,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 110,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x24,
        xtal_cap20p: 0x01,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 120,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x24,
        xtal_cap20p: 0x01,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 140,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x14,
        xtal_cap20p: 0x01,
        xtal_cap10p: 0x01,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 180,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x13,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 220,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x13,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 250,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x11,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 280,
        open_d: 0x00,
        rf_mux_ploy: 0x02,
        tf_c: 0x00,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 310,
        open_d: 0x00,
        rf_mux_ploy: 0x41,
        tf_c: 0x00,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 450,
        open_d: 0x00,
        rf_mux_ploy: 0x41,
        tf_c: 0x00,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 588,
        open_d: 0x00,
        rf_mux_ploy: 0x40,
        tf_c: 0x00,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
    FreqRange {
        freq_mhz: 650,
        open_d: 0x00,
        rf_mux_ploy: 0x40,
        tf_c: 0x00,
        xtal_cap20p: 0x00,
        xtal_cap10p: 0x00,
        xtal_cap0p: 0x00,
    },
];

/// The tracking-filter entry for an LO frequency.
pub fn freq_range_for(lo_hz: f64) -> &'static FreqRange {
    let mhz = (lo_hz / 1e6) as u32;
    let mut i = 0;
    while i < FREQ_RANGES.len() - 1 && mhz >= FREQ_RANGES[i + 1].freq_mhz {
        i += 1;
    }
    &FREQ_RANGES[i]
}

/// Incremental LNA gain per index step, in tenths of a dB. Measured, not
/// computed — the steps are famously non-monotonic.
pub const LNA_GAIN_STEPS: [i32; 16] = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];

/// Incremental mixer gain per index step, in tenths of a dB. The last step is
/// negative on real silicon; that is not a typo.
pub const MIXER_GAIN_STEPS: [i32; 16] = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];

/// The gain values the LNA/mixer walk can actually reach, in tenths of a dB.
/// From `librtlsdr.c`'s `r82xx_gains`. A requested gain is snapped to the
/// nearest of these before being applied, and the snapped value is what gets
/// reported back so the UI slider settles somewhere real.
pub const GAINS_TENTH_DB: [i32; 29] = [
    0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372,
    386, 402, 421, 434, 439, 445, 480, 496,
];

/// Snap a gain in dB to the nearest value the hardware can produce, returning
/// tenths of a dB.
pub fn snap_gain_tenth_db(db: f64) -> i32 {
    let want = (db * 10.0).round() as i32;
    *GAINS_TENTH_DB
        .iter()
        .min_by_key(|g| (*g - want).abs())
        .expect("the gain table is never empty")
}

/// IF low-pass filter corners, in Hz, for the narrow-bandwidth branch of
/// `set_bandwidth`.
pub const IF_LOW_PASS_BW: [i32; 10] = [
    1_700_000, 1_600_000, 1_550_000, 1_450_000, 1_200_000, 900_000, 700_000, 550_000, 450_000,
    350_000,
];

/// High-pass corner contributions used by the same branch.
pub const FILT_HP_BW1: i32 = 350_000;
pub const FILT_HP_BW2: i32 = 380_000;

/// Reverse the bits of a byte.
///
/// The R82xx returns its registers bit-reversed on read — a property of the
/// part, not of the I2C layer. Writes are *not* reversed.
pub fn bitrev(byte: u8) -> u8 {
    const LUT: [u8; 16] = [
        0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf,
    ];
    (LUT[(byte & 0xf) as usize] << 4) | LUT[(byte >> 4) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitrev_matches_the_reference_lut() {
        assert_eq!(bitrev(0x00), 0x00);
        assert_eq!(bitrev(0xff), 0xff);
        assert_eq!(bitrev(0x01), 0x80);
        assert_eq!(bitrev(0x80), 0x01);
        assert_eq!(bitrev(0x69), 0x96);
        assert_eq!(bitrev(0x0f), 0xf0);
        // Reversal is its own inverse, at every input.
        for b in 0..=255u8 {
            assert_eq!(bitrev(bitrev(b)), b, "byte {b:#04x}");
        }
    }

    /// The tuner probe compares the **raw** byte against 0x69, while
    /// [`super::r82xx::R82xx::read`] reverses. Reversing in both places makes
    /// every dongle report as an unsupported tuner, which is exactly what
    /// happened the first time this ran against real hardware — so pin the
    /// distinction rather than relying on remembering it.
    #[test]
    fn probe_value_is_not_bit_reversed() {
        assert_ne!(bitrev(0x69), 0x69, "0x69 is not a bitrev fixed point");
        assert_eq!(bitrev(0x69), 0x96);
    }

    #[test]
    fn init_array_covers_the_whole_shadow() {
        assert_eq!(INIT_ARRAY.len(), NUM_REGS);
        assert_eq!(INIT_ARRAY[0], 0x83, "R5");
        assert_eq!(INIT_ARRAY[26], 0xc0, "R31, the last specified value");
        assert_eq!(
            &INIT_ARRAY[27..],
            &[0, 0, 0],
            "R32..R34 are unspecified upstream"
        );
    }

    #[test]
    fn freq_range_lookup_picks_the_right_row() {
        assert_eq!(freq_range_for(0.0).freq_mhz, 0);
        assert_eq!(freq_range_for(49.9e6).freq_mhz, 0);
        assert_eq!(freq_range_for(50.0e6).freq_mhz, 50);
        assert_eq!(freq_range_for(54.9e6).freq_mhz, 50);
        assert_eq!(freq_range_for(100.0e6).freq_mhz, 100);
        assert_eq!(freq_range_for(145.0e6).freq_mhz, 140);
        assert_eq!(freq_range_for(435.0e6).freq_mhz, 310);
        assert_eq!(freq_range_for(600.0e6).freq_mhz, 588);
        // Above the last row the lookup must clamp, not run off the end.
        assert_eq!(freq_range_for(1_800e6).freq_mhz, 650);
    }

    /// Every boundary in the table, from both sides. An off-by-one here
    /// mis-selects the tracking filter and costs sensitivity in a way that is
    /// very hard to spot on a waterfall.
    #[test]
    fn freq_range_boundaries_are_exact() {
        for w in FREQ_RANGES.windows(2) {
            let edge = w[1].freq_mhz as f64 * 1e6;
            assert_eq!(freq_range_for(edge).freq_mhz, w[1].freq_mhz, "at {edge}");
            assert_eq!(
                freq_range_for(edge - 1e6).freq_mhz,
                w[0].freq_mhz,
                "below {edge}"
            );
        }
    }

    #[test]
    fn gain_table_snapping() {
        // Every entry snaps to itself.
        for g in GAINS_TENTH_DB {
            assert_eq!(snap_gain_tenth_db(g as f64 / 10.0), g);
        }
        // Clamps at both ends rather than extrapolating.
        assert_eq!(snap_gain_tenth_db(-20.0), 0);
        assert_eq!(snap_gain_tenth_db(100.0), 496);
        // Snapping is monotonic across the whole range.
        let mut prev = i32::MIN;
        let mut db = 0.0;
        while db <= 50.0 {
            let g = snap_gain_tenth_db(db);
            assert!(g >= prev, "snapping went backwards at {db} dB");
            prev = g;
            db += 0.1;
        }
    }

    /// The gain table in `librtlsdr.c` must agree with what the LNA/mixer walk
    /// in `tuner_r82xx.c` can actually produce — they live in different files
    /// upstream and nothing enforces the correspondence there.
    #[test]
    fn gain_table_matches_the_lna_mixer_walk() {
        let mut reachable = vec![0i32];
        let mut total = 0;
        let (mut lna, mut mix) = (0usize, 0usize);
        for _ in 0..15 {
            lna += 1;
            total += LNA_GAIN_STEPS[lna];
            reachable.push(total);
            mix += 1;
            total += MIXER_GAIN_STEPS[mix];
            reachable.push(total);
        }
        for g in GAINS_TENTH_DB {
            assert!(
                reachable.contains(&g),
                "{g} tenths of a dB is offered but the index walk cannot reach it"
            );
        }
    }
}
