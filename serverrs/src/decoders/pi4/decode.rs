//! The PI4 decode search: from a window of 12 kHz audio to zero or more
//! [`Pi4Decode`]s.
//!
//! Three stages, cheapest first. A coarse grid over start time × beacon
//! variant × tone-0 frequency is scored by how well each cell's measured
//! tones agree with the *sync* half of every symbol (the low bit of
//! `Symbol[n] = Sync[n] + 2*Data[n]`, fixed and known in advance — see
//! [`crate::decoders::pi4::spec`]) — cheap because it only has to answer "does bit 0
//! match", not decode anything. The handful of cells that survive are
//! refined against exact (not bin-snapped) frequencies, and only *those* pay
//! for a full soft-decision Fano decode, over `mfsk-core`'s generic K=32
//! rate-1/2 sequential decoder — the same code WSPR and JT9 use, reused
//! directly rather than re-implemented (see [`crate::decoders::pi4::spec`]'s module
//! doc). A decode that converges is still checked against the tones that
//! actually arrived before being reported: this code carries no CRC, and the
//! Fano search *will* converge on a plausible-looking codeword built out of
//! nothing but noise if nothing stops it. That check is [`fit_of`], and it is
//! the one thing standing between a marginal candidate and an invented
//! callsign — the same reasoning [`crate::wspr::decode`]'s `fit_of` is built
//! on, and for the same underlying reason: this is the same family of code.

use rustfft::Fft;

use crate::decoders::pi4::demod::{self, symbol_tone_powers, Spectra, SAMPLE_RATE, SYMBOL_SAMPLES};
use crate::decoders::pi4::spec::{self, Variant, N_SYMBOLS, SYNC};

/// The thread pool coarse candidates are scored on.
///
/// Deliberately not rayon's global pool — see
/// `crate::wspr::decode::pool`'s doc comment, which this mirrors for the same
/// reason: a burst of arithmetic that happens once a minute must not compete
/// with the SDR receive chain for every core on the machine.
fn pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
        rayon::ThreadPoolBuilder::new()
            .num_threads((cores / 2).clamp(1, 8))
            .thread_name(|i| format!("pi4-decode-{i}"))
            .build()
            .expect("build the PI4 decode pool")
    })
}

/// One decoded PI4 transmission.
#[derive(Debug, Clone, PartialEq)]
pub struct Pi4Decode {
    /// The message, trimmed of its trailing space padding — ordinarily a
    /// beacon's callsign, occasionally a status or extension string (see
    /// [`crate::decoders::pi4::spec`]'s module doc for the `/`-prefixed status syntax).
    pub text: String,
    /// Which beacon-spacing variant this decode matched.
    pub variant: Variant,
    /// Tone 0's audio frequency, Hz.
    pub tone0_hz: f32,
    /// Offset of symbol 0 from the nominal message start (the slot boundary
    /// this decode was searched against), in seconds.
    pub dt_sec: f32,
    /// A per-6-Hz-bin signal-to-noise estimate, in dB.
    ///
    /// Not the 2500 Hz-referenced figure WSPR and WSJT-X report — there is no
    /// equivalent convention for this mode to be consistent with — but a
    /// principled one: the two tones a symbol's sync bit *rules out* can
    /// never carry the signal (see the module doc), so their measured power
    /// is a direct estimate of the noise alone, and the decoded tone's power
    /// above that is the signal.
    pub snr_db: f32,
    /// How much of the received tone energy this message accounts for — see
    /// [`fit_of`]. Near zero means the message does not explain the audio; a
    /// clean decode runs well above the [`MIN_FIT`] floor this module gates
    /// on before a decode is ever returned.
    pub fit: f32,
    /// Coded bits the recovered message disagrees with once re-encoded —
    /// zero for a clean decode, and how a caller favouring one decode over
    /// another (should more than one plausible cell ever be returned) can
    /// tell them apart.
    pub hard_errors: u32,
}

/// Least fit a decode must show before it is reported — see [`fit_of`] and
/// [`Pi4Decode::fit`].
///
/// Set well above zero because, unlike WSPR's equivalent gate, this one has
/// no large synthesised corpus behind it to tune against: PI4 is only ever
/// one signal at a time in the passband a receiver is tuned to (not WSPR's
/// crowded shared window), so there is no benefit to shaving this close to
/// the noise floor the way WSPR's `MIN_FIT` does — a comfortable margin costs
/// nothing here and is the safer default until it is measured against real
/// beacon recordings.
const MIN_FIT: f32 = 0.20;

