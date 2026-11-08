# Rust port tracking (`serverrs`)

Port of the Go backend in `serverng/` to Rust, wire-compatible with the existing
SolidJS client (`client/src/shared/protocol.ts`).

Target: `serverrs/` Cargo crate, binary `serverrs` (same HTTP/WS API + binary
protocol as `serverng`).

## Current status (2.11.2)

- Rust backend is feature-complete for the existing client: FFT/IQ streaming,
  ADPCM/deflate/Opus codecs, all demodulators, RDS (incl. group 4A clock),
  WebSocket manager, admin/REST API, band plan, bookmarks, music recognition,
  IQ recording, history and SPA serving.
- Dongle sources: `demo`, `rtl_tcp`, `airspy_tcp`/`hfp_tcp`/`rsp_tcp`
  (rtl_tcp-compatible), and **local USB `rtlsdr`** (feature `rtlsdr`).
  Local RTL2838/R820T hardware verified: streaming, FFT, Opus WFM, RDS,
  profile switch, MW direct sampling, stop/start.
- Features: `opus` (server-side audio) and `rtlsdr` (direct USB, requires
  librtlsdr) are **default features**. Use `--no-default-features` to build
  without native dependencies. macOS/Windows release artifacts use
  `--no-default-features --features opus` (no librtlsdr there).
- CI: `.github/workflows/rust-binaries.yml` builds Linux amd64 v1-v4, Linux
  arm64 Cortex-A53/A72/A76, macOS arm64/Intel, Windows 11 and portable release
  archives. `docker/Dockerfile.rust` builds the multi-CPU Alpine image.
- Latest published release: `v2.11.2-rust` (prerelease). It adds the hot-path
  performance pass on top of 2.11.1's direct USB rtlsdr, aggregate bandwidth
  stats and default Opus+rtlsdr features.
- Release `v2.11.0-rust` (prerelease): portable archives + multi-arch image
  `ghcr.io/gbozo/no-sdr:2.11.0-rust` (never `latest`; that tag belongs to the
  Go backend on main).

## Ground rules

- Do not change the client protocol. Existing client must work unmodified.
- Existing Go backend stays in the tree as the reference implementation.
- No commits unless explicitly requested.
- Real-hardware test (USB RTL-SDR) happens only after user provides a dongle —
  **ask the user first**.

## Milestones

- [x] Branch `rustport` created
- [x] Cargo crate scaffold + dependencies
- [x] `config` (YAML/JSON, defaults, validation, ConfigVersion)
- [x] `codec` (ADPCM, FFT quantize/delta, deflate, opus feature stub)
- [x] `dsp` (FFT, windows, FFT processor, NCO, Butterworth, decimation,
      noise blanker, DC block, pipeline, fanout, IQ extractor)
- [x] `demod` (FM mono/stereo, AM, SSB, CW, SAM, C-QUAM, RDS)
- [x] `ws` (binary protocol, client, manager, rate limiting)
- [x] `dongle` (demo, rtl_tcp, local rtlsdr feature, manager, Opus pipeline,
      recorder, notifications, system stats)
- [x] `api` (router, admin, bandplan, identify/recognizer, bookmarks, static,
      system)
- [x] `history` (FFT waterfall ring buffer)
- [x] `main` wiring + graceful shutdown
- [x] `cargo test` unit tests mirroring Go tests
- [x] client end-to-end (in-app browser + raw WebSocket client) for demo,
      rtl_tcp and local USB sources
- [x] optional feature: `opus` (verified live: AUDIO_OPUS + RDS messages)
- [x] optional feature: `rtlsdr` (librtlsdr direct USB; RTL2838 hardware test)
- [x] real USB dongle hardware test

## Notes / compatibility decisions

- Wire formats copied 1:1 from `serverng/internal/ws/protocol.go`.
- Deflate uses `flate2` with the `zlib-rs` backend; the quantized+delta
  streams are byte-identical to Go, and zlib-rs typically compresses slightly
  better than Go's `compress/flate`.
