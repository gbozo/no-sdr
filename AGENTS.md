# AGENTS.md — no-sdr

## What This Is

Multi-user WebSDR. Streams RF spectrum + audio from RTL-SDR dongles to browsers.

Rust backend (`serverrs/`, axum + tokio + rustfft). It does FFT (shared) +
per-client IQ extraction + optional server-side demod/Opus. The
SolidJS/TypeScript client does demodulation + audio rendering.

The original Go backend was removed from this branch; `serverrs/` is now the
only server implementation.

## Quick Orientation

```
serverrs/              → Rust backend (axum, tokio, rustfft; features `opus`, `rtlsdr`, `bias-t`)
  src/api/             → axum REST/admin router, bandplan, identify/recognizer, bookmarks
  src/ws/              → WebSocket protocol, client state, manager, rate limiting
  src/dsp/             → rustfft FFT, IQ extractor, NCO, FIR, decimation, IQ correction
  src/demod/           → FM mono/stereo+RDS, AM, SSB, CW, SAM, C-QUAM
  src/dongle/          → demo/rtl_tcp/native rtlsdr/manager/Opus/recorder/notifications
    rtlsdr/            → native RTL2832U + R82xx USB driver (nusb)
  src/codec/           → ADPCM, deflate (zlib-rs), Opus (feature gated)
  src/config.rs        → YAML config + defaults/validation/version
  bands/               → embedded band plans (bands.json, bands-r1..r3.json)
client/src/shared/     → Protocol constants, binary codec, types, modes, ADPCM decoder
client/src/engine/     → DSP: demodulators, RDS, noise reduction, audio worklet, renderers
client/src/components/ → SolidJS UI: ControlPanel, WaterfallDisplay, FrequencyDisplay
client/src/admin/      → Admin page: AdminPage, admin-store, sections/
client/src/store/      → SolidJS reactive state
client/src/styles/     → Tailwind v4 @theme (design tokens in CSS, no JS config)
config/config.yaml     → Dongle + profile definitions
packaging/             → portable release archive builder + launchers + udev rule
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

`serverrs/src/dongle/manager.rs` owns the dongle loop. Optional
`iqCorrection` runs on the raw device stream before recording/FFT/client
pipelines.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust 1.85+, axum 0.8, tokio, rustfft, serde, tracing |
| Native USB | `nusb` (pure Rust; no librtlsdr/libusb) |
| Frontend | SolidJS, TypeScript, Vite, Tailwind v4 |
| Shared types | TypeScript, merged into `client/src/shared/` |
| Build | npm workspaces (client), Cargo crate (serverrs) |
| Dev reload | Vite HMR (client), concurrently; Rust runs as a normal process |
| Config | YAML; `serverrs/src/config.rs` |
| Optional deps | libopus (`opus`); native RTL-SDR (`rtlsdr`); bias-T (`bias-t`). All three are default Cargo features |

## Key Files (by responsibility)

| File | What it does | Hot path? |
|------|-------------|-----------|
| `serverrs/src/dongle/manager.rs` | Dongle lifecycle, client pipelines, FFT broadcast | YES |
| `serverrs/src/dsp/fft_processor.rs` | rustfft wrapper, windowing, rate cap, averaging | YES |
| `serverrs/src/dsp/iq_extractor.rs` | Rust NCO + Butterworth + polyphase decimation | YES |
| `serverrs/src/dsp/iq_correct.rs` | DC blocker + I/Q imbalance correction | YES (optional) |
| `serverrs/src/dongle/rtlsdr/` | Native RTL2832U USB driver (nusb) + source, feature `rtlsdr` | Per dongle |
| `serverrs/src/demod/fm.rs` | Server-side FM demodulator (stereo + RDS) | Per Opus-client |
| `serverrs/src/dongle/opus_pipeline.rs` | Server-side demod + Opus encode per client | Per Opus-client |
| `serverrs/src/codec/adpcm.rs` | IMA-ADPCM encoder/decoder (4:1 lossy) | Every IQ/FFT frame |
| `serverrs/src/ws/manager.rs` | WS lifecycle, broadcast, aggregate traffic stats | YES |
| `serverrs/src/ws/protocol.rs` | Binary WS protocol: pack/unpack, message types, client commands | Every WS message |
| `serverrs/src/api/router.rs` | axum routes, admin API, static SPA, WebSocket upgrade | Request handler |
| `client/src/engine/sdr-engine.ts` | Client orchestrator (god object) | Dispatches all client work |
| `client/src/engine/demodulators.ts` | All demod classes: FM stereo, AM, C-QUAM, SAM, SSB, CW | Per audio frame |
| `client/src/engine/audio.ts` | AudioWorklet + 5-band EQ + jitter buffer | Per audio frame |
| `client/src/shared/protocol.ts` | Binary WS protocol: client-side pack/unpack, codec helpers | Every WS message |
| `client/src/shared/adpcm.ts` | IMA-ADPCM decoder (TypeScript, browser-side) | Every IQ/FFT frame |

## GPU Acceleration (planned)

Offload DSP to GPU via Vulkan + VkFFT for CPU core liberation and higher
throughput. The original design notes were written against the former Go
backend and live in `docs/gpu-offload-plan.md`; the Rust implementation will
live under `serverrs/src/gpu/` behind a `gpu_vulkan` feature.

| Operation | GPU Library | Per-Client | Priority |
|-----------|-------------|------------|----------|
| FFT (65536 @ 30fps) | VkFFT | No (shared) | **Critical** |
| Butterworth LPF (4th-order) | Vulkan Compute Shader | Yes | High |
| NCO Frequency Shift | Vulkan Compute Shader | Yes | High |
| Decimation (integer) | Vulkan Compute Shader | Yes | High |
| FM Stereo FIR (2×51-tap) | Vulkan Compute Shader | Yes | **Critical** |

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
npm install                        # Install client deps
npm run build                      # client tsc/vite → cargo release build (order matters)
npm run dev                        # Dev: Rust server (port 3000) + Vite (port 3001, proxies to 3000)
npm run dev:demo                   # Dev with simulated signals (no hardware needed)
```

