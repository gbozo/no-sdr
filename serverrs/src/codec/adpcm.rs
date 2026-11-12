//! IMA-ADPCM (4:1) streaming encoder/decoder.
//!
//! Wire-compatible with the original Go implementation and the client's
//! `shared/src/adpcm.ts`.

/// Step index adjustment table (nibble -> index delta).
const INDEX_TABLE: [i32; 16] = [
    -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];

/// IMA-ADPCM step size table (89 entries, index 0..=88).
const STEP_TABLE: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];

/// Number of warmup samples prepended to each FFT ADPCM frame.
pub const FFT_ADPCM_PAD: usize = 10;

#[inline]
fn clamp_i16(v: i32) -> i32 {
    v.clamp(-32768, 32767)
}

#[inline]
fn clamp_index(v: i32) -> i32 {
    v.clamp(0, 88)
}

#[derive(Debug, Clone, Default)]
pub struct ImaAdpcmEncoder {
    predicted: i32,
    index: i32,
}

impl ImaAdpcmEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.predicted = 0;
        self.index = 0;
    }

    /// Encodes PCM samples to ADPCM nibbles, two samples per byte
    /// (low nibble first).
    pub fn encode(&mut self, samples: &[i16]) -> Vec<u8> {
        let mut out = vec![0u8; samples.len().div_ceil(2)];
        self.encode_into(samples, &mut out);
        out
    }

    /// Encodes into `out` (must be at least `ceil(samples.len()/2)` bytes).
    /// Returns the number of bytes written.
    pub fn encode_into(&mut self, samples: &[i16], out: &mut [u8]) -> usize {
        let n = samples.len();
        let out_len = n.div_ceil(2);
        out[..out_len].fill(0);
        for (i, &sample) in samples.iter().enumerate() {
            let nibble = self.encode_nibble(sample as i32);
            if i & 1 == 1 {
                out[i >> 1] |= (nibble as u8) << 4;
            } else {
                out[i >> 1] = (nibble as u8) & 0x0f;
            }
        }
        out_len
    }

    fn encode_nibble(&mut self, sample: i32) -> i32 {
        let step = STEP_TABLE[self.index as usize];
        let mut delta = sample - self.predicted;
        let mut nibble = 0i32;

        if delta < 0 {
            nibble = 8;
            delta = -delta;
        }
        if delta >= step {
            nibble |= 4;
            delta -= step;
        }
        if delta >= step >> 1 {
            nibble |= 2;
            delta -= step >> 1;
        }
        if delta >= step >> 2 {
            nibble |= 1;
        }

        // Reconstruct exactly what the decoder will produce (avoids drift).
        let mut diff = step >> 3;
        if nibble & 1 != 0 {
            diff += step >> 2;
        }
        if nibble & 2 != 0 {
            diff += step >> 1;
        }
        if nibble & 4 != 0 {
            diff += step;
        }
        if nibble & 8 != 0 {
            diff = -diff;
        }

        self.predicted = clamp_i16(self.predicted + diff);
        self.index = clamp_index(self.index + INDEX_TABLE[(nibble & 0x0f) as usize]);
        nibble
    }
}

#[derive(Debug, Clone, Default)]
pub struct ImaAdpcmDecoder {
    predicted: i32,
    index: i32,
}

impl ImaAdpcmDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.predicted = 0;
        self.index = 0;
    }

    /// Decodes ADPCM nibbles to `sample_count` PCM samples.
    pub fn decode(&mut self, data: &[u8], sample_count: usize) -> Vec<i16> {
        let mut out = Vec::with_capacity(sample_count);
        for &b in data {
            if out.len() >= sample_count {
                break;
            }
            out.push(self.decode_nibble((b & 0x0f) as i32) as i16);
            if out.len() >= sample_count {
                break;
            }
            out.push(self.decode_nibble(((b >> 4) & 0x0f) as i32) as i16);
        }
        while out.len() < sample_count {
            out.push(0);
        }
        out
    }

    fn decode_nibble(&mut self, nibble: i32) -> i32 {
        let step = STEP_TABLE[self.index as usize];
        self.index = clamp_index(self.index + INDEX_TABLE[nibble as usize]);

        let mut diff = step >> 3;
        if nibble & 1 != 0 {
            diff += step >> 2;
        }
        if nibble & 2 != 0 {
            diff += step >> 1;
        }
        if nibble & 4 != 0 {
            diff += step;
        }
        if nibble & 8 != 0 {
            diff = -diff;
        }

        self.predicted = clamp_i16(self.predicted + diff);
        self.predicted
    }
}

/// Encodes an FFT frame (dB values) to ADPCM.
///
/// Returns `[i16 minDb LE][i16 maxDb LE][ADPCM for pad + fftSize samples]`.
pub fn encode_fft_adpcm(fft: &[f32], min_db: f32, max_db: f32) -> Vec<u8> {
    let total = FFT_ADPCM_PAD + fft.len();
    let mut int16_buf = vec![0i16; total];
    let first = clamp_i16((fft[0] as f64 * 100.0).round() as i32) as i16;
    for v in int16_buf.iter_mut().take(FFT_ADPCM_PAD) {
        *v = first;
    }
    for (i, &v) in fft.iter().enumerate() {
        int16_buf[FFT_ADPCM_PAD + i] =
            clamp_i16((v as f64 * 100.0).round() as i32) as i16;
    }

    let mut enc = ImaAdpcmEncoder::new();
    let adpcm = enc.encode(&int16_buf);

    let mut out = Vec::with_capacity(4 + adpcm.len());
    out.extend_from_slice(&((min_db as f64).round() as i16).to_le_bytes());
    out.extend_from_slice(&((max_db as f64).round() as i16).to_le_bytes());
    out.extend_from_slice(&adpcm);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_is_close() {
        let mut enc = ImaAdpcmEncoder::new();
        let mut dec = ImaAdpcmDecoder::new();
        let samples: Vec<i16> = (0..1000)
            .map(|i| ((i as f32 * 0.05).sin() * 12000.0) as i16)
            .collect();
        let encoded = enc.encode(&samples);
        assert_eq!(encoded.len(), samples.len().div_ceil(2));
        let decoded = dec.decode(&encoded, samples.len());
        for (a, b) in samples.iter().zip(decoded.iter()) {
            assert!((*a as i32 - *b as i32).abs() < 3000, "{a} vs {b}");
        }
    }

    #[test]
    fn ff_adpcm_header() {
        let fft = vec![-90.0f32; 16];
        let out = encode_fft_adpcm(&fft, -100.4, -20.6);
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), -100);
        assert_eq!(i16::from_le_bytes([out[2], out[3]]), -21);
        assert_eq!(out.len(), 4 + (16 + FFT_ADPCM_PAD).div_ceil(2));
    }
}