- YAML config uses the Go YAML key names (`defaultBandwidth`, `defaultMode`,
  `defaultTuneOffset`); JSON API uses the Go JSON tags (`bandwidth`, `mode`,
  `tuneOffset`). Conversion is done at the YAML boundary.
- Go quirk reproduced for parity: `applyDefaults` forces `enabled`/`autoStart`
  to `true` for every dongle after load.
- `opusComplexity` < 0 means "use 5" at load time; **0 is valid and selects
  the fastest encoder setting**.

## Build / run

```bash
cd serverrs
cargo test                                       # full default suite
cargo test --no-default-features                 # dependency-free stub build
cargo test --no-default-features --features opus # Opus-only build
cargo build --release                            # full binary (default features)
CONFIG_PATH=../config/config.yaml STATIC_DIR=../client/dist ./target/release/serverrs
```

npm helpers: `npm run test:rust`, `build:rust`, `build:rust:opus`,
`build:rust:full`, `start:rust`, `start:rust:demo`.

## Status log

- 2026-11-07: branch created; Go backend surveyed; Rust crate scaffolded.
- 2026-11-07: config, codec and dsp modules ported; `cargo test` green
  (41 tests). Cargo registry had to use `CARGO_HOME=$HOME/.cargo` because
  `/usr/local/cargo/registry` is not writable.
- 2026-11-07: demod completed (FM mono/stereo, AM, SSB, CW, SAM, C-QUAM, RDS).
  FM stereo output verified numerically against the Go implementation with a
  temporary parity test (identical to f32 precision). `cargo test` green
  (63 tests).
- 2026-11-07: `ws` completed (protocol pack/unpack, client state machine,
  bounded drop-oldest write queue, manager with welcome/command/broadcast/
  unsubscribe, stale checker, per-IP rate limiter, axum upgrade handler).
  Includes a real WebSocket end-to-end test (welcome + subscribe + broadcast +
  disconnect). `cargo test` green (87 tests).
- 2026-11-07: `history`, `dongle`, `api` and `main` ported. Demo-mode smoke
  test passes: `/health`, `/api/status`, `/api/dongles`, `/api/capabilities`,
  `/api/bandplan`, admin login/check/clients/system-info, and a live WebSocket
  session receiving welcome META + FFT_COMPRESSED + IQ frames. `cargo test`
  green (98 tests).
- 2026-11-07: API/main verification complete. SPA fallback now returns 200 for
  client-side routes; bandplan weekly refresh tolerates duplicate upstream JSON
  keys (Go behavior). Identify token issue/consume verified end-to-end with the
  Opus PCM snapshot. Opus feature build tested live against the demo source.
  `cargo test` green (105 tests). Warnings clean.
- 2026-11-07: npm scripts added: `build:rust`, `build:rust:opus`,
  `build:rust:full`, `test:rust`, `start:rust`, `start:rust:demo`.
- 2026-11-07: Real-radio verification via `rtl_tcp` at 192.168.1.3:1234 using
  the in-app browser. Confirmed: live spectrum + waterfall, stereo FM with
  server-side Opus audio (RMS ~0.23, AudioContext running at 48 kHz), RDS
  decoding (PI/PTY), tuning/offset changes, and the admin UI (login, SDR
  devices, monitor with live client/stream state). Side-by-side with the Go
  backend, FFT output rate is identical (~19 fps for bursty 16 KiB rtl_tcp
  reads at fftFps=60), confirming this is existing behavior rather than a port
  regression. `cargo test` still green (105 tests).

## FFT compression review (2026-11-07)

- Quantization (`compress_fft`), delta encoding, and the `deflate-floor`
  noise-floor pipeline were compared byte-for-byte against Go using 293 real
  FFT frames captured from the rtl_tcp receiver. The quantized+delta streams are
  **identical**; only the deflate backend differed.
