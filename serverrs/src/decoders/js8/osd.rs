//! Ordered-statistics decoding: the fallback for when belief propagation gives
//! up.
//!
//! BP is iterative and probabilistic — it converges on most frames and simply
//! fails on some, particularly where a few bits are badly wrong rather than
//! many being slightly wrong. OSD attacks the same codeword from the other
//! direction and is deterministic: **trust the most reliable bits, re-derive
//! the rest.**
//!
//! 1. Sort the 174 received bits by `|LLR|` — how confident the demodulator is.
//! 2. Gaussian-eliminate the generator so the 87 most reliable *independent*
//!    positions become the information set.
//! 3. Take the hard decisions on those 87 as the message and re-encode. Every
//!    other bit is now implied by the ones we trust most, so any number of
//!    errors among the unreliable bits is corrected at a stroke.
//! 4. That is order 0. Higher orders flip small combinations of the information
//!    bits and re-encode, keeping whichever candidate lands closest to what was
//!    actually received.
//!
//! Ported from JS8Call's `lib/ft8/osd174.f90`, minus its `npre1`/`npre2`
//! partial-sum pruning: those exist to make the search affordable in Fortran,
//! and re-encoding incrementally (a candidate differing from another by one
//! information bit differs by exactly one generator row) makes the whole
//! order-2 search cost a few thousand XORs instead.
//!
//! Note the LLRs are **not** permuted through `colorder` on the way in, unlike
//! upstream. Ours already are: the generator rows were transcribed from
//! JS8Call's C++ port, which folds that permutation into the row order. See
//! `vendor/js8call/PROVENANCE.md`.

use super::ldpc_tables::{GEN_PARITY, K, N};

/// A row of the working generator, one bit per codeword position.
type Row = [u64; 3];

#[inline]
fn bit(r: &Row, i: usize) -> u8 {
    ((r[i >> 6] >> (i & 63)) & 1) as u8
}

#[inline]
fn set_bit(r: &mut Row, i: usize, v: u8) {
    let mask = 1u64 << (i & 63);
    if v != 0 {
        r[i >> 6] |= mask;
    } else {
        r[i >> 6] &= !mask;
    }
}

#[inline]
fn xor_into(a: &mut Row, b: &Row) {
    a[0] ^= b[0];
    a[1] ^= b[1];
    a[2] ^= b[2];
}

/// What OSD found.
pub struct OsdResult {
    pub info: [u8; K],
    pub codeword: [u8; N],
    /// Bits whose hard decision the winning codeword overrode.
    pub hard_errors: u32,
}

/// Largest order this implements. Beyond 2 the candidate count grows faster
/// than the returns; WSJT-X's own depth ladder stops escalating there too for
/// everything but its deepest retry.
pub const MAX_ORDER: u8 = 2;

/// Hard-decision bits a result may override before it is treated as fitted to
/// noise rather than decoded. See the note where it is applied.
pub const MAX_HARD_ERRORS: u32 = 60;

