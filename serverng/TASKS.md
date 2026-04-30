# serverng — Task Tracker

## Legend

```
Status: [ ] pending  [~] in progress  [x] done  [!] blocked
Agent:  Which agent/worktree takes this task
Deps:   Task IDs that must complete first (blank = no blockers)
Phase:  1-5 from PLAN.md
```

---

## Phase 1: Foundation (scaffold, FFT, WebSocket, protocol)

### T01 — Go Module Scaffold
- **Agent:** A
- **Deps:** —
- **Files:** `serverng/go.mod`, `serverng/cmd/serverng/main.go`, `serverng/Makefile`
- **Status:** [x]
- **Spec:** Init Go module `github.com/gbozo/no-sdr/serverng`. Add deps: chi, coder/websocket, yaml.v3, slog. Create `main.go` with config load + HTTP server start (placeholder). Makefile targets: `build`, `build-pi` (GOOS=linux GOARCH=arm64), `run`, `test`.

### T02 — Config Loader
- **Agent:** A
- **Deps:** T01
- **Files:** `serverng/internal/config/config.go`, `serverng/internal/config/config_test.go`
- **Status:** [x]
- **Spec:** Port config.yaml parsing. Go structs with yaml tags matching existing schema: `ServerConfig`, `DongleConfig`, `DongleProfile`, `SourceConfig`. Validate: required fields, sample rate ranges, FFT size is power of 2. Load from `config/config.yaml` (relative) or `$CONFIG_PATH`. Support graceful defaults (empty dongles array = valid, demo mode available).

### T03 — Binary Protocol (pack/unpack)
- **Agent:** B
- **Deps:** —
- **Files:** `serverng/internal/ws/protocol.go`, `serverng/internal/ws/protocol_test.go`
- **Status:** [x]
- **Spec:** Port `shared/src/protocol.ts` pack/unpack functions. Must produce byte-identical output to TypeScript. Types: MSG_FFT(0x01), MSG_IQ(0x02), MSG_META(0x03), MSG_FFT_COMPRESSED(0x04), MSG_FFT_ADPCM(0x08), MSG_IQ_ADPCM(0x09), MSG_FFT_DEFLATE(0x0B), MSG_AUDIO_OPUS(0x0C), MSG_RDS(0x0D). Test: round-trip pack/unpack for each message type. Use `encoding/binary` LittleEndian.

### T04 — IMA-ADPCM Codec
- **Agent:** B
- **Deps:** —
- **Files:** `serverng/internal/codec/adpcm.go`, `serverng/internal/codec/adpcm_test.go`
- **Status:** [x]
- **Spec:** Port `shared/src/adpcm.ts`. ImaAdpcmEncoder + ImaAdpcmDecoder structs. Step table (89 entries), index table (16 entries). `Encode(samples []int16) []byte`, `Decode(data []byte, sampleCount int) []int16`. `EncodeFftAdpcm(fft []float32, minDb, maxDb float32) []byte`. Test: encode→decode round-trip, verify against TS output for known input.

### T05 — Radix-4 FFT (float32)
- **Agent:** C
- **Deps:** —
- **Files:** `serverng/internal/dsp/fft.go`, `serverng/internal/dsp/fft_test.go`
- **Status:** [x]
- **Spec:** Port fft.js radix-4 algorithm to Go using `[]float32` interleaved complex (re0, im0, re1, im1...). In-place transform. Sizes: power-of-2, up to 65536. Pre-compute twiddle factors on init. Test: compare output against known DFT for small N, benchmark for N=65536 (target <10ms on amd64).

### T06 — Window Functions
- **Agent:** C
- **Deps:** —
- **Files:** `serverng/internal/dsp/window.go`, `serverng/internal/dsp/window_test.go`
- **Status:** [x]
- **Spec:** Blackman-Harris 4-term, Hann, Hamming, Kaiser (with besselI0). `NewWindow(typ string, size int) []float32`. Test: known values at edges and center, sum-of-squares for each type.

### T07 — FFT Processor
- **Agent:** C
- **Deps:** T05, T06
- **Files:** `serverng/internal/dsp/fft_processor.go`, `serverng/internal/dsp/fft_processor_test.go`
- **Status:** [x]
- **Spec:** Port `server/src/fft-processor.ts`. Ring buffer accumulator, window → FFT → magnitude (10*log10) → normalization → averaging → rate cap (targetFps). Input: `[]byte` (uint8 IQ). Output: `[]float32` (dB per bin). Pre-allocate all buffers. Test: sine wave input → peak at correct bin.

