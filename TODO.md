# TODO — no-sdr

## Active / In Progress

- [ ] **Spectral noise reduction quality** — current FFT-based Wiener filter produces robotic artifacts on music/tones. Investigate alternatives: RNNoise (WASM), multi-band expander, time-domain NR, or hybrid approach. Noise blanker works well; spectral NR needs rework.
- [ ] **Audio not re-enabled after WebSocket reconnect** — on reconnect the tune offset and mode are correctly restored, but audio playback does not resume. `audio_enabled` is re-sent and `AudioContext.resume()` is called, but audio stays silent. Needs deeper investigation into AudioWorklet state, jitter buffer, and AudioContext lifecycle across reconnects. See `client/src/engine/sdr-engine.ts` `subscribed` handler and `client/src/engine/audio.ts`.

## Planned Features

### Audio & DSP
- [ ] **Audio time-shift / seek-back** — buffer demodulated Float32 audio frames in a client-side ring buffer (alongside the existing FftFrameBuffer). On waterfall scrub, push buffered audio chunks to the AudioWorklet at the corresponding time position. Works for both IQ codec path (tap after `processIqData` demod output) and Opus path (tap after `opusDecoder.decodeFrame`). ~30s buffer at 48kHz stereo ≈ 10MB. Sync is FFT-frame-granular (33ms) not sample-perfect. See discussion in session for full design.
- [ ] **RDS decoding** — FM broadcast metadata (station name, song title, traffic info) from 57kHz subcarrier
- [ ] **Hang-timer AGC for SSB** — dual-averager AGC with hang timer (Moe Wheatley N0V design) for better SSB voice quality
- [ ] **FM-IF spectral NR** — peak-bin FFT on IQ before FM demodulation (SDR++ approach) for WFM hiss reduction at source
- [ ] **Adaptive L-R LPF for WFM** — frequency cutoff proportional to stereo blend factor for smoother weak-station behavior
- [x] **Opus audio codec** — server-side demodulation + Opus VBR encoding for ultra-low-bandwidth clients (`opusscript` server + `opus-decoder` client WASM)

### Display & UI
- [ ] **WebGL waterfall** — GPU-accelerated rendering for large FFT sizes and smooth zoom
- [ ] **Responsive mobile UI** — tablet and phone layouts
- [x] **Frequency bookmarks** — save and recall frequency/mode/bandwidth presets. Persisted in localStorage. Sidebar panel with add/recall/delete/rename. Auto-populates signal markers on waterfall frequency scale.
- [x] **Waterfall history** — seek-back scrub bar below waterfall. Uses client-side FftFrameBuffer (1024 frames). Scrub left to view past, click ↩ live to resume. Spectrum stays live during seek.
- [x] **Spectrum noise floor line** — per-pixel running minimum drawn as a dim dashed line. Toggle button on spectrum toolbar.
- [x] **Signal markers on waterfall** — amber tick marks on the frequency scale at registered Hz frequencies. `engine.addSignalMarker(hz)` / `removeSignalMarker` / `clearSignalMarkers`. Zoom-aware.
- [x] **Spectrum frequency-axis zoom** — click-drag on spectrum to zoom; double-click or ×zoom button to reset. Both spectrum and waterfall remap X axis. Zoom-aware click-to-tune and tooltip.

### Infrastructure
- [ ] **IQ recording** — save raw IQ to SigMF format for offline analysis and playback
- [ ] **User sessions** — optional authentication for persistent settings
- [ ] **Multi-server aggregation** — combine multiple no-sdr instances behind a gateway
- [ ] **Worker threads** — offload FFT and IQ extraction from the main event loop
- [x] **Rate limiting** — max 10 WebSocket connections per IP. X-Forwarded-For aware for reverse-proxy deployments.

### Decoders
- [ ] **DMR/D-Star/YSF** — via digiham WASM port
- [ ] **DAB/DAB+** — via welle.io WASM port
- [ ] **NOAA APT** — satellite weather imagery
- [ ] **Meteor M2 LRPT** — satellite imagery
- [ ] **P25 / TETRA** — trunked radio