- The original `flate2` default backend (`miniz_oxide`) produced ~2–3% larger
  frames than Go's `compress/flate`. Switched `flate2` to the `zlib-rs` backend
  (pure Rust, no C dependency), which now matches or slightly beats Go:
  - Go (live): deflate 8696 B/frame, floor 8565 B/frame
  - Rust + zlib-rs: deflate 8853 B/frame, floor 8579 B/frame (same signal)
  - Offline 293-frame set: Go 10312 / 9719 B; Rust (zlib-rs) 9874 / 9643 B
- Measured compression ratios vs raw Float32 (bins × 4 B):
  - FM broadcast, 16k FFT: deflate ~7.4–7.5:1, deflate-floor ~7.5:1
  - Aviation, 8k FFT: ~8.2:1
  - Shortwave, 4k FFT: ~10.0:1
- `deflate-floor` gains are small by design: it clamps only bins below the
  5th-percentile noise floor (matches the Go and original Node implementation).
  On quiet bands most of the gain already comes from delta+deflate.
- ADPCM is 4:1 on Int16 IQ/FFT samples (≈8:1 versus raw Float32), so ~8.2 KB
  per 16k FFT frame — it is compressed, not raw.
- 2026-11-07: FFT codec-switch polish. Server flushes queued FFT frames when a
  client changes `fftCodec` (and on profile switch). Client now drops FFT
  frames whose type does not match the selected codec before byte accounting/
  rendering, and resets FFT bandwidth stats on switch, so the compression panel
  stops showing the previous codec immediately. Remaining latency is only the
  kernel/socket backlog of already-written old-codec frames (a few seconds
  after a long high-bandwidth run); new frames render as soon as they arrive.
- 2026-11-07: Fixed two pre-existing client TypeScript errors (`spectrum.ts`
  paused draw returned undefined; `WaterfallDisplay.tsx` called a 0-arg
  handler with an event). `npm run typecheck --workspace=client` is clean.
- 2026-11-08: Replaced the hand-written radix-4 FFT with `rustfft` 6 while
  keeping the `Fft` API (`new`/`size`/`transform`) and unnormalised forward-DSF
  convention. Micro-benchmark (native release, i3-9100): n=8192 ours 218.9 us vs
  rustfft 11.8 us (18.5x); n=16384 ours 528.2 us vs rustfft 29.0 us (18.2x).
  Live server CPU with one Opus client dropped from ~31% to ~19-25% of one core;
  FFT compression ratio unchanged within noise (9.7 -> 9.9:1) and audio/waterfall
  verified working. `rustfft` performs runtime SIMD dispatch, so portable builds
  benefit too.
- 2026-11-08: Restored the two client TypeScript fixes (spectrum paused draw
  returns false; WaterfallDisplay calls the 0-arg handleMouseLeave without an
  event). `npm run typecheck --workspace=client` clean, client rebuilt.
- 2026-11-08: Further FFT-processor optimisation. Split the DC-shift/magnitude
  loop into two contiguous halves (removes the per-bin `(i+half)&mask` wrap),
  and fused the EMA averaging write into the same pass (removed a full 32 KiB
  copy per frame). Micro-benchmark at 293 chunks/s: 75.4 us/chunk (2.21% core)
  -> 49.9 us/chunk (1.46% core), a 34% reduction; rustfft itself is 11.8 us of
  that. Compression ratio unchanged (9.9:1) and live audio/waterfall verified.
- 2026-11-08: IQ-extraction optimisation inspired by sdroxide's techniques
  (independently reimplemented; sdroxide is GPL-3.0-or-later. The project has
  since moved to GPL-3.0-or-later, but these kernels remain our own code):
  * NCO: replaced the 4096-entry sine/cosine table + per-sample interpolation
    with an f64 block phasor recurrence (8 precomputed lanes per block),
    phase-continuous across retunes and renormalised every 65536 samples.
  * Decimator: replaced per-phase circular delay lines and per-tap modulo
    branches with a contiguous input history and a symmetric-prototype dot
    product using 8 independent accumulators (SIMD-friendly, delay-aligned with
    the old output phase). Output length/phase preserved.
  * Micro-benchmark (native, 2.4 MSPS, factor 10, 257 taps): 15.57% -> 1.98% of
    one core (7.9x). Live server CPU with one Opus client dropped from ~23% to
    ~10-13%. FFT 9.9:1 and IQ 23.7:1 unchanged; audio/waterfall verified.
  * sdroxide's half-band cascade was evaluated but not adopted: for a 10x
    decimation the single-stage prototype FIR is cheaper; half-bands pay off at
    large factors (their 16 Msps front end).