### T08 — FFT Codecs (deflate, uint8, adpcm)
- **Agent:** B
- **Deps:** T04, T07
- **Files:** `serverng/internal/codec/compress_fft.go`, `serverng/internal/codec/deflate.go`, `serverng/internal/codec/compress_fft_test.go`
- **Status:** [x]
- **Spec:** `CompressFft(fft []float32, minDb, maxDb float32) []byte` — quantize to Uint8. `PackFftDeflateMessage(uint8Data []byte, minDb, maxDb int16, binCount int) []byte` — delta-encode + `compress/flate` level 6. `PackFftAdpcmMessage(fft []float32, minDb, maxDb float32) []byte`. Must produce wire-compatible output with TS. Test: verify client can decode output.

### T09 — WebSocket Manager
- **Agent:** A
- **Deps:** T01, T03
- **Files:** `serverng/internal/ws/manager.go`, `serverng/internal/ws/client.go`, `serverng/internal/ws/backpressure.go`
- **Status:** [x]
- **Spec:** Client registry (map[string]*Client). Accept WS upgrade via coder/websocket. Per-client read goroutine (JSON commands). Per-client write goroutine with buffered channel (cap=4 for FFT, cap=8 for IQ). Backpressure: if write channel full, drop oldest. Parse ClientCommand JSON: subscribe, tune, mode, bandwidth, codec, audio_enabled, stereo_enabled. Broadcast helper for FFT frames.

### T10 — Demo Signal Simulator
- **Agent:** A
- **Deps:** T01
- **Files:** `serverng/internal/dongle/demo.go`, `serverng/internal/dongle/demo_test.go`
- **Status:** [x]
- **Spec:** Port `server/src/signal-simulator.ts`. Generate fake uint8 IQ at configurable sample rate with: carrier tones at configurable offsets, noise floor, optional FM-modulated audio (sine sweep). Output via channel at real-time rate (sleep between chunks). Used for development without hardware.

### T11 — HTTP Server + Static Serving
- **Agent:** A
- **Deps:** T01, T02, T09
- **Files:** `serverng/internal/api/router.go`, `serverng/internal/api/static.go`
- **Status:** [x]
- **Spec:** chi router. `GET /api/status` → server info. WebSocket upgrade at `/ws`. Serve `client/dist/` as static files (SPA fallback to index.html). CORS headers for dev mode. Port 3000 default (configurable).

### T12 — FFT Broadcast Integration
- **Agent:** A
- **Deps:** T07, T08, T09, T10
- **Files:** `serverng/internal/dongle/manager.go` (initial)
- **Status:** [x]
- **Spec:** Wire it all together: DongleManager starts demo source → raw IQ → FftProcessor → codec (per-client preference) → WS broadcast. Client connects, subscribes, receives FFT frames. **Milestone: client waterfall/spectrum works against Go backend.**

---

## Phase 2: IQ Pipeline + Flow Graph

### T20 — Flow Graph Engine (Block interface + Pipe)
- **Agent:** D
- **Deps:** —
- **Files:** `serverng/internal/dsp/block.go`, `serverng/internal/dsp/pipe.go`, `serverng/internal/dsp/pipeline.go`, `serverng/internal/dsp/registry.go`
- **Status:** [ ]
- **Spec:** Block interface (Name, Init, Process, Close). Pipe[T] with SPSC ring buffer (lock-free: atomic read/write cursors, pre-allocated slice). Pipeline struct: ordered list of blocks + pipes, Start/Stop lifecycle, rate propagation. Registry: map[string]BlockFactory. Construction from config (profile pipeline definition).

### T21 — NCO (Numerically Controlled Oscillator)
- **Agent:** D
- **Deps:** T20
- **Files:** `serverng/internal/dsp/nco.go`, `serverng/internal/dsp/nco_test.go`
- **Status:** [ ]
- **Spec:** Lookup-table sin/cos (float32, 4096 entries). Block: takes `[]complex64` IQ, mixes with NCO frequency. `SetFrequency(hz float64)` recalculates phase increment. Test: verify frequency shift on known sine.

