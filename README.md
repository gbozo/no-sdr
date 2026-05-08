<p align="center">
  <img src="client/public/favicon.svg" width="80" height="80" alt="no-sdr logo" />
</p>

<h1 align="center">no-sdr</h1>

<p align="center">
  <strong>No SDR hardware on your desk? No problem.<br/>Multi-user web receiver with real-time waterfall, stereo FM, and digital mode decoding — all served from Node.js to your browser.</strong>
</p>

<p align="center">
  <a href="https://github.com/gbozo/no-sdr/stargazers"><img src="https://img.shields.io/github/stars/gbozo/no-sdr?style=social" alt="GitHub Stars" /></a>
  &nbsp;
  <a href="https://github.com/gbozo/no-sdr/network/members"><img src="https://img.shields.io/github/forks/gbozo/no-sdr?style=social" alt="Forks" /></a>
  &nbsp;
  <a href="https://github.com/gbozo/no-sdr/watchers"><img src="https://img.shields.io/github/watchers/gbozo/no-sdr?style=social" alt="Watchers" /></a>
</p>

<p align="center">
  <a href="https://github.com/gbozo/no-sdr/actions"><img src="https://img.shields.io/github/actions/workflow/status/gbozo/no-sdr/ci.yml?branch=main&label=build" alt="Build Status" /></a>
  <a href="https://github.com/gbozo/no-sdr/releases"><img src="https://img.shields.io/github/v/release/gbozo/no-sdr?include_prereleases&label=version&color=blue" alt="Version" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/typescript-5-blue" alt="TypeScript 5" />
  <a href="https://github.com/gbozo/no-sdr/blob/main/LICENSE"><img src="https://img.shields.io/github/license/gbozo/no-sdr?color=green" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/RTL--SDR-supported-orange" alt="RTL-SDR" />
  <a href="https://github.com/gbozo/no-sdr/issues"><img src="https://img.shields.io/github/issues/gbozo/no-sdr" alt="Open Issues" /></a>
  <a href="https://github.com/gbozo/no-sdr/pulls"><img src="https://img.shields.io/github/issues-pr/gbozo/no-sdr" alt="Pull Requests" /></a>
  <img src="https://img.shields.io/github/last-commit/gbozo/no-sdr" alt="Last Commit" />
  <img src="https://img.shields.io/github/repo-size/gbozo/no-sdr" alt="Repo Size" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#demo-mode">Demo Mode</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#deployment">Deployment</a> &bull;
  <a href="SPEC.md">Technical Spec</a>
</p>

<p align="center">
  <sub>If you find this project useful, please consider giving it a <a href="https://github.com/gbozo/no-sdr">star on GitHub</a> — it helps others discover it and keeps the motivation flowing! :star:</sub>
</p>

---

<p align="center">
  <img src="screenshots/no(sdr).jpeg" alt="no-sdr interface — waterfall, spectrum analyzer, and stereo FM with RDS" width="100%" />
</p>

**no-sdr** turns cheap RTL-SDR USB dongles into a full-featured web-based radio receiver. Multiple users connect through their browser and independently tune, demodulate, and listen to signals — all sharing the same hardware. No plugins, no installs, just open a URL.

