# Rust DSP library evaluation (serverrs)

*Investigation date: 2026-11-09. Scope: hot-path DSP in `serverrs` only. No
client, protocol, config or dependency changes were made.*

## Verdict

**Do not add a general-purpose Rust DSP crate to the hot path.** The one
library with a large measured win, `rustfft`, is already in the tree (18× over
the original hand-written FFT). Every other candidate we measured is equal to
or slower than the current kernels, and each kernel is already a small
fraction of one core.

The only library with a credible benefit is **`pulp`** (runtime-dispatched
SIMD): it matched the hand-written AVX2 kernel exactly and would replace
per-architecture `unsafe` code with one portable source. That is a
maintainability/ARM-portability win, not a speed win.

## Method

- Host: Intel i3-9100 (4 threads, AVX2, no AVX-512), generic `x86-64` release
  build, `lto = "thin"`, `codegen-units = 1`.
- Harness: best of 5 rounds after a warm-up, `black_box` on inputs/outputs,
  same chunk sizes as production (`serverrs/examples/bench.rs` conventions).
- Comparisons use the real `serverrs` kernels (`ButterworthBlock`,
  `SimpleFir`, `DecimateBlock`, `Interpolator`) against the candidate crate on
  the same data and output count. The FIR comparison isolates the dot kernel
  so the production ring-buffer/assembly overhead is not charged to the
  library.
- Scratch crate: `/home/opencode/dsp-eval` (outside the repo). Reproduce with
  `CARGO_HOME=/home/opencode/.cargo cargo run --release`.

## Results

`% core` is for one client on one core, derived from the real-time chunk rate.

| Path | Current | Candidate | Result | Verdict |
|------|---------|-----------|--------|---------|
| 8th-order Butterworth, 8192 complex @ 240 kHz | 84.8 µs | `biquad` 0.6 (`DirectForm2Transposed<f64>`, 4 sections/channel) | 85.0 µs (0.249% core) | Parity. No speed benefit; optional code cleanup only. |
| 51-tap FIR, 4800 samples @ 240 kHz | 29.2 µs (production, incl. bookkeeping) | hand AVX2 kernel (inlined microbenchmark) | 17.6 µs | Kernel-only baseline; production overhead is analysed in the SimpleFir section. |
| 51-tap FIR, 4800 samples @ 240 kHz | 29.2 µs | `pulp` 0.22 runtime SIMD (same call shape) | 17.55 µs | Matches hand AVX2. Portable SIMD win (x86 + ARM), not speed. |
| Complex decimator, 2.4 MSPS → 240 kSPS, 257 taps | 23.3 µs | `pulp` 0.22 `c32` vector | 76.3 µs | 3.3× slower. The packed real-FMA trick matters. |
| Complex decimator, same | 23.3 µs | `futuredsp` 0.10 `DecimatingFirFilter` | 41.6 µs | 1.8× slower. |
| Complex decimator, same | 23.3 µs | `rubato` 5 sinc (I/Q as 2 channels) | 99.9 µs | 4.3× slower; audio-oriented, wrong fit for the IQ front end. |
| Audio resampler 24 → 48 kHz, 480 samples / 20 ms | 7.3–7.8 µs | `resampler` 0.5 `ResamplerFir` (`new_from_hz`) | 26.6 µs | 3.4× slower. Higher-quality 128-tap/1024-phase filter, but unnecessary for integer 2×. |
| Audio resampler 24 → 48 kHz | 7.3–7.8 µs | `speexdsp-resampler` 0.1 (quality 10) | 234.6 µs | ~30× slower. |

## Crate-by-crate

### Adopt / keep

- **`rustfft` 6** — already adopted. Replaced the hand-written radix-4 FFT with
  an 18× speedup at n=8192/16384. Runtime SIMD dispatch means portable builds
  benefit too. This is the single biggest DSP-library win and it is banked.
- **`pulp` 0.22** — safe generic SIMD with runtime feature detection. Measured
  parity with the hand AVX2 FIR (17.55 vs 17.57 µs). One source can produce
  SSE2/SSE4/AVX2/AVX-512/NEON kernels, replacing the hand-written x86-only
  copies in `dsp/simd.rs`, `dsp/decimate.rs`, `dsp/nco.rs` and `demod/fm.rs`
  (≈250 lines of `unsafe`). Caveat: the straightforward `c32` vector form of
  the decimator is 3.3× slower; a packed-f32 port is needed to preserve the
  current kernel. Adopt only as a deliberate refactor with parity tests, not
  for speed.

### Reject for the hot path

- **`biquad` 0.6** — clean API, exactly the same performance as our inlined
  cascade. Adding a dependency to delete ~40 lines of straightforward IIR code
  is not worth it.
