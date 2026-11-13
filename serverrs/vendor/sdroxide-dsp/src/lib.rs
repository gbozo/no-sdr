//! Minimal stand-in for sdroxide-dsp.
//!
//! The hardware drivers need `Complex32` and a small part of the DSP crate:
//! a window, an NCO, and for RX-888 the WOLA downconverter and wideband
//! spectrum. The real upstream crate also contains speech denoisers and pulls a
//! large neural-inference dependency tree unrelated to USB I/O.

pub mod ddc;
pub mod decim;
pub mod nco;
pub mod resample;
pub mod simd;
pub mod wbddc;
pub mod wbspectrum;
pub mod window;

pub type Complex32 = num_complex::Complex<f32>;

pub use ddc::Ddc;
pub use decim::{lowpass_taps, FirDecim, HalfbandDecim};
pub use nco::Nco;
pub use resample::MonoResampler;
pub use wbddc::{WbDdc, clamp_center_hz, reachable_range_hz};
pub use wbspectrum::WideSpectrum;
pub use window::{blackman_harris, blackman_harris_derivative, hann};

/// Reinterpret a complex slice as interleaved floats.
pub fn as_interleaved(z: &[Complex32]) -> &[f32] {
    // SAFETY: `Complex<f32>` is `#[repr(C)] { re: f32, im: f32 }`.
    unsafe { std::slice::from_raw_parts(z.as_ptr().cast::<f32>(), z.len() * 2) }
}

pub fn as_interleaved_mut(z: &mut [Complex32]) -> &mut [f32] {
    // SAFETY: as above, with an exclusive borrow.
    unsafe { std::slice::from_raw_parts_mut(z.as_mut_ptr().cast::<f32>(), z.len() * 2) }
}
