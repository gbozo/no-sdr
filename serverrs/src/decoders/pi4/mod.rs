//! PI4 — the "Next Generation Beacon" digital mode.
//!
//! Adapted from `sdroxide-digi`'s PI4 module (GPL-3.0-or-later); protocol
//! constants and decode stages are unchanged, only the crate paths are local.
#![allow(dead_code)]
//!
//! 4-FSK, 146 symbols at 166.667 ms each (24.333 s), rate-1/2 K=32
//! convolutionally coded and interleaved, carrying up to eight characters —
//! ordinarily a beacon's callsign. Explicitly built as a JT4 derivative for
//! the IARU Region 1 VHF Committee's one-minute mixed-mode beacon sequence
//! (PI4, then CW identification, then an unmodulated carrier), and it shows:
//! the FEC is the exact Layland-Lushbaugh rate-1/2 K=32 code WSPR and JT9
//! both use, just with a shorter message.
//!
//! ## What is here and what is not
//!
//! [`spec`] is the protocol itself — the sync vector, the message alphabet
//! and its base-38 packing, and the FEC wired up over `mfsk-core`'s generic
//! conv-code primitives rather than a re-implementation of them (see that
//! module's doc comment for why, and for the worked-example regression test
//! that keeps it honest against the spec). [`demod`] is the audio-domain
//! tone measurement — an FFT-resolution coarse scan plus an exact-frequency
//! Goertzel refinement. [`decode`] is the search that ties them together:
//! start time × beacon variant × tone-0 frequency, scored cheaply by sync
//! agreement before anything pays for a real Fano attempt, and gated by
//! [`decode::fit_of`] against the FEC's lack of a CRC — see that module's doc
//! comment.
//!
//! Decode only. There is no PI4 transmitter here: this is a receiving
//! amateur's decoder for a beacon network's signal, not a beacon
//! implementation.

pub mod decode;
pub mod demod;
pub mod spec;


