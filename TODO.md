# TODO — no-sdr

## Next: v2.0.0 — Golang Backend (`serverng/`)

- [ ] **New Go backend (`serverng/`)** — rewrite server in Go for native concurrency, lower CPU, and easier deployment. Node.js `server/` remains untouched as reference/fallback.
- [ ] Architecture plan: goroutine-per-client IQ extraction, shared FFT via channel fan-out, native zlib, CGo Opus or pure-Go alternative
- [ ] Define migration path: same WebSocket binary protocol, same REST API shape, client unchanged

## Active / In Progress

- [ ] **Spectral noise reduction quality** — current FFT-based Wiener filter produces robotic artifacts on music/tones. LMS ANR handles CW/SSB well but AM/WFM still needs a better spectral approach (MMSE-LSA or multi-band expander).
- [ ] **Audio not re-enabled after WebSocket reconnect** — on reconnect the tune offset and mode are correctly restored, but audio playback does not resume. Needs investigation into AudioWorklet state and AudioContext lifecycle across reconnects.

## Performance

- [ ] **Worker threads for Opus pipeline** — each OpusAudioPipeline (demod + encode) is per-client with zero shared state. Move to worker_threads for 2-3ms/client off the event loop.
- [ ] **Worker threads for IQ extraction** — IqExtractor.process() is pure math (NCO + Butterworth + decimate). SharedArrayBuffer ring for dongle data, workers post back Int16 results.
- [ ] **Client-side noise floor** — move FFT noise floor EMA + histogram + clamping from server to client. Eliminates second deflate call and histogram computation per FFT frame.
- [ ] **Client-side RDS for Opus path** — decode RDS from Opus decoded audio on client instead of server (client already has full RDS decoder).

## Planned Features

### Audio & DSP
- [ ] **Audio time-shift / seek-back** — buffer demodulated audio in client ring buffer (~30s at 48kHz stereo). Sync to waterfall scrub position.
- [ ] **Kaiser window + slow-scan FFT** — configurable FFT window (Kaiser beta) + multi-frame integration for weak signal detection (+6-12 dB)
- [ ] **FM-IF spectral NR** — peak-bin FFT on IQ before FM demodulation (SDR++ approach) for WFM hiss reduction
- [ ] **Adaptive L-R LPF for WFM** — frequency cutoff proportional to stereo blend factor

### Display & UI
- [ ] **WebGL waterfall** — GPU-accelerated rendering for large FFT sizes and smooth zoom
- [ ] **Responsive mobile UI** — tablet and phone layouts

### Infrastructure
- [ ] **IQ recording** — save raw IQ to SigMF format for offline analysis and playback
- [ ] **User sessions** — optional authentication for persistent settings
- [ ] **Multi-server aggregation** — combine multiple no-sdr instances behind a gateway

### Decoders
- [ ] **DMR/D-Star/YSF** — via digiham WASM port
- [ ] **DAB/DAB+** — via welle.io WASM port
- [ ] **NOAA APT** — satellite weather imagery
- [ ] **Meteor M2 LRPT** — satellite imagery

### Testing
- [ ] Set up test framework (vitest)
- [ ] `shared/src/protocol.ts` — pack/unpack round-trip tests
- [ ] `shared/src/adpcm.ts` — encode/decode round-trip
- [ ] `server/src/fft-processor.ts` — FFT correctness, window functions
- [ ] `server/src/iq-extractor.ts` — Butterworth filter design, NCO accuracy
- [ ] `client/src/engine/demodulators.ts` — demodulator output validation
