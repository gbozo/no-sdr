//! Bell 202 AFSK receiver for APRS / VHF AX.25.
//!
//! Adapted from `sdroxide-dsp`'s `afsk.rs` (GPL-compatible). The detector,
//! bit-clock recovery and automatic threshold correction are unchanged; only
//! the small FIR/integrator helpers and crate paths are local here.
#![allow(dead_code)]

use std::f64::consts::TAU;

use num_complex::Complex32;

const CLOCK_TRACK_GAIN: f32 = 0.10;
const STROBE_PHASE: f32 = 0.5;
const ATC_SMOOTH: f32 = 8.0e-3;
const ATC_RELAX: f32 = ATC_SMOOTH / 4.0;
const ATC_IDLE_BITS: f32 = 10.0;
const ATC_MIN_RATIO: f32 = 0.15;

/// The two packet speeds. APRS on VHF is `Vhf1200`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AfskProfile {
    Vhf1200,
}

impl AfskProfile {
    fn baud(self) -> f64 {
        match self {
            AfskProfile::Vhf1200 => 1200.0,
        }
    }

    fn tones(self) -> (f64, f64) {
        match self {
            AfskProfile::Vhf1200 => (1200.0, 2200.0),
        }
    }

    fn centre_hz(self) -> f64 {
        let (m, s) = self.tones();
        (m + s) / 2.0
    }

    fn shift_hz(self) -> f64 {
        let (m, s) = self.tones();
        (s - m).abs()
    }
}

pub(crate) struct ComplexFir {
    taps: Vec<Complex32>,
    buf: Vec<Complex32>,
}

impl ComplexFir {
    pub(crate) fn new(taps: Vec<Complex32>) -> Self {
        Self {
            taps,
            buf: Vec::new(),
        }
    }

    pub(crate) fn set_taps(&mut self, taps: Vec<Complex32>) {
        self.taps = taps;
        self.buf.clear();
    }

    pub(crate) fn process(&mut self, input: &[Complex32], out: &mut Vec<Complex32>) {
        self.buf.extend_from_slice(input);
        let n = self.taps.len();
        if n == 0 || self.buf.len() < n {
            return;
        }
        let count = self.buf.len() - n + 1;
        out.reserve(count);
        for i in 0..count {
            let mut sum = Complex32::default();
            for (x, t) in self.buf[i..i + n].iter().zip(&self.taps) {
                sum += *x * *t;
            }
            out.push(sum);
        }
        self.buf.drain(..count);
    }

    pub(crate) fn reset(&mut self) {
        self.buf.clear();
    }
}

pub(crate) struct Integrator {
    ring: Vec<Complex32>,
    pos: usize,
    sum_re: f64,
    sum_im: f64,
}

impl Integrator {
    pub(crate) fn new(len: usize) -> Self {
        Self {
            ring: vec![Complex32::default(); len.max(1)],
            pos: 0,
            sum_re: 0.0,
            sum_im: 0.0,
        }
    }

    pub(crate) fn resize(&mut self, len: usize) {
        self.ring.clear();
        self.ring.resize(len.max(1), Complex32::default());
        self.pos = 0;
        self.sum_re = 0.0;
        self.sum_im = 0.0;
    }

    pub(crate) fn push(&mut self, z: Complex32) -> Complex32 {
        let old = std::mem::replace(&mut self.ring[self.pos], z);
        self.pos = (self.pos + 1) % self.ring.len();
        self.sum_re += f64::from(z.re - old.re);
        self.sum_im += f64::from(z.im - old.im);
        let k = 1.0 / self.ring.len() as f64;
        Complex32::new((self.sum_re * k) as f32, (self.sum_im * k) as f32)
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
    }
}

fn blackman_harris(n: usize, i: usize) -> f64 {
    let x = std::f64::consts::TAU * i as f64 / (n.saturating_sub(1)).max(1) as f64;
    0.35875 - 0.48829 * x.cos() + 0.14128 * (2.0 * x).cos() - 0.01168 * (3.0 * x).cos()
}

