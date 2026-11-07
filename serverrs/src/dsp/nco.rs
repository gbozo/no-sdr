//! Numerically controlled oscillator (frequency shift).
//!
//! Mirrors `serverng/internal/dsp/nco.go`.

use std::f64::consts::PI;

use num_complex::Complex32;

use super::block::ProcessorBlock;
use super::fft_processor::INV_U8_SCALE;

const NCO_TABLE_SIZE: usize = 4096;
const NCO_TABLE_MASK: usize = NCO_TABLE_SIZE - 1;

pub struct NcoBlock {
    offset_hz: f64,
    sample_rate: f64,
    phase: f64,
    phase_inc: f64,
    sin_table: Vec<f32>,
    cos_table: Vec<f32>,
}

impl NcoBlock {
    pub fn new(offset_hz: f64) -> Self {
        let mut n = Self {
            offset_hz,
            sample_rate: 0.0,
            phase: 0.0,
            phase_inc: 0.0,
            sin_table: vec![0.0; NCO_TABLE_SIZE],
            cos_table: vec![0.0; NCO_TABLE_SIZE],
        };
        for i in 0..NCO_TABLE_SIZE {
            let angle = 2.0 * PI * i as f64 / NCO_TABLE_SIZE as f64;
            n.sin_table[i] = angle.sin() as f32;
            n.cos_table[i] = angle.cos() as f32;
        }
        n
    }

    pub fn set_offset(&mut self, hz: f64) {
        self.offset_hz = hz;
        if self.sample_rate > 0.0 {
            self.phase_inc = 2.0 * PI * hz / self.sample_rate;
        }
    }

    pub fn offset_hz(&self) -> f64 {
        self.offset_hz
    }
}

impl ProcessorBlock for NcoBlock {
    fn name(&self) -> &'static str {
        "nco"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> anyhow::Result<()> {
        self.sample_rate = sample_rate;
        self.phase_inc = 2.0 * PI * self.offset_hz / self.sample_rate;
        self.phase = 0.0;
        Ok(())
    }

    fn process_complex(&mut self, input: &[Complex32]) -> Vec<Complex32> {
        let mut out = Vec::with_capacity(input.len());
        let table_scale = NCO_TABLE_SIZE as f64 / (2.0 * PI);
        for s in input {
            let phase_scaled = self.phase * table_scale;
            let idx = (phase_scaled as usize) & NCO_TABLE_MASK;
            let frac = (phase_scaled - phase_scaled.floor()) as f32;
            let next = (idx + 1) & NCO_TABLE_MASK;

            let cos0 = self.cos_table[idx];
            let sin0 = self.sin_table[idx];
            let cos1 = self.cos_table[next];
            let sin1 = self.sin_table[next];

            let cos_val = cos0 + frac * (cos1 - cos0);
            let sin_val = sin0 + frac * (sin1 - sin0);

            out.push(Complex32::new(
                s.re * cos_val + s.im * sin_val,
                s.im * cos_val - s.re * sin_val,
            ));
            self.phase += self.phase_inc;
        }

        self.phase %= 2.0 * PI;
        if self.phase < 0.0 {
            self.phase += 2.0 * PI;
        }
        out
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}

/// Fused uint8 -> complex conversion (`(v-127.5)/127.5`).
pub fn convert_u8_iq(raw: &[u8], out: &mut Vec<Complex32>) {
    out.clear();
    out.reserve(raw.len() / 2);
    for pair in raw.chunks_exact(2) {
        out.push(Complex32::new(
            (pair[0] as f32 - 127.5) * INV_U8_SCALE,
            (pair[1] as f32 - 127.5) * INV_U8_SCALE,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shifts_positive_offset_to_dc() {
        let mut nco = NcoBlock::new(1000.0);
        nco.init(48_000.0).unwrap();
        let input: Vec<Complex32> = (0..1024)
            .map(|i| {
                let a = 2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 48_000.0;
                Complex32::new(a.cos() as f32, a.sin() as f32)
            })
            .collect();
        let out = nco.process_complex(&input);
        // After mixing down, the signal should be near DC: consecutive samples
        // rotate only slightly.
        let mid = out.len() / 2;
        let prod = out[mid] * out[mid + 1].conj();
        assert!(prod.arg().abs() < 0.2, "residual rotation {}", prod.arg());
    }
}
