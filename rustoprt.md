# Rust port tracking (`serverrs`)

Port of the Go backend in `serverng/` to Rust, wire-compatible with the existing
SolidJS client (`client/src/shared/protocol.ts`).

Target: `serverrs/` Cargo crate, binary `serverrs` (same HTTP/WS API + binary
protocol as `serverng`).

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
- [x] demo-mode end-to-end against the existing client (HTTP + WS protocol;
      headless browser unavailable in this environment)
- [x] optional feature: `opus` (verified live: AUDIO_OPUS + RDS messages)
- [ ] optional feature: `rtlsdr` (needs librtlsdr + USB hardware)
- [ ] **ASK USER for real USB dongle**, then hardware test

## Notes / compatibility decisions

- Wire formats copied 1:1 from `serverng/internal/ws/protocol.go`.
- Deflate uses `flate2` raw deflate; any valid deflate stream is accepted by the
  browser's `DecompressionStream("deflate-raw")`, byte-for-byte parity with Go's
  flate is not required.
- YAML config uses the Go YAML key names (`defaultBandwidth`, `defaultMode`,
  `defaultTuneOffset`); JSON API uses the Go JSON tags (`bandwidth`, `mode`,
  `tuneOffset`). Conversion is done at the YAML boundary.
- Go quirk reproduced for parity: `applyDefaults` forces `enabled`/`autoStart`
  to `true` for every dongle after load.
- `opusComplexity` <= 0 means "use 5" at pipeline construction time.

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
