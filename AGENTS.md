# AGENTS.md — AI Agent Guide for no-sdr

This file helps AI coding agents understand the no-sdr codebase quickly.

## Project Overview

**no-sdr** is a multi-user WebSDR (Software Defined Radio) application for RTL-SDR USB dongles. It streams live radio spectrum data to web browsers with an interactive waterfall display, spectrum analyzer, and audio demodulation. Multiple users can independently tune within the same dongle's bandwidth. Dongles can be local (USB), remote (rtl_tcp), or simulated (demo mode).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  RTL-SDR Dongle(s)                                           │
│  ├─ local: rtl_sdr child process (stdout IQ)                 │
│  ├─ rtl_tcp: TCP client to remote rtl_tcp server             │
│  └─ demo: SignalSimulator (fake IQ, no hardware)             │
└───────────┬──────────────────────────────────────────────────┘
            │ Buffer chunks (uint8 interleaved I/Q)
┌───────────▼──────────────────────────────────────────────────┐
│  Server (Node.js / Hono)                                     │
│  ├─ DongleManager: manages dongle lifecycle (3 source types) │
│  │   + rtl_tcp protocol (0x01–0x0E): freq, gain, AGC,       │
│  │     direct sampling, bias-T, offset tuning, IF gain       │
│  ├─ FftProcessor: FFT from IQ → Float32 dB (rate-capped)    │
│  ├─ IqExtractor: per-client NCO + Butterworth LPF + decimate│
│  ├─ IQ accumulator: 20ms fixed-size chunk buffering          │
│  ├─ ADPCM compression: per-client IMA-ADPCM for FFT & IQ    │
│  ├─ Delta+Deflate: lossless FFT compression (zlib built-in)  │
│  ├─ OpusAudioPipeline: server-side demod + Opus VBR encode   │
│  │   ├─ FmStereoDemod (19kHz PLL, SNR blend, de-emphasis)    │
│  │   ├─ CQuamStereoDemod (2nd-order PLL, cosGamma, 25Hz)    │
│  │   ├─ FmMonoDemod, AmMonoDemod, SsbMonoDemod, CwMonoDemod  │
│  │   └─ Dynamic mono↔stereo encoder switching (opusscript)   │
│  ├─ Backpressure: bufferedAmount checks, frame skipping      │
│  ├─ DecoderManager: spawns digital mode C binaries           │
│  ├─ WebSocketManager: routes data to connected clients       │
│  └─ SignalSimulator: generates fake IQ for demo mode         │
└───────────┬──────────────────────────────────────────────────┘
            │ WebSocket (binary protocol, multi-codec)
