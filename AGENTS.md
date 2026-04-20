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
│  ├─ FftProcessor: FFT from IQ → Float32 dB (rate-capped)    │
│  ├─ IqExtractor: per-client NCO + Butterworth LPF + decimate│
│  ├─ ADPCM compression: per-client IMA-ADPCM for FFT & IQ    │
│  ├─ Backpressure: bufferedAmount checks, frame skipping      │
│  ├─ DecoderManager: spawns digital mode C binaries           │
│  ├─ WebSocketManager: routes data to connected clients       │
│  └─ SignalSimulator: generates fake IQ for demo mode         │
└───────────┬──────────────────────────────────────────────────┘
            │ WebSocket (binary protocol, ADPCM compressed)
┌───────────▼──────────────────────────────────────────────────┐
│  Client (SolidJS / Vite / Tailwind CSS v4)                   │
│  ├─ SdrEngine: orchestrates WS, renderers, audio, codecs     │
│  ├─ WaterfallRenderer: Canvas 2D, 256-entry color palette    │
│  ├─ SpectrumRenderer: Canvas 2D line/fill chart (30fps cap)  │
│  ├─ Demodulators: pure TS DSP                                │
│  │   ├─ WFM stereo (PLL + SNR-proportional blend)            │
│  │   ├─ NFM, AM, USB, LSB, CW, Raw                          │
│  │   └─ AM Stereo (C-QUAM: PLL + cosGamma + 25Hz pilot)     │
│  ├─ NoiseReduction: spectral NR + noise blanker              │
│  ├─ AudioEngine: AudioWorklet + 5-band EQ + balance          │
│  │   + loudness compression + squelch gate                    │
│  └─ SolidJS components: App, ControlPanel, FrequencyDisplay  │
└──────────────────────────────────────────────────────────────┘
```

### DSP Data Flow

1. **Server**: Dongle IQ → FFT (rate-capped to `fftFps`, shared, broadcast to all clients on that dongle)
2. **Server**: Dongle IQ → IqExtractor per client (NCO → Butterworth LPF → decimate) → optional ADPCM encode → IQ sub-band
3. **Server → Client**: FFT (0x01/0x04/0x08) + IQ sub-band per user (0x02/0x09) via WebSocket. IQ only sent after client enables audio.
4. **Client**: IQ → optional ADPCM decode → demodulator (FM stereo/AM/C-QUAM/SSB/CW) → noise reduction → audio → AudioWorklet → 5-band EQ → balance → loudness → speakers

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
├── docker/
│   ├── Dockerfile        # Multi-stage: build + node:22-slim runtime
│   └── docker-compose.yml
├── shared/               # @node-sdr/shared — zero-dep types & constants
│   └── src/
│       ├── types.ts      # DongleInfo, DongleProfile, DemodMode, SourceConfig, etc.
│       ├── protocol.ts   # Binary WS protocol (MSG_FFT=0x01..0x09), CodecType, ClientCommand
│       ├── modes.ts      # DEMOD_MODES, DIGITAL_MODES, FREQUENCY_BANDS
│       ├── adpcm.ts      # IMA-ADPCM encoder/decoder + FFT-specific helpers
│       └── index.ts      # Re-exports
├── server/               # @node-sdr/server — Hono backend
│   └── src/
│       ├── index.ts      # Hono app, REST API, WS endpoint, static serving
│       ├── config.ts     # YAML loading + Zod validation + saveConfig()
│       ├── logger.ts     # pino logger
│       ├── dongle-manager.ts    # Manages dongles (local/rtl_tcp/demo)
│       ├── fft-processor.ts     # FFT via fft.js, windowing, dB norm, rate cap (targetFps)
│       ├── iq-extractor.ts      # Per-client IQ sub-band (NCO + Butterworth + decimate)
│       ├── ws-manager.ts        # Client subscriptions, per-client IQ/codec routing, backpressure
│       ├── decoder-manager.ts   # Spawns C binaries for digital modes
│       └── signal-simulator.ts  # Demo mode IQ generation
└── client/               # @node-sdr/client — SolidJS frontend
    ├── vite.config.ts    # Vite 6 + solid + tailwindcss/vite, port 3001, proxy to 3000
    ├── index.html
    └── src/
        ├── index.tsx
        ├── App.tsx               # Main layout, theme switching, bandwidth meter
        ├── styles/app.css        # Tailwind v4 @theme, component classes
        ├── store/index.ts        # SolidJS signals (frequency, mode, EQ, codec, NR, etc.)
        ├── engine/
        │   ├── sdr-engine.ts     # WS orchestrator, auto-reconnect, codec negotiation, stats
        │   ├── waterfall.ts      # Canvas 2D waterfall renderer (30fps throttle, resize preserve)
        │   ├── spectrum.ts       # Canvas 2D spectrum renderer (30fps throttle)
        │   ├── palettes.ts       # 5 color themes (turbo, viridis, etc.)
        │   ├── demodulators.ts   # Pure TS DSP: FM stereo (blend), AM, C-QUAM, SSB, CW + PLL
        │   ├── noise-reduction.ts # Spectral NR (Wiener) + noise blanker (EMA + hang timer)
        │   └── audio.ts          # AudioWorklet + 5-band EQ + balance + loudness
        └── components/
            ├── WaterfallDisplay.tsx
            ├── FrequencyDisplay.tsx
            └── ControlPanel.tsx   # SMeter (bar/needle), ModeSelector, Audio, NR, Codec, Admin
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
| Config | YAML + Zod | js-yaml for parsing, Zod for validation |
| Logging | pino | Structured JSON logging |
| Hardware | rtl_sdr CLI / rtl_tcp | Local child process or remote TCP |

## Key Design Decisions

- **Three source types**: `local` (spawn rtl_sdr), `rtl_tcp` (TCP client to remote server), `demo` (signal simulator). Configured per-dongle in YAML.
- **Hybrid DSP**: Server computes FFT (broadcast to all), client does per-user demodulation from IQ sub-bands. This scales to many users without server CPU per-user for demodulation.
- **Per-client IQ extraction**: Server runs `IqExtractor` per connected client — NCO frequency shift + 4th-order Butterworth anti-alias filter + decimation. Output rate depends on mode (WFM=240k, NFM/AM/AMS=48k, SSB=24k, CW=12k).
- **IMA-ADPCM compression**: 4:1 lossy compression for both FFT and IQ streams. Per-client codec negotiation (`none` | `adpcm`). Defaults to `adpcm`.
- **Server-side FFT rate cap**: Configurable `fftFps` per profile (default 30). All computed FFT frames are averaged into a pending frame, emitted at target rate.
- **WebSocket backpressure**: `ws.raw.bufferedAmount` checked before send (256KB for FFT, 1MB for IQ). Slow clients get frames dropped.
- **Audio-gated IQ**: Server only sends per-user IQ data after client sends `{ cmd: 'audio_enabled', enabled: true }`.
- **Stereo FM blend**: PLL SNR maps to continuous blend factor 0.0-1.0 (not hard on/off). Weak stations fade gracefully to mono.
- **C-QUAM AM Stereo**: Motorola C-QUAM decode with 2nd-order PLL, cosGamma correction, 25Hz Goertzel pilot detection. Full stereo output.
- **Noise reduction**: Spectral NR (512-pt FFT Wiener filter, overlap-add) + noise blanker (EMA + hang timer). NR has known artifact issues; NB works well.
- **5-band parametric EQ**: Web Audio API BiquadFilterNodes (lowshelf 80Hz, peaking 500Hz, peaking 1.5kHz, peaking 4kHz, highshelf 12kHz).
- **No framework state for hot data**: FFT and audio data bypass SolidJS reactivity entirely. Canvas and AudioWorklet are driven imperatively.
- **Binary WebSocket protocol**: Type byte prefix (0x01-0x09) + typed array payload. Client→Server is JSON text.
- **Demo mode**: Signal simulator generates realistic IQ data. Activated via `NODE_SDR_DEMO=1` env var or `demoMode: true` in config.
- **Waterfall resize preservation**: Offscreen canvas snapshot prevents blank waterfall on browser resize.
- **S-meter**: Classic analog needle meter (canvas-drawn) with warm backlit face, dual scale, red needle, peak hold. Toggle to bar mode.

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

### Client → Server (JSON Text)

```json
{ "cmd": "subscribe", "dongleId": "dongle-0" }
{ "cmd": "tune", "offset": 25000 }
{ "cmd": "mode", "mode": "nfm" }
{ "cmd": "bandwidth", "hz": 12500 }
{ "cmd": "codec", "fftCodec": "adpcm", "iqCodec": "adpcm" }
{ "cmd": "audio_enabled", "enabled": true }
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

