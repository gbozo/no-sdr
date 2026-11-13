//! Frame ↔ audio. The only file in `js8/` that touches raw `mfsk-core` types,
//! mirroring the role [`crate::modem`] plays for FT8.
//!
//! ## A note on transmit shaping
//!
//! JS8Call transmits **unshaped CPFSK**: `Modulator.cpp` steps a phase
//! accumulator, switches tone abruptly at each symbol boundary, and applies
//! only an exponential ramp-down over the last 0.017 symbols. There is no
//! Gaussian pulse anywhere in its transmit path.
//!
//! We shape ours with the same Gaussian FT8 uses (BT = 2.0). A JS8 receiver
//! recovers a symbol by measuring tone energy over the symbol period, so it is
//! indifferent to how the transitions are shaped — which is exactly why WSJT-X
//! could move FT8 from unshaped to GFSK in v2.0 without breaking older
//! decoders. What shaping buys is spectrum: hard tone switches splatter across
//! neighbouring signals, and JS8 sub-bands are crowded.
//!
//! [`synth_cpfsk`] reproduces JS8Call's waveform exactly and exists so the
//! difference can be measured rather than argued about.

use mfsk_core::engine::dsp::gfsk::{synth_f32, GfskCfg};
use mfsk_core::engine::tx::codeword_to_itone;
use mfsk_core::engine::{FrameLayout, ModulationParams};
use sdroxide_types::Js8Speed;

use super::ldpc;
use super::message::Js8Payload;
use super::protocol::Js8Proto;
use crate::with_js8_speed;

/// Sample rate everything here works at.
pub const DECODE_RATE: f64 = 12_000.0;

/// Channel symbols in a JS8 frame.
pub const N_SYMBOLS: usize = 79;

/// Turn a payload into the 79 tones that go on the air.
pub fn frame_tones<P: Js8Proto>(payload: Js8Payload) -> [u8; N_SYMBOLS] {
    let cw = ldpc::encode(&payload.to_info());
    let tones = codeword_to_itone::<P>(&cw);
    let mut out = [0u8; N_SYMBOLS];
    out.copy_from_slice(&tones);
    out
}

/// Tones for a runtime-selected speed.
pub fn frame_tones_for(speed: Js8Speed, payload: Js8Payload) -> [u8; N_SYMBOLS] {
    with_js8_speed!(speed, |P| frame_tones::<P>(payload))
}

/// Gaussian-shaped 12 kHz audio for one frame, centred on `audio_hz`.
pub fn synth_gfsk<P: Js8Proto>(tones: &[u8], audio_hz: f32, amplitude: f32) -> Vec<f32> {
    let nsps = <P as ModulationParams>::NSPS as usize;
    let cfg = GfskCfg {
        sample_rate: DECODE_RATE as f32,
        samples_per_symbol: nsps,
        bt: <P as ModulationParams>::GFSK_BT,
        hmod: <P as ModulationParams>::GFSK_HMOD,
        ramp_samples: nsps / 8,
    };
    synth_f32(tones, audio_hz, amplitude, &cfg)
}

/// JS8Call's own waveform: continuous-phase FSK with hard tone transitions and
/// an exponential ramp-down over the final 0.017 symbols (`Modulator.cpp`).
///
/// Kept for A/B comparison against [`synth_gfsk`]; not the default transmit
/// path.
pub fn synth_cpfsk<P: Js8Proto>(tones: &[u8], audio_hz: f32, amplitude: f32) -> Vec<f32> {
    let nsps = <P as ModulationParams>::NSPS as usize;
    let spacing = f64::from(<P as ModulationParams>::TONE_SPACING_HZ);
    let mut out = vec![0.0f32; tones.len() * nsps];
    let mut phi = 0.0f64;
    let mut amp = f64::from(amplitude);
    // Upstream fades over the last 0.017 symbols, multiplying by 0.98 per
    // 48 kHz frame; at 12 kHz that is four frames' worth per sample.
    let fade_from = ((tones.len() as f64 - 0.017) * nsps as f64) as usize;
    for (i, sample) in out.iter_mut().enumerate() {
        let tone = tones[i / nsps];
        let f = f64::from(audio_hz) + f64::from(tone) * spacing;
        phi += std::f64::consts::TAU * f / DECODE_RATE;
        if phi > std::f64::consts::TAU {
            phi -= std::f64::consts::TAU;
        }
        if i > fade_from {
            amp *= 0.98f64.powi(4);
        }
        *sample = (amp * phi.sin()) as f32;
    }
    out
}