### T22 — Butterworth IIR Filter Block
- **Agent:** D
- **Deps:** T20
- **Files:** `serverng/internal/dsp/filter.go`, `serverng/internal/dsp/filter_test.go`
- **Status:** [ ]
- **Spec:** Port `designButterworth4()` from `iq-extractor.ts`. 2 cascaded biquad sections (4th-order). Process complex IQ (I and Q filtered independently). `SetCutoff(hz float64, sampleRate float64)` recomputes coefficients. Direct Form II transposed. Test: unit impulse response, frequency response at cutoff.

### T23 — Decimation Block
- **Agent:** D
- **Deps:** T20
- **Files:** `serverng/internal/dsp/decimate.go`, `serverng/internal/dsp/decimate_test.go`
- **Status:** [ ]
- **Spec:** Integer decimation: output every Nth sample. Input: `[]complex64`. Output: `[]complex64` (length / N). Propagates output sample rate = input / N. Test: rate reduction verified.

### T24 — IQ Extractor Pipeline (composite)
- **Agent:** D
- **Deps:** T21, T22, T23
- **Files:** `serverng/internal/dsp/iq_extractor.go`, `serverng/internal/dsp/iq_extractor_test.go`
- **Status:** [ ]
- **Spec:** CompositeBlock: NCO shift → Butterworth LPF → Decimate → scale to Int16. Params: inputSampleRate, outputSampleRate, tuneOffset. Output: `[]int16` (interleaved I,Q). This is the per-client pipeline that replaces `server/src/iq-extractor.ts`.

### T25 — Per-Client IQ Streaming
- **Agent:** A
- **Deps:** T12, T24, T04
- **Files:** update `serverng/internal/ws/client.go`, `serverng/internal/dongle/manager.go`
- **Status:** [ ]
- **Spec:** On `audio_enabled` → create IqExtractor pipeline for client. Fan-out dongle IQ → client pipeline goroutine. Output: ADPCM encode → packIqAdpcmMessage → WS write channel. On `tune` → update NCO offset. On `bandwidth` → recompute Butterworth + decimation. **Milestone: client can tune and hear audio.**

### T26 — Fan-Out Buffer
- **Agent:** D
- **Deps:** T20
- **Files:** `serverng/internal/dsp/fanout.go`, `serverng/internal/dsp/fanout_test.go`
- **Status:** [ ]
- **Spec:** Generic FanOut[T]: single writer, N readers with independent cursors. Shared ring buffer. Reader that falls behind skips to current (frame drop with counter). Lock-free via atomics. Test: 1 writer + 3 readers at different speeds, verify no data loss for fast readers and graceful skip for slow.

---

## Phase 3: Demodulation + Opus

### T30 — FM Demod Block (mono)
- **Agent:** E
- **Deps:** T20
- **Files:** `serverng/internal/demod/fm.go`, `serverng/internal/demod/fm_test.go`
- **Status:** [ ]
- **Spec:** FM discriminator (atan2 of conjugate product). Input: `[]complex64`. Output: `[]float32` (audio). De-emphasis filter (50μs or 75μs configurable). `fastAtan2` polynomial approximation. Test: modulate known audio → demod → compare.

### T31 — FM Stereo Demod Block
- **Agent:** E
- **Deps:** T30
- **Files:** update `serverng/internal/demod/fm.go`
- **Status:** [ ]
- **Spec:** 19kHz PLL pilot detection, SNR-proportional stereo blend (continuous 0-1, 200ms hold), L+R/L-R decode, per-channel de-emphasis. Output: `[]float32` interleaved stereo. Includes RDS composite output tap for T36.

### T32 — AM / SAM / C-QUAM Demod Blocks
- **Agent:** E
- **Deps:** T20
- **Files:** `serverng/internal/demod/am.go`, `serverng/internal/demod/sam.go`, `serverng/internal/demod/cquam.go`
- **Status:** [ ]
- **Spec:** AM: envelope detection (`sqrt(I²+Q²)`). SAM: 2nd-order PLL carrier lock + coherent detection. C-QUAM: PLL + cosGamma + 25Hz Goertzel pilot + stereo decode. Port from `client/src/engine/demodulators.ts` and `server/src/opus-audio.ts`.

### T33 — SSB / CW Demod Blocks
- **Agent:** E
- **Deps:** T20
- **Files:** `serverng/internal/demod/ssb.go`, `serverng/internal/demod/cw.go`
- **Status:** [ ]
- **Spec:** SSB: I-channel extraction (USB) or Q-channel (LSB). CW: BFO mix (configurable offset, default 700Hz) + I-channel. Simplest demod blocks.

