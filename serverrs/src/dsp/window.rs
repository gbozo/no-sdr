//! Window functions.
//!
//! Ported from the original Go backend.

use anyhow::{bail, Result};
use std::f64::consts::PI;

pub fn blackman_harris(size: usize) -> Vec<f32> {
    let mut w = vec![0.0f32; size];
    if size == 1 {
        w[0] = 1.0;
        return w;
    }
    const A0: f64 = 0.35875;
    const A1: f64 = 0.48829;
    const A2: f64 = 0.14128;
    const A3: f64 = 0.01168;
    let nm1 = (size - 1) as f64;
    for (i, out) in w.iter_mut().enumerate() {
        let x = 2.0 * PI * i as f64 / nm1;
        *out = (A0 - A1 * x.cos() + A2 * (2.0 * x).cos() - A3 * (3.0 * x).cos()) as f32;
    }
    w
}

pub fn hann(size: usize) -> Vec<f32> {
    let mut w = vec![0.0f32; size];
    if size == 1 {
        w[0] = 1.0;
        return w;
    }
    let nm1 = (size - 1) as f64;
    for (i, out) in w.iter_mut().enumerate() {
        *out = (0.5 * (1.0 - (2.0 * PI * i as f64 / nm1).cos())) as f32;
    }
    w
}

pub fn hamming(size: usize) -> Vec<f32> {
    let mut w = vec![0.0f32; size];
    if size == 1 {
        w[0] = 1.0;
        return w;
    }
    let nm1 = (size - 1) as f64;
    for (i, out) in w.iter_mut().enumerate() {
        *out = (0.54 - 0.46 * (2.0 * PI * i as f64 / nm1).cos()) as f32;
    }
    w
}

pub fn kaiser(size: usize, beta: f64) -> Vec<f32> {
    let mut w = vec![0.0f32; size];
    if size == 1 {
        w[0] = 1.0;
        return w;
    }
    let denom = bessel_i0(beta);
    let nm1 = (size - 1) as f64;
    for (i, out) in w.iter_mut().enumerate() {
        let t = 2.0 * i as f64 / nm1 - 1.0;
        let arg = beta * (1.0 - t * t).max(0.0).sqrt();
        *out = (bessel_i0(arg) / denom) as f32;
    }
    w
}

/// Modified Bessel function of the first kind, order 0 (power series).
pub fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    for k in 1..25 {
        let factor = x / (2.0 * k as f64);
        term *= factor * factor;
        sum += term;
        if term < 1e-12 * sum {
            break;
        }
    }
    sum
}

/// Creates a window by name: `blackman-harris`, `hann`, `hamming`, `kaiser`.
pub fn new_window(name: &str, size: usize) -> Result<Vec<f32>> {
    if size < 1 {
        bail!("window: size must be >= 1");
    }
    Ok(match name {
        "blackman-harris" => blackman_harris(size),
        "hann" => hann(size),
        "hamming" => hamming(size),
        "kaiser" => kaiser(size, 8.6),
        other => bail!("window: unknown window type: {other}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_one_is_unity() {
        assert_eq!(blackman_harris(1), vec![1.0]);
        assert_eq!(hann(1), vec![1.0]);
        assert_eq!(hamming(1), vec![1.0]);
        assert_eq!(kaiser(1, 8.6), vec![1.0]);
    }

    #[test]
    fn symmetric_endpoints() {
        let w = blackman_harris(64);
        assert!((w[0] - 0.00006).abs() < 1e-4);
        assert!((w[63] - 0.00006).abs() < 1e-4);
        let mid = w[32];
        assert!(mid > 0.99);
    }

    #[test]
    fn unknown_window_fails() {
        assert!(new_window("bogus", 8).is_err());
    }
}