Think of it as your own private, open [WebSDR](http://websdr.org) that you can run at your home pc or on a docker container (compose). Works in Raspberry Pi too. 

This project aims High Fidelity, weak signals processing, near lossless quality, low bandwidth consumption and aims every feature to be run also on arm architecture (RPi/MAC). For x86 four binaries are included and you CPU capability level is detected on container start, processors with streaming extensions (SSE/AVX etc.) have superior performance and each client cosnumes less CPU cycles. All of this open, no closed source. 

There is also an Identify Song button, you can identify the currently song you listen too (you need some API keys for Audd)

*Made with ❤️ and patience, your friend George*

### Codec Performance

<table>
<tr>
<td width="50%"><img src="screenshots/no-sdr-compression.jpeg" alt="no-sdr compression stats" width="100%" /></td>
<td valign="top">

**Waterfall (FFT)**
| Codec | Ratio | Type |
|-------|-------|------|
| **Deflate** | 7.5–10:1 | Lossless (default) |
| ADPCM | ~8:1 | Lossy |

**Audio (IQ / Opus)**
| Codec | Bandwidth | Type |
|-------|-----------|------|
| ADPCM | ~48 KB/s (default) | Lossy 4:1 on IQ |
| **Opus** | ~4 KB/s | VBR 32kbps mono / 64kbps stereo |
| **Opus HQ** | ~16 KB/s | VBR 128kbps mono / 192kbps stereo |

Opus codecs use server-side demodulation with full stereo FM and C-QUAM support. Clients independently select their preferred codec — no restart needed.
A typical HF / AM Profile with sampling rate of 2.4 MBPS , fft size of 4096 buckets with 8 frames per second and deflate compression 8-10 KB/s, with opus mono audio compression ~4 KB/s.
So a total of around 12-13 KB/s per client of bandwidht required with full audio and waterfall, spectrum.
There is also opus lite with almost identical quality of ADPCM at around 2.1KB/s but as always there is a drawback, opus has nasty artifact at this rate (and some nasty robotic hiss).

</td>
</tr>
</table>

## Features

### Radio

- **8 analog demodulation modes** — WFM (stereo, RDS), NFM, AM (stereo), USB, LSB, CW, Raw IQ
- **Stereo FM** — PLL-based 19kHz pilot detection, L-R DSB-SC demodulation with SNR-proportional stereo blend
- **RDS** — client-side FM RDS decoder extracts station name (PS), radio text (RT), programme type, PI code, and clock time with overlay on waterfall
- **AM Stereo (C-QUAM) [EXPERIMENTAL]** — auto-detected in AM mode via two-stage verification (25Hz Goertzel pilot + PLL lock confirmation). When a C-QUAM station is detected, stereo decoding activates automatically. *This feature needs testers with access to C-QUAM AM stereo broadcasts — please report results via GitHub issues!*
- PLANNED -> **9 digital decoders** — ADS-B, ACARS, VDL2, AIS, APRS, POCSAG, FT8, FT4, WSPR (via external binaries)
- **Multi-user** — everyone shares the same waterfall; each user tunes independently within the dongle's bandwidth
- **Multi-dongle** — configure multiple RTL-SDR devices, each with its own frequency profiles
- **Three dongle source types** — local USB (`rtl_sdr`), remote TCP (`rtl_tcp`), or demo simulator
- **Profile system** — admins define presets (FM broadcast, aviation, 2m ham, ADS-B, marine) per dongle; switching a profile changes it for all connected users
- **Profile CRUD** — create, update, and delete profiles at runtime via REST API; changes persist to disk

### Display

- **Live waterfall** — Canvas 2D with 5 color themes (turbo, viridis, classic, grayscale, hot)
- **Auto-range** — automatic dB scaling based on signal statistics, or manual min/max control
- **Spectrum analyzer** — real-time power spectral density with tuning indicator and bandwidth overlay
- **Frequency display** — LCD-style readout with scroll-to-tune digit groups
- **S-meter** — bar or classic analog needle meter with warm backlit face, dual scale (S-units + dB), red needle with peak hold indicator
- **Bandwidth meter** — real-time SVG sparkline showing WebSocket throughput + FFT frame rate
- **3 UI themes** — LCD (cyan), CRT (phosphor green), VFD (amber)

### Audio

- **Client-side DSP** — demodulation runs entirely in the browser via pure TypeScript
- **Stereo output** — stereo FM with SNR-proportional blend, auto-detected C-QUAM AM stereo (experimental)
- **Noise reduction** — spectral subtraction (Wiener filter) + impulse noise blanker with adjustable strength
- **AudioWorklet** — low-latency audio playback with adaptive jitter buffer (150ms min, 200ms target, ±1 sample/frame rate control)
- **5-band parametric EQ** — LOW 80Hz, L-MID 500Hz, MID 1.5kHz, H-MID 4kHz, HIGH 12kHz (all ±12dB)
- **Balance** — stereo pan control (-100% left to +100% right)
- **Loudness** — dynamic compression with pre-boost for quiet signals
- **Squelch** — adjustable noise gate based on signal level, with 500ms bypass after tune changes

### Infrastructure

- **Multi-codec compression** — per-client codec negotiation for both FFT and IQ streams
  - **FFT**: None (Uint8, 4:1), ADPCM (~8:1), Delta+Deflate (7.5–10:1 lossless, default)
  - **IQ**: None (raw Int16), ADPCM (4:1, default), Opus VBR (server-side demod, 32kbps mono / 64kbps stereo), Opus HQ (128kbps mono / 192kbps stereo)
- **Server-side Opus audio** — full WFM stereo PLL and C-QUAM demod on server with dynamic mono↔stereo encoder switching (opusscript WASM)
- **Server-side FFT rate cap** — configurable fps per profile (default 30) with inter-frame averaging
- **IQ chunk accumulation** — server buffers IQ into fixed 20ms chunks for consistent WebSocket messages
- **Client-side resampler** — linear interpolation upsamples SSB (24kHz) and CW (12kHz) to 48kHz
- **WebSocket backpressure** — bufferedAmount-based frame skipping prevents server memory bloat
- **Audio-gated IQ** — server only sends per-user IQ data after client enables audio playback
- **Dongle hardware options** — directSampling, biasT, digitalAgc, offsetTuning, ifGain, tunerBandwidth via config
- **Demo mode** — built-in signal simulator for development and demos, no hardware needed
- **rtl_tcp support** — connect to remote RTL-SDR dongles over TCP (Docker sidecars, remote antennas)
- **Docker ready** — multi-stage Dockerfile with USB passthrough for RTL-SDR, auto-publish to GHCR on release
- **Raspberry Pi compatible** — runs on ARM64, tested on Pi 4/5
- **Admin panel** — start/stop dongles, switch profiles, CRUD profiles, monitor status via REST API + UI
- **YAML config** — validated at startup with Zod schemas, persisted on admin changes
- **Per-client IQ extraction** — server-side NCO frequency shift + 4th-order Butterworth anti-alias filter + decimation
- **Compression stats** — live wire bytes, raw equivalent, ratio, and savings displayed in UI

## Quick Start

### Prerequisites

- **Node.js 22+** (LTS recommended)
- **RTL-SDR dongle** + drivers, or a remote `rtl_tcp` server, or just use demo mode

### Install & Run

```bash
git clone https://github.com/gbozo/no-sdr.git
cd no-sdr
npm install
npm run build
npm start
```

Open `http://localhost:3000` in your browser.

### Demo Mode (No Hardware)

Don't have an RTL-SDR? No problem — demo mode simulates realistic radio signals:

```bash
npm run dev:demo
```

This starts the server with a signal simulator that generates FM stations, aviation communications, and ham radio signals. The waterfall, spectrum, and demodulation all work exactly as they would with real hardware.

## Architecture

```
RTL-SDR Dongle ──► rtl_sdr / rtl_tcp / simulator ──► IQ samples
                                                         │
                    ┌────────────────────────────────────┘
                    ▼
             Server (Node.js)
             ├─ FFT (shared) ──────────────► WebSocket ──► All clients (waterfall)
             └─ IQ sub-band (per user) ─┐
                NCO shift + Butterworth ├──► WebSocket ──► One client
                + decimate ─────────────┘                     │
                                                    Browser (SolidJS)
                                                    ├─ Waterfall (Canvas 2D)
                                                    ├─ Spectrum (Canvas 2D)
                                                    ├─ Demodulator (TS DSP)
                                                    │   └─ Stereo FM (PLL)
                                                    └─ Audio (AudioWorklet)
                                                        ├─ 5-band EQ
                                                        ├─ Balance
                                                        ├─ Loudness
                                                        └─ Squelch gate
```

**Hybrid DSP model**: The server computes FFT and broadcasts it to all clients (shared waterfall). Per-user IQ sub-bands are extracted using a numerically-controlled oscillator (NCO) for frequency shifting, a 4th-order Butterworth anti-aliasing filter, and integer decimation. Each client receives its own narrowband IQ stream and performs demodulation locally. Server CPU cost scales with user count only for IQ extraction — demodulation is entirely client-side with no codec and ADPCM.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | GO 1.23 |
| Backend | Go 1.23 |
| Frontend | [SolidJS](https://www.solidjs.com) |
| Build | [Vite 6](https://vite.dev) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com) |
| FFT | [fft.js](https://github.com/nicedoc/fft.js) (radix-4, pure JS) |
| Opus | OPUSlib |
| Deflate | zlib (server) + [fflate](https://github.com/101arrowz/fflate) (client) |
| Config | YAML ([js-yaml](https://github.com/nodeca/js-yaml)) + [Zod](https://zod.dev) |
| Logging | [pino](https://getpino.io) |
| Language | GO / TypeScript 5 (strict) |

## Configuration

All configuration lives in `config/config.yaml`. The file is validated against a Zod schema at startup — invalid configs fail fast with clear error messages.

```yaml
server:
  host: "0.0.0.0"
  port: 3000
  adminPassword: "changeme"

dongles:
  # Local USB dongle
  - id: dongle-0
    deviceIndex: 0
    name: "RTL-SDR #0"
    source:
      type: local              # spawn rtl_sdr child process
    autoStart: true
    profiles:
      - id: fm-broadcast
        name: "FM Broadcast"
        centerFrequency: 100000000
        sampleRate: 2400000
        fftSize: 2048
        defaultMode: wfm
        defaultBandwidth: 200000

  # Remote dongle via rtl_tcp
  - id: dongle-remote
    name: "Remote Antenna"
    source:
      type: rtl_tcp
      host: "192.168.1.100"
      port: 1234
    autoStart: true
    profiles:
      - id: aviation
        name: "Aviation VHF"
        centerFrequency: 125000000
        sampleRate: 2400000
        fftSize: 2048
        defaultMode: am
        defaultBandwidth: 8330
        gain: 40

  # Demo dongle (no hardware)
  - id: dongle-demo
    name: "Simulator"
    source:
      type: demo
    profiles:
      - id: fm-demo
        name: "FM Demo"
        centerFrequency: 100000000
        sampleRate: 2400000
        fftSize: 2048
        defaultMode: wfm
```

### Source Types

| Type | Description | Config |
|------|-------------|--------|
| `local` | Spawns `rtl_sdr` child process, reads IQ from stdout | `deviceIndex`, optional `binary`, `extraArgs` |
| `rtl_tcp` | TCP client to a remote `rtl_tcp` server | `host`, `port` (required) |
| `demo` | Built-in signal simulator, no hardware | No extra config needed |

### Profile System

Each dongle has multiple profiles. When an admin switches the active profile, **all connected clients viewing that dongle are switched automatically** — center frequency, sample rate, demodulation mode, and bandwidth all update in real time.

Profiles can be created, updated, and deleted at runtime via the admin REST API. Changes are automatically persisted back to the YAML config file on disk.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_SDR_CONFIG` | `config/config.yaml` | Path to config file |
| `NODE_SDR_DEMO` | — | Set to `1` to enable demo mode (overrides per-dongle source) |
| `LOG_LEVEL` | `info` | pino log level |
| `NODE_ENV` | — | Set to `production` for optimized serving |

## Demodulation Modes

### Analog (client-side, pure TypeScript)

| Mode | Description | Bandwidth | Notes |
|------|-------------|-----------|-------|
| **WFM** | Wideband FM (broadcast radio) | 150–200 kHz | Stereo FM with PLL pilot detection, SNR-proportional blend, RDS decoding |
| **NFM** | Narrowband FM (VHF/UHF comms) | 5–25 kHz | De-emphasis filter |
| **AM** | Amplitude Modulation (aviation, shortwave) | 3–10 kHz | Envelope detection + AGC; auto-detects C-QUAM stereo |
| **USB** | Upper Sideband (HF amateur, marine) | 1–4 kHz | BFO complex oscillator |
| **LSB** | Lower Sideband (HF amateur, CB) | 1–4 kHz | Conjugate flip + BFO |
| **CW** | Continuous Wave / Morse code | 50–1000 Hz | 700Hz BFO + narrow bandpass |
| **RAW** | Raw IQ passthrough | Variable | I-channel audio output |

### Digital (server-side, external binaries) - NOT YET IMPLEMENTED

| Mode | Binary | Description |
|------|--------|-------------|
| **ADS-B** | `dump1090` | Aircraft tracking at 1090 MHz |
| **ACARS** | `acarsdec` | Aircraft data link messages |
| **VDL2** | `dumpvdl2` | VHF digital data link |
| **AIS** | `rtl_ais` | Ship tracking |
| **APRS** | `direwolf` | Amateur packet radio |
| **POCSAG** | `multimon-ng` | Pager decoding |
| **FT8/FT4** | `jt9` | Weak-signal amateur modes |
| **WSPR** | `wsprd` | Propagation reporting |

Digital decoders are optional — install the binaries you need. The server auto-detects available binaries at startup.

## Deployment

### Docker

```bash
cd docker
docker compose up -d
```

The Dockerfile uses a multi-stage build and includes `rtl-sdr`, `dump1090`, and `multimon-ng` in the runtime image. USB passthrough requires `privileged: true` on Linux.

### Docker Compose with rtl_tcp Sidecar

```yaml
services:
  no-sdr:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - ../config:/app/config:ro   
    restart: unless-stopped
```

Configure the dongle source as `rtl_tcp` with `host: rtl_tcp` and `port: 1234`.

### Raspberry Pi

no-sdr runs well on Raspberry Pi 4/5 (ARM64).

```bash
sudo apt install rtl-sdr
git clone https://github.com/gbozo/no-sdr.git
cd no-sdr
npm install && npm run build && npm start
```

### Reverse Proxy (nginx) - Only if you want to terminate SSL

```nginx
server {
    listen 80;
    server_name sdr.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## REST API

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/status` | — | Server status, uptime, client count |
| `GET` | `/api/dongles` | — | List all configured dongles |
| `GET` | `/api/dongles/:id` | — | Get dongle info |
| `GET` | `/api/dongles/:id/profiles` | — | List profiles for dongle |
| `GET` | `/api/decoders` | — | List running decoders |
| `GET` | `/api/decoders/check` | — | Check which decoder binaries are installed |
| `POST` | `/api/admin/login` | — | Authenticate (body: `{ password }`) |
| `POST` | `/api/admin/dongles/:id/start` | Admin | Start a dongle |
| `POST` | `/api/admin/dongles/:id/stop` | Admin | Stop a dongle |
| `POST` | `/api/admin/dongles/:id/profile` | Admin | Switch active profile (body: `{ profileId }`) |
| `POST` | `/api/admin/dongles/:id/profiles` | Admin | Create new profile (body: profile object) |
| `PUT` | `/api/admin/dongles/:id/profiles/:pid` | Admin | Update profile (body: partial profile) |
| `DELETE` | `/api/admin/dongles/:id/profiles/:pid` | Admin | Delete profile |
| `POST` | `/api/admin/save-config` | Admin | Persist current config to disk |
| `GET` | `/api/admin/status` | Admin | Full status with memory usage |

Admin endpoints require `Authorization: Bearer <password>` header.

## WebSocket Protocol

The WebSocket endpoint is at `/ws`. Server-to-client messages use a binary protocol with a type byte prefix. Client-to-server messages are JSON text.

See [SPEC.md](SPEC.md) for the complete protocol specification.

## Development

```bash
# Start everything in demo mode with hot reload
npm run dev:demo

# Build all workspaces
npm run build

# Type check all workspaces
npm run typecheck

# Clean build artifacts
npm run clean
```

### Project Structure

- **`server/`** — Go backend, hardware management, FFT, IQ extraction, Opus audio pipeline, WebSocket
- **`client/`** — SolidJS frontend, Canvas renderers, DSP, stereo FM, RDS decoder, AudioWorklet + EQ

Build order: `client` → `server` (the server serves the built client).

## Contributing

Contributions are welcome. Please:

1. Fork the repo and create a feature branch
2. Run `npm run build && npm run typecheck` before submitting
3. Keep PRs focused — one feature or fix per PR
4. Add to `config/config.yaml` examples if adding new modes or decoders

### Areas Where Help Is Needed

- **AM Stereo (C-QUAM) testing** — auto-detection is experimental; we need testers near C-QUAM stations (~45 in the US, a handful in Italy, Japan, Philippines, Thailand). Requires direct sampling mod or HF-capable dongle. Please report results!
- **Testing** — unit tests for DSP, protocol, config validation, ADPCM codec
- **WebGL waterfall** — GPU-accelerated rendering for large FFT sizes
- **Recording** — IQ recording and playback (SigMF format)
- **Bookmarks** — frequency bookmark management
- **New decoders** — WASM ports of C decoders (FT8, DAB, etc.)

## License

MIT

## Acknowledgments

- [OpenWebRX](https://github.com/jketterl/openwebrx) — the gold standard of open-source WebSDR, major architectural inspiration
- [Intercept](https://github.com/smittix/intercept) — modern signal intelligence platform, UI/UX reference
- [fft.js](https://github.com/nicedoc/fft.js) by Fedor Indutny — fast pure-JS radix-4 FFT
- [RTL-SDR](https://www.rtl-sdr.com/) community — for making software-defined radio accessible to everyone
- [SolidJS](https://www.solidjs.com/) — reactive UI without the VDOM overhead