### T34 — Opus Encode Block
- **Agent:** F
- **Deps:** T20
- **Files:** `serverng/internal/codec/opus.go` (build tag: `//go:build opus`)
- **Status:** [ ]
- **Spec:** Wrapper around hraban/opus. Block: takes `[]float32` audio (mono or stereo), outputs Opus packets. Frame size: 960 samples (20ms @ 48kHz). Bitrate configurable (32k/64k/128k/192k). Dynamic mono↔stereo switching. Resampler if input != 48kHz.

### T35 — Server-Side Demod Pipeline (Opus path)
- **Agent:** F
- **Deps:** T24, T30, T31, T32, T33, T34
- **Files:** `serverng/internal/dsp/opus_pipeline.go`
- **Status:** [ ]
- **Spec:** CompositeBlock: IqExtractor → DemodBlock (per mode) → OpusEncode. Mode switch tears down and rebuilds demod stage. Equivalent to `server/src/opus-audio.ts` OpusAudioPipeline. **Milestone: Opus codec path works.**

### T36 — RDS Decoder Block
- **Agent:** E
- **Deps:** T31
- **Files:** `serverng/internal/demod/rds.go`, `serverng/internal/demod/rds_test.go`
- **Status:** [ ]
- **Spec:** 57kHz BPF → NCO mix-down → LPF + decimate → biphase symbol sync → block sync (CRC-16) → group parser (0A/0B→PS, 2A/2B→RT, 4A→CT). Port from `server/src/rds-decoder.ts`. Output: RdsData struct → packRdsMessage.

---

## Phase 4: Hardware + Admin

### T40 — rtl_tcp Client
- **Agent:** G
- **Deps:** T01
- **Files:** `serverng/internal/dongle/rtltcp.go`, `serverng/internal/dongle/rtltcp_test.go`
- **Status:** [ ]
- **Spec:** TCP connection to rtl_tcp server. Parse 12-byte dongle info header. Send 5-byte commands (0x01-0x0E): set freq, set gain, set sample rate, etc. Read raw uint8 IQ stream. Reconnect with backoff. Output via channel.

### T41 — airspy_tcp / hfp_tcp / rsp_tcp Clients
- **Agent:** G
- **Deps:** T40
- **Files:** `serverng/internal/dongle/airspy.go`, `serverng/internal/dongle/hfp.go`, `serverng/internal/dongle/rsp.go`
- **Status:** [ ]
- **Spec:** Same rtl_tcp wire protocol with device-specific extensions. RSP: extended commands (antenna port, notch filter, RF gain, LNA state). Port from Node.js `dongle-manager.ts` connection methods.

### T42 — Local RTL-SDR (gortlsdr)
- **Agent:** G
- **Deps:** T01
- **Files:** `serverng/internal/dongle/rtlsdr.go` (build tag: `//go:build rtlsdr`)
- **Status:** [ ]
- **Spec:** Direct USB access via gortlsdr. Async read with callback → channel adapter. Set frequency, gain, sample rate, AGC, direct sampling, bias-T via API calls. Build-tag gated (requires librtlsdr-dev).

### T43 — Dongle Manager (full)
- **Agent:** G
- **Deps:** T10, T40, T41, T42
- **Files:** `serverng/internal/dongle/manager.go`
- **Status:** [ ]
- **Spec:** Manages multiple dongles. Source type routing (local/rtl_tcp/airspy_tcp/hfp_tcp/rsp_tcp/demo). Start/stop/restart. Profile switching (with client notification). Auto-start on boot. Enabled/disabled flag.

### T44 — REST API (dongles, profiles, admin)
- **Agent:** A
- **Deps:** T11, T43
- **Files:** `serverng/internal/api/dongles.go`, `serverng/internal/api/admin.go`
- **Status:** [ ]
- **Spec:** Port REST endpoints from `server/src/index.ts`: GET/POST/PUT/DELETE dongles, profiles, profile-order. Admin auth (cookie-based, httpOnly, 7-day expiry, per-boot secret). GET /api/status. Save config to disk.

### T45 — FFT History Buffer
- **Agent:** A
- **Deps:** T07
- **Files:** `serverng/internal/history/fft_buffer.go`
- **Status:** [ ]
- **Spec:** Ring buffer storing last N FFT frames (configurable, default 1024). Supports seek-back requests: client sends frame range, server responds with packed history (deflate/adpcm codec). Port from `server/src/fft-history.ts`.

