# AGENTS.md — no-sdr

## What This Is

Multi-user WebSDR. Streams RF spectrum + audio from RTL-SDR dongles to browsers.

Two interchangeable backends share the same wire protocol and REST API:

- `serverng/` — Go backend (reference implementation, production on `main`).
- `serverrs/` — Rust backend (active port on branch `rustport`, release 2.11.6).

Both do FFT (shared) + per-client IQ extraction + optional server-side
demod/Opus. The SolidJS/TypeScript client does demodulation + audio rendering.

## Quick Orientation

```
serverrs/              → Rust backend (axum, tokio, rustfft; features `opus`, `rtlsdr`)
  src/api/             → axum REST/admin router, bandplan, identify/recognizer, bookmarks
  src/ws/              → WebSocket protocol, client state, manager, rate limiting
  src/dsp/             → rustfft FFT, IQ extractor, NCO, FIR, decimation, IQ correction
  src/demod/           → FM mono/stereo+RDS, AM, SSB, CW, SAM, C-QUAM
  src/dongle/          → demo/rtl_tcp/local rtlsdr/manager/Opus/recorder/notifications
  src/codec/           → ADPCM, deflate (zlib-rs), Opus (feature gated)
  src/config.rs        → YAML config + defaults/validation/version
  bands/               → embedded band plans
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
  internal/gpu/        → GPU offload: VkFFT + Vulkan compute shaders (planned)
client/src/shared/     → Protocol constants, binary codec, types, modes, ADPCM decoder
client/src/engine/     → DSP: demodulators, RDS, noise reduction, audio worklet, renderers
client/src/components/ → SolidJS UI: ControlPanel, WaterfallDisplay, FrequencyDisplay
client/src/admin/      → Admin page: AdminPage, admin-store, sections/
client/src/store/      → SolidJS reactive state
client/src/styles/     → Tailwind v4 @theme (design tokens in CSS, no JS config)
config/config.yaml     → Dongle + profile definitions (shared by Go/Rust config layers)
packaging/             → portable release archive builder + launchers
docker/Dockerfile.rust → multi-CPU Rust image (amd64 v1-v4, arm64 Pi cores)
```

## Architecture (data flow)

```
Dongle (uint8 IQ @ 2.4 MSPS, demo/rtl_tcp/local USB)
  ├─► FftProcessor (1× per dongle) → Float32 dB → codec encode → broadcast all clients
  └─► IqExtractor (1× per client) → NCO + Butterworth + decimate → Int16 sub-band
        ├─► ADPCM/raw → WS → client demod (FM/AM/SSB/CW/SAM/C-QUAM) → audio
        └─► OpusPipeline → server demod + Opus encode → WS → client decode → audio
```

The Rust pipeline is the same shape; `serverrs/src/dongle/manager.rs` owns the
dongle loop. Optional `iqCorrection` runs on the raw device stream before
recording/FFT/client pipelines.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend (Go) | Go 1.23, chi/v5 router, coder/websocket, slog structured logging |
| Backend (Rust) | Rust 1.82+, axum 0.8, tokio, rustfft, serde, tracing |
| Frontend | SolidJS, TypeScript, Vite, Tailwind v4 |
| Shared types | TypeScript, merged into `client/src/shared/` |
| Build | npm workspaces (client), Go binary (serverng), Cargo crate (serverrs) |
| Dev reload | Air (Go), Vite HMR (client), concurrently; Rust runs as a normal process |
| Config | YAML; Go `internal/config`, Rust `serverrs/src/config.rs` |
| Optional deps | libopus (`opus`), librtlsdr (`rtlsdr`); both are default Cargo features |

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
| `client/src/shared/protocol.ts` | Binary WS protocol: client-side pack/unpack, codec helpers | Every WS message |
| `client/src/shared/adpcm.ts` | IMA-ADPCM decoder (TypeScript, browser-side) | Every IQ/FFT frame |
| `serverrs/src/dongle/manager.rs` | Rust dongle lifecycle, client pipelines, FFT broadcast | YES |
| `serverrs/src/dsp/fft_processor.rs` | rustfft wrapper, windowing, rate cap, averaging | YES |
| `serverrs/src/dsp/iq_extractor.rs` | Rust NCO + Butterworth + polyphase decimation | YES |
| `serverrs/src/dsp/iq_correct.rs` | DC blocker + I/Q imbalance correction | YES (optional) |
| `serverrs/src/dongle/rtlsdr.rs` | Direct USB RTL-SDR source (feature `rtlsdr`) | Per dongle |
| `serverrs/src/ws/manager.rs` | Rust WS lifecycle, broadcast, aggregate traffic stats | YES |
| `serverrs/src/api/router.rs` | axum routes, admin API, static SPA, WebSocket upgrade | Request handler |

