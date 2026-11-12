//! Minimal NCO used by the Airspy HF+ and RX-888 host DSP.

pub struct Nco {
    phasor: num_complex::Complex<f64>,
    step: num_complex::Complex<f64>,
}

impl Nco {
    pub fn new(freq_hz: f64, rate_hz: f64) -> Self {
        let mut nco = Self {
            phasor: num_complex::Complex::new(1.0, 0.0),
            step: num_complex::Complex::new(1.0, 0.0),
        };
        nco.set_freq(freq_hz, rate_hz);
        nco
    }

    pub fn set_freq(&mut self, freq_hz: f64, rate_hz: f64) {
        let w = std::f64::consts::TAU * freq_hz / rate_hz.max(1.0);
        self.step = num_complex::Complex::new(w.cos(), w.sin());
    }

    pub fn mix_in_place(&mut self, iq: &mut [crate::Complex32]) {
        for sample in iq {
            let p = self.phasor;
            *sample *= num_complex::Complex::new(p.re as f32, p.im as f32);
            self.phasor *= self.step;
        }
    }

    /// Mix `input` into `out`, appending the shifted samples.
    ///
    /// The shim keeps the simple per-sample recurrence; the upstream crate
    /// vectorises this with its SIMD kernel, but the drivers and the AIS
    /// channel only need the API shape.
    pub fn mix(&mut self, input: &[crate::Complex32], out: &mut Vec<crate::Complex32>) {
        out.clear();
        out.extend_from_slice(input);
        self.mix_in_place(out);
    }
}
