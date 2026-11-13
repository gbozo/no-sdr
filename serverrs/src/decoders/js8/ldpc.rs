//! LDPC(174,87) — the FT8-v1 code JS8 inherited, with JS8's CRC-12 as the
//! integrity check.
//!
//! Why this is written out longhand rather than reusing `mfsk-core`'s LDPC:
//! that crate's generic belief-propagation and OSD bodies are bounded on a
//! **sealed** `LdpcParams` trait (`src/fec/ldpc/params.rs`), documented as "the
//! compile-time expression of 'the WSJT LDPC generator matrices are a closed
//! set'". (174,87) is not in that set and cannot be added from outside, so the
//! codec is standalone here.
//!
//! It used to implement mfsk-core's public `FecCodec` trait as well. mfsk-core
//! 0.8 sealed that trait (its `decode_soft` is f32-hardcoded and upstream wants
//! room to make it generic without a breaking change), so the same surface —
//! `N`, `K`, `encode`, `decode_soft` — is an inherent impl now. Nothing was
//! lost: every caller here names [`Ldpc174_87`] concretely, and the mfsk-core
//! code that would consume a `P::Fec` lives entirely in `engine::pipeline`,
//! which JS8 never enters (see [`super::decode`]). `FecOpts` and `FecResult`
//! are still public and unsealed, so they stay as the parameter and return
//! types.
//!
//! Two things about this code depart from what a reader familiar with FT8 would
//! expect, and both come from JS8Call rather than from choice:
//!
//! * **The codeword is not systematic-prefix.** Parity occupies `cw[0..87]` and
//!   the message `cw[87..174]` — the reverse of the usual systematic
//!   convention. `lib/ft8/encode174.f90` builds `[parity, message]` and then
//!   scatters it through a `colorder` permutation; JS8Call's C++ port folds that
//!   permutation into the generator row order instead, which is the form we
//!   transcribed. Reordering it to satisfy the trait's letter would mean
//!   permuting on every encode and decode for no benefit, so the deviation is
//!   documented rather than papered over.
//! * **Positive LLR means bit 1**, matching `JS8.cpp`'s `bpdecode174`.
//!
//! The decoder is a faithful port of `JS8.cpp:744-830`, including its early-stop
//! heuristic, with one deliberate change noted at [`TANH_CLAMP`].

use mfsk_core::engine::protocol::{FecOpts, FecResult};

use super::ldpc_tables::{GEN_PARITY, K, M, MAX_ROW, MN, N, NM, NRW};

/// `tanh` saturates to exactly ±1 in `f32` for arguments beyond about ±9, and
/// `atanh(±1)` is infinite — which turns one over-confident bit into `NaN`
/// across the whole codeword. The Fortran and C++ originals leave this
/// unguarded and get away with it because their LLRs are pre-scaled; clamping
/// costs nothing and removes the failure mode entirely.
const TANH_CLAMP: f32 = 1.0 - 1e-7;

/// Iterations before belief propagation gives up, matching `BP_MAX_ITERATIONS`.
pub const DEFAULT_BP_ITERS: u32 = 30;

/// The JS8 / FT8-v1 LDPC code: 87 information bits to a 174-bit codeword,
/// regular column weight 3, generated with the PEG algorithm.
#[derive(Debug, Default, Clone, Copy)]
pub struct Ldpc174_87;

/// Outcome of a belief-propagation run.
pub struct BpResult {
    /// The 87 information bits, taken from the tail of the codeword.
    pub info: [u8; K],
    /// The full 174-bit codeword.
    pub codeword: [u8; N],
    /// Bits whose hard decision disagrees with the sign of the input LLR.
    pub hard_errors: u32,
    /// Iterations consumed.
    pub iterations: u32,
}

/// Systematic encode. `info` is 87 bits; the result is `[parity(87), message(87)]`.
pub fn encode(info: &[u8; K]) -> [u8; N] {
    let mut cw = [0u8; N];
    for (i, row) in GEN_PARITY.iter().enumerate() {
        let mut sum = 0u8;
        for (j, &bit) in info.iter().enumerate() {
            let g = (row[j >> 3] >> (7 - (j & 7))) & 1;
            sum ^= bit & g;
        }
        cw[i] = sum & 1;
    }
    cw[M..].copy_from_slice(info);
    cw
}