## GPU Acceleration (planned)

Offload DSP to GPU via Vulkan + VkFFT for CPU core liberation and higher throughput.

### Operations to Offload

| Operation | GPU Library | Per-Client | Priority |
|-----------|-------------|------------|----------|
| FFT (65536 @ 30fps) | VkFFT | No (shared) | **Critical** |
| Butterworth LPF (4th-order) | Vulkan Compute Shader | Yes | High |
| NCO Frequency Shift | Vulkan Compute Shader | Yes | High |
| Decimation (integer) | Vulkan Compute Shader | Yes | High |
| FM Stereo FIR (2×51-tap) | Vulkan Compute Shader | Yes | **Critical** |

### Hardware Tiers

| Tier | Hardware | FFT Speedup | Primary Benefit |
|------|----------|-------------|-----------------|
| 1 | Intel UHD 630, AMD Vega 8 | 1.5–3× | CPU core liberation |
| 2 | AMD 680M/780M, Intel Xe | 3–5× | Real throughput gains |
| 3 | RTX 3060+, RX 6700+ | 5–10× | Many clients |

### Why Vulkan + VkFFT

- **Cross-platform:** Nvidia, AMD, Intel, Apple, Pi4
- **AMD APU benefit:** Vulkan 60% faster than ROCm (VRAM+GTT ~88GB vs VRAM only ~48GB)
- **VkFFT:** MIT license, header-only, runtime kernel generation

### Implementation Phases

1. `serverng/internal/gpu/` — Vulkan device detection, CPU fallback
2. FFT via VkFFT (drop-in replacement)
3. IQ DSP — Butterworth + NCO + Decimate shaders
4. FM Stereo FIR shader
5. Multi-client batching with command buffers

### Dependencies

```yaml
required:
  - github.com/DTolm/VkFFT  # MIT, header-only via CGO
  - vulkan-sdk >= 1.2
build: go build -tags gpu_vulkan ./cmd/serverng
```

Full plan: `docs/gpu-offload-plan.md`

## Binary Protocol (Server → Client)

| Byte | Name | Payload |
|------|------|---------|
| `0x01` | FFT | Float32Array (dB magnitudes) |
| `0x04` | FFT_COMPRESSED | Int16(minDb) + Int16(maxDb) + Uint8[N] |
| `0x08` | FFT_ADPCM | ADPCM on Int16(dB×100) |
| `0x0B` | FFT_DEFLATE | Int16(minDb) + Int16(maxDb) + Uint32(binCount) + deflate bytes (DEFAULT) |
| `0x0D` | FFT_HISTORY | Waterfall history burst |
| `0x02` | IQ | Uint32(sampleRate) + Uint8(channels=2) + Uint8(reserved) + Int16 interleaved I/Q |
| `0x09` | IQ_ADPCM | Uint32(sampleCount) + Uint32(sampleRate) + Uint8(channels=2) + Uint8(reserved) + ADPCM bytes (DEFAULT) |
| `0x0C` | AUDIO_OPUS | Uint16(sampleCount) + Uint8(channels) + Opus packet |
| `0x03` | META | UTF-8 JSON (ServerMeta) |
| `0x05` | AUDIO | Int16Array mono samples |
| `0x06` | DECODER | JSON-encoded decoder messages |
| `0x07` | SIGNAL_LEVEL | Float32 dB value |
| `0x0A` | RDS | UTF-8 JSON (RDS data: ps, rt, ptyName, pi, pty, synced, optional clock) |

Client → Server: JSON text commands (`subscribe`, `tune`, `mode`, `bandwidth`, `codec`, `audio_enabled`, `stereo_enabled`, etc.)

`META` (0x03) also carries `server_stats` every 2 s:
`{cpuPercent, memMb, clients, wsBytesPerSec}` — `wsBytesPerSec` is the
aggregate outbound WebSocket rate for all connected clients.

RDS JSON may include `clock` (group 4A): `{year, month, day, hour, minute, offsetHalfHours}`.

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

### Rust-specific commands