- **`futuredsp` 0.10** — the closest pure-Rust SDR DSP library (FIR,
  decimating FIR, polyphase resampler, rotator, iirdes). Its decimator is
  stateless/generic and 1.8× slower. Useful as a reference and possibly for
  future block work, not for the current loop.
- **`rubato` 5** — excellent audio resampler (sinc/FFT, SIMD, real-time safe),
  but 4.3× slower on our integer IQ decimation and adds `audioadapter`/
  `realfft`/`windowfunctions` dependencies. Only relevant if we need
  arbitrary-ratio, clock-drift-aware *audio* resampling.
- **`resampler` 0.5** — zero dependencies, SIMD, arbitrary integer rates,
  16–64 sample latency. 3.4× slower than the custom integer interpolator for
  24→48 kHz, but it is the best fallback if a future mode produces a
  non-integer audio ratio; much better fit than `rubato` for that case.
- **`speexdsp-resampler` 0.1** — ~30× slower at quality 10. No.
- **`fmradio` 0.5** — a young crate from the `desperado` app (v0.5.2, ~600
  downloads). Source inspection shows a per-block `Vec` allocation and
  `Complex::arg()` per sample in `PhaseExtractor`; the crate also carries
  `ratatui`, `crossterm`, `tinyaudio`, `tokio`, `rayon` and `rubato` as normal
  dependencies. Our FM stereo is allocation-free, SIMD-accelerated, parity
  tested against Go, and our RDS has burst correction + group 4A clock. No.
- **`liquid-dsp` bindings** — stale (2019/2024), C dependency, contrary to the
  pure-Rust/portable release strategy.
- **`sdr` 0.7** — last updated 2018; FIR/CIC/downconversion only. Dead.
- **`dasp` / `fundsp`** — audio PCM/synthesis graph crates, not SDR DSP.
  Architecture mismatch and graph/dynamic-dispatch overhead.
- **`wide` 1.7** — good portable SIMD types, but feature selection is
  compile-time only; it explicitly cannot use runtime detection. Our release
  artifacts are multi-CPU x86-64 v1–v4 plus ARM, so `wide` would regress the
  baseline build. `pulp` is the runtime-dispatch equivalent.
- **`realfft` 3.5** — real-to-complex FFT; our FFT input is complex IQ, so it
  does not apply.
- **`phastft` / `microfft` / `fftw` / `pffft`** — alternative FFTs. `rustfft`
  is already fast and the FFT stage is ~1.2% of one core; a C dependency or a
  new FFT backend would not pay for itself.
- **`idsp`** — embedded integer DSP; not relevant on x86-64/aarch64 servers.
- **`micromath` / `fastapprox`** — our `fast_atan2` and 5th-order `sin_cos5`
  are already tailored to the demod path; generic approximations would not
  move measurable cost.

### Watch list (not now)

- **`rustradio` 0.20** and **`orion-sdr` 0.0.74** — GNU-radio-style block
  libraries / SDR waveform stacks. Potentially useful for future digital
  decoders (DMR, DAB, NOAA APT, OFDM), not for the current FM/AM/SSB chain.
  `orion-sdr` is 0.0.x and low-adoption; `rustradio` is more mature but brings
  a graph runtime.
- **`halfband` 0.3** — high-performance 2× polyphase resampling. Only worth
  revisiting if the front end moves to much higher input rates where a
  CIC/half-band cascade beats the single-stage 257-tap decimator.
- **`nnnoiseless` / `deep_filter`** — neural speech denoisers (used by
  sdroxide). Adjacent to the planned NR work, but they are speech models, not
  SDR noise reduction; evaluate separately if we pursue that feature.

## SimpleFir deep dive

`SimpleFir` exposes two convolution paths, and they behave very differently.
All numbers below are one filter, 48 kHz or 240 kHz as noted, one core.

### Batch path (`process_batch`, used by FM stereo)

51 taps, 4800 samples per 20 ms chunk at 240 kHz:

| Variant | Time per 20 ms | % core |
|---------|----------------|--------|
| Production `SimpleFir::process_batch` | 29–34 µs | 0.15–0.17 |
| Exact local replica of the same algorithm | 34.5 µs | 0.17 |
| Linear-history variant (no per-sample ring update) | 32.0 µs | 0.16 |
| Kernel with the call forced out of line | 31.5 µs | 0.16 |
| Kernel inlined into the benchmark loop | 17.5 µs | 0.09 |

The bookkeeping (history copy + circular-buffer update) is only **~3 µs per
filter per 20 ms**, i.e. ~0.015% core. The earlier 11.7 µs figure was an
inlining artifact: the 17.5 µs kernel number comes from a copy inlined into the
benchmark loop, which is not the production call shape. FM stereo uses two
51-tap filters, so removing all bookkeeping would save ~0.03% core. Not worth
the churn.