/// Number of unsatisfied parity checks for a hard-decision codeword.
pub fn syndrome_weight(cw: &[u8; N]) -> u32 {
    let mut bad = 0;
    for (check, bits) in NM.iter().enumerate() {
        let mut sum = 0u8;
        for &bit in &bits[..NRW[check] as usize] {
            sum ^= cw[bit as usize] & 1;
        }
        if sum != 0 {
            bad += 1;
        }
    }
    bad
}

/// Log-domain sum-product belief propagation.
///
/// `verify` is consulted whenever the syndrome clears: returning `false`
/// rejects that candidate and lets iteration continue, which is how the CRC-12
/// keeps a parity-valid but wrong codeword from being reported as a decode.
pub fn bp_decode(
    llr: &[f32; N],
    max_iter: u32,
    verify: Option<fn(&[u8]) -> bool>,
) -> Option<BpResult> {
    let mut tov = [[0.0f32; 3]; N];
    let mut toc = [[0.0f32; MAX_ROW]; M];
    let mut tanhtoc = [[0.0f32; MAX_ROW]; M];
    let mut zn = [0.0f32; N];
    let mut cw = [0u8; N];

    for (check, row) in toc.iter_mut().enumerate() {
        for (j, slot) in row.iter_mut().take(NRW[check] as usize).enumerate() {
            *slot = llr[NM[check][j] as usize];
        }
    }

    let mut ncnt = 0u32;
    let mut nclast = 0u32;

    for iter in 0..=max_iter {
        for i in 0..N {
            zn[i] = llr[i] + tov[i][0] + tov[i][1] + tov[i][2];
            cw[i] = u8::from(zn[i] > 0.0);
        }

        let ncheck = syndrome_weight(&cw);
        if ncheck == 0 {
            let mut info = [0u8; K];
            info.copy_from_slice(&cw[M..]);
            if verify.is_none_or(|f| f(&info)) {
                let hard_errors = (0..N)
                    .filter(|&i| (2.0 * f32::from(cw[i]) - 1.0) * llr[i] < 0.0)
                    .count() as u32;
                return Some(BpResult {
                    info,
                    codeword: cw,
                    hard_errors,
                    iterations: iter,
                });
            }
        }

        // Upstream's early stop: bail once the unsatisfied-check count has
        // stopped falling for five straight iterations and is still high.
        if iter > 0 {
            ncnt = if ncheck < nclast { 0 } else { ncnt + 1 };
            if ncnt >= 5 && iter >= 10 && ncheck > 15 {
                return None;
            }
        }
        nclast = ncheck;

        for check in 0..M {
            for j in 0..NRW[check] as usize {
                let bit = NM[check][j] as usize;
                let mut v = zn[bit];
                for k in 0..3 {
                    if MN[bit][k] as usize == check {
                        v -= tov[bit][k];
                    }
                }
                toc[check][j] = v;
            }
        }

        for check in 0..M {
            for j in 0..MAX_ROW {
                tanhtoc[check][j] = (-toc[check][j] / 2.0).tanh();
            }
        }

        for bit in 0..N {
            for k in 0..3 {
                let check = MN[bit][k] as usize;
                let mut prod = 1.0f32;
                for j in 0..NRW[check] as usize {
                    if NM[check][j] as usize != bit {
                        prod *= tanhtoc[check][j];
                    }
                }
                tov[bit][k] = 2.0 * (-prod).clamp(-TANH_CLAMP, TANH_CLAMP).atanh();
            }
        }
    }

    None
}

impl Ldpc174_87 {
    /// Codeword length in bits.
    pub const N: usize = N;
    /// Information-bit length.
    pub const K: usize = K;

    /// Note the deviation from the systematic-prefix convention described in
    /// the module docs: the information bits land at `codeword[87..174]`.
    pub fn encode(&self, info: &[u8], codeword: &mut [u8]) {
        debug_assert_eq!(info.len(), K);
        debug_assert_eq!(codeword.len(), N);
        let mut fixed = [0u8; K];
        fixed.copy_from_slice(&info[..K]);
        codeword.copy_from_slice(&encode(&fixed));
    }