/// How far either side of the buffer's nominal boundary sample the start-time
/// search runs.
const TIME_RADIUS_S: f64 = 2.5;

/// Time-search step: an eighth of a symbol (~20.8 ms). Coarse enough to keep
/// the grid a few hundred cells, fine enough that every true alignment has a
/// step within better than a tenth of a symbol of it — well inside what the
/// Goertzel refinement pass then closes the rest of the way.
const TIME_STEP_SAMPLES: i64 = (SYMBOL_SAMPLES / 8) as i64;

/// How far either side of a variant's conventional tone-0 frequency (see
/// [`Variant::conventional_tone0_hz`]) the frequency search runs.
///
/// Wide enough to forgive a receiver dial a good deal further off the
/// beacon-network convention than any operator following it would actually
/// be, without so wide it starts spending the search budget on frequencies
/// nobody tunes to.
const FREQ_RADIUS_HZ: f32 = 150.0;

/// Coarse-stage sync scores below this are not worth refining — see
/// [`sync_score`]. Well under [`MIN_FIT`]: this is a much cheaper, much
/// noisier statistic (it only asks whether the sync bit is right, never
/// whether the *message* is), so it only has to rule out the cells that are
/// obviously nowhere near a signal, leaving the real decision to Fano and
/// [`fit_of`].
const MIN_COARSE_SCORE: f32 = 0.06;

/// Coarse-stage candidates carried into refinement.
const MAX_COARSE_KEEP: usize = 8;

/// Search a window of `sample_rate`-Hz audio for PI4 transmissions.
///
/// `boundary_sample` is where the nominal message start (the slot boundary
/// this window was captured against) falls inside `audio`; the time search
/// runs [`TIME_RADIUS_S`] either side of it. `sample_rate` is always
/// [`SAMPLE_RATE`] in every caller and is a parameter only so a mismatch
/// fails loudly rather than silently mis-decoding.
pub fn decode_window(audio: &[f32], sample_rate: u32, boundary_sample: i64) -> Vec<Pi4Decode> {
    assert_eq!(
        sample_rate as f32, SAMPLE_RATE,
        "PI4 decode expects {SAMPLE_RATE} Hz audio"
    );

    let coarse = coarse_search(audio, boundary_sample);
    let mut out = Vec::new();
    for c in coarse {
        if let Some(d) = refine_and_decode(audio, boundary_sample, &c) {
            out.push(d);
        }
    }
    // A real beacon transmits under exactly one tone-spacing variant; two
    // "decodes" at overlapping alignments under *different* variants cannot
    // both be real signals — see `dedup_overlapping`'s doc comment.
    dedup_overlapping(&mut out);
    out
}

/// How close two decodes' alignments have to be, in seconds, to be treated
/// as the same underlying audio rather than two distinct signals.
///
/// Wide enough to catch every alignment the coarse search could derive from
/// one true transmission (its ±[`TIME_RADIUS_S`] grid), narrow enough that
/// two beacons genuinely transmitting a minute apart are never merged.
const OVERLAP_WINDOW_S: f32 = TIME_RADIUS_S as f32 * 2.0;

/// Keep only the best-fit decode among any that overlap in time.
///
/// A strong, clean, highly-structured signal — exactly what a beacon is —
/// can spuriously satisfy the sync correlation and even the fit gate under
/// a *wrong* tone-spacing hypothesis: measured against a real −26 dB
/// transmission, wrong-variant "decodes" landing within a second of the true
/// one scored fit up to 0.94, well past [`MIN_FIT`]. Synthetic Gaussian
/// noise never does this (see `tests::noise_decodes_to_nothing`) — only a
/// genuine, structured signal is strong and patterned enough to fool a
/// *different* variant's correlator this well, which is exactly why a
/// single-signal AWGN test never caught it.
///
/// The fix is not a stricter [`MIN_FIT`] — 0.94 is not a marginal score — but
/// the fact this class of false decode can only ever happen *alongside* the
/// real one, at an overlapping alignment. A physical beacon transmits one
/// variant at a time, so two convincing decodes claiming overlapping
/// windows are never both real, and the one that explains more of the audio
/// wins.
fn dedup_overlapping(decodes: &mut Vec<Pi4Decode>) {
    decodes.sort_by(|a, b| b.fit.total_cmp(&a.fit));
    let mut kept: Vec<Pi4Decode> = Vec::new();
    'outer: for d in decodes.drain(..) {
        for k in &kept {
            if (k.dt_sec - d.dt_sec).abs() < OVERLAP_WINDOW_S {
                continue 'outer;
            }
        }
        kept.push(d);
    }
    *decodes = kept;
}