The larger variance is codegen: whether the SIMD batch loop is inlined and
optimised with known lengths changes the kernel by ~10–15 µs per filter. That
is a potential 0.05–0.07% core per filter, but it is fragile and should not be
the reason to restructure the code.

### Sample-at-a-time path (`process`, used by AM/SSB/CW/FM-mono audio LPF)

960 samples per 20 ms at 48 kHz:

| Taps | `process()` per sample | `process_batch()` | Speedup | Saved % core |
|------|------------------------|-------------------|---------|--------------|
| 31 (AM, FM mono) | 21.0 µs | 8.0 µs | 2.6× | 0.065 |
| 63 (SSB) | 44.6 µs | 10.4 µs | 4.3× | 0.171 |
| 127 (CW) | 108.6 µs | 11.5 µs | 9.5× | 0.486 |

The per-sample path has a serial 127-FMA dependency chain and a masked
circular-buffer index per tap; the batch path uses the 8-accumulator SIMD
kernel. The two paths are numerically equivalent: over 960 random samples the
maximum difference was 1.8e-7, with no sample above 1e-6.

Call sites: `demod/fm.rs:322` (31 taps), `demod/am.rs:120` (31),
`demod/ssb.rs:132` (63), `demod/cw.rs:87` (127). CW always creates the 127-tap
filter in `init`, so a CW client always pays the 0.54% core; the others pay it
when their bandwidth-driven LPF is enabled.

Per client, converting these to batch is the only `SimpleFir` change with a
real payoff (numbers assume a 48 kHz demod rate; at 24 or 12 kHz both the cost
and the saving scale linearly):

- **CW: ~0.49% core saved** — roughly 10–20% of a CW client's marginal
  pipeline (excluding the shared FFT broadcast), or ~13% if the shared FFT is
  attributed to the client.
- **SSB: ~0.17% core**, AM/FM mono: **~0.065% core**.
- **FM stereo: ~0.03% core** from bookkeeping — ignore.

Implementation is small and local: add `SimpleFir::process_inplace(&mut [f32])`
using an internal scratch buffer, or a scratch buffer in each demod, and
replace the per-sample loops. Add a test asserting `process()` and
`process_batch()` agree to f32 rounding.

## Where the CPU actually goes

Measured with `serverrs/examples/bench.rs` (one client, one core):

| Stage | % core |
|-------|--------|
| FFT processor (8192/16384, per chunk) | ~1.2–1.5 |
| IQ extractor 2.4 MSPS → 240 kSPS | 1.77 |
| IQ extractor 2.4 MSPS → 48 kSPS | 1.19 |
| IQ correction (optional) | 0.85 |
| FM stereo (20 ms @ 240 kHz) | 1.01 |
| RDS | 0.32 |
| Opus WFM pipeline | 1.62 |
| Decimator (inside the extractor) | 0.68 |
| Butterworth (inside the extractor) | 0.25 |
| 51-tap stereo FIR (one of two in FM stereo) | 0.15 |

The per-client total for a WFM Opus client is ~7–10% of one core, matching the
live server measurements in `rustport.md`. The stages overlap (the extractor
number includes NCO/decimator/Butterworth/DC/noise blanker), so the individual
rows are not additive. The practical consequence: a library that is 1.8×
slower or faster on one kernel changes total CPU by a fraction of a percent.
Swapping kernels is not the scaling lever; parallelising per-client pipelines
is.

## Recommendations

1. **No new hot-path DSP dependency.** Keep the custom kernels; they are
   measured at or ahead of every credible Rust crate.
2. **Keep `rustfft`.** It is the one large win and already integrated.
3. **Optional: adopt `pulp` for portable SIMD.** Do it only as a dedicated
   refactor with bit-exact/parity tests, starting with the 51-tap FIR and NCO.
   For the decimator, port the packed-real-FMA shape, not the `c32` shape.
   Expected outcome: same speed, one kernel for x86-64 and aarch64, less
   `unsafe`.
4. **If arbitrary-ratio audio resampling is ever needed, use `resampler` 0.5**
   (zero deps, low latency, arbitrary rates), not `rubato` or `speexdsp`.
   For the current integer ratios the custom `Interpolator` is 3.4× faster.
5. **Convert the audio LPFs to batch processing.** The per-sample
   `SimpleFir::process()` path is 2.6×/4.3×/9.5× slower than `process_batch()`
   for 31/63/127 taps, saving ~0.065/0.171/0.486% core per client. CW is the
   big one (127 taps, always enabled). The FM-stereo batch path only spends
   ~3 µs per 20 ms on bookkeeping (~0.015% core per filter); the earlier
   11.7 µs figure was an inlining artifact and is not worth chasing.
6. **For future digital decoders, evaluate `rustradio` / `orion-sdr` /
   `futuredsp` as frameworks** rather than hand-rolling block scheduling. None
   should replace the current demod chain.