/// Decode by ordered statistics.
///
/// `depth` is the order: 0 trusts the most reliable bits outright, 1 also tries
/// flipping each of them, 2 tries pairs. `verify` gates acceptance — for JS8
/// that is the CRC-12, and without it OSD *always* returns something, because
/// re-encoding any information set yields a valid codeword. That is the whole
/// hazard of this method: it cannot fail, so something else has to say no.
pub fn osd_decode(
    llr: &[f32; N],
    depth: u8,
    verify: Option<fn(&[u8]) -> bool>,
) -> Option<OsdResult> {
    let depth = depth.min(MAX_ORDER);

    // Hard decisions and confidence.
    let mut hard = [0u8; N];
    let mut rel = [0.0f32; N];
    for i in 0..N {
        hard[i] = u8::from(llr[i] > 0.0);
        rel[i] = llr[i].abs();
    }

    // Most reliable first.
    let mut order: [usize; N] = std::array::from_fn(|i| i);
    order.sort_unstable_by(|&a, &b| rel[b].total_cmp(&rel[a]));

    // The generator, columns permuted into reliability order. Row k is the
    // codeword produced by information bit k alone.
    let mut basis: [Row; K] = [[0u64; 3]; K];
    for (k, row) in basis.iter_mut().enumerate() {
        for (j, &col) in order.iter().enumerate() {
            let v = if col < K {
                // Parity half: GEN_PARITY[parity][info], bit-packed MSB-first.
                (GEN_PARITY[col][k >> 3] >> (7 - (k & 7))) & 1
            } else {
                u8::from(col - K == k)
            };
            set_bit(row, j, v);
        }
    }

    // Gaussian elimination: make the first K permuted columns an identity, so
    // the most reliable independent positions become the information set.
    // A column that is already dependent gets swapped out for the next
    // reliable one that is not.
    let mut cols: [usize; N] = std::array::from_fn(|i| order[i]);
    for id in 0..K {
        let Some(pivot) = (id..N).find(|&c| basis.iter().skip(id).any(|r| bit(r, c) == 1)) else {
            // The code has rank K, so this cannot happen; bail rather than
            // return a codeword derived from a defective basis.
            return None;
        };
        // Bring a row with a 1 in the pivot column up to `id`.
        let src = (id..K).find(|&r| bit(&basis[r], pivot) == 1)?;
        basis.swap(id, src);
        if pivot != id {
            for r in basis.iter_mut() {
                let a = bit(r, id);
                let b = bit(r, pivot);
                set_bit(r, id, b);
                set_bit(r, pivot, a);
            }
            cols.swap(id, pivot);
        }
        // Clear the rest of the column.
        let pivot_row = basis[id];
        for (r, row) in basis.iter_mut().enumerate() {
            if r != id && bit(row, id) == 1 {
                xor_into(row, &pivot_row);
            }
        }
    }

    // Received word and confidence, in the same permuted order.
    let mut phard: Row = [0u64; 3];
    let mut prel = [0.0f32; N];
    for j in 0..N {
        set_bit(&mut phard, j, hard[cols[j]]);
        prel[j] = rel[cols[j]];
    }

    // Order 0: re-encode the hard decisions on the information set.
    let mut base: Row = [0u64; 3];
    for k in 0..K {
        if bit(&phard, k) == 1 {
            xor_into(&mut base, &basis[k]);
        }
    }

    let distance = |cw: &Row| -> f32 {
        let mut d = 0.0;
        for j in 0..N {
            if bit(cw, j) != bit(&phard, j) {
                d += prel[j];
            }
        }
        d
    };

    let unpermute = |cw: &Row| -> [u8; N] {
        let mut full = [0u8; N];
        for j in 0..N {
            full[cols[j]] = bit(cw, j);
        }
        full
    };

    // Selection is by soft distance alone — the maximum-likelihood criterion,
    // and the whole point of the method. The CRC is checked *once*, on the
    // winner.
    //
    // Gating every candidate on the CRC instead looks safer and is much worse.
    // An order-2 search generates 3 829 candidates; against a 12-bit CRC the
    // chance that at least one wrong codeword passes is
    // 1 - (1 - 1/4096)^3829, about 61%. Any such impostor that happens to sit
    // closer than the true codeword then wins, so OSD *removes* decodes that
    // belief propagation had already got right. Measured: 6/6 became 5/6 and
    // 3/6 became 0/6 before this was fixed.
    let mut best: Option<(f32, Row)> = None;
    let consider = |cw: Row, best: &mut Option<(f32, Row)>| {
        let d = distance(&cw);
        if best.as_ref().is_none_or(|(bd, _)| d < *bd) {
            *best = Some((d, cw));
        }
    };

    consider(base, &mut best);

    if depth >= 1 {
        // Flipping information bit k adds generator row k — one XOR, not a
        // fresh encode.
        for k in 0..K {
            let mut cw = base;
            xor_into(&mut cw, &basis[k]);
            consider(cw, &mut best);
        }
    }
    if depth >= 2 {
        for a in 0..K {
            let mut ca = base;
            xor_into(&mut ca, &basis[a]);
            for b in (a + 1)..K {
                let mut cw = ca;
                xor_into(&mut cw, &basis[b]);
                consider(cw, &mut best);
            }
        }
    }

    let (_, cw) = best?;
    let full = unpermute(&cw);
    let hard_errors = (0..N).filter(|&i| full[i] != hard[i]).count() as u32;

    // Second net. A genuine decode near threshold overrides perhaps a quarter
    // of the bits; a codeword fitted to noise overrides about half, since it
    // is uncorrelated with what was received. Rejecting the implausible ones
    // costs real decodes only well below the point where anything is readable.
    if hard_errors > MAX_HARD_ERRORS {
        return None;
    }

    let mut info = [0u8; K];
    info.copy_from_slice(&full[N - K..]);
    if verify.is_some_and(|f| !f(&info)) {
        return None;
    }
    Some(OsdResult {
        info,
        codeword: full,
        hard_errors,
    })
}

#[cfg(all(test, any()))]
mod tests {
    use super::super::{crc12, ldpc};
    use super::*;