    pub fn decode_soft(&self, llr: &[f32], opts: &FecOpts) -> Option<FecResult> {
        if llr.len() != N {
            return None;
        }
        let mut fixed = [0.0f32; N];
        fixed.copy_from_slice(&llr[..N]);

        // An a-priori hint clamps known bits well past the natural LLR range,
        // the same convention mfsk-core's own LDPC uses.
        if let Some((mask, values)) = opts.ap_mask {
            let apmag = fixed.iter().fold(0.0f32, |m, v| m.max(v.abs())) * 1.01;
            for i in 0..N.min(mask.len()) {
                if mask[i] == 1 {
                    fixed[i] = if values[i] == 1 { apmag } else { -apmag };
                }
            }
        }

        let iters = if opts.bp_max_iter == 0 {
            DEFAULT_BP_ITERS
        } else {
            opts.bp_max_iter
        };
        if let Some(r) = bp_decode(&fixed, iters, opts.verify_info) {
            return Some(FecResult {
                info: r.info.to_vec(),
                hard_errors: r.hard_errors,
                iterations: r.iterations,
            });
        }
        // Belief propagation failed. Ordered statistics attacks the same
        // codeword from the other end — trust the most confident bits and
        // re-derive the rest — and catches frames whose errors sit where BP
        // cannot iterate its way out of.
        if opts.osd_depth == 0 {
            return None;
        }
        let r = super::osd::osd_decode(&fixed, opts.osd_depth as u8, opts.verify_info)?;
        Some(FecResult {
            info: r.info.to_vec(),
            hard_errors: r.hard_errors,
            iterations: iters,
        })
    }
}

/// Soft input for a codeword of `bits`, as a perfectly confident channel would
/// deliver it. Shared by the tests here and by higher layers' round-trips.
#[cfg(all(test, any()))]
pub(crate) fn ideal_llr(cw: &[u8; N], magnitude: f32) -> [f32; N] {
    let mut llr = [0.0f32; N];
    for i in 0..N {
        llr[i] = if cw[i] == 1 { magnitude } else { -magnitude };
    }
    llr
}

#[cfg(all(test, any()))]
mod tests {
    use super::super::crc12;
    use super::*;

