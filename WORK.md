# WORK.md — Active Work & Backlog

*Consolidated from tasks.md, plan.md, TODO.md, and serverng/TASKS.md*
*Last updated: v2.3.1*

---

## In Progress / Near-Term

### Go Backend Polish (serverng Phase 5 remnants)
- [ ] **T50 Benchmarks** — `go test -bench .` for FFT (N=2048→65536), IqExtractor throughput, ADPCM encode, full pipeline latency vs Node.js baselines
- [ ] **T52 Graceful shutdown** — SIGINT/SIGTERM → drain connections (5s timeout) → close dongles → exit. Context propagation in `cmd/serverng/main.go`
- [ ] **T53 Integration test** — Start serverng in demo mode, WS client, subscribe, verify FFT/IQ frames arrive in correct format (no browser needed)

### Client Issues
- [ ] **Audio not re-enabled after WS reconnect** — AudioWorklet state not restored on reconnect (audio starts silent until page reload)
- [ ] **Spectral NR quality** — Wiener filter has robotic artifacts on AM/WFM; LMS ANR is the recommended alternative (already exists, Wiener should be disabled or removed)

---

## Future Features

### Audio & DSP
- [ ] Audio time-shift / seek-back (client ring buffer synced to waterfall scrub)
- [ ] Kaiser window + slow-scan FFT (configurable window + multi-frame integration)
- [ ] FM-IF spectral NR (SDR++ approach — FFT on IQ before demod)
- [ ] Adaptive L-R LPF for WFM (cutoff proportional to stereo blend)

### Display & UI
- [ ] WebGL waterfall (GPU rendering for large FFT + smooth zoom)

### Infrastructure
- [ ] IQ recording (SigMF format)
- [ ] User sessions (optional auth for persistent settings per user)
- [ ] Multi-server aggregation (gateway for multiple serverng instances)
- [ ] Docker cross-compile — linux/amd64, linux/arm64 (RPi), darwin/arm64 via multi-stage Dockerfile

### GPU Acceleration (see docs/gpu-offload-plan.md)
- [ ] Create `serverng/internal/gpu/` package with Vulkan detection
- [ ] Wrap VkFFT via CGO for GPU FFT offloading
- [ ] GPU Butterworth + NCO + decimation in IQ extractor (compute shaders)
- [ ] GPU FM Stereo FIR (2× 51-tap at 240 kHz)
- [ ] Multi-client batching with Vulkan command buffers
- [ ] Graceful CPU fallback when GPU unavailable

### Decoders
- [ ] DMR/D-Star/YSF (digiham WASM)
- [ ] DAB/DAB+ (welle.io WASM)
- [ ] NOAA APT satellite imagery
- [ ] Meteor M2 LRPT

---

## Completed (reference)

### v2.3.x
- [x] RDS station name in VFO frequency panel (absolute overlay, theme-aware)
- [x] Media Session API + AudioContext resume on screen unlock
- [x] Responsive mobile layout (scroll-based, header→freq→waterfall→panel)
- [x] Admin FFT hot-apply — SwitchProfile unconditionally rebuilds FftProcessor
- [x] stereoEnabled propagated to OpusPipeline at construction
- [x] ws.Client.StereoEnabled defaults to true

### v2.3.0
- [x] Go RDS decoder rewritten to match TypeScript IEC 62106 algorithm
- [x] RDS wired into OpusPipeline (was always nil)
- [x] Wire-driven IQ protocol: MSG_IQ 6-byte header, MSG_IQ_ADPCM 10-byte header
- [x] Opus decoder lifecycle driven by wire channel byte (dumb terminal)
- [x] Chipmunk root cause fixed: SetMode() now recalculates decimFactor after updating p.mode
- [x] 50Hz ticking on IQ codecs fixed (updateResampleRatio guard)
- [x] 8 pre-existing TypeScript type errors resolved

### v2.2.x — Admin Panel & Client State
- [x] Full admin panel at `/admin` (phases 1–14 of Settings Revamp)
- [x] Persistent client identity, multi-tab tracking
- [x] Resilient dongle boot (5-retry exponential backoff)
- [x] Config versioning + optimistic concurrency (ETag/If-Match)
- [x] Real-time WS push for all config mutations
- [x] Bookmarks CRUD, system-info, clients monitor endpoints
- [x] DC offset removal, sqrt optimisations, noise blanker improvements

### v2.0.0 — Go Backend
- [x] Full Go rewrite of Node.js server (all phases 1–4)
- [x] All demodulators (FM stereo, AM, SAM, C-QUAM, SSB, CW)
- [x] Opus encode (hraban/opus, build tag)
- [x] All hardware sources (rtl_tcp, airspy, hfp, rsp, local USB, demo)
- [x] WebSocket manager + per-client IQ pipelines
- [x] REST API (19 routes, admin CRUD)
- [x] FFT history, pre-filter NB, deflate-floor noise clamping
- [x] Docker, cross-compile, hot reload (air)