`config/config.yaml` defines dongles and their profiles. Each dongle has a `source` section specifying how to connect: `local` (USB), `rtl_tcp` (remote), or `demo`. Each profile specifies center frequency, sample rate, FFT size, `fftFps` (frame rate cap, default 30), default demodulation mode, and optional digital decoders. Validated at startup with Zod.

When an admin switches a dongle's active profile, **all connected clients on that dongle are switched automatically**.

Admin can create, update, and delete profiles at runtime via REST API. Changes are persisted to disk.

## UI Theming

- **Three UI themes**: Default (cyan), CRT (phosphor green), VFD (amber) — switched via `data-theme` attribute
- **Five waterfall color palettes**: turbo, viridis, classic, grayscale, hot — independent of UI theme
- **Tailwind v4**: All theme values defined in `client/src/styles/app.css` using `@theme` directive. No `tailwind.config.js`.

## Audio Features

- **Stereo FM**: PLL-based 19kHz pilot detection with SNR-proportional stereo blend (continuous 0–1, not hard switch). Per-channel de-emphasis.
- **AM Stereo (C-QUAM)**: Motorola C-QUAM with PLL carrier lock, cosGamma correction, 25Hz Goertzel pilot, per-channel notch filter + AGC.
- **Noise reduction**: Spectral NR (Wiener filter, 512-pt FFT, known artifacts) + Noise blanker (EMA + hang timer, works well for impulse noise).
- **5-band EQ**: LOW (80Hz lowshelf), L-MID (500Hz peaking), MID (1.5kHz peaking), H-MID (4kHz peaking), HIGH (12kHz highshelf). All ±12dB.
- **Balance**: StereoPannerNode, -1 (left) to +1 (right)
- **Loudness**: DynamicsCompressorNode with pre-boost gain. Squashes dynamic range for quiet signals.
- **Squelch**: Client-side gate based on FFT-derived signal level. 500ms bypass after tune/mode change.
- **Jitter buffer**: 100ms minimum fill in AudioWorklet ring buffer.