┌───────────▼──────────────────────────────────────────────────┐
│  Client (SolidJS / Vite / Tailwind CSS v4)                   │
│  ├─ SdrEngine: orchestrates WS, renderers, audio, codecs     │
│  │   + client-side resampler (SSB/CW → 48kHz)               │
│  ├─ WaterfallRenderer: Canvas 2D, peak-hold binning          │
│  ├─ SpectrumRenderer: Canvas 2D line/fill chart (30fps cap)  │
│  ├─ Demodulators: pure TS DSP (IQ codec path)                │
│  │   ├─ WFM stereo (PLL + SNR-proportional blend)            │
│  │   ├─ NFM, AM, USB, LSB, CW, Raw                          │
│  │   └─ AM Stereo (C-QUAM: PLL + cosGamma + 25Hz pilot)     │
│  ├─ RdsDecoder: 57kHz BPF → NCO → biphase → group parser    │
│  ├─ NoiseReduction: spectral NR + noise blanker              │
│  ├─ Opus decoder: opus-decoder WASM (Opus codec path)        │
│  ├─ AudioEngine: AudioWorklet + 5-band EQ + balance          │
│  │   + loudness compression + squelch gate                    │
│  │   + adaptive jitter buffer (150ms min, 200ms target)      │
│  └─ SolidJS components: App, ControlPanel, FrequencyDisplay  │
│      WaterfallDisplay (+ RDS overlay)                         │
└──────────────────────────────────────────────────────────────┘
```

### DSP Data Flow

**IQ codec path** (none/adpcm — client-side demod):
1. **Server**: Dongle IQ → FFT (rate-capped to `fftFps`, shared, broadcast to all clients)
2. **Server**: Dongle IQ → IqExtractor per client (NCO → Butterworth LPF → decimate) → 20ms accumulator → optional ADPCM encode → IQ sub-band
3. **Server → Client**: FFT (0x04/0x08/0x0B) + IQ sub-band per user (0x02/0x09) via WebSocket. IQ only sent after client enables audio.
4. **Client**: IQ → optional ADPCM decode → demodulator (FM stereo/AM/C-QUAM/SSB/CW) → resampler (if needed) → noise reduction → audio → AudioWorklet → 5-band EQ → balance → loudness → speakers

**Opus codec path** (opus/opus-hq — server-side demod):
1. **Server**: Dongle IQ → FFT (shared, same as above)
2. **Server**: Dongle IQ → IqExtractor → OpusAudioPipeline (server demod → 48kHz PCM → Opus VBR encode)
3. **Server → Client**: FFT + Opus audio packets (0x0C) per user
4. **Client**: Opus decode (WASM) → Float32 audio → AudioWorklet (bypasses client demod/NR)

## Monorepo Structure

```
no-sdr/
├── package.json          # npm workspaces root
├── tsconfig.base.json    # Shared TypeScript config (ES2022, strict)
├── TODO.md               # Pending tasks and completed work
├── SPEC.md               # Full technical specification
├── AGENTS.md             # This file
├── config/
│   └── config.yaml       # Dongle profiles, server config (YAML + Zod validated)
├── .github/
│   └── workflows/
│       └── docker-publish.yml  # Build + push Docker image to GHCR on release
├── docker/
│   ├── Dockerfile        # Multi-stage: build + node:22-slim runtime
│   └── docker-compose.yml
├── scripts/              # Dev/test scripts (FFT capture, benchmarks)
├── shared/               # @node-sdr/shared — zero-dep types & constants
│   └── src/
│       ├── types.ts      # DongleInfo, DongleProfile, DemodMode, SourceConfig, DongleConfig
│       ├── protocol.ts   # Binary WS protocol (MSG_FFT=0x01..0x0C), FftCodecType, IqCodecType, ClientCommand
│       ├── modes.ts      # DEMOD_MODES, DIGITAL_MODES, FREQUENCY_BANDS
│       ├── adpcm.ts      # IMA-ADPCM encoder/decoder + FFT-specific helpers
│       └── index.ts      # Re-exports
├── server/               # @node-sdr/server — Hono backend
│   └── src/
│       ├── index.ts      # Hono app, REST API, WS endpoint, static serving
│       ├── config.ts     # YAML loading + Zod validation + saveConfig()
│       ├── logger.ts     # pino logger
│       ├── dongle-manager.ts    # Manages dongles (local/rtl_tcp/demo), rtl_tcp 0x01–0x0E protocol
│       ├── fft-processor.ts     # FFT via fft.js, windowing, dB norm, rate cap (targetFps)
│       ├── iq-extractor.ts      # Per-client IQ sub-band (NCO + Butterworth + decimate)
│       ├── ws-manager.ts        # Client subscriptions, per-client codec routing, backpressure, IQ accumulator
│       ├── opus-audio.ts        # Server-side demod + Opus VBR encode (stereo FM, C-QUAM, mono modes)
│       ├── decoder-manager.ts   # Spawns C binaries for digital modes
│       └── signal-simulator.ts  # Demo mode IQ generation
└── client/               # @node-sdr/client — SolidJS frontend
    ├── vite.config.ts    # Vite 6 + solid + tailwindcss/vite, port 3001, proxy to 3000
    ├── index.html
    └── src/
        ├── index.tsx
        ├── App.tsx               # Main layout, theme switching, bandwidth meter
        ├── styles/app.css        # Tailwind v4 @theme, component classes
        ├── store/index.ts        # SolidJS signals (frequency, mode, EQ, codec, NR, RDS, etc.)
        ├── engine/
        │   ├── sdr-engine.ts     # WS orchestrator, auto-reconnect, codec negotiation, stats, resampler
        │   ├── waterfall.ts      # Canvas 2D waterfall renderer (30fps throttle, resize preserve, peak-hold)
        │   ├── spectrum.ts       # Canvas 2D spectrum renderer (30fps throttle, peak-hold binning)
        │   ├── palettes.ts       # 5 color themes (turbo, viridis, etc.)
        │   ├── demodulators.ts   # Pure TS DSP: FM stereo (blend), AM (C-QUAM auto-detect), SSB, CW + PLL
        │   ├── rds-decoder.ts    # RDS decoder: 57kHz BPF → NCO → biphase → block sync → group parser
        │   ├── noise-reduction.ts # Spectral NR (Wiener) + noise blanker (EMA + hang timer)
        │   └── audio.ts          # AudioWorklet + 5-band EQ + balance + loudness + adaptive jitter buffer
        └── components/
            ├── WaterfallDisplay.tsx  # Waterfall + RDS overlay
            ├── FrequencyDisplay.tsx  # LCD digits + stereo indicator badge
            └── ControlPanel.tsx      # SMeter (bar/needle), ModeSelector, Audio, NR, Codec, Admin
