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
