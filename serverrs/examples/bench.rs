//! Reproducible micro-benchmarks for the hot paths in `serverrs`.
//!
//! Run with:
//! ```text
//! cd serverrs
//! CARGO_HOME=/home/opencode/.cargo cargo run --release --example bench
//! ```
//!
//! The harness is deliberately dependency-free (no criterion/divan) so it can
//! never leak into the release build. Each case warms up once, runs five timed
//! rounds and reports the best round. `% core` is computed from the real-time
//! chunk rate, not wall-clock samples.

use std::hint::black_box;
use std::time::{Duration, Instant};

use serverrs::codec::adpcm::encode_fft_adpcm;
use serverrs::codec::{compress_fft, FftDeflateEncoder};
use serverrs::demod::{Demodulator, FmMonoDemod, FmStereoDemod, RdsDecoder};
use serverrs::dongle::opus_pipeline::{OpusPipeline, OpusPipelineConfig};
use serverrs::dsp::{
    ButterworthBlock, DcBlocker, DecimateBlock, FftProcessor, FftProcessorConfig, IqExtractor,
    IqExtractorConfig, NcoBlock, ProcessorBlock,
};
use serverrs::ws::client::Client;

const SAMPLE_RATE: i32 = 2_400_000;
const CHUNK_BYTES: usize = 16_384;

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 32) as u32
    }
    fn next_f32(&mut self) -> f32 {
        (self.next_u32() as f32) / (u32::MAX as f32)
    }
}

/// Raw uint8 IQ that looks like a noisy band with a tone.
fn make_iq_bytes(rng: &mut Rng, samples: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples * 2);
    for i in 0..samples {
        let a = 2.0 * std::f64::consts::PI * 20_000.0 * i as f64 / SAMPLE_RATE as f64;
        let n = |rng: &mut Rng| (rng.next_f32() - 0.5) * 0.2;
        let i_val = (127.5 + 100.0 * a.cos() as f32 + 12.0 * n(rng)).clamp(0.0, 255.0);
        let q_val = (127.5 + 100.0 * a.sin() as f32 + 12.0 * n(rng)).clamp(0.0, 255.0);
        out.push(i_val as u8);
        out.push(q_val as u8);
    }
    out
}

fn make_int16_iq(rng: &mut Rng, samples: usize) -> Vec<i16> {
    let mut out = Vec::with_capacity(samples * 2);
    for i in 0..samples {
        let a = 2.0 * std::f64::consts::PI * 20_000.0 * i as f64 / SAMPLE_RATE as f64;
        let n = |rng: &mut Rng| (rng.next_f32() - 0.5) * 0.1;
        out.push(((a.cos() as f32 + n(rng)) * 20_000.0) as i16);
        out.push(((a.sin() as f32 + n(rng)) * 20_000.0) as i16);
    }
    out
}

fn make_complex(i: &[i16]) -> Vec<num_complex::Complex32> {
    i.chunks_exact(2)
        .map(|p| {
            num_complex::Complex32::new(p[0] as f32 / 32768.0, p[1] as f32 / 32768.0)
        })
        .collect()
}

fn make_fft_frame(rng: &mut Rng, bins: usize) -> Vec<f32> {
    // Smooth noise floor with a couple of carriers, roughly dB scale.
    (0..bins)
        .map(|i| {
            let peak = if i % (bins / 8) == 0 { 35.0 } else { 0.0 };
            -110.0 + 25.0 * ((i as f32 * 0.03).sin() + 1.0) * 0.5 + rng.next_f32() * 6.0 + peak
        })
        .collect()
}

/// Runs `f` five times over `iters` and returns the best elapsed time.
fn best_of<F: FnMut()>(iters: usize, mut f: F) -> Duration {
    // Warm up caches / allocator.
    for _ in 0..iters / 4 {
        f();
    }
    let mut best = Duration::MAX;
    for _ in 0..5 {
        let start = Instant::now();
        for _ in 0..iters {
            f();
        }
        let elapsed = start.elapsed();
        if elapsed < best {
            best = elapsed;
        }
    }
    best
}

fn report(name: &str, iters: usize, elapsed: Duration, realtime_hz: f64) {
    let per = elapsed.as_secs_f64() / iters as f64;
    let core = if realtime_hz > 0.0 {
        per * realtime_hz * 100.0
    } else {
        0.0
    };
    println!(
        "{:<38} {:>10.3} us/iter {:>10.2} it/s {:>8.2}% core",
        name,
        per * 1e6,
        1.0 / per,
        core
    );
}