- 2026-11-08: `SimpleFir::process_batch` (used by FM stereo's two 51-tap
  low-passes) now lays history + block out contiguously and uses 8 independent
  accumulators; sample-at-a-time `process` keeps the circular buffer. Benchmark
  per 51-tap FIR: 9.36% -> 2.01% of one core at 2.4 MSPS (at the actual 240 kHz
  demod rate that is ~10x less). Live server CPU with one Opus client:
  ~10-13% -> ~7%. Audio/waterfall/ratios unchanged (9.9:1, 23.7:1).
- 2026-11-08: sdroxide review, remaining items:
  * RDS: theirs adds burst error correction, clock-time (MJD) and richer
    group coverage; ours matches Go. CPU cost is negligible, so this is a
    robustness/feature trade-off, not a performance one.
  * Interpolators: theirs uses rubato septic polynomial resampling; our Opus
    path still uses linear interpolation for SSB/CW upsampling. Quality upgrade
    possible at audio rate (cheap), not yet implemented.
  * Noise floor: their per-region median (bit-pattern select_nth) could replace
    the global 5th-percentile clamp in `deflate-floor`. Offline on 293 captured
    16k frames: global 5% = 10.25 KB/frame, region-64 30th pct = 8.87 KB (-13%),
    region-64 median = 7.06 KB (-31%), at the cost of flattening more weak bins.
    Not applied; current behaviour matches Go.
- 2026-11-08: Added a band-limited integer interpolator (`dsp::Interpolator`)
  for the Opus pipeline's SSB/CW 24k/12k -> 48k upsampling: zero-stuffing plus
  a Blackman-Harris windowed-sinc polyphase FIR, gain-compensated and processed
  with 8 accumulators. Linear interpolation remains as a fallback for
  non-integer ratios. Unit tests cover rate/tone preservation and chunk
  equivalence; USB and WFM paths verified live with no client errors.
- 2026-11-08: RDS robustness. Block sync now corrects every 1- and 2-bit
  error burst during tracking using a syndrome->burst table (52 patterns),
  replacing the single-bit-only correction. Acquisition still requires a clean
  offset word, which avoids false sync on noise. Test asserts the table recovers
  every single bit and every adjacent pair for arbitrary blocks. Live RDS still
  decodes (PS/PTY/PI verified). Not ported from sdroxide: clock-time group 4A
  (MJD date) and its wider group coverage.
- 2026-11-08: RDS group 4A (clock time) implemented server-side: MJD ->
  calendar date, UTC hour/minute and signed half-hour offset, exposed as
  `clock` in the RDS JSON. The client formats it as
  `YYYY-MM-DD HH:MM UTC±HH:MM` and shows it in the RDS overlay. Unit test
  decodes MJD 51544 + 12:34 + UTC+02:00. Live stations tested did not emit 4A
  during the check, so the display path is exercised by the unit test only for
  now.
- 2026-11-08: Front-end IQ correction (inspired by sdroxide's iqcorrect,
  independently implemented): per-dongle optional `iqCorrection` applies a
  leaky-mean DC blocker (10 Hz corner) plus the adaptive orthogonalise/normalise
  imbalance loop (16k-sample blocks, 0.35 s time constant, alpha/gain clamps,
  implausible-block rejection) to the raw device stream before recording/FFT/
  client pipelines. Enabled for the test dongle in config.yaml. Live CPU with
  one Opus client unchanged at ~7%; audio, RDS and FFT/IQ ratios verified
  (9.9:1 / 23.7:1). Unit tests cover DC removal, convergence direction and
  reset.