/// [`synth_gfsk`] for a runtime-selected speed.
pub fn synth_gfsk_for(speed: Js8Speed, tones: &[u8], audio_hz: f32, amplitude: f32) -> Vec<f32> {
    with_js8_speed!(speed, |P| synth_gfsk::<P>(tones, audio_hz, amplitude))
}

/// [`synth_cpfsk`] for a runtime-selected speed.
pub fn synth_cpfsk_for(speed: Js8Speed, tones: &[u8], audio_hz: f32, amplitude: f32) -> Vec<f32> {
    with_js8_speed!(speed, |P| synth_cpfsk::<P>(tones, audio_hz, amplitude))
}

/// Encode one frame to 12 kHz audio for a runtime-selected speed.
pub fn encode_frame_12k(
    speed: Js8Speed,
    payload: Js8Payload,
    audio_hz: f32,
    amplitude: f32,
) -> Vec<f32> {
    with_js8_speed!(speed, |P| {
        let tones = frame_tones::<P>(payload);
        synth_gfsk::<P>(&tones, audio_hz, amplitude)
    })
}

/// Samples one frame occupies at 12 kHz, excluding the start delay.
pub fn frame_samples(speed: Js8Speed) -> usize {
    with_js8_speed!(speed, |P| N_SYMBOLS
        * <P as ModulationParams>::NSPS as usize)
}

/// Where a frame starts within its slot, in 12 kHz samples.
pub fn start_offset_samples(speed: Js8Speed) -> usize {
    with_js8_speed!(speed, |P| {
        (f64::from(<P as FrameLayout>::TX_START_OFFSET_S) * DECODE_RATE) as usize
    })
}

#[cfg(all(test, any()))]
mod tests {
    use super::super::protocol::{Js8Fast, Js8Normal, Js8Slow, Js8Turbo};
    use super::*;

