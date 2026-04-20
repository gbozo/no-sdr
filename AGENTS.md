# AGENTS.md — AI Agent Guide for node-sdr

This file helps AI coding agents understand the node-sdr codebase quickly.

## Project Overview

**node-sdr** is a multi-user WebSDR (Software Defined Radio) application for RTL-SDR USB dongles. It streams live radio spectrum data to web browsers with an interactive waterfall display, spectrum analyzer, and audio demodulation. Multiple users can independently tune within the same dongle's bandwidth.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  RTL-SDR Dongle(s)                                           │
│  └─ rtl_sdr child process (or signal simulator in demo mode) │
│     └─ stdout: raw uint8 interleaved I/Q samples             │
└───────────┬──────────────────────────────────────────────────┘
            │ Buffer chunks
┌───────────▼──────────────────────────────────────────────────┐
│  Server (Node.js / Hono)                                     │
│  ├─ DongleManager: spawns/manages rtl_sdr processes          │
│  ├─ FftProcessor: computes FFT from IQ → Float32 dB array    │
│  ├─ DecoderManager: spawns digital mode binaries             │
│  │   (dump1090, acarsdec, dumpvdl2, multimon-ng, direwolf)   │
│  ├─ WebSocketManager: routes data to connected clients       │
│  └─ SignalSimulator: generates fake IQ for demo mode         │
└───────────┬──────────────────────────────────────────────────┘
            │ WebSocket (binary protocol)
┌───────────▼──────────────────────────────────────────────────┐
│  Client (SolidJS / Vite / Tailwind CSS v4)                   │
│  ├─ SdrEngine: orchestrates WS, renderers, audio             │
│  ├─ WaterfallRenderer: Canvas 2D, 256-entry color palette    │
│  ├─ SpectrumRenderer: Canvas 2D line/fill chart              │
│  ├─ Demodulators: pure TS DSP (WFM/NFM/AM/USB/LSB/CW)       │
│  ├─ AudioEngine: Web Audio API + AudioWorklet                │
│  └─ SolidJS components: App, ControlPanel, FrequencyDisplay  │
└──────────────────────────────────────────────────────────────┘
```

### DSP Data Flow

1. **Server**: Dongle IQ → FFT (shared, broadcast to all clients on that dongle)
2. **Server → Client**: FFT magnitudes (0x01) + IQ sub-band per user (0x02) via WebSocket
3. **Client**: IQ sub-band → demodulator (FM/AM/SSB/CW) → audio samples → AudioWorklet → speakers

## Monorepo Structure

```
node-sdr/
├── package.json          # npm workspaces root
├── tsconfig.base.json    # Shared TypeScript config (ES2022, strict)
├── config/
│   └── config.yaml       # Dongle profiles, server config (YAML + Zod validated)
├── docker/
│   ├── Dockerfile        # Multi-stage: build + node:22-slim runtime
│   └── docker-compose.yml
├── shared/               # @node-sdr/shared — zero-dep types & constants
│   └── src/
│       ├── types.ts      # DongleInfo, DongleProfile, DemodMode, etc.
│       ├── protocol.ts   # Binary WS protocol (MSG_FFT=0x01, etc.)
│       ├── modes.ts      # DEMOD_MODES, DIGITAL_MODES, FREQUENCY_BANDS
│       └── index.ts      # Re-exports
├── server/               # @node-sdr/server — Hono backend
│   └── src/
│       ├── index.ts      # Hono app, REST API, WS endpoint, static serving
│       ├── config.ts     # YAML loading + Zod validation
│       ├── logger.ts     # pino logger
│       ├── dongle-manager.ts    # Spawns rtl_sdr, manages dongles
│       ├── fft-processor.ts     # FFT via fft.js, windowing, dB output
│       ├── ws-manager.ts        # Client subscriptions, command routing
│       ├── decoder-manager.ts   # Spawns C binaries for digital modes
│       └── signal-simulator.ts  # Demo mode IQ generation
└── client/               # @node-sdr/client — SolidJS frontend
    ├── vite.config.ts    # Vite 6 + solid + tailwindcss/vite plugins
    ├── index.html
    └── src/
        ├── index.tsx
        ├── App.tsx               # Main layout, theme switching
        ├── styles/app.css        # Tailwind v4 @theme, component classes
        ├── store/index.ts        # SolidJS signals (frequency, mode, etc.)
        ├── engine/
        │   ├── sdr-engine.ts     # WS orchestrator, auto-reconnect
        │   ├── waterfall.ts      # Canvas 2D waterfall renderer
        │   ├── spectrum.ts       # Canvas 2D spectrum renderer
        │   ├── palettes.ts       # 5 color themes (turbo, viridis, etc.)
        │   ├── demodulators.ts   # Pure TS DSP: FM, AM, SSB, CW
        │   └── audio.ts          # AudioWorklet-based audio engine
        └── components/
            ├── WaterfallDisplay.tsx
            ├── FrequencyDisplay.tsx
            └── ControlPanel.tsx
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
| Hardware | rtl_sdr CLI | Spawned as child process |

