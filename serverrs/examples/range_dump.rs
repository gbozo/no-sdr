//! Dumps a range-coded FFT frame plus the expected u8 codes for cross-checking
//! the TypeScript decoder.
//!
//! cargo run --release --example range_dump

use serverrs::codec::deflate::{clamp_percentile, smooth_margin_db, SMOOTH_PERCENTILE};
use serverrs::codec::fft::compress_fft_into;
use serverrs::codec::range::{FftRangeEncoder, MSG_FFT_RANGE};

fn main() {
    let n = 1024usize;
    let frame: Vec<f32> = (0..n)
        .map(|i| {
            let x = (i as f32 * 12.9898).sin() * 43758.5453;
            let noise = (x - x.floor()) * 6.0;
            let mut v = -110.0 + noise;
            if i % 97 == 0 {
                v += 25.0;
            }
            v
        })
        .collect();

    let mut enc = FftRangeEncoder::new(n);
    let msg = enc
        .encode_message(MSG_FFT_RANGE, &frame, -130.0, 0.0)
        .expect("encode");

    let mut expected = vec![0u8; n];
    compress_fft_into(&frame, -130.0, 0.0, &mut expected);
    let margin_codes = ((smooth_margin_db() / 130.0) * 255.0).round().max(0.0) as usize;
    clamp_percentile(&mut expected, SMOOTH_PERCENTILE, margin_codes);

    std::fs::write("/tmp/opencode/rc_frame.bin", &msg[9..]).unwrap();
    std::fs::write("/tmp/opencode/rc_codes.bin", &expected).unwrap();
    println!("payload={} bins={n} min=-130 max=0", msg.len() - 9);

    // History burst: 8 frames x 64 bins, per-frame delta.
    let hbins = 64usize;
    let hframes = 8usize;
    let mut history = vec![0u8; hbins * hframes];
    for f in 0..hframes {
        for i in 0..hbins {
            history[f * hbins + i] = ((f * 7 + i * 3) % 200) as u8;
        }
    }
    let hpayload = serverrs::codec::range::encode_history(&history, hbins);
    std::fs::write("/tmp/opencode/rh_frame.bin", &hpayload).unwrap();
    std::fs::write("/tmp/opencode/rh_codes.bin", &history).unwrap();
    println!("history payload={} frames={hframes} bins={hbins}", hpayload.len());
}