- 2026-11-08: Packaging for CI-only builds (no local Docker builds). Added
  `docker/Dockerfile.rust` + `docker/entrypoint-rust.sh`: amd64 builds x86-64
  v1..v4, arm64 builds Cortex-A53/A72/A76; the entrypoint detects AVX-512/AVX2/
  SSE4.2 or the aarch64 CPU part and execs the best binary. Runtime is Alpine
  with the client dist, config and bookmarks baked in; Opus is built statically
  by audiopus-sys (cmake in the builder). Added
  `.github/workflows/rust-binaries.yml` (Linux amd64/arm64 + macOS arm64/Intel
  artifacts, release attachment) and `.github/workflows/docker-publish-rust.yml`
  (GHCR `no-sdr-rust`, linux/amd64 + linux/arm64) triggered by release/manual.
- 2026-11-08: Version bump to 2.11.0 (`package.json`, client, `serverrs`
  Cargo package, WS `SERVER_VERSION`). Release packaging added:
  `packaging/package.sh` builds portable archives (binary, web client,
  config, bookmarks, LICENSE, launcher scripts, README) for Linux amd64
  v1..v4, Linux arm64 Cortex-A53/A72/A76, macOS arm64/Intel and Windows
  amd64, plus `SHA256SUMS`. The `Rust Binaries` workflow now builds the
  client, packages these archives and attaches them on release. The Rust
  Docker workflow publishes the same GHCR repository with semver
  `-rust` tags only (e.g. `2.11.0-rust`) and never `latest`; the Go Docker
  workflow skips `-rust` release tags so `latest` stays with the main-branch
  Go server.