pub(crate) fn lowpass_taps(ntaps: usize, cutoff: f64) -> Vec<f32> {
    let center = (ntaps - 1) as f64 / 2.0;
    let mut taps: Vec<f64> = (0..ntaps)
        .map(|i| {
            2.0 * cutoff * sinc(2.0 * cutoff * (i as f64 - center)) * blackman_harris(ntaps, i)
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    if sum != 0.0 {
        taps.iter_mut().for_each(|t| *t /= sum);
    }
    taps.into_iter().map(|t| t as f32).collect()
}

pub(crate) fn bandpass_taps(
    ntaps: usize,
    lo_hz: f64,
    hi_hz: f64,
    sample_rate: f64,
) -> Vec<Complex32> {
    let bw = (hi_hz - lo_hz).abs().max(50.0);
    let center = (lo_hz + hi_hz) / 2.0;
    let lp = lowpass_taps(ntaps, (bw / 2.0) / sample_rate);
    let mid = (ntaps - 1) as f64 / 2.0;
    lp.iter()
        .enumerate()
        .map(|(i, &t)| {
            let ph = -TAU * center * (i as f64 - mid) / sample_rate;
            Complex32::new(
                (ph.cos() * f64::from(t)) as f32,
                (ph.sin() * f64::from(t)) as f32,
            )
        })
        .collect()
}

/// feed the levels to `sdroxide_ax25::Deframer`.
pub struct AfskRx {
    rate: f64,
    baud: f64,
    centre_hz: f64,
    shift_hz: f64,
    reverse: bool,

    // Front end: mix to the centre tone, then band-limit.
    ph: f32,
    ph_inc: f32,
    lpf: ComplexFir,

    // Tone branches: rotate ±shift/2 to DC and integrate over one bit.
    tone_ph: f32,
    tone_inc: f32,
    mark_int: Integrator,
    space_int: Integrator,

    // Bit clock: a free-running NCO nudged by observed transitions.
    spb: f32,
    clk: f32,
    last_bit: bool,
    have_last: bool,

    // Automatic threshold correction.
    ref_mark: f32,
    ref_space: f32,
    mark_idle: f32,
    space_idle: f32,

    mag: f32,
    /// Smoothed tone separation — how convincingly one branch is winning.
    /// Drives the data-carrier detect the CSMA layer needs.
    sep: f32,

    mixed: Vec<Complex32>,
    bb: Vec<Complex32>,
}

/// Smoothing for the separation figure, about 20 ms at 48 kHz — fast enough
/// that DCD follows a real transmission's start and end, slow enough not to
/// chatter between bits.
const SEP_SMOOTH: f32 = 1.0e-3;

impl AfskRx {
    #[must_use]
    pub fn new(rate: f64, profile: AfskProfile) -> Self {
        let mut rx = AfskRx {
            rate,
            baud: profile.baud(),
            centre_hz: profile.centre_hz(),
            shift_hz: profile.shift_hz(),
            reverse: false,
            ph: 0.0,
            ph_inc: 0.0,
            lpf: ComplexFir::new(Vec::new()),
            tone_ph: 0.0,
            tone_inc: 0.0,
            mark_int: Integrator::new(1),
            space_int: Integrator::new(1),
            spb: 1.0,
            clk: 0.0,
            last_bit: true,
            have_last: false,
            ref_mark: 0.0,
            ref_space: 0.0,
            mark_idle: 0.0,
            space_idle: 0.0,
            mag: 0.0,
            sep: 0.0,
            mixed: Vec::new(),
            bb: Vec::new(),
        };
        rx.configure();
        rx
    }

    fn configure(&mut self) {
        self.spb = (self.rate / self.baud) as f32;
        let len = self.spb.round().max(1.0) as usize;
        self.mark_int.resize(len);
        self.space_int.resize(len);
        self.tone_inc = (TAU * (self.shift_hz / 2.0) / self.rate) as f32;
        self.tone_ph = 0.0;
        self.ph_inc = (TAU * self.centre_hz / self.rate) as f32;
        // Pass both tones and the modulation either side of them. The matched
        // filters do the real rejection; this only keeps the neighbours out.
        let bw = (self.shift_hz / 2.0 + 2.0 * self.baud).max(400.0);
        self.lpf.set_taps(bandpass_taps(129, -bw, bw, self.rate));
        self.lpf.reset();
        self.have_last = false;
        self.ref_mark = 0.0;
        self.ref_space = 0.0;
        self.mark_idle = 0.0;
        self.space_idle = 0.0;
        self.sep = 0.0;
    }

    /// Smoothed signal magnitude.
    #[must_use]
    pub fn magnitude(&self) -> f32 {
        self.mag
    }

    /// Demodulate `audio`, appending one line level per recovered bit.
    pub fn process(&mut self, audio: &[f32], out: &mut Vec<bool>) {
        self.mixed.clear();
        self.mixed.reserve(audio.len());
        for &a in audio {
            let z = Complex32::new(a * self.ph.cos(), -a * self.ph.sin());
            self.ph += self.ph_inc;
            if self.ph > std::f32::consts::TAU {
                self.ph -= std::f32::consts::TAU;
            }
            self.mixed.push(z);
        }
        self.bb.clear();
        let mut bb = std::mem::take(&mut self.bb);
        self.lpf.process(&self.mixed, &mut bb);

        for &z in &bb {
            let (s, c) = (self.tone_ph.sin(), self.tone_ph.cos());
            self.tone_ph += self.tone_inc;
            if self.tone_ph > std::f32::consts::TAU {
                self.tone_ph -= std::f32::consts::TAU;
            }
            // In **both** packet profiles mark is the *lower* tone — 1200
            // against 2200, and 1600 against 1800. That is the opposite of
            // amateur RTTY, where mark sits above the centre, so the two
            // rotations are the other way round from `rtty.rs`'s. Getting this
            // backwards swaps mark and space, which NRZI then hides completely:
            // the frames still decode, and only a raw bit comparison ever
            // notices. Hence `mark_is_the_lower_tone` below.
            let m = self.mark_int.push(z * Complex32::new(c, s));
            let sp = self.space_int.push(z * Complex32::new(c, -s));
            let (em, es) = (m.norm(), sp.norm());

            let total = em + es;
            self.mag += 0.02 * (total - self.mag);
            let sep = if total > 1e-20 {
                (em - es).abs() / total
            } else {
                0.0
            };
            self.sep += SEP_SMOOTH * (sep - self.sep);

            // Seed both references together on the first sample carrying
            // energy; starting from zero costs a few bits of transient, which
            // on a packet frame lands in the preamble where it is free.
            if self.ref_mark <= 0.0 && self.ref_space <= 0.0 && total > 1e-20 {
                self.ref_mark = total * 0.5;
                self.ref_space = total * 0.5;
            }
            let (dm, ds) = if self.ref_mark > 1e-20 && self.ref_space > 1e-20 {
                (em / self.ref_mark, es / self.ref_space)
            } else {
                (em, es)
            };

            let phys_mark = dm > ds;
            let bit = phys_mark != self.reverse;

            let idle_limit = ATC_IDLE_BITS * self.spb;
            if phys_mark {
                self.ref_mark += ATC_SMOOTH * (em - self.ref_mark);
                self.space_idle += 1.0;
                self.mark_idle = 0.0;
                if self.space_idle > idle_limit {
                    self.ref_space += ATC_RELAX * (self.ref_mark - self.ref_space);
                }
            } else {
                self.ref_space += ATC_SMOOTH * (es - self.ref_space);
                self.mark_idle += 1.0;
                self.space_idle = 0.0;
                if self.mark_idle > idle_limit {
                    self.ref_mark += ATC_RELAX * (self.ref_space - self.ref_mark);
                }
            }
            let floor = self.ref_mark.max(self.ref_space) * ATC_MIN_RATIO;
            self.ref_mark = self.ref_mark.max(floor);
            self.ref_space = self.ref_space.max(floor);

            self.advance_clock(bit, out);
        }
        self.bb = bb;
    }

    /// Free-running bit clock, pulled towards the middle of the eye by every
    /// transition.
    ///
    /// Transitions are steered to phase 0.5 and the strobe fires at the wrap,
    /// so the two sit half a bit apart — the strobe lands in the middle of the
    /// eye, which is the whole object. Steering transitions to the strobe phase
    /// instead samples exactly on the edges, where any jitter flips the bit;
    /// that reads as a clock that never locks rather than as a clock that is
    /// half a bit out.
    fn advance_clock(&mut self, bit: bool, out: &mut Vec<bool>) {
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
            return;
        }
        self.clk -= 1.0;
        out.push(bit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demodulates_a_bell202_ax25_frame() {
        use sdroxide_ax25::{Addr, Deframer, Framer, Packet};

        let src = Addr::new("N0CALL").expect("source");
        let dst = Addr::new("APRS").expect("destination");
        let packet = Packet::ui(src, dst, b"!4903.50N/07201.75W-Test");
        let frame = packet.serialize(false);

        let mut framer = Framer::new();
        framer.push_flags(16);
        framer.push_frame(&frame);
        framer.push_flags(2);
        let bits = framer.take();

        let rate = 48_000.0f64;
        let spb = (rate / 1200.0) as usize;
        let mut phase = 0.0f64;
        let mut audio = Vec::with_capacity(bits.len() * spb);
        for bit in bits {
            let hz = if bit { 1200.0 } else { 2200.0 };
            for _ in 0..spb {
                audio.push((phase.sin() * 0.5) as f32);
                phase += std::f64::consts::TAU * hz / rate;
                if phase > std::f64::consts::TAU {
                    phase -= std::f64::consts::TAU;
                }
            }
        }

        let mut rx = AfskRx::new(rate, AfskProfile::Vhf1200);
        let mut levels = Vec::new();
        rx.process(&audio, &mut levels);
        let mut deframer = Deframer::new();
        let mut frames = Vec::new();
        for level in levels {
            deframer.push_level(level, &mut frames);
        }
        assert!(
            frames.iter().any(|f| f == &frame),
            "AFSK/HDLC did not recover the frame: {} frames",
            frames.len()
        );
    }
}
