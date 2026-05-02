# AGENTS.md — no-sdr

## What This Is

Multi-user WebSDR. Streams RF spectrum + audio from RTL-SDR dongles to browsers. Go backend does FFT (shared) + per-client IQ extraction + optional server-side demod/Opus. SolidJS/TypeScript client does demodulation + audio rendering.

## Quick Orientation

```
serverng/              → Go backend (chi router, WebSocket, DSP pipeline, dongle management)
  cmd/serverng/        → Entrypoint (main.go)
  internal/api/        → chi REST router + admin endpoints + static file serving
  internal/ws/         → WebSocket manager, binary protocol, backpressure, rate limiting
  internal/dsp/        → FFT, IQ extraction, NCO, Butterworth, decimation, noise blanker, pipeline
  internal/demod/      → Server-side demodulators (FM, AM, SSB, CW, SAM, C-QUAM, RDS)
  internal/codec/      → ADPCM, deflate, Opus (build-tag gated), FFT compression
  internal/dongle/     → Dongle lifecycle: demo/rtl_tcp/rtlsdr(cgo)/airspy/hfp/rsp + Opus pipeline
  internal/config/     → YAML config loader + validation
  internal/history/    → FFT history ring buffer (waterfall backfill)
shared/src/            → TypeScript types, binary protocol codec, ADPCM codec (zero deps)
client/src/engine/     → DSP: demodulators, RDS, noise reduction, audio worklet, renderers
client/src/components/ → SolidJS UI: ControlPanel, AdminModal, WaterfallDisplay, FrequencyDisplay
client/src/store/      → SolidJS reactive state
client/src/styles/     → Tailwind v4 @theme (design tokens in CSS, no JS config)
config/config.yaml     → Dongle + profile definitions (validated by Go config package)
```

## Architecture (data flow)