- 2026-11-08: Released `v2.11.0-rust` (prerelease so it never becomes the
  repository's "Latest"). Rust Binaries CI built and attached ten portable
  archives (Linux amd64 v1-v4, Linux arm64 Cortex-A53/A72/A76, macOS
  arm64/Intel, Windows amd64) plus SHA256SUMS. Docker published
  `ghcr.io/gbozo/no-sdr:2.11.0-rust` as a linux/amd64 + linux/arm64 manifest
  (no `latest`). The Alpine image builds against musl, needs
  `CMAKE_POLICY_VERSION_MINIMUM=3.5` for vendored Opus, and uses per-arch
  cargo cache IDs to avoid buildx cache races. Go Docker publishing is skipped
  for `-rust` release tags so the Go image keeps `latest`.
- 2026-11-08: Status-bar bandwidth now reports the **server-wide total** for
  all connected clients instead of the local client's inbound rate. The Rust
  WebSocket write loop counts every payload byte into a manager-wide atomic
  counter; the 2-second `server_stats` META message includes
  `wsBytesPerSec`, and the client prefers it for the footer meter and
  sparkline (falling back to local counting when absent, e.g. Go backend).
- 2026-11-08: Direct USB RTL-SDR support implemented and hardware-tested.
  New `serverrs/src/dongle/rtlsdr.rs` (feature `rtlsdr`) wraps librtlsdr:
  serial/index selection, enumeration for `/api/admin/devices`, synchronous
  16 KiB reads on a blocking thread, command channel for frequency, sample
  rate, gain/gain-mode, PPM, AGC, direct sampling and offset tuning. The
  configured dongle now uses `type: local`. Verified on an RTL2838/R820T:
  device opens, FFT/waterfall and IQ streams run, server-side Opus WFM audio
  decodes, RDS syncs (`PI:AE6D`, PTY), profile switches reconfigure the tuner,
  MW direct-sampling mode enables/disables cleanly, and stop/start reopens the
  device. `cargo test --features "opus rtlsdr"`: 114 passed. Caveat: the
  `rtl-sdr` 0.1 crate does not expose bias-T, so `biasT` is accepted but not
  applied yet; offset-tuning is ignored by the R820T (librtlsdr returns
  InvalidParam, harmless).
- 2026-11-08: `opus` and `rtlsdr` are now **default Cargo features**.
  `cargo build`/`cargo test` therefore produce the full-featured backend on
  systems with libopus + librtlsdr. CI/Docker use explicit
  `--no-default-features --features "opus rtlsdr"` on Linux so the defaults
  cannot silently change the build; macOS/Windows artifacts use
  `--no-default-features --features opus`. The Alpine builder/runtime now
  install `librtlsdr-dev`/`libusb-dev` and `librtlsdr`/`libusb`.
- 2026-11-08: CI build caching. Native binary jobs now use sccache (GitHub
  Actions backend) plus cargo registry/cache restore, so the four amd64
  microarchitecture builds and repeat runs reuse compiled dependencies.
  The Docker workflow no longer emulates arm64 under QEMU: amd64 and arm64
  are built on native runners (`ubuntu-latest`, `ubuntu-24.04-arm`) with
  separate GHA layer cache scopes, then the two digests are merged into one
  multi-arch manifest.
- 2026-11-08: Hot-path performance pass (no protocol/API/config changes).
  Added `serverrs/examples/bench.rs`, a dependency-free best-of-5 microbenchmark
  harness (`cargo run --release --example bench`). Re-reviewed sdroxide and
  adopted its runtime-SIMD pattern: the same portable loop is compiled again
  under `#[target_feature(enable = "avx2,fma")]` / AVX-512 and selected once per
  block, so portable release binaries still use wide registers. Added
  `dsp/simd.rs`, explicit AVX2+FMA kernels for the complex decimator dot
  (taps duplicated to match interleaved `re,im`) and the real 51-tap stereo FIR,
  and SIMD dispatch for the NCO block mixer. Removed per-chunk allocations:
  `IqExtractor::process_into` plus in-place NCO/Butterworth and reusable scratch;
  `OpusPipeline` reuses complex/PCM/rate buffers, avoids the WFM stereo clone and
  the per-sample modulo in the capture ring; `FmStereoDemod` reuses its PLL/FIR
  work buffers and `FmMonoDemod::process_into` feeds the composite without a
  copy. Fused the IQ-correction DC + imbalance loops and replaced a per-bin
  division in FFT frame averaging with a reciprocal.
  Microbenchmarks (generic x86-64 release, i3-9100, best of 5):
  decimator 2.4M /10 / 257 taps 78.7 -> 23.1 us per 16 KiB chunk (3.4x);
  IQ extractor 2.4M -> 240k 136.5 -> 60-66 us/chunk (2.1x, ~4.7% -> ~1.9% core);
  2.4M -> 48k 80.6 -> 42 us (1.9x); 51-tap FIR batch 50.7 -> 32-34 us;
  FM stereo 241 -> 205-212 us per 20 ms; Opus WFM pipeline 373 -> 328-341 us
  per 20 ms; IQ correction 35.5 -> 29-30 us per chunk; FFT unchanged
  (~36 us/chunk @8192, ~1.1% core). A `-C target-cpu=native` build measured
  within noise of the runtime-dispatched generic build.
  Live RTL2838/R820T, one Opus WFM client at 100.6 MHz: ~10.2% of one core
  (server_stats average; 10.5% measured externally), 277 FFT frames and 583
  Opus packets over 35 s (34.98 s audio), RDS sync messages present, no client
  errors. The same test on HEAD 6272daf measured 12.3% average (~17% lower after
  the pass). Four concurrent clients: 22.95% of one core, each receiving
  19.9-20.0 s of audio per 20 s. Client pipelines still run sequentially on the
  dongle task; parallelising them is the next step for >8 clients.
  `cargo test` and `cargo test --no-default-features` remain 114/114 green.

- 2026-11-08: Version bump to 2.11.2 and release `v2.11.2-rust` (prerelease):
  portable archives and the multi-CPU Docker image ship the hot-path
  performance pass (SIMD dispatch, allocation-free extractor/Opus path).