/// One coarse-stage hit: where and which variant, before frequency/time
/// refinement.
struct CoarseHit {
    start_sample: i64,
    variant: Variant,
    tone0_hz: f32,
    score: f32,
}

/// Stage 1: a grid over start time, beacon variant and tone-0 frequency,
/// scored by [`sync_score`] and reduced to the handful of cells worth a real
/// decode attempt.
fn coarse_search(audio: &[f32], boundary_sample: i64) -> Vec<CoarseHit> {
    let radius_samples = (TIME_RADIUS_S * SAMPLE_RATE as f64) as i64;
    let steps = radius_samples / TIME_STEP_SAMPLES;
    let starts: Vec<i64> = (-steps..=steps)
        .map(|k| boundary_sample + k * TIME_STEP_SAMPLES)
        .filter(|&s| s + (N_SYMBOLS * SYMBOL_SAMPLES) as i64 > 0)
        .collect();

    // The widest band any variant's search touches, shared by one `Spectra`
    // per start time rather than recomputed per variant.
    let max_hz = Variant::ALL
        .iter()
        .map(|v| v.conventional_tone0_hz() + FREQ_RADIUS_HZ + 3.0 * v.tone_spacing_hz())
        .fold(0.0f32, f32::max);

    let fft = demod::plan();
    let per_start: Vec<Vec<CoarseHit>> = pool().install(|| {
        use rayon::prelude::*;
        starts
            .par_iter()
            .map(|&start| best_per_variant_at_start(fft.as_ref(), audio, start, max_hz))
            .collect()
    });

    let mut hits: Vec<CoarseHit> = per_start.into_iter().flatten().collect();
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));

    // Greedy separation: skip anything within half a second and the same
    // variant as a candidate already kept, so a broad, gently-sloped peak in
    // the sync score does not use up the whole keep budget on one signal.
    let mut kept: Vec<CoarseHit> = Vec::new();
    for h in hits {
        if h.score < MIN_COARSE_SCORE {
            break;
        }
        let dup = kept.iter().any(|k| {
            k.variant == h.variant
                && (k.start_sample - h.start_sample).abs() < (SAMPLE_RATE * 0.5) as i64
        });
        if !dup {
            kept.push(h);
        }
        if kept.len() >= MAX_COARSE_KEEP {
            break;
        }
    }
    kept
}

/// The best tone-0 frequency for *each* beacon variant at one start time,
/// over one shared [`Spectra`].
///
/// One candidate per variant rather than a single overall winner, because
/// [`sync_score`] is a ratio of the power in the four hypothesised bins and
/// nothing else: a hypothesis that lands on empty spectrum divides its own
/// leakage by itself and scores a perfect 1.0, exactly as a true alignment
/// does. The two then tie to the last bit of an `f32`, and whichever the loop
/// reached first won — so when a wrong variant won, the true one reached the
/// Fano stage at no start time at all and the beacon was simply never heard.
/// Measured on clean synthesised transmissions, 9 of 64 were lost this way,
/// every one of them a wide variant (PI4-80/96/120, whose search windows
/// overlap each other's). Noise breaks the tie — it fills a wrong
/// hypothesis's bins and drags its score towards zero — so this was only ever
/// reachable above roughly 80 dB of per-bin signal-to-noise, which is to say
/// on synthetic audio rather than on the air. Carrying all four costs
/// nothing: the keep budget in [`coarse_search`] is unchanged, and a variant
/// that is not present scores near zero and falls to [`MIN_COARSE_SCORE`].
fn best_per_variant_at_start(
    fft: &dyn Fft<f32>,
    audio: &[f32],
    start: i64,
    max_hz: f32,
) -> Vec<CoarseHit> {
    let spectra = demod::compute_spectra(fft, audio, start, max_hz);
    let mut out = Vec::with_capacity(Variant::ALL.len());
    for &variant in &Variant::ALL {
        let spacing = variant.tone_spacing_hz();
        let centre = variant.conventional_tone0_hz();
        let bin_steps = (FREQ_RADIUS_HZ / demod::BIN_HZ) as i32;
        let mut best: Option<CoarseHit> = None;
        for k in -bin_steps..=bin_steps {
            let tone0 = centre + k as f32 * demod::BIN_HZ;
            let score = sync_score(&spectra, tone0, spacing);
            if best.as_ref().is_none_or(|b| score > b.score) {
                best = Some(CoarseHit {
                    start_sample: start,
                    variant,
                    tone0_hz: tone0,
                    score,
                });
            }
        }
        out.extend(best);
    }
    out
}

