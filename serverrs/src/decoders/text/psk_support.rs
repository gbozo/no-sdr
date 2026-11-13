//! Small support types needed by the PSK implementation.
//!
//! PSK31 itself uses `VaricodeRx` and the local FIR/decoder helpers. The full
//! upstream PSK module also carries PSKR/PSK8 helpers; these two lightweight
//! stand-ins keep those compile paths present without importing the large
//! MFSK receiver that only the unused PSKR paths need.

#![allow(dead_code)]

pub(crate) struct Interleaver {
    size: usize,
    depth: usize,
    forward: bool,
    table: Vec<u8>,
}

impl Interleaver {
    pub(crate) fn new(size: usize, depth: usize, forward: bool) -> Self {
        Self {
            size,
            depth,
            forward,
            table: vec![
                if forward { 0 } else { 128 };
                size.saturating_mul(size).saturating_mul(depth)
            ],
        }
    }

    /// One step of the block interleaver. The PSK31 path does not use this;
    /// the compact implementation is enough for the unused PSKR surface.
    pub(crate) fn symbols(&mut self, p: &mut [u8]) {
        if self.size == 0 || self.depth == 0 {
            return;
        }
        for value in p.iter_mut().take(self.size) {
            let index = (*value as usize) % self.table.len().max(1);
            if self.forward {
                std::mem::swap(value, &mut self.table[index]);
            } else {
                *value = self.table[index];
            }
        }
    }
}

/// Minimal MFSK word table retained for the unused PSK8/PSKR transmit paths.
/// PSK31 uses its own Varicode table.
pub(crate) fn mfsk_word(_c: u8) -> (u32, usize) {
    (0, 0)
}

pub(crate) fn varicode_bits(_c: char) -> Vec<u8> {
    Vec::new()
}

/// Minimal MFSK varicode sink retained for the PSKR compile paths. PSK31 uses
/// its own `VaricodeRx`; this intentionally does not emit text.
pub(crate) struct MfskVaricodeRx {
    shreg: u32,
}

impl MfskVaricodeRx {
    pub(crate) fn new() -> Self {
        Self { shreg: 0 }
    }

    pub(crate) fn push_bit(&mut self, bit: u8) -> Option<char> {
        self.shreg = (self.shreg << 1) | (bit & 1) as u32;
        if self.shreg > 0x1_0000 {
            self.shreg = 1;
        }
        None
    }
}