### Rust commands

```bash
npm run test:rust                  # cargo test (all default features)
npm run build:rust                 # release build (all default features)
npm run build:rust:opus            # minimal build, server-side Opus only
npm run build:rust:full            # release build with --all-features
npm run build:rust:native          # --all-features with target-cpu=native
npm run start:rust                 # run built Rust binary
npm run start:rust:demo            # demo source, no hardware
```

Manual:
```bash
cd serverrs
cargo test                          # default features (opus + rtlsdr + bias-t)
cargo test --no-default-features    # dependency-free
cargo build --release               # full binary
cargo run --example rtlsdr_probe    # hardware smoke test
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
| New demod mode | `serverrs/src/config.rs` + `serverrs/src/demod/` + `serverrs/src/dongle/opus_pipeline.rs`; client `demodulators.ts`, `client/src/shared/{types,modes}.ts`, `ControlPanel.tsx` |
| New codec | `serverrs/src/ws/protocol.rs` + `serverrs/src/codec/` + `serverrs/src/dongle/manager.rs`; `client/src/shared/protocol.ts` + `sdr-engine.ts` |
| New REST endpoint | `serverrs/src/api/router.rs` |
| New admin endpoint | `serverrs/src/api/admin.rs` |
| New UI panel | `client/src/components/` + import in `App.tsx` |
| New dongle source | `serverrs/src/dongle/source.rs` trait + `<source>.rs`, wire into `create_source` |
| New native SDR driver | `serverrs/src/dongle/<radio>/` (nusb; model on `rtlsdr/`), wire into `manager.rs` |
| Config changes | `serverrs/src/config.rs` + `config/config.yaml` |
| DSP block | `serverrs/src/dsp/` (`ProcessorBlock` trait) |

## Design System

- Dark blue-black background (`#07090e` → `#1a2435`)
- Single accent variable `--sdr-accent`: cyan (default) / green (CRT) / amber (VFD)
- Military/aviation button aesthetic (`.mil-btn`): beveled, LED indicator, matte gradient
- Monospace everywhere (JetBrains Mono), uppercase + tracking on labels
- Tailwind v4 with `@theme` in `client/src/styles/app.css`
- See `DESIGN.md` for full token reference

## Rust Package Conventions

- Modules: `serverrs/src/{config,codec,dsp,demod,ws,dongle,api}`.
- Wire formats and JSON field names must stay byte-compatible with
  `client/src/shared/protocol.ts`.
- Hot paths avoid allocation: preallocated buffers, slices, and `rustfft`
  plans are reused.
- Feature flags gate optional deps: `opus` (libopus via `audiopus_sys`),
  `rtlsdr` (native RTL2832U via `nusb`, no C library) and `bias-t` (bias-T
  GPIO support, implies `rtlsdr`). All are **enabled by default**; use
  `--no-default-features` for a dependency-free build and add features back
  explicitly. All release targets build with `--all-features`.
- `cargo test` runs the full default-feature suite; `cargo test
  --no-default-features` verifies the dependency-free stub build;
  `--no-default-features --features opus` covers Opus-only platforms, and
  `--features "rtlsdr bias-t"` covers the native USB driver without libopus.
- In this environment use `CARGO_HOME=/home/opencode/.cargo` for Cargo.
- Binary/CI releases are built by GitHub Actions (`Rust Binaries`,
  `Docker Publish`). Pushes to `main` publish `latest` and `main`; releases add
  plain semver tags, with historical `<version>-rust` / `latest-rust` aliases.
- CI caching: native binary jobs use `sccache` + `Swatinem/rust-cache`
  (crates only; compilation objects are shared via sccache). The Docker
  workflow builds amd64 and arm64 on native runners with per-architecture
  GHA layer caches, then merges the digests into one manifest.

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

Knowledge graph at `graphify-out/`.

- Read `graphify-out/GRAPH_REPORT.md` before answering architecture questions
- Use `graphify query "<question>"` / `graphify path "<A>" "<B>"` for cross-module tracing
- After modifying code, run `graphify update .` (AST-only, no API cost)
- God nodes: SdrEngine (client), DongleManager (`serverrs`)
