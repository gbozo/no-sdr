# WORK.md — Active Work & Backlog

*Consolidated from tasks.md, plan.md, TODO.md, and serverng/TASKS.md*
*Last updated: v2.6.7*

---

## In Progress / Near-Term

### Go Backend Polish (serverng Phase 5 remnants)
- [ ] **T50 Benchmarks** — `go test -bench .` for FFT (N=2048→65536), IqExtractor throughput, ADPCM encode, full pipeline latency vs Node.js baselines
- [ ] **T52 Graceful shutdown** — SIGINT/SIGTERM → drain connections (5s timeout) → close dongles → exit. Context propagation in `cmd/serverng/main.go`
- [ ] **T53 Integration test** — Start serverng in demo mode, WS client, subscribe, verify FFT/IQ frames arrive in correct format (no browser needed)

---

## Future Features

### Audio & DSP
- [ ] Audio time-shift / seek-back (client ring buffer synced to waterfall scrub)
- [ ] Kaiser window + slow-scan FFT (configurable window + multi-frame integration)
- [ ] FM-IF spectral NR (SDR++ approach — FFT on IQ before demod)
- [ ] Adaptive L-R LPF for WFM (cutoff proportional to stereo blend)

### Display & UI
- [x] WebGL waterfall (GPU ring-buffer texture, Phase 1+2 mobile flicker fixes)

### Infrastructure
- [ ] IQ recording (SigMF format)
- [ ] User sessions (optional auth for persistent settings per user)
- [ ] Multi-server aggregation (gateway for multiple serverng instances)
- [ ] Docker cross-compile — linux/amd64, linux/arm64 (RPi), darwin/arm64 via multi-stage Dockerfile

### GPU Acceleration (see docs/gpu-offload-plan.md)

Full plan written. Build tag: `gpu_vulkan`. CPU fallback is always the default.

**Phase 0 — Skeleton + build infra** (1–2 h)
- [ ] `serverng/internal/gpu/` package: `gpu.go` interface, `gpu_stub.go` CPU fallback
- [ ] `GPUConfig` struct in `config/config.go` + `config.yaml` (disabled by default)
- [ ] `build:go:gpu` npm script: `CGO_ENABLED=1 go build -tags gpu_vulkan`

**Phase 1 — Vulkan device detection** (2–3 h)
- [ ] `vulkan.go` + `device.go` (tag: `gpu_vulkan`): headless Vulkan init, device enumeration
- [ ] `gpu.Probe()` returns `Capability{DeviceName, DeviceType, VRAM}`, logged on startup
- [ ] Integration with `dongle/manager.go`: call `gpu.Probe()`, log result, no-op if unavailable

**Phase 2 — VkFFT GPU FFT** (4–6 h) — highest single-operation impact (4–8× speedup)
- [ ] Vendor `VkFFT/vkfft.h` to `internal/gpu/clib/`, write `vkfft_wrapper.c` CGO shim
- [ ] `vkfft.go` (tag: `gpu_vulkan`): uint8 IQ → window → VkFFT → magnitude dB
- [ ] `fft_processor.go`: add `SetGPUBackend(*gpu.Backend)`, GPU dispatch in `processOneFrame`
- [ ] Unit test: GPU FFT output matches CPU FFT to within 0.1 dB for N = 1024..65536
- [ ] Benchmark: `BenchmarkFFT_CPU_65536` vs `BenchmarkFFT_GPU_65536`

**Phase 3 — GPU IQ pipeline: NCO + Butterworth + Decimate** (6–8 h) — scales with client count
- [ ] Write `shaders/nco_butter_decimate.comp` GLSL compute shader
- [ ] Pre-compile to `nco_butter_decimate.spv` via `glslangValidator`
- [ ] `pipeline_iq.go`: batch dispatch all active clients in one `vkQueueSubmit`
- [ ] `iq_extractor.go`: add `SetGPUBackend`, GPU path in `Process()`
- [ ] Per-client filter state (NCO phase + 2× biquad) stored in device SSBO across frames
- [ ] Integration test: 10 clients × 100 frames — output matches CPU reference

**Phase 4 — GPU FM Stereo FIR** (4–6 h) — highest per-WFM-client impact (3–5 ms → <1 ms)
- [ ] Write `shaders/fm_stereo_fir.comp` GLSL: pilot PLL + 2×51-tap L+R / L-R FIR
- [ ] `pipeline_fm.go`: dispatch per active WFM Opus client
- [ ] `demod/fm.go`: add GPU path in `processWfmStereo`

**Phase 5 — Command buffer batching** (2–3 h)
- [ ] `batch.go`: single `vkQueueSubmit` containing all client dispatches
- [ ] Timeline semaphore: overlap GPU IQ processing with CPU ADPCM/Opus encoding

**Phase 6 — iGPU zero-copy** (optional, 1–2 h)
- [ ] Detect `DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT` memory type at init
- [ ] Use persistent mapped buffer for dongle IQ → GPU input SSBO (no staging copy)

### Decoders
- [ ] DMR/D-Star/YSF (digiham WASM)
- [ ] DAB/DAB+ (welle.io WASM)
- [ ] NOAA APT satellite imagery
- [ ] Meteor M2 LRPT

---

## Completed (reference)

### v2.6.7
- [x] SNR display in needle S-meter — theme-aware ink colors for dBm + SNR readouts
- [x] Per-digit frequency tuning in FrequencyDisplay (click top/bottom half, scroll, touch per digit)
- [x] Signal history graph below S-meter (4.8s ring buffer, accent filled area chart)
- [x] Audio panel: L/R VU meter, stereo pilot blend bar, compressor gain reduction bar
- [x] Band plan overlay on waterfall (embedded JSON, weekly GitHub refresh, tag-colored top strip)
- [x] Click-to-tune waterfall overhaul: instant-jump outside band, nudge inside band, fine-tune drag
- [x] SNR computed in fft-analysis worker (signal peak vs noise floor, EMA τ=200ms)
- [x] Filter BW + Squelch sliders side-by-side; Volume + Balance sliders side-by-side
- [x] Real IP header support for proxy/tunnel (CF-Connecting-IP, X-Forwarded-For, custom)
- [x] Admin: open in new tab support (a href + navigate interceptor)
- [x] SelectInput reactivity fix (selected per-option instead of select value= binding)
- [x] DCOffsetRemoval fix: returned in GET /api/admin/dongles, applied live on SwitchProfile
- [x] WS reconnect state restoration (hadPriorSubscription persists across reconnects)
- [x] Monitor section shows realIp column when proxy header configured

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