```
Dongle (uint8 IQ @ 2.4 MSPS)
  ├─► FftProcessor (1× per dongle, Go) → Float32 dB → codec encode → broadcast all clients
  └─► IqExtractor (1× per client, Go) → NCO + Butterworth + decimate → Int16 sub-band
        ├─► ADPCM/raw → WS → client demod (FM/AM/SSB/CW/SAM/C-QUAM) → audio
        └─► OpusPipeline (Go) → server demod + Opus encode → WS → client decode → audio
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.23, chi/v5 router, coder/websocket, slog structured logging |
| Frontend | SolidJS, TypeScript, Vite, Tailwind v4 |
| Shared types | TypeScript (npm workspace `shared/`) |
| Build | npm workspaces (shared + client), Go binary (serverng) |
| Dev reload | Air (Go hot reload), Vite HMR (client), concurrently |
| Config | YAML (gopkg.in/yaml.v3), validated by `internal/config` |
| Optional deps | libopus (build tag `opus`), librtlsdr (build tag `rtlsdr`) |

## Key Files (by responsibility)

| File | What it does | Hot path? |
|------|-------------|-----------|
| `serverng/internal/dongle/manager.go` | Dongle lifecycle, per-client IQ pipeline orchestration, FFT broadcast | YES — main data loop (1571 lines) |
| `serverng/internal/dsp/fft_processor.go` | FFT (radix-4), windowing, rate cap, exponential averaging | YES — runs per IQ chunk |
| `serverng/internal/dsp/iq_extractor.go` | Per-client NCO + 4th-order Butterworth + decimation pipeline | YES — O(clients) per chunk |
| `serverng/internal/ws/manager.go` | WS connection lifecycle, broadcast, backpressure, stale-client cleanup | YES — every WS frame |
| `serverng/internal/ws/protocol.go` | Binary WS protocol: pack/unpack, message types, client commands | Every WS message |
| `serverng/internal/demod/fm.go` | Server-side FM demodulator (stereo + RDS) | Per Opus-client |
| `serverng/internal/dongle/opus_pipeline.go` | Server-side demod + Opus encode per client | Per Opus-client |
| `serverng/internal/codec/adpcm.go` | IMA-ADPCM encoder/decoder (4:1 lossy) | Every IQ/FFT frame |
| `serverng/internal/api/router.go` | chi REST routes, WS upgrade, admin API, CORS | Request handler |
| `client/src/engine/sdr-engine.ts` | Client orchestrator (god object) | Dispatches all client work |
| `client/src/engine/demodulators.ts` | All demod classes: FM stereo, AM, C-QUAM, SAM, SSB, CW | Per audio frame |
| `client/src/engine/audio.ts` | AudioWorklet + 5-band EQ + jitter buffer | Per audio frame |
| `shared/src/protocol.ts` | Binary WS protocol: client-side pack/unpack, codec helpers | Every WS message |
| `shared/src/adpcm.ts` | IMA-ADPCM decoder (TypeScript, browser-side) | Every IQ/FFT frame |

## Binary Protocol (Server → Client)

| Byte | Name | Payload |
|------|------|---------|
| `0x01` | FFT | Float32Array (dB magnitudes) |
| `0x04` | FFT_COMPRESSED | Int16(minDb) + Int16(maxDb) + Uint8[N] |
| `0x08` | FFT_ADPCM | ADPCM on Int16(dB×100) |
| `0x0B` | FFT_DEFLATE | Int16(minDb) + Int16(maxDb) + Uint32(binCount) + deflate bytes (DEFAULT) |
| `0x0D` | FFT_HISTORY | Waterfall history burst |
| `0x02` | IQ | Int16Array (raw interleaved I/Q) |
| `0x09` | IQ_ADPCM | Uint32(sampleCount) + ADPCM bytes (DEFAULT) |
| `0x0C` | AUDIO_OPUS | Uint16(sampleCount) + Uint8(channels) + Opus packet |
| `0x03` | META | UTF-8 JSON (ServerMeta) |
| `0x05` | AUDIO | Int16Array mono samples |
| `0x06` | DECODER | JSON-encoded decoder messages |
| `0x07` | SIGNAL_LEVEL | Float32 dB value |
| `0x0A` | RDS | UTF-8 JSON (RDS data) |

Client → Server: JSON text commands (`subscribe`, `tune`, `mode`, `bandwidth`, `codec`, `audio_enabled`, etc.)

## Build & Dev

```bash
npm install                        # Install shared + client deps
npm run build                      # shared tsc → client vite → go build (order matters)
npm run dev                        # Dev: shared build + Air (Go, port 3000) + Vite (port 3001, proxies to 3000)
npm run dev:demo                   # Dev with simulated signals (no hardware needed)
```

### Go-specific commands

```bash
npm run build:go                   # CGO_ENABLED=0 (no opus, no rtlsdr)
npm run build:go:opus              # With Opus support (needs libopus)
npm run build:go:full              # With Opus + RTL-SDR native (needs both libs)
npm run build:go:all               # Cross-compile linux-amd64/arm64 + darwin-arm64
npm run test:go                    # go test ./...
npm run bench:go                   # Benchmark DSP, demod, codec packages
```

### Production

```bash
npm run start                      # Run built binary (serves static + API on port 3000)
npm run start:demo                 # Same but demo mode (simulated signals)
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONFIG_PATH` | `../config/config.yaml` | Path to YAML config |
| `STATIC_DIR` | `../client/dist` | Path to built client assets |
| `NODE_SDR_DEMO` | unset | Set to `1` to force demo mode |

## Common Modifications

| Task | Files to touch |
|------|---------------|
| New demod mode | `serverng/internal/config/config.go` (validModes) + `serverng/internal/demod/` (new file) + `serverng/internal/dongle/opus_pipeline.go` + `client/src/engine/demodulators.ts` + `shared/src/types.ts` + `shared/src/modes.ts` + `client/src/components/ControlPanel.tsx` |
| New codec | `serverng/internal/ws/protocol.go` + `serverng/internal/codec/` (new file) + `serverng/internal/dongle/manager.go` + `shared/src/protocol.ts` + `client/src/engine/sdr-engine.ts` |
| New REST endpoint | `serverng/internal/api/router.go` |
| New admin endpoint | `serverng/internal/api/admin.go` |
| New UI panel | `client/src/components/` + import in `App.tsx` |
| New dongle source | `serverng/internal/dongle/source.go` (interface) + new `serverng/internal/dongle/<source>.go` + `serverng/internal/config/config.go` |
| Config changes | `serverng/internal/config/config.go` + `config/config.yaml` |
| DSP block | `serverng/internal/dsp/` (implement `ProcessorBlock` interface) |

## Design System

- Dark blue-black background (`#07090e` → `#1a2435`)
- Single accent variable `--sdr-accent`: cyan (default) / green (CRT) / amber (VFD)
- Military/aviation button aesthetic (`.mil-btn`): beveled, LED indicator, matte gradient
- Monospace everywhere (JetBrains Mono), uppercase + tracking on labels
- Tailwind v4 with `@theme` in `client/src/styles/app.css`
- See `DESIGN.md` for full token reference

## Go Package Conventions

- All server packages live under `serverng/internal/` (unexported outside module)
- DSP code uses pre-allocated buffers and avoids allocation in hot paths
- Build tags gate optional C deps: `opus` (libopus), `rtlsdr` (librtlsdr)
- Stub files (`opus_stub.go`, `rtlsdr_stub.go`) provide fallbacks when tags are absent
- Tests use `_test.go` suffix; benchmarks in `bench_test.go`
- Structured logging via `log/slog` everywhere

## Git Rules

1. **Never commit or push** unless explicitly instructed in that message (e.g. "commit", "commit and push"). Working on code does NOT imply permission to commit.
2. **"Wrap up"** is the only shorthand: update TODO.md with changes → `git commit` → `git push`. No release.
3. **Never create a GitHub release** unless separately instructed.
4. Commit format: `<type>(<scope>): <summary>` (feat/fix/refactor/chore/docs/test/perf)

## Known Issues

- Spectral NR (Wiener) has robotic artifacts on tonal signals — LMS ANR is the recommended alternative
- SdrEngine client-side is a god object — rendering and audio coordination are extraction candidates
- `opusscript` (Node.js CJS) is no longer used — replaced by Go `hraban/opus.v2` (build-tag gated)
- The old `server/` directory (Node.js/Hono backend) has been removed; all backend is now in `serverng/`

## graphify

Knowledge graph at `graphify-out/` (869 nodes, 1221 edges, 41 communities).

- Read `graphify-out/GRAPH_REPORT.md` before answering architecture questions
- Use `graphify query "<question>"` / `graphify path "<A>" "<B>"` for cross-module tracing
- After modifying code, run `graphify update .` (AST-only, no API cost)
- God nodes: SdrEngine (client), DongleManager (server, 1571 lines)