## Key Design Decisions

- **Child process for hardware**: We spawn `rtl_sdr` as a child process (not native addon) for reliability and Docker compatibility. IQ data arrives on stdout as Buffer chunks.
- **Hybrid DSP**: Server computes FFT (broadcast to all), client does per-user demodulation from IQ sub-bands. This scales to many users without server CPU per-user.
- **No framework state for hot data**: FFT and audio data bypass SolidJS reactivity entirely. Canvas and AudioWorklet are driven imperatively. SolidJS signals are only for UI controls.
- **Binary WebSocket protocol**: Type byte prefix (0x01-0x07) + typed array payload. Client→Server is JSON text.
- **Demo mode**: Signal simulator generates realistic IQ data. Activated via `NODE_SDR_DEMO=1` env var or `demoMode: true` in config.
- **Digital decoders**: External C binaries (dump1090, acarsdec, etc.) spawned as child processes with stdout parsing. Decoder output is forwarded to clients as JSON via WebSocket.

## WebSocket Protocol

### Server → Client (Binary)

| Type Byte | Constant | Payload | Direction |
|-----------|----------|---------|-----------|
| `0x01` | `MSG_FFT` | Float32Array (dB magnitudes) | Broadcast to dongle |
| `0x02` | `MSG_IQ` | Int16Array (interleaved I/Q) | Per-user |
| `0x03` | `MSG_META` | UTF-8 JSON (ServerMeta) | Per-user |
| `0x04` | `MSG_FFT_COMPRESSED` | Uint8Array (0-255 mapped dB) | Broadcast |
| `0x05` | `MSG_AUDIO` | Int16Array (mono PCM) | Per-user |
| `0x06` | `MSG_DECODER` | UTF-8 JSON (decoder output) | Broadcast to dongle |
| `0x07` | `MSG_SIGNAL_LEVEL` | Float32 (dB) | Per-user |

### Client → Server (JSON Text)

```json
{ "cmd": "subscribe", "dongleId": "dongle-0" }
{ "cmd": "tune", "offset": 25000 }
{ "cmd": "mode", "mode": "nfm" }
{ "cmd": "bandwidth", "hz": 12500 }
```

## Build & Run

```bash
npm install                  # Install all workspaces
npm run build                # Build shared → client → server
npm run dev:demo             # Development with simulated signals
npm start                    # Production (requires RTL-SDR hardware)
```

Build order matters: `shared` must build before `server` and `client`.

## Configuration

`config/config.yaml` defines dongles and their profiles. Each profile specifies center frequency, sample rate, FFT size, default demodulation mode, and optional digital decoders. Validated at startup with Zod.

When an admin switches a dongle's active profile, **all connected clients on that dongle are switched automatically**.

## UI Theming

- **Three UI themes**: Default (cyan), CRT (phosphor green), VFD (amber) — switched via `data-theme` attribute
- **Five waterfall color palettes**: turbo, viridis, classic, grayscale, hot — independent of UI theme
- **Tailwind v4**: All theme values defined in `client/src/styles/app.css` using `@theme` directive. No `tailwind.config.js`.

## Common Tasks

- **Add a new demodulation mode**: Add to `DemodMode` type in `shared/src/types.ts`, add info to `DEMOD_MODES` in `shared/src/modes.ts`, implement class in `client/src/engine/demodulators.ts`
- **Add a new digital decoder**: Add to `DigitalMode` type, add info to `DIGITAL_MODES`, add parser function in `server/src/decoder-manager.ts`
- **Add a REST endpoint**: Add route in `server/src/index.ts`
- **Add a UI component**: Create in `client/src/components/`, import in `App.tsx`
- **Change waterfall colors**: Edit `PALETTE_STOPS` in `client/src/engine/palettes.ts`
- **Add a dongle profile**: Edit `config/config.yaml`

## Testing

No test framework is set up yet. Priority areas for testing:
- `shared/src/protocol.ts` — pack/unpack round-trip
- `server/src/fft-processor.ts` — FFT correctness, window functions
- `client/src/engine/demodulators.ts` — demodulator output validation
- `server/src/config.ts` — Zod schema validation edge cases
