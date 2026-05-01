# TODO — no-sdr

## v2.0.0 — Go Backend (`serverng/`) — COMPLETE

### Done
- [x] FFT pipeline (radix-4 float32, deflate/adpcm/uint8 codecs, 30fps rate cap)
- [x] IQ extraction (NCO + Butterworth + decimate, per-client goroutine)
- [x] Flow graph engine (Block interface, Pipeline, FanOut)
- [x] All demodulators (FM stereo, AM, SAM, C-QUAM, SSB, CW)
- [x] Opus encode (build tag, hraban/opus CGo)
- [x] RDS decoder (57kHz BPF, biphase, CRC, PS/RT)
- [x] All hardware sources (rtl_tcp, airspy, hfp, rsp, local USB, demo)
- [x] WebSocket manager (backpressure, codec negotiation, per-client pipelines)
- [x] REST API (full parity: 19 routes, admin CRUD, auth, server config)
- [x] All WS commands handled (15 handlers: subscribe, tune, mode, bandwidth, codec, stereo, admin, NB)
- [x] Server stats broadcast (CPU%, memory, clients — every 2s)
- [x] Deflate-floor noise clamping (5th percentile EMA)
- [x] FFT history with config-driven downsampling + compression
- [x] Pre-filter noise blanker DSP (EMA + guard window, 2.2 GB/s)
- [x] SwapIQ, oscillatorOffset, per-profile gain/directSampling
- [x] DemoMode config override
- [x] Cross-compile (linux/amd64, arm64, darwin/arm64)
- [x] Docker + Makefile + hot reload (air)
- [x] Integration test (full pipeline: WS → FFT → IQ verified)
- [x] Load benchmark (5 clients: 377 frames/sec, 75/client)
- [x] All config options honored

### Stats
- 7,956 LOC source, 9 packages
- FFT N=65536: 0.83ms (4.8x faster than Node.js)
- NB: 2.2 GB/s, 0 allocs
- Binary: ~11MB static (no CGo), ~7.5MB with Opus

## Active — Audio Not Working

- [ ] **Audio pipeline debug** — client connects and tunes but audio is silent or distorted. Investigate IQ extraction output, ADPCM encoding, chunk accumulation timing, and client-side demodulation.

## Client Issues (both backends)

- [ ] **Spectral NR quality** — Wiener filter has robotic artifacts on AM/WFM
- [ ] **Audio not re-enabled after reconnect** — AudioWorklet state not restored

## Future Features

### Audio & DSP
- [ ] Audio time-shift / seek-back (client ring buffer synced to waterfall scrub)
- [ ] Kaiser window + slow-scan FFT (configurable window + multi-frame integration)
- [ ] FM-IF spectral NR (SDR++ approach — FFT on IQ before demod)
- [ ] Adaptive L-R LPF for WFM (cutoff proportional to stereo blend)

### Display & UI
- [ ] WebGL waterfall (GPU rendering for large FFT + smooth zoom)
- [ ] Responsive mobile UI (tablet/phone layouts)

### Infrastructure
- [ ] IQ recording (SigMF format)
- [ ] User sessions (optional auth for persistent settings)
- [ ] Multi-server aggregation (gateway for multiple instances)

### Decoders
- [ ] DMR/D-Star/YSF (digiham WASM)
- [ ] DAB/DAB+ (welle.io WASM)
- [ ] NOAA APT satellite imagery
- [ ] Meteor M2 LRPT
