//! 8th-order Butterworth low-pass filter (4 cascaded biquads).
//!
//! Mirrors `serverng/internal/dsp/filter.go`.

use std::f64::consts::PI;

use num_complex::Complex32;

use super::block::ProcessorBlock;

#[derive(Debug, Clone, Copy, Default)]
struct BiquadCoeffs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct BiquadState {
    z1: f64,
    z2: f64,
}

pub struct ButterworthBlock {
    cutoff_hz: f64,
    sample_rate: f64,
    sections: [BiquadCoeffs; 4],
    state_i: [BiquadState; 4],
    state_q: [BiquadState; 4],
}

impl ButterworthBlock {
    pub fn new(cutoff_hz: f64) -> Self {
        Self {
            cutoff_hz,
            sample_rate: 0.0,
            sections: [BiquadCoeffs::default(); 4],
            state_i: [BiquadState::default(); 4],
            state_q: [BiquadState::default(); 4],
        }
    }

    pub fn set_cutoff(&mut self, hz: f64) {
        self.cutoff_hz = hz;
        if self.sample_rate > 0.0 {
            self.compute_coeffs();
        }
    }

    pub fn cutoff_hz(&self) -> f64 {
        self.cutoff_hz
    }

    fn compute_coeffs(&mut self) {
        for k in 0..4 {
            let theta = (2.0 * k as f64 + 1.0) * PI / 16.0;
            let q = 1.0 / (2.0 * theta.cos());
            self.sections[k] = compute_biquad(self.cutoff_hz, self.sample_rate, q);
        }
    }

    fn filter_sample(&mut self, x: f64, which: Channel) -> f64 {
        let states = match which {
            Channel::I => &mut self.state_i,
            Channel::Q => &mut self.state_q,
        };
        let mut val = x;
        for sec in 0..4 {
            let c = self.sections[sec];
            let st = &mut states[sec];
            let y = c.b0 * val + st.z1;
            st.z1 = c.b1 * val - c.a1 * y + st.z2;
            st.z2 = c.b2 * val - c.a2 * y;
            val = y;
        }
        val
    }
}

#[derive(Clone, Copy)]
enum Channel {
    I,
    Q,
}

fn compute_biquad(cutoff_hz: f64, sample_rate: f64, q: f64) -> BiquadCoeffs {
    let k = (PI * cutoff_hz / sample_rate).tan();
    let k2 = k * k;
    let norm = 1.0 + k / q + k2;
    BiquadCoeffs {
        b0: k2 / norm,
        b1: 2.0 * k2 / norm,
        b2: k2 / norm,
        a1: 2.0 * (k2 - 1.0) / norm,
        a2: (1.0 - k / q + k2) / norm,
    }
}

impl ProcessorBlock for ButterworthBlock {
    fn name(&self) -> &'static str {
        "butterworth_lpf"
    }

    fn sample_rate_out(&self, input_rate: f64) -> f64 {
        input_rate
    }

    fn init(&mut self, sample_rate: f64) -> anyhow::Result<()> {
        self.sample_rate = sample_rate;
        self.compute_coeffs();
        Ok(())
    }

    fn process_complex(&mut self, input: &[Complex32]) -> Vec<Complex32> {
        let mut out = Vec::with_capacity(input.len());
        for s in input {
            let re = self.filter_sample(s.re as f64, Channel::I);
            let im = self.filter_sample(s.im as f64, Channel::Q);
            out.push(Complex32::new(re as f32, im as f32));
        }
        out
    }

    fn reset(&mut self) {
        self.state_i = [BiquadState::default(); 4];
        self.state_q = [BiquadState::default(); 4];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: f64, n: usize) -> Vec<Complex32> {
        (0..n)
            .map(|i| {
                let a = 2.0 * std::f64::consts::PI * freq * i as f64 / rate;
                Complex32::new(a.cos() as f32, a.sin() as f32)
            })
            .collect()
    }

    fn rms(v: &[Complex32]) -> f64 {
        (v.iter().map(|c| (c.re * c.re + c.im * c.im) as f64).sum::<f64>() / v.len() as f64).sqrt()
    }

    #[test]
    fn passes_dc_and_blocks_high_tone() {
        let mut f = ButterworthBlock::new(1000.0);
        f.init(48_000.0).unwrap();
        let dc = vec![Complex32::new(1.0, 0.0); 4096];
        let out = f.process_complex(&dc);
        assert!((rms(&out[2000..]) - 1.0).abs() < 0.05);

        f.reset();
        let high = tone(12_000.0, 48_000.0, 4096);
        let out = f.process_complex(&high);
        assert!(rms(&out[2000..]) < 0.05, "{}", rms(&out[2000..]));
    }
}