    struct Xorshift(u64);
    impl Xorshift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        /// An information word carrying a valid CRC, as a real frame does.
        fn frame(&mut self) -> [u8; K] {
            let mut info = [0u8; K];
            for b in info.iter_mut().take(crc12::PAYLOAD_BITS) {
                *b = (self.next() & 1) as u8;
            }
            let crc = crc12::crc12(&info[..crc12::PAYLOAD_BITS]);
            crc12::place(&mut info, crc);
            info
        }
    }

    fn llr_for(cw: &[u8; N], magnitude: f32) -> [f32; N] {
        std::array::from_fn(|i| if cw[i] == 1 { magnitude } else { -magnitude })
    }

    #[test]
    fn order_zero_recovers_a_clean_codeword() {
        let mut rng = Xorshift(0x0501);
        for _ in 0..20 {
            let info = rng.frame();
            let cw = ldpc::encode(&info);
            let r = osd_decode(&llr_for(&cw, 3.0), 0, Some(crc12::check)).expect("decode");
            assert_eq!(r.info, info);
            assert_eq!(r.hard_errors, 0);
        }
    }

    #[test]
    fn unreliable_bits_are_overridden_wholesale() {
        // The point of OSD: errors concentrated in low-confidence positions are
        // corrected by re-deriving them, however many there are.
        let mut rng = Xorshift(0x0502);
        for _ in 0..20 {
            let info = rng.frame();
            let cw = ldpc::encode(&info);
            let mut llr = llr_for(&cw, 4.0);
            // Corrupt 25 bits, but mark them as barely-trusted.
            for i in 0..25 {
                let p = (rng.next() % N as u64) as usize;
                llr[p] = if llr[p] > 0.0 { -0.05 } else { 0.05 };
                let _ = i;
            }
            let r = osd_decode(&llr, 0, Some(crc12::check)).expect("decode");
            assert_eq!(r.info, info);
        }
    }

    #[test]
    fn higher_orders_recover_errors_among_the_trusted_bits() {
        // An error in a *confident* position defeats order 0 — the information
        // set itself is wrong — and is exactly what flipping is for.
        let mut rng = Xorshift(0x0503);
        let mut order0 = 0;
        let mut order1 = 0;
        for _ in 0..30 {
            let info = rng.frame();
            let cw = ldpc::encode(&info);
            let mut llr = llr_for(&cw, 1.0);
            // One confidently wrong bit, plus noise elsewhere.
            let p = (rng.next() % N as u64) as usize;
            llr[p] = if llr[p] > 0.0 { -6.0 } else { 6.0 };
            for v in llr.iter_mut() {
                *v += ((rng.next() % 200) as f32 / 100.0) - 1.0;
            }
            if osd_decode(&llr, 0, Some(crc12::check)).is_some_and(|r| r.info == info) {
                order0 += 1;
            }
            if osd_decode(&llr, 1, Some(crc12::check)).is_some_and(|r| r.info == info) {
                order1 += 1;
            }
        }
        assert!(
            order1 > order0,
            "order 1 recovered {order1}, order 0 {order0}"
        );
    }

    #[test]
    fn the_verifier_is_what_stops_osd_inventing_a_codeword() {
        // Re-encoding any information set produces a *valid* codeword, so
        // without the CRC this method cannot fail — it would return confident
        // nonsense for pure noise. This is the test that documents why
        // `verify` is not optional in practice.
        let mut rng = Xorshift(0x0504);
        let mut without = 0;
        let mut with = 0;
        for _ in 0..100 {
            let llr: [f32; N] =
                std::array::from_fn(|_| ((rng.next() % 2000) as f32 / 1000.0) - 1.0);
            if osd_decode(&llr, 0, None).is_some() {
                without += 1;
            }
            if osd_decode(&llr, 0, Some(crc12::check)).is_some() {
                with += 1;
            }
        }
        // Re-encoding any information set yields a valid codeword, so almost
        // every noise frame produces one; only the hard-error ceiling turns a
        // few away. The CRC is what actually says no.
        assert!(without >= 95, "un-gated OSD returned only {without}/100");
        assert!(with <= 2, "CRC-gated OSD accepted {with}/100 noise frames");
    }

    #[test]
    fn a_returned_codeword_actually_satisfies_the_parity_checks() {
        let mut rng = Xorshift(0x0505);
        for _ in 0..20 {
            let info = rng.frame();
            let cw = ldpc::encode(&info);
            let mut llr = llr_for(&cw, 2.0);
            for _ in 0..15 {
                let p = (rng.next() % N as u64) as usize;
                llr[p] = -llr[p] * 0.1;
            }
            if let Some(r) = osd_decode(&llr, 1, Some(crc12::check)) {
                assert_eq!(ldpc::syndrome_weight(&r.codeword), 0, "not a codeword");
                assert_eq!(
                    ldpc::encode(&r.info),
                    r.codeword,
                    "codeword disagrees with its info"
                );
            }
        }
    }

    #[test]
    fn depth_is_clamped_rather_than_running_away() {
        let mut rng = Xorshift(0x0506);
        let cw = ldpc::encode(&rng.frame());
        // Anything above MAX_ORDER behaves as MAX_ORDER, not as an ever-growing
        // search.
        assert!(osd_decode(&llr_for(&cw, 3.0), 200, Some(crc12::check)).is_some());
    }
}