    /// `(costas set, frame type, 12 transport chars, the 79 tones)`.
    ///
    /// Produced by compiling JS8Call's own `JS8::encode` (`JS8.cpp:2657`) into
    /// a standalone harness and running it. Costas set 0 is ORIGINAL (Normal),
    /// 1 is MODIFIED (Fast/Turbo/Slow). See `vendor/js8call/PROVENANCE.md`.
    ///
    /// One assertion against these covers the whole transmit chain at once:
    /// the transport alphabet, CRC-12 placement, the LDPC generator, the
    /// parity/message ordering within the frame, the identity tone map and the
    /// Costas arrays. Anything wrong in any of them moves at least one tone.
    #[rustfmt::skip]
    const GOLDEN: &[(u8, u8, &str, &[u8; 79])] = &[
        (0, 0, "0123456789AB", &[4,2,5,6,1,3,0,7,0,3,5,3,6,3,4,1,3,0,2,2,1,5,6,0,1,3,1,3,2,2,0,3,2,6,0,7,4,2,5,6,1,3,0,0,0,0,1,0,2,0,3,0,4,0,5,0,6,0,7,1,0,1,1,1,2,1,3,0,0,0,1,4,4,2,5,6,1,3,0]),
        (0, 3, "HELLOWORLD12", &[4,2,5,6,1,3,0,4,7,6,5,3,6,6,0,4,3,4,1,5,5,6,7,5,5,0,1,1,7,3,4,7,6,2,0,0,4,2,5,6,1,3,0,2,1,1,6,2,5,2,5,3,0,4,0,3,0,3,3,2,5,1,5,0,1,0,2,3,6,3,3,6,4,2,5,6,1,3,0]),
        (0, 4, "KM4ACKtestin", &[4,2,5,6,1,3,0,4,4,1,7,6,1,4,0,1,4,0,6,5,7,5,5,2,5,3,1,0,2,5,7,6,2,5,7,4,4,2,5,6,1,3,0,2,4,2,6,0,4,1,2,1,4,2,4,6,7,5,0,6,6,6,7,5,4,6,1,4,3,1,7,4,4,2,5,6,1,3,0]),
        (0, 1, "AAAAAAAAAAAA", &[4,2,5,6,1,3,0,1,7,6,3,0,6,0,2,7,7,7,1,1,0,3,3,4,2,4,5,3,1,1,3,1,0,5,3,5,4,2,5,6,1,3,0,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,7,3,0,0,4,2,5,6,1,3,0]),
        (0, 7, "zzzzzzzzzzzz", &[4,2,5,6,1,3,0,2,2,7,2,6,2,2,1,1,7,0,6,0,0,7,4,4,1,0,4,2,0,0,4,2,0,6,2,5,4,2,5,6,1,3,0,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,0,3,2,4,2,5,6,1,3,0]),
        (0, 2, "-+-+-+-+-+-+", &[4,2,5,6,1,3,0,5,4,1,3,3,2,4,2,5,5,4,6,2,3,2,0,7,1,1,5,0,6,0,0,4,6,5,7,2,4,2,5,6,1,3,0,7,6,7,7,7,6,7,7,7,6,7,7,7,6,7,7,7,6,7,7,7,6,7,7,2,6,7,0,0,4,2,5,6,1,3,0]),
        (0, 5, "000000000000", &[4,2,5,6,1,3,0,2,1,1,2,6,4,0,1,4,6,2,6,0,6,4,4,6,6,7,0,6,0,5,2,7,2,5,3,0,4,2,5,6,1,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,5,4,0,1,6,4,2,5,6,1,3,0]),
        (0, 6, "QRZdeVK3ABC1", &[4,2,5,6,1,3,0,0,2,6,0,5,6,0,3,4,2,3,2,7,5,0,7,0,7,2,4,5,2,0,5,4,0,4,5,7,4,2,5,6,1,3,0,3,2,3,3,4,3,4,7,5,0,3,7,2,4,0,3,1,2,1,3,1,4,0,1,6,1,5,6,2,4,2,5,6,1,3,0]),
        (1, 0, "0123456789AB", &[0,6,2,3,5,4,1,7,0,3,5,3,6,3,4,1,3,0,2,2,1,5,6,0,1,3,1,3,2,2,0,3,2,6,0,7,1,5,0,2,3,6,4,0,0,0,1,0,2,0,3,0,4,0,5,0,6,0,7,1,0,1,1,1,2,1,3,0,0,0,1,4,2,5,0,6,4,1,3]),
        (1, 3, "HELLOWORLD12", &[0,6,2,3,5,4,1,4,7,6,5,3,6,6,0,4,3,4,1,5,5,6,7,5,5,0,1,1,7,3,4,7,6,2,0,0,1,5,0,2,3,6,4,2,1,1,6,2,5,2,5,3,0,4,0,3,0,3,3,2,5,1,5,0,1,0,2,3,6,3,3,6,2,5,0,6,4,1,3]),
        (1, 4, "KM4ACKtestin", &[0,6,2,3,5,4,1,4,4,1,7,6,1,4,0,1,4,0,6,5,7,5,5,2,5,3,1,0,2,5,7,6,2,5,7,4,1,5,0,2,3,6,4,2,4,2,6,0,4,1,2,1,4,2,4,6,7,5,0,6,6,6,7,5,4,6,1,4,3,1,7,4,2,5,0,6,4,1,3]),
        (1, 1, "AAAAAAAAAAAA", &[0,6,2,3,5,4,1,1,7,6,3,0,6,0,2,7,7,7,1,1,0,3,3,4,2,4,5,3,1,1,3,1,0,5,3,5,1,5,0,2,3,6,4,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,2,1,7,3,0,0,2,5,0,6,4,1,3]),
        (1, 7, "zzzzzzzzzzzz", &[0,6,2,3,5,4,1,2,2,7,2,6,2,2,1,1,7,0,6,0,0,7,4,4,1,0,4,2,0,0,4,2,0,6,2,5,1,5,0,2,3,6,4,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,7,5,0,3,2,2,5,0,6,4,1,3]),
        (1, 2, "-+-+-+-+-+-+", &[0,6,2,3,5,4,1,5,4,1,3,3,2,4,2,5,5,4,6,2,3,2,0,7,1,1,5,0,6,0,0,4,6,5,7,2,1,5,0,2,3,6,4,7,6,7,7,7,6,7,7,7,6,7,7,7,6,7,7,7,6,7,7,7,6,7,7,2,6,7,0,0,2,5,0,6,4,1,3]),
        (1, 5, "000000000000", &[0,6,2,3,5,4,1,2,1,1,2,6,4,0,1,4,6,2,6,0,6,4,4,6,6,7,0,6,0,5,2,7,2,5,3,0,1,5,0,2,3,6,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,5,4,0,1,6,2,5,0,6,4,1,3]),
        (1, 6, "QRZdeVK3ABC1", &[0,6,2,3,5,4,1,0,2,6,0,5,6,0,3,4,2,3,2,7,5,0,7,0,7,2,4,5,2,0,5,4,0,4,5,7,1,5,0,2,3,6,4,3,2,3,3,4,3,4,7,5,0,3,7,2,4,0,3,1,2,1,3,1,4,0,1,6,1,5,6,2,2,5,0,6,4,1,3]),
    ];