fn main() {
    println!("serverrs hot-path benchmarks (release, best of 5)");
    println!("-----------------------------------------------");

    let mut rng = Rng::new(0x9E37_79B9_7F4A_7C15);

    // --- FFT processor -----------------------------------------------------
    for &fft_size in &[8192usize, 16_384] {
        let chunk_samples = CHUNK_BYTES / 2;
        let chunks_per_frame = (fft_size as f64 / chunk_samples as f64).ceil() as usize;
        let iq = make_iq_bytes(&mut rng, chunk_samples * 8);
        let mut proc = FftProcessor::new(FftProcessorConfig {
            fft_size,
            sample_rate: SAMPLE_RATE,
            window: "blackman-harris".to_string(),
            averaging: 0.5,
            averaging_taps: 0,
            target_fps: 0,
        })
        .unwrap();
        let iters = 400;
        let elapsed = best_of(iters, || {
            let mut pos = 0;
            for _ in 0..chunks_per_frame {
                let end = (pos + CHUNK_BYTES).min(iq.len());
                let out = proc.process_iq_data(black_box(&iq[pos..end]));
                black_box(out);
                pos = if end == iq.len() { 0 } else { end };
            }
        });
        let per_chunk = elapsed.as_secs_f64() / iters as f64 / chunks_per_frame as f64;
        report(
            &format!("fft_processor {fft_size} (per chunk)"),
            iters * chunks_per_frame,
            Duration::from_secs_f64(per_chunk * iters as f64 * chunks_per_frame as f64),
            2_400_000.0 / chunk_samples as f64,
        );

        // Same processor with the live fps cap (8 fps for the FM profile).
        let mut capped = FftProcessor::new(FftProcessorConfig {
            fft_size,
            sample_rate: SAMPLE_RATE,
            window: "blackman-harris".to_string(),
            averaging: 0.5,
            averaging_taps: 0,
            target_fps: 8,
        })
        .unwrap();
        let elapsed = best_of(iters, || {
            let mut pos = 0;
            for _ in 0..chunks_per_frame {
                let end = (pos + CHUNK_BYTES).min(iq.len());
                black_box(capped.process_iq_data(&iq[pos..end]));
                pos = if end == iq.len() { 0 } else { end };
            }
        });
        let per_chunk = elapsed.as_secs_f64() / iters as f64 / chunks_per_frame as f64;
        report(
            &format!("fft_processor {fft_size} (fps=8, per chunk)"),
            iters * chunks_per_frame,
            Duration::from_secs_f64(per_chunk * iters as f64 * chunks_per_frame as f64),
            2_400_000.0 / chunk_samples as f64,
        );
    }

    // --- IQ extractor ------------------------------------------------------
    let chunk_samples = CHUNK_BYTES / 2;
    let iq = make_iq_bytes(&mut rng, chunk_samples);
    for &out_rate in &[240_000i32, 48_000] {
        let mut ex = IqExtractor::new(IqExtractorConfig {
            input_sample_rate: SAMPLE_RATE,
            output_sample_rate: out_rate,
            tune_offset: 20_000,
            dc_offset_removal: true,
        })
        .unwrap();
        ex.set_bandwidth(if out_rate == 240_000 { 200_000 } else { 12_500 });
        let iters = 3000;
        let elapsed = best_of(iters, || {
            black_box(ex.process(black_box(&iq)));
        });
        report(
            &format!("iq_extractor 2.4M -> {out_rate} (own Vec)"),
            iters,
            elapsed,
            SAMPLE_RATE as f64 / chunk_samples as f64,
        );

        let mut out = Vec::with_capacity(4096);
        let elapsed = best_of(iters, || {
            ex.process_into(black_box(&iq), &mut out);
            black_box(&out);
        });
        report(
            &format!("iq_extractor 2.4M -> {out_rate} (reused)"),
            iters,
            elapsed,
            SAMPLE_RATE as f64 / chunk_samples as f64,
        );
    }

    // --- IQ extractor stages (isolate 2.4M front-end cost) ------------------
    let cx = make_complex(&make_int16_iq(&mut rng, chunk_samples));
    let mut nco = NcoBlock::new(20_000.0);
    nco.init(SAMPLE_RATE as f64).unwrap();
    let iters = 3000;
    let elapsed = best_of(iters, || {
        black_box(nco.process_complex(black_box(&cx)));
    });
    report(
        "  nco 8192 samples",
        iters,
        elapsed,
        SAMPLE_RATE as f64 / chunk_samples as f64,
    );

    let mut dc = DcBlocker::new(SAMPLE_RATE as f64, 1.0, true);
    let mut dc_buf = cx.clone();
    let elapsed = best_of(iters, || {
        dc_buf.copy_from_slice(&cx);
        dc.process(black_box(&mut dc_buf));
    });
    report(
        "  dc blocker 8192 samples",
        iters,
        elapsed,
        SAMPLE_RATE as f64 / chunk_samples as f64,
    );

    let mut conv = vec![num_complex::Complex32::default(); chunk_samples];
    let raw = make_iq_bytes(&mut rng, chunk_samples);
    let elapsed = best_of(iters, || {
        for (o, p) in conv.iter_mut().zip(raw.chunks_exact(2)) {
            *o = num_complex::Complex32::new(
                (p[0] as f32 - 127.5) * (1.0 / 127.5),
                (p[1] as f32 - 127.5) * (1.0 / 127.5),
            );
        }
        black_box(&conv);
    });
    report(
        "  u8->complex 8192 samples",
        iters,
        elapsed,
        SAMPLE_RATE as f64 / chunk_samples as f64,
    );

    let mut butter240 = ButterworthBlock::new(100_000.0);
    butter240.init(240_000.0).unwrap();
    let butter_in: Vec<num_complex::Complex32> = (0..819)
        .map(|i| {
            let a = i as f32 * 0.01;
            num_complex::Complex32::new(a.cos(), a.sin())
        })
        .collect();
    let elapsed = best_of(iters, || {
        black_box(butter240.process_complex(black_box(&butter_in)));
    });
    report(
        "  butterworth 819 samples @ 240k",
        iters,
        elapsed,
        240_000.0 / 819.0,
    );

    // --- Front-end IQ correction -------------------------------------------
    let mut iqcorr = serverrs::dsp::IqCorrect::new(SAMPLE_RATE as f64, 10.0, true);
    let mut corr_buf = cx.clone();
    let iters = 3000;
    let elapsed = best_of(iters, || {
        iqcorr.process(black_box(&mut corr_buf));
    });
    report(
        "iq_correction 8192 samples",
        iters,
        elapsed,
        SAMPLE_RATE as f64 / chunk_samples as f64,
    );

    // --- Decimator ---------------------------------------------------------
    let input = make_complex(&make_int16_iq(&mut rng, chunk_samples));
    let mut dec = DecimateBlock::new(10);
    dec.init(SAMPLE_RATE as f64).unwrap();
    dec.set_bandwidth(200_000);
    let iters = 4000;
    let elapsed = best_of(iters, || {
        black_box(dec.process_complex(black_box(&input)));
    });
    report(
        "decimator 2.4M factor 10, 200k bw",
        iters,
        elapsed,
        SAMPLE_RATE as f64 / chunk_samples as f64,
    );

    // --- FM FIR (stereo low-pass) -----------------------------------------
    let mut fir = serverrs::demod::SimpleFir::new(51, 15_000.0 / 240_000.0);
    let fir_in: Vec<f32> = (0..4800).map(|i| (i as f32 * 0.1).sin() * 0.2).collect();
    let mut fir_out = vec![0.0f32; fir_in.len()];
    let iters = 20_000;
    let elapsed = best_of(iters, || {
        fir.process_batch(black_box(&fir_in), &mut fir_out);
        black_box(&fir_out);
    });
    report(
        "fir 51-tap batch (20 ms @ 240k)",
        iters,
        elapsed,
        240_000.0 / fir_in.len() as f64,
    );

    // --- FM demodulators ---------------------------------------------------
    let iq48 = make_complex(&make_int16_iq(&mut rng, 960));
    let mut fm_mono = FmMonoDemod::new(50e-6);
    fm_mono.init(48_000.0).unwrap();
    let iters = 20_000;
    let elapsed = best_of(iters, || {
        black_box(fm_mono.process(black_box(&iq48)));
    });
    report(
        "fm_mono (20 ms @ 48k)",
        iters,
        elapsed,
        48_000.0 / 960.0,
    );

    let iq240 = make_complex(&make_int16_iq(&mut rng, 4800));
    let mut fm_stereo = FmStereoDemod::new(75e-6);
    fm_stereo.init(240_000.0).unwrap();
    let iters = 4000;
    let elapsed = best_of(iters, || {
        black_box(fm_stereo.process(black_box(&iq240)));
    });
    report(
        "fm_stereo (20 ms @ 240k)",
        iters,
        elapsed,
        240_000.0 / 4800.0,
    );

    // --- Opus pipeline (WFM, complexity 0) --------------------------------
    let mut opus = OpusPipeline::new(OpusPipelineConfig {
        mode: "wfm".to_string(),
        sample_rate: 240_000,
        bitrate: 0,
        stereo_enabled: Some(true),
        quality: "opus".to_string(),
        complexity: 0,
    })
    .unwrap();
    let opus_iq = make_int16_iq(&mut rng, 4800);
    let iters = 2000;
    let elapsed = best_of(iters, || {
        black_box(opus.process(black_box(&opus_iq)));
    });
    report(
        "opus_pipeline wfm mono-out (20 ms)",
        iters,
        elapsed,
        240_000.0 / 4800.0,
    );

    // --- RDS ---------------------------------------------------------------
    let mut rds = RdsDecoder::new(240_000.0);
    let composite: Vec<f32> = (0..4800)
        .map(|i| {
            let t = i as f64 / 240_000.0;
            (0.3 * (2.0 * std::f64::consts::PI * 19_000.0 * t).cos()
                + 0.1 * (2.0 * std::f64::consts::PI * 1_000.0 * t).sin()) as f32
        })
        .collect();
    let phases: Vec<f64> = (0..4800)
        .map(|i| (i as f64 * 2.0 * std::f64::consts::PI * 19_000.0 / 240_000.0) % (2.0 * std::f64::consts::PI))
        .collect();
    let iters = 4000;
    let elapsed = best_of(iters, || {
        black_box(rds.process_with_pilot(black_box(&composite), black_box(&phases)));
    });
    report(
        "rds decode (20 ms @ 240k)",
        iters,
        elapsed,
        240_000.0 / 4800.0,
    );

    // --- Codecs ------------------------------------------------------------
    let frame = make_fft_frame(&mut rng, 8192);
    let pcm: Vec<i16> = (0..8192).map(|i| ((i as f32 * 0.03).sin() * 12_000.0) as i16).collect();
    let iters = 5000;
    let elapsed = best_of(iters, || {
        black_box(encode_fft_adpcm(black_box(&frame), -130.0, 0.0));
    });
    report("fft adpcm encode (8192 bins)", iters, elapsed, 8.0);

    let elapsed = best_of(iters, || {
        black_box(compress_fft(black_box(&frame), -130.0, 0.0));
    });
    report("fft quantize (8192 bins)", iters, elapsed, 8.0);

    let mut deflate = FftDeflateEncoder::new(8192);
    let elapsed = best_of(iters, || {
        black_box(deflate.encode_message(0x0B, black_box(&frame), -130.0, 0.0).unwrap());
    });
    report("fft deflate encode (8192 bins)", iters, elapsed, 8.0);

    let mut adpcm = serverrs::codec::ImaAdpcmEncoder::new();
    let elapsed = best_of(iters, || {
        black_box(adpcm.encode(black_box(&pcm)));
    });
    report("adpcm encode (8192 samples)", iters, elapsed, 50.0);

    // --- WebSocket fan-out ------------------------------------------------
    let msg = vec![0x0Bu8; 8500];
    for &n in &[1usize, 4, 16] {
        let clients: Vec<Client> = (0..n)
            .map(|i| {
                Client::new(
                    format!("c{i}"),
                    format!("p{i}"),
                    1,
                    String::new(),
                    String::new(),
                    256,
                )
            })
            .collect();
        let iters = 20_000;
        let elapsed = best_of(iters, || {
            for c in &clients {
                c.send(black_box(msg.clone()));
                black_box(c.queue().pop());
            }
        });
        report(
            &format!("ws send 8.5 KB x {n} clients"),
            iters,
            elapsed,
            0.0,
        );
    }
}