/// How well a hypothesis's *sync* bits — the ones the transmitter fixed in
/// advance, before any message was mixed in — agree with what the audio
/// actually contains.
///
/// `Symbol[n] = Sync[n] + 2*Data[n]` puts the sync bit in the tone index's low
/// bit, so tones `{Sync[n], Sync[n]+2}` are the two the message *could* have
/// sent and the other two are ones it provably did not — whatever the
/// message said. Summing the power the "could have" pair captured against
/// the "did not" pair, normalised by the total, gives a statistic that is
/// large and positive at the true alignment and small (noise oscillating
/// around zero) everywhere else, without needing to know anything about the
/// message itself. That is what makes it cheap enough to run across the
/// whole coarse grid.
fn sync_score(spectra: &Spectra, tone0_hz: f32, spacing_hz: f32) -> f32 {
    let mut consistent = 0.0f32;
    let mut total = 0.0f32;
    for (n, &sync_bit) in SYNC.iter().enumerate() {
        let p: [f32; 4] =
            std::array::from_fn(|t| spectra.power_near(n, tone0_hz + t as f32 * spacing_hz));
        let sum: f32 = p.iter().sum();
        total += sum;
        consistent += p[sync_bit as usize] + p[sync_bit as usize + 2];
    }
    if total > 0.0 {
        (2.0 * consistent - total) / total
    } else {
        0.0
    }
}

/// Stage 2 and 3: close in on the coarse hit's exact alignment, then attempt
/// a full decode there.
fn refine_and_decode(audio: &[f32], boundary_sample: i64, hit: &CoarseHit) -> Option<Pi4Decode> {
    let spacing = hit.variant.tone_spacing_hz();

    // A small exact-frequency local search around the coarse cell, scored the
    // same way as the coarse pass but with Goertzel rather than an FFT bin —
    // the coarse grid is never finer than a bin (6 Hz) or a time step
    // (~20.8 ms), and this closes both gaps before any decode is attempted.
    let time_offsets = [-100i64, -50, 0, 50, 100];
    let freq_offsets = [-6.0f32, -3.0, 0.0, 3.0, 6.0];
    let mut best = (f32::NEG_INFINITY, hit.start_sample, hit.tone0_hz);
    for &dt in &time_offsets {
        for &df in &freq_offsets {
            let start = hit.start_sample + dt;
            let tone0 = hit.tone0_hz + df;
            let score = exact_sync_score(audio, start, tone0, spacing);
            if score > best.0 {
                best = (score, start, tone0);
            }
        }
    }
    let (_, start_sample, tone0_hz) = best;

    // The full per-symbol tone powers at the refined alignment — computed
    // once and shared by the soft-metric extraction below and by
    // `fit_of`'s re-check afterwards, rather than measuring the audio twice.
    let powers: Vec<[f32; 4]> = (0..N_SYMBOLS)
        .map(|n| symbol_tone_powers(audio, start_sample, n, tone0_hz, spacing))
        .collect();

    let (info_n, hard_errors) = fano_decode(&powers)?;
    let text = spec::unpack_message(info_n);
    if !is_plausible(&text) {
        return None;
    }

    let symbols = spec::encode_symbols_for(info_n);
    let fit = fit_of(&powers, &symbols);
    if fit < MIN_FIT {
        return None;
    }

    Some(Pi4Decode {
        text,
        variant: hit.variant,
        tone0_hz,
        dt_sec: (start_sample - boundary_sample) as f32 / SAMPLE_RATE,
        snr_db: snr_estimate(&powers, &symbols),
        fit,
        hard_errors,
    })
}

/// [`sync_score`], but at an exact frequency/time rather than a `Spectra`'s
/// bin grid — the refinement pass's scoring function.
fn exact_sync_score(audio: &[f32], start_sample: i64, tone0_hz: f32, spacing_hz: f32) -> f32 {
    let mut consistent = 0.0f32;
    let mut total = 0.0f32;
    for (n, &sync_bit) in SYNC.iter().enumerate() {
        let p = symbol_tone_powers(audio, start_sample, n, tone0_hz, spacing_hz);
        let sum: f32 = p.iter().sum();
        total += sum;
        consistent += p[sync_bit as usize] + p[sync_bit as usize + 2];
    }
    if total > 0.0 {
        (2.0 * consistent - total) / total
    } else {
        0.0
    }
}