    #[test]
    fn tones_match_js8calls_own_encoder() {
        for (costas, frame_type, text, want) in GOLDEN {
            let payload = Js8Payload::from_chars(text, *frame_type).expect("packs");
            // Costas set 0 is Normal's; set 1 is shared by the other three, so
            // any of them exercises it.
            let got: Vec<u8> = if *costas == 0 {
                frame_tones::<Js8Normal>(payload).to_vec()
            } else {
                frame_tones::<Js8Fast>(payload).to_vec()
            };
            assert_eq!(
                got,
                want.to_vec(),
                "costas {costas} type {frame_type} {text:?}"
            );
        }
    }

    #[test]
    fn every_modified_speed_produces_identical_tones() {
        // Fast, Turbo and Slow differ only in symbol duration, so their tone
        // sequences must agree exactly; only the audio length changes.
        let payload = Js8Payload::from_chars("KM4ACKtestin", 3).expect("packs");
        let fast = frame_tones::<Js8Fast>(payload);
        assert_eq!(fast, frame_tones::<Js8Turbo>(payload));
        assert_eq!(fast, frame_tones::<Js8Slow>(payload));
        assert_ne!(
            fast,
            frame_tones::<Js8Normal>(payload),
            "Normal uses the other Costas set"
        );
    }

    #[test]
    fn the_costas_blocks_survive_into_the_tone_sequence() {
        let payload = Js8Payload::from_chars("0123456789AB", 0).expect("packs");
        let t = frame_tones::<Js8Normal>(payload);
        assert_eq!(&t[0..7], &super::super::protocol::COSTAS_ORIGINAL);
        assert_eq!(&t[36..43], &super::super::protocol::COSTAS_ORIGINAL);
        assert_eq!(&t[72..79], &super::super::protocol::COSTAS_ORIGINAL);

        let t = frame_tones::<Js8Fast>(payload);
        assert_eq!(&t[0..7], &super::super::protocol::COSTAS_MODIFIED[0]);
        assert_eq!(&t[36..43], &super::super::protocol::COSTAS_MODIFIED[1]);
        assert_eq!(&t[72..79], &super::super::protocol::COSTAS_MODIFIED[2]);
    }

    #[test]
    fn all_tones_are_inside_the_alphabet() {
        for speed in Js8Speed::ALL {
            let payload = Js8Payload::from_chars("zzzzzzzzzzzz", 7).expect("packs");
            assert!(frame_tones_for(speed, payload).iter().all(|&t| t < 8));
        }
    }

    #[test]
    fn waveform_length_is_seventynine_symbols() {
        for speed in Js8Speed::ALL {
            let payload = Js8Payload::from_chars("0123456789AB", 0).expect("packs");
            let audio = encode_frame_12k(speed, payload, 1500.0, 0.5);
            assert_eq!(audio.len(), frame_samples(speed), "{}", speed.label());
            // And that length must match the published burst duration.
            let secs = audio.len() as f64 / DECODE_RATE;
            assert!(
                (secs - speed.burst_s()).abs() < 0.01,
                "{}: {secs:.2}s vs {:.2}s",
                speed.label(),
                speed.burst_s()
            );
        }
    }

    #[test]
    fn the_two_shapings_agree_on_tone_energy() {
        // GFSK and CPFSK must put their energy in the same places, or the
        // claim that a JS8 receiver is indifferent to shaping is wrong.
        let payload = Js8Payload::from_chars("KM4ACKtestin", 3).expect("packs");
        let tones = frame_tones::<Js8Normal>(payload);
        let g = synth_gfsk::<Js8Normal>(&tones, 1500.0, 0.5);
        let c = synth_cpfsk::<Js8Normal>(&tones, 1500.0, 0.5);
        assert_eq!(g.len(), c.len());

        let nsps = 1920usize;
        let spacing = 6.25f64;
        for (sym, &tone) in tones.iter().enumerate().take(20) {
            // Measure each candidate tone's energy over the symbol and check
            // the transmitted one wins in both waveforms.
            let best = |audio: &[f32]| {
                (0..8u8)
                    .max_by(|&a, &b| {
                        let e = |t: u8| {
                            let f = 1500.0 + f64::from(t) * spacing;
                            let (mut re, mut im) = (0.0f64, 0.0f64);
                            for k in 0..nsps {
                                let ph = std::f64::consts::TAU * f * k as f64 / DECODE_RATE;
                                let s = f64::from(audio[sym * nsps + k]);
                                re += s * ph.cos();
                                im += s * ph.sin();
                            }
                            re * re + im * im
                        };
                        e(a).total_cmp(&e(b))
                    })
                    .unwrap()
            };
            assert_eq!(best(&g), tone, "gfsk symbol {sym}");
            assert_eq!(best(&c), tone, "cpfsk symbol {sym}");
        }
    }
}
