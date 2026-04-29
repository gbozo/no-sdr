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

- [x] **Phase 1 signal improvements** — DC offset removal (IIR blocker, dongle default + profile override), pre-filter noise blanker (server-side, disabled — not useful without impulse noise), hang-timer AGC (client-side, mode-specific presets, 15ms look-ahead). Admin panel DSP Processing section.
- [x] **LMS Adaptive NR** — NLMS predictor with adaptive leakage (WDSP algorithm). Replaces old Wiener spectral NR which was causing quality degradation. Mode-specific presets (SSB/CW/AM). Strength slider maps to adaptation gain (0% = true passthrough).
- [x] **FM Hi-Blend filter** — frequency-dependent stereo reduction for weak FM stations. LPF on L-R difference channel. Adjustable cutoff (500Hz–8kHz). Only shown in UI when WFM + stereo detected. Dramatically reduces FM hiss.
- [x] **Rumble filter** — 4th-order Butterworth HPF (30–150Hz cutoff). Removes hum fundamentals and wind/blowing noise.
- [x] **Auto-notch** — LMS adaptive tone removal (outputs error signal). Slow adaptation (locks in ~200ms), 128-sample decorrelation delay preserves bass/music while removing stationary hum harmonics.
- [x] **ADPCM codec quality fix** — encoder and decoder were never reset on tune/mode/profile change, causing predictor state mismatch and degraded quality. Both sides now reset simultaneously on any stream discontinuity.
- [x] **Legacy spectral NR disabled** — old Wiener filter was still running alongside new LMS ANR (double-processing), causing significant quality loss. Now permanently disabled.
- [x] **All DSP filters work on all codec paths** — Adaptive NR, AGC, Rumble, Auto-Notch, Hi-Blend all process decoded audio on both IQ and Opus paths.
- [x] **Tuning step UI & keyboard tuning** — tuning step selector in frequency display (auto/1Hz–200kHz). Arrow keys: left/right = step, up/down = 10x step. Step snaps to grid. Scroll wheel on frequency digits uses digit position (no snap). Click-to-tune on waterfall uses exact frequency (no snap). Profile's tuningStep sent from server on subscribe/profile_changed. Dropdown auto-blurs after selection so arrow keys work immediately.
- [x] **Direct sampling / bias-T / offset tuning always sent on profile switch** — previously these rtl_tcp commands were only sent when enabled, so switching from an HF profile (direct sampling=2) to VHF (direct sampling=0) left hardware in the old mode. Now all three are always explicitly sent (including 0 to disable).
- [x] **Per-profile bias-T and offset tuning** — these hardware settings now override dongle-level defaults per frequency profile (same pattern as directSampling). Admin UI checkboxes in Hardware Overrides section.
- [x] **Profile list cache invalidation** — the user-facing dongle/profile dropdown now always re-fetches profiles when opened and when activeProfileId changes. Fixes stale list after admin deletes/adds profiles.
- [x] **UI title changed to NO(DE)-SDR** — navbar, HTML title, PWA manifest all updated.
- [x] **Profile switching race condition fixed** — `connectRtlTcp` (and all TCP variants) now returns a Promise awaited by `startDongle`. Added generation counter to prevent stale socket events from corrupting state. 300ms settle delay between disconnect/reconnect prevents rtl_tcp server hangs. `stopDongle` removes all listeners before socket destroy. Fixes: waterfall freezing after 2-3 profile switches, rtl_tcp backend hanging.
- [x] **Dongle enabled/disabled flag** — new `enabled` field on DongleConfig. Disabled dongles cannot be started (manual or auto-start). Admin UI shows DISABLED badge, grayed indicator, and disabled Start button. Defaults to `true` for backward compatibility.
- [x] **Admin dongle config: source type & connection** — connection info bar (source type, host:port, device index, PPM) always visible below dongle header. Runtime state (running, activeProfileId, clientCount) merged into admin API response.
- [x] **Admin: create receiver UX** — new dongles are created disabled with auto-start off. Success message shown. Dongle auto-selected and edit form opens immediately for configuration.
- [x] **Admin: delete receiver** — "Delete Receiver" button in dongle edit form with confirmation dialog. Calls DELETE endpoint, clears selection.
- [x] **Admin: delete profile** — red "Delete" button in profile actions bar with confirmation. Server prevents deleting last or active profile.
- [x] **Admin: reorder profiles** — left/right arrow buttons to move profiles. New `PUT /api/admin/dongles/:id/profiles-order` endpoint + `reorderProfiles()` in DongleManager.
- [x] **Profile presets** — 30 curated presets (FM, MW, SW, DAB, ham bands, airband, marine, PMR, GMRS, CB, ISM, public safety, satellite, weather) derived from ITU band plans. "From preset..." dropdown in profile tab bar creates pre-filled profiles.
- [x] **Tuning step per profile** — optional `tuningStep` field on DongleProfile. Dropdown with common steps (1 Hz to 200 kHz, including 8.33 kHz aviation, 9 kHz MW). Defaults to "Auto (bandwidth)".
- [x] **Live dongle config updates** — `updateDongleConfig()` method syncs admin REST changes to DongleManager runtime state without requiring server restart. Fixes: enabling a disabled dongle via admin panel then starting it.
- [x] **Band plan & bookmark data** — downloaded ITU band plans (bands.json, bands-r1/r2/r3.json) and 26 bookmark files (aviation, marine, CB, PMR, GMRS, NOAA, etc.) from openwebrx for future use.
- [x] **Dongle & Profile selector dropdown** — new fancy dropdown above demodulation section in sidebar. Shows "Profile Name › Frequency" in trigger, lists all dongles with their profiles, active dongle info below. Replaces old basic DongleSelector at bottom.
- [x] **Profile switching fixed** — subscribe command now triggers `switchProfile` when profileId differs from active. Server rebuilds IQ extractors for all existing clients on profile change. Dropdown and admin panel both work correctly. Added reactive `activeProfileId` store signal updated on `subscribed`/`profile_changed` events.
- [x] **Admin panel reworked** — unified Receivers tab with dongle selector, hardware settings editor (source type, PPM, device index, direct sampling, bias-T, digital AGC, offset tuning, auto-start), and profile tabs with full editor (name, mode, frequency, sample rate, bandwidth, gain, FFT size/fps, tune offset). Server tab with callsign/description/location, network, security, and DSP settings.
- [x] **Cookie-based admin sessions** — httpOnly cookie set on login (7-day expiry, per-boot secret). Session check on modal open auto-restores auth without re-entering password. Logout clears cookie server-side.
- [x] **Graceful no-config startup** — server starts with empty dongles array if no config.yaml exists (or invalid config falls back to defaults). Admin can configure everything via the UI. Config written to disk on first save.
- [x] **Per-profile hardware overrides** — directSampling (Off/I-ADC/Q-ADC), swapIQ (fixes inverted spectrum), oscillatorOffset (Hz, compensates LO error). Profile-level overrides dongle-level. Applied in both local rtl_sdr and rtl_tcp paths. Admin UI in profile editor under "Hardware Overrides" section.
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