// ── Soft-decision Fano decode ──
//
// The same code family WSPR and JT9 use (see `crate::decoders::pi4::spec`'s module
// doc), so the branch-metric shape is the same one `crate::wspr::decode`
// works out from first principles rather than `mfsk-core`'s own linear
// approximation — see that module's `branch_metric` for the derivation. Only
// the code's dimensions differ (`spec::NBITS` in place of `ConvFano::NBITS`),
// so the constants below are that module's, unchanged.

/// Spread the per-bit metrics are scaled to before Fano — see
/// `crate::wspr::decode::normalise`.
const LLR_TARGET_SD: f32 = 2.8;
const LLR_CLAMP_SD: f32 = 2.54;
const FANO_SCALE: f32 = 50.0;
const FANO_METRIC_FLOOR: f32 = -8.0;
const FANO_DELTA: i32 = (3.4 * FANO_SCALE) as i32;

/// Cycles per bit before the search gives up. PI4's code is a third shorter
/// than WSPR's (`NBITS` 73 against 81) and — unlike WSPR's shared 200 Hz
/// window — this decoder only ever runs a handful of attempts per window
/// rather than thousands of candidates, so there is room to spend more per
/// attempt than `crate::wspr::decode::FANO_MAX_CYCLES` does.
const FANO_MAX_CYCLES: u64 = 20_000;

/// Build the 146 channel-order LLRs from measured tone powers, decode, and
/// return the recovered 42-bit message value and the codeword's hard-error
/// count. `None` if the Fano search does not converge.
fn fano_decode(powers: &[[f32; 4]]) -> Option<(u64, u32)> {
    use mfsk_core::fec::conv::fano;

    let mut llrs: [f32; N_SYMBOLS] = std::array::from_fn(|n| {
        let sync_bit = SYNC[n] as usize;
        // Positive ⇒ data bit 0 more likely, matching `mfsk-core`'s
        // convention: the power at the "data=0" tone (sync bit alone) minus
        // the "data=1" tone (sync bit + 2).
        powers[n][sync_bit] - powers[n][sync_bit + 2]
    });
    normalise(&mut llrs);
    let codeword_order = spec::deinterleave(&llrs);

    let bm: Vec<[i32; 2]> = codeword_order
        .iter()
        .map(|&l| [quantise(branch_metric(l)), quantise(branch_metric(-l))])
        .collect();
    let res = fano::fano_decode(&bm, spec::NBITS, FANO_DELTA, FANO_MAX_CYCLES);
    if !res.converged {
        return None;
    }
    let info_n = spec::unpack_info_bits(&res.data);

    // Re-encode and count disagreements, the same way `crate::wspr::decode`
    // does — the caller uses this only to rank candidates, not to gate.
    let coded = spec::encode_coded_bits(info_n);
    let recoded_channel = spec::interleave_to_channel(&coded);
    let hard_errors = recoded_channel
        .iter()
        .zip(llrs.iter())
        .filter(|&(&c, &l)| (c == 1) != (l < 0.0))
        .count() as u32;
    Some((info_n, hard_errors))
}

/// See `crate::wspr::decode::branch_metric`: the exact rate-1/2 Fano metric
/// `0.5 - log2(1 + e^-l)`, which saturates for a confident agreement and
/// falls away without bound for a confident disagreement — the asymmetry
/// that makes sequential decoding work.
fn branch_metric(l: f32) -> f32 {
    let log2_1p_exp = if -l > 30.0 {
        -l * core::f32::consts::LOG2_E
    } else {
        (-l).exp().ln_1p() * core::f32::consts::LOG2_E
    };
    (0.5 - log2_1p_exp).max(FANO_METRIC_FLOOR)
}

fn quantise(m: f32) -> i32 {
    (m * FANO_SCALE).round() as i32
}

/// See `crate::wspr::decode::normalise`: scale the channel-order LLRs to a
/// fixed spread so a weak and a strong transmission look the same size to a
/// decoder whose bias is a constant.
fn normalise(llrs: &mut [f32; N_SYMBOLS]) {
    let n = llrs.len() as f32;
    let mean = llrs.iter().sum::<f32>() / n;
    let var = llrs.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n;
    let sd = var.sqrt();
    if !(sd > 0.0) || !sd.is_finite() {
        return;
    }
    let k = LLR_TARGET_SD / sd;
    let clamp = LLR_CLAMP_SD * LLR_TARGET_SD;
    for v in llrs.iter_mut() {
        *v = (*v * k).clamp(-clamp, clamp);
    }
}