### Testing
- [ ] Set up test framework (vitest)
- [ ] `shared/src/protocol.ts` — pack/unpack round-trip tests
- [ ] `shared/src/adpcm.ts` — encode/decode round-trip, compression ratio validation
- [ ] `server/src/fft-processor.ts` — FFT correctness, window functions, normalization
- [ ] `server/src/iq-extractor.ts` — Butterworth filter design, NCO accuracy, decimation
- [ ] `client/src/engine/demodulators.ts` — demodulator output validation, stereo FM PLL lock, C-QUAM pilot detection
- [ ] `server/src/config.ts` — Zod schema validation edge cases

## Completed (Recent)

- [x] **Dongle & Profile selector dropdown** — new fancy dropdown above demodulation section in sidebar. Shows "Profile Name › Frequency" in trigger, lists all dongles with their profiles, active dongle info below. Replaces old basic DongleSelector at bottom.
- [x] **Profile switching fixed** — subscribe command now triggers `switchProfile` when profileId differs from active. Server rebuilds IQ extractors for all existing clients on profile change. Dropdown and admin panel both work correctly. Added reactive `activeProfileId` store signal updated on `subscribed`/`profile_changed` events.
- [x] **Codec preferences persisted to localStorage** — fftCodec and iqCodec now saved across page reloads. Always sent to server on subscribe (removes conditional check).
- [x] **DSP allocation optimizations** — eliminated per-frame GC pressure in client demodulators: `iqInt16ToFloat()` uses shared scratch buffers, `processMonoPath()` and `processWfmStereo()` use pre-allocated Float32Array outputs instead of dynamic `number[]` arrays (~6-8 MB/s GC pressure removed for WFM stereo).
- [x] **ADPCM FFT decode optimization** — eliminated intermediate Int16Array allocation by decoding ADPCM nibbles directly to Float32 (÷100 inline). Saves ~128KB allocation per frame at 65536 FFT bins.
- [x] **NCO lookup tables Float64→Float32** — halves table memory (32KB→16KB per client) with no precision loss since output is Int16.
- [x] **Git workflow rules in AGENTS.md** — explicit rules for commit/push/release requiring user instruction.

- [x] **Multi-SDR network-TCP sources** — Added `airspy_tcp` (AirSpy Mini/R2), `hfp_tcp` (AirSpy HF+), and `rsp_tcp` (SDRplay RSP1/2/duo/dx) via rtl_tcp-compatible protocols. Extended DongleManager with device-specific gain controls and RSP extended commands (antenna port, notch filter, refclk, RF gain, LNA state). See `docs/hardware-integration.md` for CLI-based sources and extended features roadmap.
- [x] **C-QUAM AM stereo demodulator** — full Motorola C-QUAM decode with PLL carrier lock, cosGamma correction, 25Hz Goertzel pilot detection, per-channel notch filter + AGC
- [x] **Noise reduction engine** — spectral subtraction (Wiener filter, 512-pt FFT, overlap-add) + noise blanker (EMA amplitude tracking, hang timer). NR has artifacts; NB works well.
- [x] **WFM stereo blend** — SNR-proportional continuous blend factor replacing hard on/off switch. Weak stations fade gracefully to mono.
- [x] **IMA-ADPCM compression** — 4:1 lossy codec for both FFT and IQ streams, per-client codec negotiation (`none` | `adpcm`)
- [x] **Server-side FFT rate cap** — configurable `fftFps` per profile (default 30), inter-frame averaging
- [x] **Uint8 FFT compression** — `MSG_FFT_COMPRESSED` with embedded min/max dB header
- [x] **ADPCM FFT compression** — `MSG_FFT_ADPCM` with ADPCM-on-Int16 encoding (~8:1 vs raw Float32)
- [x] **Spectrum renderer throttle** — 30fps cap matching waterfall
- [x] **WebSocket backpressure** — `bufferedAmount` checks (256KB FFT, 1MB IQ thresholds) with frame skipping for slow clients
- [x] **Audio-enabled IQ gating** — server only sends IQ data after client enables audio
- [x] **Needle S-meter** — classic analog meter with warm backlit face, dual scale, red needle, peak hold
- [x] **Waterfall resize preservation** — offscreen canvas snapshot prevents blank waterfall on resize
- [x] **Compression stats UI** — live wire/raw bytes, ratio, and savings percentage in codec settings panel
- [x] **Dev script improvements** — parallel shared watch + server tsx watch + client vite dev with proxy
