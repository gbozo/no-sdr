//! Digital down-converter: NCO mix to baseband, then multistage decimation
//! from the device rate to a ~48 kHz channel rate.

use crate::Complex32;
use crate::decim::{FirDecim, HalfbandDecim};
use crate::nco::Nco;

pub struct Ddc {
    nco: Nco,
    in_rate: f64,
    halfbands: Vec<HalfbandDecim>,
    final_decim: Option<FirDecim>,
    out_rate: f64,
    tmp_a: Vec<Complex32>,
    tmp_b: Vec<Complex32>,
}

impl Ddc {
    /// Build a chain from `in_rate` down to as close to `target_rate` as an
    /// integer decimation allows. The exact rate is [`Self::out_rate`] —
    /// callers resample audio afterwards if they need the target exactly.
    pub fn new(in_rate: f64, target_rate: f64) -> Self {
        let mut rate = in_rate;
        let mut halfbands = Vec::new();
        while rate > target_rate * 8.0 {
            halfbands.push(HalfbandDecim::new());
            rate /= 2.0;
        }
        let m = (rate / target_rate).round().max(1.0) as usize;
        let final_decim = (m > 1).then(|| FirDecim::new(m));
        let out_rate = rate / m as f64;

        Ddc {
            nco: Nco::new(0.0, in_rate),
            in_rate,
            halfbands,
            final_decim,
            out_rate,
            tmp_a: Vec::new(),
            tmp_b: Vec::new(),
        }
    }

    /// The rate [`Ddc::new`] would settle on, without building one. Lets a
    /// caller advertise or compare the achievable rate on a hot path (the TCI
    /// server publishes it on every state tick) instead of constructing filters.
    pub fn rate_for(in_rate: f64, target_rate: f64) -> f64 {
        let mut rate = in_rate;
        while rate > target_rate * 8.0 {
            rate /= 2.0;
        }
        rate / (rate / target_rate).round().max(1.0)
    }

    pub fn out_rate(&self) -> f64 {
        self.out_rate
    }

    /// Tune: `offset_hz` is the wanted signal's offset from the hardware
    /// center frequency; it gets mixed down to DC.
    pub fn set_offset_hz(&mut self, offset_hz: f64) {
        self.nco.set_freq(-offset_hz, self.in_rate);
    }

    /// Appends channel-rate samples to `out`.
    pub fn process(&mut self, input: &[Complex32], out: &mut Vec<Complex32>) {
        self.tmp_a.clear();
        self.nco.mix(input, &mut self.tmp_a);

        for hb in &mut self.halfbands {
            self.tmp_b.clear();
            hb.process(&self.tmp_a, &mut self.tmp_b);
            std::mem::swap(&mut self.tmp_a, &mut self.tmp_b);
        }

        match &mut self.final_decim {
            Some(d) => d.process(&self.tmp_a, out),
            None => out.extend_from_slice(&self.tmp_a),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `rate_for` must agree with the constructed chain — it exists so callers
    /// can skip building one, which is only safe while the two stay in step.
    #[test]
    fn rate_for_matches_constructed() {
        for &in_rate in &[1_536_000.0, 2_000_000.0, 768_000.0, 48_000.0, 122_880.0] {
            for &target in &[48_000.0, 96_000.0, 192_000.0, 256_000.0] {
                assert_eq!(
                    Ddc::rate_for(in_rate, target),
                    Ddc::new(in_rate, target).out_rate(),
                    "in={in_rate} target={target}"
                );
            }
        }
    }
}