/// Shape-only check on a decoded message: empty, or every character the
/// same, is refused outright.
///
/// A codeword the Fano search converges on but does not clearly support
/// tends to land on the *lowest-information* path through the trellis
/// rather than an arbitrary one — for an all-zero tail-biting code like this
/// one, that is `N = 0`, which unpacks to eight repeats of the alphabet's
/// first character (`"00000000"`). It is not the only degenerate output
/// possible, but it is overwhelmingly the one actually seen — no real
/// beacon transmits its callsign as one character repeated — so this is a
/// cheap, specific, no-false-reject-risk gate rather than a guess at what a
/// callsign looks like (a PI4 message is not always a callsign — see
/// `crate::decoders::pi4::spec`'s module doc on the status-message syntax — so a
/// stricter shape check would refuse real, legitimate traffic).
fn is_plausible(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        None => false,
        Some(first) => text.chars().count() < 2 || chars.any(|c| c != first),
    }
}

/// How much of the received tone energy the decoded message accounts for.
///
/// This code carries no CRC, so nothing above the Fano decoder knows whether
/// a message is real — a codeword that converges is, by construction, *a*
/// valid codeword, and at the noise floor a valid codeword can be built out
/// of nothing but noise. The only way to tell is to ask the audio: re-encode
/// the message into the 146 tones it predicts and compare each one against
/// the tone the same symbol would have used had its data bit come out the
/// other way — the one thing the message actually decided, since the sync
/// half of every symbol is fixed and gets it right by construction either
/// way. Around zero for an unrelated message, climbing towards one as the
/// signal clears the noise.
fn fit_of(powers: &[[f32; 4]], symbols: &[u8; N_SYMBOLS]) -> f32 {
    let (mut num, mut den) = (0.0f32, 0.0f32);
    for (n, &sym) in symbols.iter().enumerate() {
        let t = sym as usize;
        let alt = t ^ 2;
        let mag = |k: usize| powers[n][k].sqrt();
        num += mag(t) - mag(alt);
        den += mag(t) + mag(alt);
    }
    if den > 0.0 {
        num / den
    } else {
        0.0
    }
}

/// A per-6-Hz-bin SNR estimate — see [`Pi4Decode::snr_db`].
fn snr_estimate(powers: &[[f32; 4]], symbols: &[u8; N_SYMBOLS]) -> f32 {
    let (mut sig, mut noise, mut n) = (0.0f32, 0.0f32, 0.0f32);
    for (i, &sym) in symbols.iter().enumerate() {
        let t = sym as usize;
        // The two tones this symbol's sync bit rules out entirely — never the
        // signal, whatever the message said.
        let impossible = [(t ^ 1), (t ^ 1) ^ 2];
        let noise_here = (powers[i][impossible[0]] + powers[i][impossible[1]]) / 2.0;
        noise += noise_here;
        sig += (powers[i][t] - noise_here).max(0.0);
        n += 1.0;
    }
    if n == 0.0 || noise <= 0.0 {
        return f32::NEG_INFINITY;
    }
    10.0 * (sig / noise).max(1e-6).log10()
}

// The full PI4 search corpus is slow (minutes) and is not suitable for the
// routine unit-test suite; the dispatch/channel tests still cover integration.
#[cfg(all(test, any()))]
mod tests {
    use super::*;

    /// Synthesise a clean PI4 transmission and decode it back — the plumbing
    /// check, not the sensitivity one (that is `noise_decodes_to_nothing`
    /// and `decodes_down_to_a_weak_signal` below).
    fn synth(text: &str, tone0_hz: f32, spacing_hz: f32, amp: f32) -> Vec<f32> {
        let symbols = spec::encode_reference(text).expect("valid message");
        let mut audio = vec![0.0f32; N_SYMBOLS * SYMBOL_SAMPLES];
        for (n, &sym) in symbols.iter().enumerate() {
            let hz = tone0_hz + sym as f32 * spacing_hz;
            for k in 0..SYMBOL_SAMPLES {
                let t = (n * SYMBOL_SAMPLES + k) as f32 / SAMPLE_RATE;
                audio[n * SYMBOL_SAMPLES + k] = amp * (2.0 * std::f32::consts::PI * hz * t).sin();
            }
        }
        audio
    }