### T46 — Rate Limiting
- **Agent:** A
- **Deps:** T09
- **Files:** `serverng/internal/ws/ratelimit.go`
- **Status:** [ ]
- **Spec:** Max 10 WebSocket connections per IP. X-Forwarded-For aware. Token bucket or sliding window. Reject with 429 on HTTP upgrade.

---

## Phase 5: Polish + Release

### T50 — Benchmarks
- **Agent:** Any
- **Deps:** T25, T35
- **Files:** `serverng/internal/dsp/fft_bench_test.go`, `serverng/internal/dsp/pipeline_bench_test.go`
- **Status:** [ ]
- **Spec:** `go test -bench .` for FFT (N=2048, 4096, 8192, 65536), IqExtractor throughput, ADPCM encode throughput, full pipeline latency. Compare to Node.js numbers from PLAN.md §6.

### T51 — Cross-Compile + Docker
- **Agent:** Any
- **Deps:** T43
- **Files:** `serverng/Makefile` (update), `serverng/Dockerfile`
- **Status:** [ ]
- **Spec:** Makefile targets: `build-linux-amd64`, `build-linux-arm64`, `build-darwin-arm64`. Docker: scratch image (static binary + client dist). Multi-stage build. < 20MB image.

### T52 — Graceful Shutdown
- **Agent:** Any
- **Deps:** T43, T09
- **Files:** update `serverng/cmd/serverng/main.go`
- **Status:** [ ]
- **Spec:** SIGINT/SIGTERM → stop accepting new connections → drain existing (5s timeout) → close dongles → exit. Context propagation throughout.

### T53 — Integration Test (client ↔ serverng)
- **Agent:** Any
- **Deps:** T12, T25
- **Files:** `serverng/test/integration_test.go`
- **Status:** [ ]
- **Spec:** Start serverng in demo mode, connect WebSocket client, subscribe, verify FFT frames arrive (correct format), send tune command, verify IQ frames arrive. Automated, no browser needed.

---

## Dependency Graph (Gantt-style)

```
Phase 1 (parallel streams):
  Stream A: T01 → T02 → T10 → T11 → T12 (scaffold, config, demo, HTTP, integration)
  Stream B: T03, T04 → T08 (protocol, ADPCM, FFT codecs)
  Stream C: T05, T06 → T07 (FFT, windows, processor)
  
  T12 blocks on: T07, T08, T09, T10 (all Phase 1 converges here)
  T09 blocks on: T01, T03

Phase 2 (parallel after T20):
  Stream D: T20 → T21, T22, T23 → T24 → T26 (flow graph, DSP blocks, IQ extractor)
  Stream A: T25 blocks on T12 + T24 (client IQ streaming)

Phase 3 (parallel after T20):
  Stream E: T30 → T31 → T36 (FM, stereo, RDS)
  Stream E: T32, T33 (AM/SAM/CQUAM, SSB/CW) — parallel with T30
  Stream F: T34 → T35 blocks on T24 + T30-T33 (Opus pipeline)

Phase 4 (parallel, mostly independent):
  Stream G: T40 → T41, T42 → T43 (hardware clients → manager)
  Stream A: T44 blocks on T43 (REST API needs dongle manager)
  Stream A: T45, T46 (history, rate limit — independent)

Phase 5 (after Phase 3+4):
  T50, T51, T52, T53 — all independent, run after feature complete
```

## Agent Assignment Summary

| Agent | Focus Area | Tasks |
|-------|-----------|-------|
| **A** | Scaffold, HTTP, WS, integration | T01, T02, T09, T10, T11, T12, T25, T44, T45, T46 |
| **B** | Protocol, codecs | T03, T04, T08 |
| **C** | FFT, signal processing math | T05, T06, T07 |
| **D** | Flow graph engine, DSP blocks | T20, T21, T22, T23, T24, T26 |
| **E** | Demodulators, RDS | T30, T31, T32, T33, T36 |
| **F** | Opus pipeline | T34, T35 |
| **G** | Hardware/dongle sources | T40, T41, T42, T43 |

**Maximum parallelism:** Agents B, C, D, E, G can all start immediately (no deps or only deps within their own stream). Agent A starts immediately on T01. Agent F waits for D+E Phase 3 deps.
