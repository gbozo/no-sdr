# AGENTS.md — no-sdr

## What This Is

Multi-user WebSDR. Streams RF spectrum + audio from RTL-SDR dongles to browsers. Server does FFT (shared) + per-client IQ extraction. Client does demodulation + audio. SolidJS frontend, Hono backend, TypeScript throughout.

## Quick Orientation

```
shared/src/          → Types, binary protocol, ADPCM codec (zero deps)
server/src/          → Hono REST/WS, dongle management, FFT, IQ extraction, Opus encode
client/src/engine/   → DSP: demodulators, RDS, noise reduction, audio worklet, renderers
client/src/components/ → SolidJS UI: ControlPanel, WaterfallDisplay, FrequencyDisplay
client/src/styles/   → Tailwind v4 @theme (design tokens in CSS, no JS config)
config/config.yaml   → Dongle + profile definitions (Zod validated)
```

## Architecture (data flow)

```
Dongle (uint8 IQ @ 2.4 MSPS)
  ├─► FftProcessor (1× per dongle) → Float32 dB → codec encode → broadcast to all clients
  └─► IqExtractor (1× per client) → NCO + Butterworth + decimate → Int16 sub-band
        ├─► ADPCM/raw → client demod (FM/AM/SSB/CW/SAM/C-QUAM) → audio
        └─► OpusAudioPipeline → server demod + Opus encode → client decode → audio
```

## Key Files (by responsibility)

| File | What it does | Hot path? |
|------|-------------|-----------|
| `server/src/ws-manager.ts` | Routes IQ/FFT to clients, codec dispatch, backpressure | YES — `_handleIqDataAsync()` is the main loop |
| `server/src/fft-processor.ts` | FFT (fft.js radix-4), windowing, rate cap, averaging | YES — runs per IQ chunk |
| `server/src/iq-extractor.ts` | Per-client NCO + 4th-order Butterworth + decimation | YES — O(clients) per chunk |
| `server/src/opus-audio.ts` | Server-side FM/AM/SSB demod + Opus WASM encode | YES — per opus-client |
| `server/src/dongle-manager.ts` | Dongle lifecycle: local/rtl_tcp/airspy/hfp/rsp/demo | Startup + profile switch |
| `client/src/engine/sdr-engine.ts` | Client orchestrator (87 methods, god object) | Dispatches all client work |
| `client/src/engine/demodulators.ts` | All demod classes: FM stereo, AM, C-QUAM, SAM, SSB, CW | Per audio frame |
| `client/src/engine/audio.ts` | AudioWorklet + 5-band EQ + jitter buffer | Per audio frame |
| `shared/src/protocol.ts` | Binary WS protocol: pack/unpack, codec helpers | Every WS message |
| `shared/src/adpcm.ts` | IMA-ADPCM encoder/decoder (4:1 lossy) | Every IQ/FFT frame |

## Performance Profile

- **Server CPU at 29%** (1 dongle, 2.4 MSPS, FFT 65536, 30fps)
- **Main bottleneck**: `_handleIqDataAsync()` runs sync IQ extraction for all clients, then async FFT deflate
- **Client offloads**: FFT decode in Web Worker, waterfall rendering in OffscreenCanvas Worker
- **Planned**: worker_threads for IqExtractor + OpusAudioPipeline (per-client, no shared state)

## Binary Protocol (Server → Client)

| Byte | Name | Payload |
|------|------|---------|
| `0x04` | FFT_COMPRESSED | Int16 min + Int16 max + Uint8[N] |
| `0x08` | FFT_ADPCM | ADPCM on Int16(dB×100) |
| `0x0B` | FFT_DEFLATE | Int16 min + Int16 max + Uint32 N + deflate bytes (DEFAULT) |
| `0x02` | IQ | Int16Array (raw) |
| `0x09` | IQ_ADPCM | Uint32 sampleCount + ADPCM bytes (DEFAULT) |
| `0x0C` | AUDIO_OPUS | Uint16 samples + Uint8 channels + Opus packet |

Client → Server: JSON text (`subscribe`, `tune`, `mode`, `bandwidth`, `codec`, `audio_enabled`)

## Build & Dev

```bash
npm install && npm run build       # shared → client → server (order matters)
npm run dev:demo                   # Dev mode with simulated signals (no hardware)
npm run dev                        # Dev mode with real RTL-SDR
```

Dev runs 3 processes: shared tsc watch, server tsx (port 3000), client vite (port 3001, proxies /ws and /api to 3000).

## Common Modifications

| Task | Files to touch |
|------|---------------|
| New demod mode | `shared/types.ts` + `shared/modes.ts` + `client/engine/demodulators.ts` + `server/iq-extractor.ts` + `server/opus-audio.ts` + `client/components/ControlPanel.tsx` |
| New codec | `shared/protocol.ts` + `server/ws-manager.ts` + `client/engine/sdr-engine.ts` + `client/components/ControlPanel.tsx` |
| New REST endpoint | `server/src/index.ts` |
| New UI panel | `client/src/components/` + import in `App.tsx` |
| New source type | `shared/types.ts` + `server/dongle-manager.ts` |

## Design System

- Dark blue-black background (`#07090e` → `#1a2435`)
- Single accent variable `--sdr-accent`: cyan (default) / green (CRT) / amber (VFD)
- Military/aviation button aesthetic (`.mil-btn`): beveled, LED indicator, matte gradient
- Monospace everywhere (JetBrains Mono), uppercase + tracking on labels
- Tailwind v4 with `@theme` in `client/src/styles/app.css`
- See `DESIGN.md` for full token reference

## Git Rules

1. **Never commit/push** unless explicitly instructed
2. **"Wrap up"** = update TODO.md + commit + push (no release)
3. Commit format: `<type>(<scope>): <summary>` (feat/fix/refactor/chore/docs/test/perf)

## Known Issues

- Spectral NR (Wiener) has robotic artifacts on tonal signals — LMS ANR is the recommended alternative
- `opusscript` is CJS-only — loaded via `createRequire(import.meta.url)` in ESM context
- SdrEngine is a god object (87 methods) — rendering and audio coordination are extraction candidates

## graphify

Knowledge graph at `graphify-out/` (869 nodes, 1221 edges, 41 communities).

- Read `graphify-out/GRAPH_REPORT.md` before answering architecture questions
- Use `graphify query "<question>"` / `graphify path "<A>" "<B>"` for cross-module tracing
- After modifying code, run `graphify update .` (AST-only, no API cost)
- God nodes: SdrEngine(87), DongleManager(32), WebSocketManager(28), AudioEngine(21)