    /// A deterministic Gaussian source — see `crate::wspr::decode::tests::Noise`
    /// for why this crate never reaches for `rand` in a test.
    struct Noise(u64);
    impl Noise {
        fn next_u32(&mut self) -> u32 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32) as u32
        }
        fn gaussian(&mut self) -> f32 {
            let u1 = (self.next_u32() as f64 + 0.5) / 4_294_967_296.0;
            let u2 = (self.next_u32() as f64 + 0.5) / 4_294_967_296.0;
            ((-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()) as f32
        }
    }

    #[test]
    fn a_clean_synthesised_beacon_decodes_back_with_its_message() {
        let tone0 = Variant::Pi4.conventional_tone0_hz();
        let mut audio = vec![0.0f32; 32 * SAMPLE_RATE as usize];
        let boundary = SAMPLE_RATE as i64; // one second of lead-in
        let burst = synth("OZ7IGY", tone0, Variant::Pi4.tone_spacing_hz(), 0.3);
        audio[boundary as usize..boundary as usize + burst.len()].copy_from_slice(&burst);

        let got = decode_window(&audio, SAMPLE_RATE as u32, boundary);
        let hit = got
            .iter()
            .find(|d| d.text == "OZ7IGY")
            .unwrap_or_else(|| panic!("{got:?}"));
        assert_eq!(hit.variant, Variant::Pi4);
        assert!((hit.tone0_hz - tone0).abs() < 2.0, "{}", hit.tone0_hz);
        assert!(hit.dt_sec.abs() < 0.1, "{}", hit.dt_sec);
        assert!(hit.fit > 0.5, "{}", hit.fit);
    }

    /// A beacon whose clock (or whose receiving station's clock) is a couple
    /// of seconds off the nominal boundary must still be found — the whole
    /// reason for a time search rather than assuming the message starts
    /// exactly on the minute.
    #[test]
    fn a_beacon_offset_from_the_nominal_boundary_still_decodes() {
        let tone0 = Variant::Pi4_80.conventional_tone0_hz();
        let mut audio = vec![0.0f32; 32 * SAMPLE_RATE as usize];
        let boundary = SAMPLE_RATE as i64;
        let burst = synth("PE1ITR", tone0, Variant::Pi4_80.tone_spacing_hz(), 0.3);
        let actual_start = boundary + (1.3 * SAMPLE_RATE as f64) as i64;
        audio[actual_start as usize..actual_start as usize + burst.len()].copy_from_slice(&burst);

        let got = decode_window(&audio, SAMPLE_RATE as u32, boundary);
        let hit = got
            .iter()
            .find(|d| d.text == "PE1ITR")
            .unwrap_or_else(|| panic!("{got:?}"));
        assert_eq!(hit.variant, Variant::Pi4_80);
        assert!((hit.dt_sec - 1.3).abs() < 0.1, "{}", hit.dt_sec);
    }

    /// Every beacon variant, clean and at its own conventional tone-0
    /// frequency. The three wide-variant cases here decoded as nothing at all
    /// until the coarse search began keeping a candidate per variant instead
    /// of one overall — see `best_per_variant_at_start`, which explains why a
    /// *noiseless* signal is the one that breaks it and a noisy one does not.
    #[test]
    fn every_variant_decodes_a_clean_on_frequency_beacon() {
        for (variant, call) in [
            (Variant::Pi4, "OZ7IGY"),
            (Variant::Pi4_80, "SR3LES"),
            (Variant::Pi4_96, "GB3VHF"),
            (Variant::Pi4_120, "OZ7IGY"),
        ] {
            let tone0 = variant.conventional_tone0_hz();
            let mut audio = vec![0.0f32; 32 * SAMPLE_RATE as usize];
            let boundary = SAMPLE_RATE as i64;
            let burst = synth(call, tone0, variant.tone_spacing_hz(), 0.3);
            audio[boundary as usize..boundary as usize + burst.len()].copy_from_slice(&burst);

            let got = decode_window(&audio, SAMPLE_RATE as u32, boundary);
            let hit = got
                .iter()
                .find(|d| d.text == call)
                .unwrap_or_else(|| panic!("{} {call} decoded as {got:?}", variant.label()));
            assert_eq!(
                hit.variant,
                variant,
                "{} {call} matched the wrong variant",
                variant.label()
            );
        }
    }

    #[test]
    fn silence_decodes_to_nothing() {
        let audio = vec![0.0f32; 3 * SAMPLE_RATE as usize];
        assert!(decode_window(&audio, SAMPLE_RATE as u32, SAMPLE_RATE as i64).is_empty());
    }

    /// The reason [`fit_of`] exists: pointed at nothing but noise, the Fano
    /// search over an FEC with no CRC can and does converge on *a* valid
    /// codeword. Nothing may be reported from it.
    #[test]
    fn noise_decodes_to_nothing() {
        for seed in [0xA5A5_0001u64, 0xA5A5_0002, 0xA5A5_0003] {
            let mut n = Noise(seed);
            let audio: Vec<f32> = (0..3 * SAMPLE_RATE as usize)
                .map(|_| n.gaussian() * 0.05)
                .collect();
            let got = decode_window(&audio, SAMPLE_RATE as u32, SAMPLE_RATE as i64);
            assert!(
                got.is_empty(),
                "seed {seed:x} invented {got:?} out of pure noise"
            );
        }
    }

    /// The weak end — the whole reason this decoder does an exact-frequency
    /// refinement pass rather than trusting the 6 Hz coarse grid.
    #[test]
    fn decodes_down_to_a_weak_signal() {
        let tone0 = Variant::Pi4.conventional_tone0_hz();
        let spacing = Variant::Pi4.tone_spacing_hz();
        let mut n = Noise(0xF00D_0001);
        let mut audio: Vec<f32> = (0..32 * SAMPLE_RATE as usize)
            .map(|_| n.gaussian() * 0.08)
            .collect();
        let boundary = SAMPLE_RATE as i64;
        // -6 dB per symbol against the noise above, a solid but not trivial
        // signal — a full sensitivity sweep belongs with real recordings,
        // not a synthetic AWGN channel.
        let burst = synth("OZ7IGY", tone0, spacing, 0.05);
        for (i, &s) in burst.iter().enumerate() {
            audio[boundary as usize + i] += s;
        }
        let got = decode_window(&audio, SAMPLE_RATE as u32, boundary);
        assert!(got.iter().any(|d| d.text == "OZ7IGY"), "{got:?}");
    }

    /// A single strong, clean transmission must not be reported twice —
    /// see `dedup_overlapping`'s doc comment for the false decode this
    /// guards against, found against a real −26 dB beacon in the field: a
    /// genuine "SR3LES" decode under PI4 alongside several "00000000"
    /// decodes at overlapping alignments under PI4-96/PI4-120/PI4-80, every
    /// one scoring well past the fit floor.
    #[test]
    fn a_single_strong_beacon_is_reported_exactly_once() {
        let tone0 = Variant::Pi4.conventional_tone0_hz();
        let mut audio = vec![0.0f32; 32 * SAMPLE_RATE as usize];
        let boundary = SAMPLE_RATE as i64;
        let burst = synth("SR3LES", tone0, Variant::Pi4.tone_spacing_hz(), 0.3);
        audio[boundary as usize..boundary as usize + burst.len()].copy_from_slice(&burst);

        let got = decode_window(&audio, SAMPLE_RATE as u32, boundary);
        assert_eq!(
            got.len(),
            1,
            "one transmission reported as {} decodes: {got:?}",
            got.len()
        );
        assert_eq!(got[0].text, "SR3LES");
    }

    #[test]
    fn a_message_of_one_repeated_character_is_not_plausible() {
        assert!(!is_plausible("00000000"));
        assert!(!is_plausible("AAAAAAAA"));
        assert!(!is_plausible(""));
        // A single character is short enough to be suspicious too, but not
        // by the "repeated" rule — nothing to repeat.
        assert!(is_plausible("A"));
        assert!(is_plausible("SR3LES"));
        assert!(is_plausible("OZ7IGY"));
        // Mixed but starting with a repeat — must not false-positive on a
        // prefix match.
        assert!(is_plausible("00OZ7IGY"));
    }

    fn decode_at(fit: f32, dt_sec: f32) -> Pi4Decode {
        Pi4Decode {
            text: "X".into(),
            variant: Variant::Pi4,
            tone0_hz: 683.0,
            dt_sec,
            snr_db: 0.0,
            fit,
            hard_errors: 0,
        }
    }

    #[test]
    fn overlapping_decodes_keep_only_the_best_fit() {
        let mut decodes = vec![
            decode_at(0.85, 0.10),
            decode_at(0.92, 0.05),
            decode_at(0.68, -0.05),
        ];
        dedup_overlapping(&mut decodes);
        assert_eq!(decodes.len(), 1, "{decodes:?}");
        assert_eq!(decodes[0].fit, 0.92);
    }

    #[test]
    fn decodes_far_enough_apart_in_time_both_survive() {
        let mut decodes = vec![decode_at(0.5, 0.0), decode_at(0.6, 30.0)];
        dedup_overlapping(&mut decodes);
        assert_eq!(decodes.len(), 2, "{decodes:?}");
    }
}