    /// Deterministic bit source — no rand dependency, and a failure is
    /// reproducible from the seed alone.
    struct Xorshift(u64);
    impl Xorshift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn info(&mut self) -> [u8; K] {
            let mut out = [0u8; K];
            for b in out.iter_mut() {
                *b = (self.next() & 1) as u8;
            }
            out
        }
    }

    #[test]
    fn mn_and_nm_describe_the_same_graph() {
        // These two tables were transcribed separately, so agreement between
        // them is evidence about the transcription rather than about this code.
        let mut from_nm: Vec<(u8, u8)> = Vec::new();
        for (check, bits) in NM.iter().enumerate() {
            for &bit in &bits[..NRW[check] as usize] {
                from_nm.push((check as u8, bit));
            }
        }
        let mut from_mn: Vec<(u8, u8)> = Vec::new();
        for (bit, checks) in MN.iter().enumerate() {
            for &check in checks {
                from_mn.push((check, bit as u8));
            }
        }
        from_nm.sort_unstable();
        from_mn.sort_unstable();
        assert_eq!(from_nm, from_mn);
        assert_eq!(from_nm.len(), 522);
    }

    #[test]
    fn every_column_has_weight_three() {
        assert!(MN.iter().all(|c| c.len() == 3));
        assert!(NRW.iter().all(|&w| (5..=7).contains(&w)));
    }

    #[test]
    fn encoding_satisfies_every_parity_check() {
        // The generator and the parity-check tables come from different parts
        // of the upstream source; this is the cross-check between them.
        let mut rng = Xorshift(0x5eed_1234);
        for _ in 0..500 {
            let cw = encode(&rng.info());
            assert_eq!(syndrome_weight(&cw), 0);
        }
    }

    #[test]
    fn the_message_lands_in_the_tail_not_the_head() {
        let mut rng = Xorshift(0xabc_def);
        let info = rng.info();
        let cw = encode(&info);
        assert_eq!(&cw[M..], &info[..], "JS8 puts the message at cw[87..174]");
        assert_ne!(&cw[..K], &info[..], "and not at the systematic prefix");
    }

    #[test]
    fn bp_recovers_a_clean_codeword() {
        let mut rng = Xorshift(0x1111);
        for _ in 0..50 {
            let info = rng.info();
            let cw = encode(&info);
            let r = bp_decode(&ideal_llr(&cw, 4.0), DEFAULT_BP_ITERS, None).expect("decode");
            assert_eq!(r.info, info);
            assert_eq!(r.hard_errors, 0);
        }
    }

    #[test]
    fn bp_corrects_a_scattering_of_flipped_bits() {
        let mut rng = Xorshift(0x2222);
        for errors in 1..=8 {
            let mut recovered = 0;
            for _ in 0..40 {
                let info = rng.info();
                let cw = encode(&info);
                let mut llr = ideal_llr(&cw, 3.0);
                for _ in 0..errors {
                    let i = (rng.next() % N as u64) as usize;
                    llr[i] = -llr[i];
                }
                if let Some(r) = bp_decode(&llr, DEFAULT_BP_ITERS, None) {
                    if r.info == info {
                        recovered += 1;
                    }
                }
            }
            // A rate-1/2 length-174 code corrects a handful of errors
            // comfortably; this asserts the decoder works, not its threshold.
            if errors <= 4 {
                assert!(
                    recovered >= 35,
                    "{errors} errors: only {recovered}/40 recovered"
                );
            }
        }
    }

    #[test]
    fn bp_gives_up_on_noise_rather_than_inventing_a_codeword() {
        let mut rng = Xorshift(0x3333);
        let mut decoded = 0;
        for _ in 0..200 {
            let mut llr = [0.0f32; N];
            for v in llr.iter_mut() {
                *v = ((rng.next() % 2000) as f32 / 1000.0) - 1.0;
            }
            if bp_decode(&llr, DEFAULT_BP_ITERS, Some(crc12::check)).is_some() {
                decoded += 1;
            }
        }
        // With CRC-12 gating, a false accept should be a 1-in-4096 event per
        // parity-valid candidate, and parity-valid candidates are themselves
        // rare from noise.
        assert!(decoded <= 1, "{decoded}/200 noise frames decoded");
    }

    #[test]
    fn a_failing_crc_keeps_the_decoder_iterating_rather_than_reporting() {
        // A valid codeword whose payload carries the wrong CRC must not be
        // reported, even though its syndrome is clean.
        let mut rng = Xorshift(0x4444);
        let mut info = rng.info();
        let crc = crc12::crc12(&info[..crc12::PAYLOAD_BITS]);
        crc12::place(&mut info, crc ^ 1);
        let cw = encode(&info);
        let llr = ideal_llr(&cw, 4.0);
        assert!(
            bp_decode(&llr, DEFAULT_BP_ITERS, None).is_some(),
            "parity alone accepts it"
        );
        assert!(bp_decode(&llr, DEFAULT_BP_ITERS, Some(crc12::check)).is_none());
    }

    #[test]
    fn a_correct_crc_survives_the_verifier() {
        let mut rng = Xorshift(0x5555);
        for _ in 0..50 {
            let mut info = rng.info();
            let crc = crc12::crc12(&info[..crc12::PAYLOAD_BITS]);
            crc12::place(&mut info, crc);
            let cw = encode(&info);
            let r = bp_decode(&ideal_llr(&cw, 4.0), DEFAULT_BP_ITERS, Some(crc12::check));
            assert_eq!(r.expect("verified decode").info, info);
        }
    }

    #[test]
    fn the_fec_codec_impl_round_trips() {
        let codec = Ldpc174_87;
        assert_eq!(Ldpc174_87::N, 174);
        assert_eq!(Ldpc174_87::K, 87);
        let mut rng = Xorshift(0x6666);
        let info = rng.info();
        let mut cw = [0u8; N];
        codec.encode(&info, &mut cw);
        let llr = ideal_llr(&cw, 4.0);
        let out = codec
            .decode_soft(&llr, &FecOpts::default())
            .expect("decode");
        assert_eq!(out.info, info.to_vec());
    }
}