```

## Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js 22 LTS | ESM throughout |
| Language | TypeScript 5 | Strict mode, ES2022 target |
| Backend | Hono + @hono/node-ws | REST + WebSocket, native TS |
| Frontend | SolidJS 1.x | Fine-grained reactivity, no VDOM |
| Build | Vite 6 | vite-plugin-solid + @tailwindcss/vite |
| Styling | Tailwind CSS v4 | @theme directive in CSS, no JS config |
| FFT | fft.js (indutny) | Radix-4, used on both server and client |
| Opus | opusscript (server WASM) | Emscripten-compiled libopus for server-side encoding |
| Opus | opus-decoder (client WASM) | 85.5KB WASM decoder for browser |
| Deflate | Node.js zlib (server) | Built-in, no deps. `deflateRawSync` for FFT |
| Deflate | fflate (client) | ~14KB pure JS inflate for browser |
| Config | YAML + Zod | js-yaml for parsing, Zod for validation |
| Logging | pino | Structured JSON logging |
| Hardware | rtl_sdr CLI / rtl_tcp | Local child process or remote TCP |

## Key Design Decisions

- **Three source types**: `local` (spawn rtl_sdr), `rtl_tcp` (TCP client to remote server), `demo` (signal simulator). Configured per-dongle in YAML.
- **Hybrid DSP**: Server computes FFT (broadcast to all), client does per-user demodulation from IQ sub-bands. This scales to many users without server CPU per-user for demodulation.
- **Dual audio codec paths**: IQ codecs (none/adpcm) send raw IQ for client-side demod with full stereo/NR. Opus codecs (opus/opus-hq) do server-side demod with Opus VBR compression — much lower bandwidth but no client NR/EQ control over demod.
- **Per-client IQ extraction**: Server runs `IqExtractor` per connected client — NCO frequency shift + 4th-order Butterworth anti-alias filter + decimation. Output rate depends on mode (WFM=240k, NFM/AM/AMS=48k, SSB=24k, CW=12k).
- **IQ chunk accumulation**: Server buffers IQ extractor output into fixed 20ms chunks before sending (eliminates variable-size WebSocket messages that caused audio fragmentation).
- **Three FFT codecs**: `none` (Uint8 with min/max header, 4:1), `adpcm` (IMA-ADPCM on Int16 dB×100, ~8:1), `deflate` (delta-encode Uint8 + zlib deflateRaw, 7.5-10:1 lossless). Default: deflate.
- **Two IQ codecs + two Opus tiers**: `none` (raw Int16), `adpcm` (4:1 lossy), `opus` (server demod, 32kbps mono / 64kbps stereo), `opus-hq` (server demod, 128kbps mono / 192kbps stereo).
- **Server-side FFT rate cap**: Configurable `fftFps` per profile (default 30). All computed FFT frames are averaged into a pending frame, emitted at target rate.
- **WebSocket backpressure**: `ws.raw.bufferedAmount` checked before send (256KB for FFT, 1MB for IQ). Slow clients get frames dropped.
- **Audio-gated IQ**: Server only sends per-user IQ data after client sends `{ cmd: 'audio_enabled', enabled: true }`.
- **Stereo FM blend**: PLL SNR maps to continuous blend factor 0.0-1.0 (not hard on/off). 200ms hold timer prevents flutter. Weak stations fade gracefully to mono.
- **C-QUAM AM Stereo**: Motorola C-QUAM decode with 2nd-order PLL, cosGamma correction, 25Hz Goertzel pilot detection. Auto-detected in AM mode via two-stage verification. Full stereo output.
- **RDS decoder**: Client-side, taps FM composite at 240kHz. 57kHz BPF → NCO mix-down → LPF+decimate → symbol sync → biphase → block sync (CRC) → group parser (types 0A/0B→PS, 2A/2B→RT, 4A→CT).
- **Server-side stereo Opus**: `opus-audio.ts` has full WFM stereo PLL and C-QUAM demod. Dynamic mono↔stereo encoder switching based on PLL detection. Client can force mono via `stereo_enabled` command.
- **Noise reduction**: Spectral NR (512-pt FFT Wiener filter, overlap-add) + noise blanker (EMA + hang timer). NR has known artifact issues; NB works well.
- **Client-side resampler**: Linear interpolation upsamples SSB (24kHz) and CW (12kHz) demod output to 48kHz for AudioWorklet.
- **Adaptive jitter buffer**: AudioWorklet ring buffer with 150ms minimum fill, 200ms target, ±1 sample/frame adaptive rate control.
- **Peak-hold FFT rendering**: When FFT bins > canvas pixels, each pixel shows max dB across all mapped bins (prevents missing narrow signals at large FFT sizes like 65536).
- **5-band parametric EQ**: Web Audio API BiquadFilterNodes (lowshelf 80Hz, peaking 500Hz, peaking 1.5kHz, peaking 4kHz, highshelf 12kHz).
- **No framework state for hot data**: FFT and audio data bypass SolidJS reactivity entirely. Canvas and AudioWorklet are driven imperatively.
- **Binary WebSocket protocol**: Type byte prefix (0x01-0x0C) + typed array payload. Client→Server is JSON text.
- **Demo mode**: Signal simulator generates realistic IQ data. Activated via `NODE_SDR_DEMO=1` env var or `demoMode: true` in config.
- **Waterfall resize preservation**: Offscreen canvas snapshot prevents blank waterfall on browser resize.
- **S-meter**: Classic analog needle meter (canvas-drawn) with warm backlit face, dual scale, red needle, peak hold. Toggle to bar mode.
- **Dongle hardware options**: DongleConfig supports directSampling (0/1/2), biasT, digitalAgc, offsetTuning, ifGain (E4000 stages), tunerBandwidth. Applied via rtl_tcp protocol commands (0x01–0x0E) or rtl_sdr CLI args.

## WebSocket Protocol

### Server → Client (Binary)

| Type Byte | Constant | Payload | Direction |
|-----------|----------|---------|-----------|
| `0x01` | `MSG_FFT` | Float32Array (dB magnitudes) | Broadcast to dongle |
| `0x02` | `MSG_IQ` | Int16Array (interleaved I/Q) | Per-user |
| `0x03` | `MSG_META` | UTF-8 JSON (ServerMeta) | Per-user |
| `0x04` | `MSG_FFT_COMPRESSED` | 4-byte header (Int16 minDb+maxDb LE) + Uint8Array (0-255 dB) | Broadcast |
| `0x05` | `MSG_AUDIO` | Int16Array (mono PCM) — placeholder, not currently sent | Per-user |
| `0x06` | `MSG_DECODER` | UTF-8 JSON (decoder output) | Broadcast to dongle |
| `0x07` | `MSG_SIGNAL_LEVEL` | Float32 (dB) — placeholder, not currently sent | Per-user |
| `0x08` | `MSG_FFT_ADPCM` | ADPCM-encoded FFT with 4-byte min/max header + warmup | Broadcast |
| `0x09` | `MSG_IQ_ADPCM` | Uint32 sampleCount + ADPCM bytes | Per-user |
| `0x0B` | `MSG_FFT_DEFLATE` | 8-byte header (Int16 minDb + Int16 maxDb + Uint32 binCount LE) + raw deflate bytes | Broadcast |
| `0x0C` | `MSG_AUDIO_OPUS` | Uint16 sampleCount + Uint8 channels + Opus packet bytes | Per-user |

### Client → Server (JSON Text)

```json
{ "cmd": "subscribe", "dongleId": "dongle-0" }
{ "cmd": "tune", "offset": 25000 }
{ "cmd": "mode", "mode": "nfm" }
{ "cmd": "bandwidth", "hz": 12500 }
{ "cmd": "codec", "fftCodec": "deflate", "iqCodec": "adpcm" }
{ "cmd": "audio_enabled", "enabled": true }
{ "cmd": "stereo_enabled", "enabled": true }
```

## Build & Run

```bash
npm install                  # Install all workspaces
npm run build                # Build shared → client → server
npm run dev:demo             # Development with hot reload + simulated signals
npm run dev                  # Development with real hardware
npm start                    # Production (requires RTL-SDR hardware)
```

Build order matters: `shared` must build before `server` and `client`.

Development mode runs three processes in parallel: shared tsc watch, server tsx watch (port 3000), client vite dev (port 3001 with proxy to 3000 for `/ws` and `/api`).

## Configuration

`config/config.yaml` defines dongles and their profiles. Each dongle has a `source` section specifying how to connect: `local` (USB), `rtl_tcp` (remote), or `demo`. Each profile specifies center frequency, sample rate, FFT size (up to 65536), `fftFps` (frame rate cap, default 30), default demodulation mode, and optional digital decoders.

Dongle-level hardware options: `directSampling` (0=off, 1=I-branch, 2=Q-branch), `biasT` (bool), `digitalAgc` (bool), `offsetTuning` (bool), `ifGain` (array of [stage, gain] for E4000), `tunerBandwidth` (Hz, rtl-sdr-blog fork only). Validated at startup with Zod.

When an admin switches a dongle's active profile, **all connected clients on that dongle are switched automatically**.

Admin can create, update, and delete profiles at runtime via REST API. Changes are persisted to disk.

## UI Theming

- **Three UI themes**: Default (cyan), CRT (phosphor green), VFD (amber) — switched via `data-theme` attribute
- **Five waterfall color palettes**: turbo, viridis, classic, grayscale, hot — independent of UI theme
- **Tailwind v4**: All theme values defined in `client/src/styles/app.css` using `@theme` directive. No `tailwind.config.js`.

## Audio Features

- **Stereo FM**: PLL-based 19kHz pilot detection with SNR-proportional stereo blend (continuous 0–1, not hard switch). 200ms hold timer. Per-channel de-emphasis.
- **AM Stereo (C-QUAM)**: Motorola C-QUAM with PLL carrier lock, cosGamma correction, 25Hz Goertzel pilot, per-channel notch filter + AGC. Auto-detected in AM mode.
- **RDS**: Client-side FM RDS decoder — extracts station name (PS), radio text (RT), PTY, PI code, clock time. Overlay on waterfall.
- **Noise reduction**: Spectral NR (Wiener filter, 512-pt FFT, known artifacts) + Noise blanker (EMA + hang timer, works well for impulse noise).
- **5-band EQ**: LOW (80Hz lowshelf), L-MID (500Hz peaking), MID (1.5kHz peaking), H-MID (4kHz peaking), HIGH (12kHz highshelf). All ±12dB.
- **Balance**: StereoPannerNode, -1 (left) to +1 (right)
- **Loudness**: DynamicsCompressorNode with pre-boost gain. Squashes dynamic range for quiet signals.
- **Squelch**: Client-side gate based on FFT-derived signal level. 500ms bypass after tune/mode change.
- **Adaptive jitter buffer**: 150ms minimum fill, 200ms target, ±1 sample/frame rate adaptation in AudioWorklet.

## Compression

- **IMA-ADPCM** (`shared/src/adpcm.ts`): Standard 4:1 lossy codec. 89-entry step table, 16-entry index table. Streaming encoder/decoder with persistent state.
- **FFT compression**: Four options — raw Float32 (0x01), Uint8 with min/max header (0x04, 4:1), ADPCM on Int16-scaled dB (0x08, ~8:1), Delta+Deflate on Uint8 (0x0B, 7.5–10:1 lossless). Default: deflate.
- **IQ compression**: Two options — raw Int16 (0x02), ADPCM (0x09, 4:1). Default: adpcm.
- **Opus audio**: Two tiers — Opus (32kbps mono / 64kbps stereo), Opus HQ (128kbps mono / 192kbps stereo). Server-side demod via `opusscript` WASM encoder.
- **Codec negotiation**: Client sends `{ cmd: 'codec', fftCodec, iqCodec }`. Server creates per-client encoder instances.
- **Compression stats**: Client tracks wire bytes vs raw bytes for both FFT and IQ, shows ratio and savings in UI.

## Common Tasks

- **Add a new demodulation mode**: Add to `DemodMode` type in `shared/src/types.ts`, add info to `DEMOD_MODES` in `shared/src/modes.ts`, implement class in `client/src/engine/demodulators.ts`, add output sample rate in `server/src/iq-extractor.ts`, add server-side demod in `server/src/opus-audio.ts`, add to mode selector in `client/src/components/ControlPanel.tsx`
- **Add a new digital decoder**: Add to `DigitalMode` type, add info to `DIGITAL_MODES`, add parser function in `server/src/decoder-manager.ts`
- **Add a new compression codec**: Add to `FftCodecType`/`IqCodecType` in `shared/src/protocol.ts`, add message type constant, add server encode path in `ws-manager.ts`, add client decode path in `sdr-engine.ts`, add UI option in `ControlPanel.tsx`
- **Add a REST endpoint**: Add route in `server/src/index.ts`
- **Add a UI component**: Create in `client/src/components/`, import in `App.tsx`
- **Change waterfall colors**: Edit `PALETTE_STOPS` in `client/src/engine/palettes.ts`
- **Add a dongle profile**: Edit `config/config.yaml` or use admin REST API
- **Add a new source type**: Add to `SourceType` in `shared/src/types.ts`, implement connection logic in `server/src/dongle-manager.ts`

## Testing

No test framework is set up yet. Priority areas for testing:
- `shared/src/protocol.ts` — pack/unpack round-trip
- `shared/src/adpcm.ts` — encode/decode round-trip, compression ratio validation
- `server/src/fft-processor.ts` — FFT correctness, window functions, normalization, rate cap
- `server/src/iq-extractor.ts` — Butterworth filter design, NCO accuracy, decimation
- `server/src/opus-audio.ts` — server-side demod output validation, stereo switching
- `client/src/engine/demodulators.ts` — demodulator output validation, stereo FM PLL lock, C-QUAM pilot detection
- `client/src/engine/rds-decoder.ts` — block sync, group parsing, CRC validation
- `server/src/config.ts` — Zod schema validation edge cases

## Known Issues

- **Spectral NR artifacts**: The Wiener filter in `noise-reduction.ts` produces robotic artifacts on music/tonal signals. Noise blanker is recommended for now. See TODO.md.
- **NFM double de-emphasis**: `demodulators.ts` applies de-emphasis twice for NFM (lines ~582 and ~594). Needs investigation.
- **opusscript CJS in ESM**: `opusscript` is CJS-only; server uses `createRequire(import.meta.url)` to load it in ESM context.
