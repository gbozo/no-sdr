//! G3RUH 9600 baud packet receiver.
//!
//! Adapted from `sdroxide-dsp`'s `g3ruh.rs` (GPL-compatible). This is the
//! discriminator-audio half only: descramble, slice, recover the bit clock and
//! hand line levels to `sdroxide_ax25::Deframer`. The transmit chain is not
//! needed by a receive-only WebSDR.

#![allow(dead_code)]

use super::afsk::lowpass_taps;

pub const BAUD: f64 = 9600.0;

const TAP_A: u32 = 16;
const TAP_B: u32 = 11;
const CLOCK_TRACK_GAIN: f32 = 0.18;
const STROBE_PHASE: f32 = 0.5;
const DC_SMOOTH: f32 = 7.0e-4;
const MAG_SMOOTH: f32 = 1.0e-3;

#[derive(Debug, Default, Clone, Copy)]
struct Scrambler {
    lfsr: u32,
}

impl Scrambler {
    fn descramble(&mut self, bit: bool) -> bool {
        let out = bit ^ (self.lfsr >> TAP_A & 1 != 0) ^ (self.lfsr >> TAP_B & 1 != 0);
        self.lfsr = (self.lfsr << 1) | u32::from(bit);
        out
    }
}

/// Minimal streaming real FIR, matching the shaping filter used by the G3RUH
/// receiver in sdroxide-dsp.
struct RealFir {
    taps: Vec<f32>,
    buf: Vec<f32>,
}

impl RealFir {
    fn lowpass(ntaps: usize, cutoff_hz: f64, sample_rate: f64) -> Self {
        Self {
            taps: lowpass_taps(ntaps, cutoff_hz / sample_rate),
            buf: Vec::new(),
        }
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.buf.extend_from_slice(input);
        let n = self.taps.len();
        if n == 0 || self.buf.len() < n {
            return;
        }
        let count = self.buf.len() - n + 1;
        out.reserve(count);
        for i in 0..count {
            let mut sum = 0.0f32;
            for (x, t) in self.buf[i..i + n].iter().zip(&self.taps) {
                sum += *x * *t;
            }
            out.push(sum);
        }
        self.buf.drain(..count);
    }
}

pub struct G3ruhRx {
    spb: f32,
    lpf: RealFir,
    descram: Scrambler,
    dc: f32,
    mag: f32,
    clk: f32,
    last_bit: bool,
    have_last: bool,
    filtered: Vec<f32>,
}

impl G3ruhRx {
    #[must_use]
    pub fn new(rate: f64) -> Self {
        Self {
            spb: (rate / BAUD) as f32,
            lpf: RealFir::lowpass(65, 0.6 * BAUD, rate),
            descram: Scrambler::default(),
            dc: 0.0,
            mag: 0.0,
            clk: 0.0,
            last_bit: false,
            have_last: false,
            filtered: Vec::new(),
        }
    }

    #[must_use]
    pub fn magnitude(&self) -> f32 {
        self.mag
    }

    #[must_use]
    pub fn separation(&self) -> f32 {
        (self.mag * 4.0).min(1.0)
    }

    /// Demodulate discriminator audio, appending one line level per bit.
    pub fn process(&mut self, audio: &[f32], out: &mut Vec<bool>) {
        self.filtered.clear();
        let mut filtered = std::mem::take(&mut self.filtered);
        self.lpf.process(audio, &mut filtered);

        for &s in &filtered {
            self.dc += DC_SMOOTH * (s - self.dc);
            let d = s - self.dc;
            self.mag += MAG_SMOOTH * (d.abs() - self.mag);
            let bit = d > 0.0;

            if self.have_last && bit != self.last_bit {
                let mut e = STROBE_PHASE - self.clk;
                if e > 0.5 {
                    e -= 1.0;
                } else if e < -0.5 {
                    e += 1.0;
                }
                self.clk = (self.clk + CLOCK_TRACK_GAIN * e).rem_euclid(1.0);
            }
            self.last_bit = bit;
            self.have_last = true;

            self.clk += 1.0 / self.spb;
            if self.clk < 1.0 {
                continue;
            }
            self.clk -= 1.0;
            out.push(self.descram.descramble(bit));
        }
        self.filtered = filtered;
    }
}