## Compression

- **IMA-ADPCM** (`shared/src/adpcm.ts`): Standard 4:1 lossy codec. 89-entry step table, 16-entry index table. Streaming encoder/decoder with persistent state.
- **FFT compression**: Three options — raw Float32 (0x01), Uint8 with min/max header (0x04), ADPCM on Int16-scaled dB (0x08, ~8:1 total).
- **IQ compression**: Two options — raw Int16 (0x02), ADPCM (0x09, 4:1).
- **Codec negotiation**: Client sends `{ cmd: 'codec', fftCodec, iqCodec }`. Server creates per-client encoder instances.
- **Compression stats**: Client tracks wire bytes vs raw bytes for both FFT and IQ, shows ratio and savings in UI.

## Common Tasks

- **Add a new demodulation mode**: Add to `DemodMode` type in `shared/src/types.ts`, add info to `DEMOD_MODES` in `shared/src/modes.ts`, implement class in `client/src/engine/demodulators.ts`, add output sample rate in `server/src/iq-extractor.ts`, add to mode selector in `client/src/components/ControlPanel.tsx`
- **Add a new digital decoder**: Add to `DigitalMode` type, add info to `DIGITAL_MODES`, add parser function in `server/src/decoder-manager.ts`
- **Add a new compression codec**: Add to `CodecType` in `shared/src/protocol.ts`, add message type constant, add server encode path in `ws-manager.ts`, add client decode path in `sdr-engine.ts`, add UI option in `ControlPanel.tsx`
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
- `client/src/engine/demodulators.ts` — demodulator output validation, stereo FM PLL lock, C-QUAM pilot detection
- `server/src/config.ts` — Zod schema validation edge cases

## Known Issues

- **Spectral NR artifacts**: The Wiener filter in `noise-reduction.ts` produces robotic artifacts on music/tonal signals. Noise blanker is recommended for now. See TODO.md.
- **NFM double de-emphasis**: `demodulators.ts` applies de-emphasis twice for NFM (lines ~582 and ~594). Needs investigation.
