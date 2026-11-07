//! FFT quantization helpers: float dB -> u8 and delta coding.
//!
//! Mirrors `serverng/internal/codec/compress_fft.go`.

/// Quantizes float32 dB magnitudes to u8 over `[min_db, max_db]`.
pub fn compress_fft(fft: &[f32], min_db: f32, max_db: f32) -> Vec<u8> {
    let mut out = vec![0u8; fft.len()];
    compress_fft_into(fft, min_db, max_db, &mut out);
    out
}

/// Quantizes into a pre-allocated buffer.
pub fn compress_fft_into(fft: &[f32], min_db: f32, max_db: f32, out: &mut [u8]) {
    let range = max_db - min_db;
    if range <= 0.0 {
        out.fill(0);
        return;
    }
    let scale = 255.0f32 / range;
    for (o, &v) in out.iter_mut().zip(fft.iter()) {
        let normalized = (v - min_db) * scale;
        *o = if normalized < 0.0 {
            0
        } else if normalized > 255.0 {
            255
        } else {
            (normalized + 0.5) as u8
        };
    }
}

/// Delta-encodes a u8 slice: `out[0] = data[0]`, `out[i] = data[i] - data[i-1]`.
pub fn delta_encode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    if let Some((&first, rest)) = data.split_first() {
        out.push(first);
        let mut prev = first;
        for &v in rest {
            out.push(v.wrapping_sub(prev));
            prev = v;
        }
    }
    out
}

/// Reverses [`delta_encode`].
pub fn delta_decode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    if let Some((&first, rest)) = data.split_first() {
        out.push(first);
        let mut prev = first;
        for &v in rest {
            prev = prev.wrapping_add(v);
            out.push(prev);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantize_range() {
        let fft = [-100.0, -50.0, 0.0, -200.0, 100.0];
        let q = compress_fft(&fft, -100.0, 0.0);
        assert_eq!(q[0], 0);
        assert_eq!(q[1], 128); // 127.5 -> +0.5 -> 128
        assert_eq!(q[2], 255);
        assert_eq!(q[3], 0);
        assert_eq!(q[4], 255);
    }

    #[test]
    fn delta_round_trip() {
        let data = vec![0u8, 255, 3, 4, 200];
        let enc = delta_encode(&data);
        assert_eq!(enc[0], 0);
        assert_eq!(delta_decode(&enc), data);
    }
}