```bash
npm run test:rust                  # cargo test (default features)
npm run build:rust                 # release build
npm run build:rust:opus            # + server-side Opus (needs libopus)
npm run build:rust:full            # + Opus + direct USB rtlsdr (needs libopus/librtlsdr)
npm run start:rust                 # run built Rust binary
npm run start:rust:demo            # demo source, no hardware
```

Manual:
```bash
cd serverrs
cargo test                          # default features (opus + rtlsdr)
cargo test --no-default-features    # dependency-free
cargo build --release               # full binary
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
| New demod mode | Both backends: `serverng/internal/config/config.go` + `serverng/internal/demod/` + `serverng/internal/dongle/opus_pipeline.go`; `serverrs/src/config.rs` + `serverrs/src/demod/` + `serverrs/src/dongle/opus_pipeline.rs`; client `demodulators.ts`, `client/src/shared/{types,modes}.ts`, `ControlPanel.tsx` |
| New codec | Both: `serverng/internal/ws/protocol.go` + `codec/` + `dongle/manager.go`; `serverrs/src/ws/protocol.rs` + `codec/` + `dongle/manager.rs`; `client/src/shared/protocol.ts` + `sdr-engine.ts` |
| New REST endpoint | `serverng/internal/api/router.go` and `serverrs/src/api/router.rs` |
| New admin endpoint | `serverng/internal/api/admin.go` and `serverrs/src/api/admin.rs` |
| New UI panel | `client/src/components/` + import in `App.tsx` |
| New dongle source | Go: `serverng/internal/dongle/source.go` + `<source>.go`; Rust: `serverrs/src/dongle/source.rs` trait + `<source>.rs`, wire into `create_source` |
| Config changes | `serverng/internal/config/config.go` + `serverrs/src/config.rs` + `config/config.yaml` |
| DSP block | Go `serverng/internal/dsp/`; Rust `serverrs/src/dsp/` (`ProcessorBlock` trait) |

## Design System

- Dark blue-black background (`#07090e` → `#1a2435`)
- Single accent variable `--sdr-accent`: cyan (default) / green (CRT) / amber (VFD)
- Military/aviation button aesthetic (`.mil-btn`): beveled, LED indicator, matte gradient
- Monospace everywhere (JetBrains Mono), uppercase + tracking on labels
- Tailwind v4 with `@theme` in `client/src/styles/app.css`
- See `DESIGN.md` for full token reference

## Rust Package Conventions

- Modules mirror Go packages: `serverrs/src/{config,codec,dsp,demod,ws,dongle,api}`.
- Wire formats and JSON field names must stay byte-compatible with the Go
  backend and `client/src/shared/protocol.ts`.
- Hot paths avoid allocation: preallocated buffers, slices, and `rustfft`
  plans are reused.
- Feature flags gate native deps: `opus` (libopus via `audiopus_sys`) and
  `rtlsdr` (librtlsdr). Both are **enabled by default**; use
  `--no-default-features` for a dependency-free build and add features back
  explicitly. macOS/Windows release builds currently use `opus` only because
  librtlsdr is not bundled there.
- `cargo test` runs the full default-feature suite; `cargo test
  --no-default-features` verifies the dependency-free stub build; `cargo test
  --no-default-features --features opus` covers Opus-only platforms.
- In this environment use `CARGO_HOME=/home/opencode/.cargo` for Cargo.
- Binary/CI releases are built by GitHub Actions (`Rust Binaries`,
  `Docker Publish (Rust)`); Docker tags for Rust releases use the
  `<version>-rust` suffix and never `latest`.
- CI caching: native binary jobs use `sccache` + `Swatinem/rust-cache`
  (crates only; compilation objects are shared via sccache). The Docker
  workflow builds amd64 and arm64 on native runners with per-architecture
  GHA layer caches, then merges the digests into one manifest.

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

## Active Work

See [WORK.md](./WORK.md) for the current task backlog and
[rustport.md](./rustport.md) for the Rust port status, verified hardware
results, release packaging and compatibility notes.

## graphify

Knowledge graph at `graphify-out/` (869 nodes, 1221 edges, 41 communities).

- Read `graphify-out/GRAPH_REPORT.md` before answering architecture questions
- Use `graphify query "<question>"` / `graphify path "<A>" "<B>"` for cross-module tracing
- After modifying code, run `graphify update .` (AST-only, no API cost)
- God nodes: SdrEngine (client), DongleManager (server, 1571 lines)
