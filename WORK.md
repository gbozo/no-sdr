# WORK.md — Active Work & Backlog

*Consolidated from tasks.md, plan.md and TODO.md*
*Last updated: v2.10.1*

---

## In Progress / Near-Term

### Rust Backend
- [ ] Native SDR drivers beyond RTL-SDR (Airspy R2/HF+, HydraSDR, HackRF) using the `nusb` pattern
- [ ] Hardware validation matrix for native USB, bias-T and direct sampling on Windows/macOS
- [ ] Port the GPU offload plan to `serverrs/src/gpu/` behind a `gpu_vulkan` feature

## Future Features

### Audio & DSP
- [x] Audio time-shift / seek-back (waterfall drag-to-scrub with FFT history ring buffer)
- [ ] Kaiser window + slow-scan FFT (configurable window + multi-frame integration)
- [ ] FM-IF spectral NR (SDR++ approach — FFT on IQ before demod)
- [ ] Adaptive L-R LPF for WFM (cutoff proportional to stereo blend)

### Display & UI
- [x] WebGL waterfall (GPU ring-buffer texture, Phase 1+2 mobile flicker fixes)

### Infrastructure
- [ ] IQ recording (SigMF format)
- [ ] User sessions (optional auth for persistent settings per user)
- [ ] Multi-server aggregation (gateway for multiple no-sdr instances)
- [ ] Docker cross-compile — linux/amd64, linux/arm64 (RPi), darwin/arm64 via multi-stage Dockerfile

### GPU Acceleration (planned)

The GPU offload design is being ported to the Rust backend. The original Go
plan in `docs/gpu-offload-plan.md` is retained for reference; implementation
will live in `serverrs/src/gpu/` behind a `gpu_vulkan` Cargo feature.

### Decoders
- [ ] DMR/D-Star/YSF (digiham WASM)
- [ ] DAB/DAB+ (welle.io WASM)
- [ ] NOAA APT satellite imagery
- [ ] Meteor M2 LRPT

---

## Completed (reference)

### v2.10.6
- [x] Polyphase DecimateBlock: prototype filter split into M sub-filters with commutator routing; zero-padding for equal-length sub-filters; correct firstOut aligns with direct-form output schedule; `PrototypeTaps()` accessor for tests
- [x] Weighted multi-tap FFT averaging: triangular weights (linearly decreasing), ring buffer of past frames, zero-alloc hot path, mutually exclusive with exponential averaging
- [x] DCBlocker simplification: leaky integrator `y = x - dcEst; dcEst += beta*y` replaces `alpha*dcEst + beta*x` — saves one multiply per sample per channel; `alpha` field removed; fused convertDC/convertDCNoise updated

### v2.7.0
- [x] Identify song: Lanczos-3 windowed-sinc resampler replacing linear interpolation (48 kHz → 22050 Hz, `recognizer.go`)
- [x] Waterfall drag-to-scrub: vertical mousedown/drag rewinds history; `↶ LIVE` return button overlay; touch direction-lock (vertical=scrub, horizontal=pan); wheel seeks history when buffer available
- [x] Waterfall tune indicator: transparent overlay `<canvas>` on main thread; bandwidth edge lines + dashed centre line; reactive to tune/bw/sr/zoom; no waterfall worker changes
- [x] Adaptive frequency scale: `ResizeObserver`-driven label count (5–15 steps); alternating major/minor ticks; absolute positioning for accurate spacing
- [x] BookmarkRibbon component: sankey bezier stems with tick marks; stacked banners with greedy left-to-right collision avoidance; band plan strips moved from FrequencyScale into ribbon; toggle button (persisted); theme accent colours throughout; z-order (left banners on top)
- [x] File-based bookmarks backend: `bookmark_files.go` walks `bookmarks/` dir, maps `modulation→mode`, stable SHA256 IDs, `implemented` flag for unsupported modes; public `/api/bookmarks` merges config + file bookmarks
- [x] Docker: `bookmarks/` dir copied into image (`docker/Dockerfile`)
- [x] Audio resume button: `audioRunning` non-persisted signal; **Enable Audio** → **Resume Audio** → hidden progression; returning users see Resume instead of silence
- [x] Bookmark click → `initAudio()`: bookmark recall (waterfall ribbon + ControlPanel) initialises AudioContext on first interaction if not yet started
- [x] Admin save → client bookmark refresh: `config_saved` WS event triggers `fetchAdminBookmarks()` on all connected clients

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
