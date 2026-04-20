<p align="center">
  <img src="client/public/favicon.svg" width="80" height="80" alt="node-sdr logo" />
</p>

<h1 align="center">node-sdr</h1>

<p align="center">
  <strong>A multi-user WebSDR for RTL-SDR dongles, built with Node.js</strong>
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
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/typescript-5-blue" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/RTL--SDR-supported-orange" alt="RTL-SDR" />
</p>

---

**node-sdr** turns cheap RTL-SDR USB dongles into a full-featured web-based radio receiver. Multiple users connect through their browser and independently tune, demodulate, and listen to signals — all sharing the same hardware. No plugins, no installs, just open a URL.

Think of it as your own private [WebSDR](http://websdr.org) that you can run at home, in a hackerspace, or on a cloud VM with a remote antenna.

## Features

### Radio

- **7 analog demodulation modes** — WFM, NFM, AM, USB, LSB, CW, Raw IQ
- **9 digital decoders** — ADS-B, ACARS, VDL2, AIS, APRS, POCSAG, FT8, FT4, WSPR (via external binaries)
- **Multi-user** — everyone shares the same waterfall; each user tunes independently within the dongle's bandwidth
- **Multi-dongle** — configure multiple RTL-SDR devices, each with its own frequency profiles
- **Profile system** — admins define presets (FM broadcast, aviation, 2m ham, ADS-B, marine) per dongle; switching a profile changes it for all connected users

### Display

- **Live waterfall** — Canvas 2D with 5 color themes (turbo, viridis, classic, grayscale, hot)
- **Spectrum analyzer** — real-time power spectral density with tuning indicator
- **Frequency display** — LCD-style readout with scroll-to-tune digit groups
- **S-meter** — signal strength indicator with color breakpoints
- **3 UI themes** — LCD (cyan), CRT (phosphor green), VFD (amber)

### Audio

- **Client-side DSP** — demodulation runs entirely in the browser via pure TypeScript
- **AudioWorklet** — low-latency audio playback via Web Audio API
- **Squelch** — adjustable noise gate for FM/AM modes

### Infrastructure

- **Demo mode** — built-in signal simulator for development and demos, no hardware needed
- **Docker ready** — multi-stage Dockerfile with USB passthrough for RTL-SDR
- **Raspberry Pi compatible** — runs on ARM64, tested on Pi 4/5
- **Admin panel** — start/stop dongles, switch profiles, monitor status via REST API + UI
- **YAML config** — validated at startup with Zod schemas

## Quick Start

### Prerequisites

- **Node.js 22+** (LTS recommended)
- **RTL-SDR dongle** + drivers (or use demo mode without hardware)

### Install & Run

```bash
git clone https://github.com/gbozo/node-sdr.git
cd node-sdr
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
RTL-SDR Dongle ──► rtl_sdr process ──► IQ samples
                                           │
                   ┌───────────────────────┘
                   ▼
            Server (Node.js)
            ├─ FFT (shared) ──────► WebSocket ──► All clients (waterfall)
            └─ IQ sub-band (per user) ──► WebSocket ──► One client
                                                            │
                                                   Browser (SolidJS)
                                                   ├─ Waterfall (Canvas 2D)
                                                   ├─ Spectrum (Canvas 2D)
                                                   ├─ Demodulator (TS DSP)
                                                   └─ Audio (AudioWorklet)
```

**Hybrid DSP model**: The server computes FFT and broadcasts it to all clients (shared waterfall). Each client receives its own IQ sub-band and performs demodulation locally. This means the server CPU cost doesn't scale with user count — only bandwidth does.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 (ESM) |
| Backend | [Hono](https://hono.dev) + [@hono/node-ws](https://github.com/honojs/middleware/tree/main/packages/node-ws) |
| Frontend | [SolidJS](https://www.solidjs.com) |
| Build | [Vite 6](https://vite.dev) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com) |
| FFT | [fft.js](https://github.com/nicedoc/fft.js) (radix-4, pure JS) |
| Config | YAML ([js-yaml](https://github.com/nodeca/js-yaml)) + [Zod](https://zod.dev) |
| Logging | [pino](https://getpino.io) |
| Language | TypeScript 5 (strict) |

## Configuration

All configuration lives in `config/config.yaml`. The file is validated against a Zod schema at startup — invalid configs fail fast with clear error messages.

```yaml
server:
  host: "0.0.0.0"
  port: 3000
  adminPassword: "changeme"

dongles:
  - id: dongle-0
    deviceIndex: 0
    name: "RTL-SDR #0"
    ppmCorrection: 0
    autoStart: true
    profiles:
      - id: fm-broadcast
        name: "FM Broadcast"
        centerFrequency: 100000000    # 100 MHz
        sampleRate: 2400000           # 2.4 MSPS
        fftSize: 2048
        defaultMode: wfm
        defaultBandwidth: 200000
        description: "FM broadcast band"

      - id: aviation
        name: "Aviation VHF"
        centerFrequency: 125000000
        sampleRate: 2400000
        fftSize: 2048
        defaultMode: am
        defaultBandwidth: 8330
        gain: 40
        description: "Aviation 118-137 MHz"

      - id: adsb
        name: "ADS-B 1090"
        centerFrequency: 1090000000
        sampleRate: 2000000
        defaultMode: raw
        fftSize: 2048
        defaultBandwidth: 1000000
        gain: 50
        decoders:
          - type: adsb
            enabled: true
            frequencyOffset: 0
            bandwidth: 1000000
```

### Profile System

Each dongle has multiple profiles. When an admin switches the active profile, **all connected clients viewing that dongle are switched automatically** — center frequency, sample rate, demodulation mode, and bandwidth all update in real time.

Profiles are defined per-dongle so different dongles can serve different purposes (one for FM, one for aviation, etc.).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_SDR_CONFIG` | `config/config.yaml` | Path to config file |
| `NODE_SDR_DEMO` | — | Set to `1` to enable demo mode |
| `LOG_LEVEL` | `info` | pino log level |
| `NODE_ENV` | — | Set to `production` for optimized serving |

## Demodulation Modes

### Analog (client-side, pure TypeScript)

| Mode | Description | Bandwidth |
|------|-------------|-----------|
| **WFM** | Wideband FM (broadcast radio) | 150–200 kHz |
| **NFM** | Narrowband FM (VHF/UHF comms) | 5–25 kHz |
| **AM** | Amplitude Modulation (aviation, shortwave) | 3–10 kHz |
| **USB** | Upper Sideband (HF amateur, marine) | 1–4 kHz |
| **LSB** | Lower Sideband (HF amateur, CB) | 1–4 kHz |
| **CW** | Continuous Wave / Morse code | 50–1000 Hz |
| **RAW** | Raw IQ passthrough | Variable |

### Digital (server-side, external binaries)

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

### Docker Compose

```yaml
services:
  node-sdr:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - ../config:/app/config:ro
    devices:
      - /dev/bus/usb:/dev/bus/usb
    privileged: true
    restart: unless-stopped
```

### Raspberry Pi

node-sdr runs well on Raspberry Pi 4/5 (ARM64). Install Node.js 22 via [NodeSource](https://github.com/nodesource/distributions) or [nvm](https://github.com/nvm-sh/nvm), then:

```bash
sudo apt install rtl-sdr
git clone https://github.com/gbozo/node-sdr.git
cd node-sdr
npm install && npm run build && npm start
```

### Reverse Proxy (nginx)

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
| `POST` | `/api/admin/dongles/:id/profile` | Admin | Switch profile (body: `{ profileId }`) |
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

This is an npm workspaces monorepo with three packages:

- **`shared/`** — Zero-dependency types, protocol constants, mode definitions
- **`server/`** — Hono backend, hardware management, FFT, WebSocket
- **`client/`** — SolidJS frontend, Canvas renderers, DSP, AudioWorklet

Build order: `shared` → `client` → `server` (the server serves the built client).

## Contributing

Contributions are welcome. Please:

1. Fork the repo and create a feature branch
2. Run `npm run build && npm run typecheck` before submitting
3. Keep PRs focused — one feature or fix per PR
4. Add to `config/config.yaml` examples if adding new modes or decoders

### Areas Where Help Is Needed

- **Testing** — unit tests for DSP, protocol, config validation
- **WebGL waterfall** — GPU-accelerated rendering for large FFT sizes
- **Recording** — IQ recording and playback
- **Bookmarks** — frequency bookmark management
- **Mobile UI** — responsive design for tablets and phones
- **New decoders** — WASM ports of C decoders (FT8, DAB, etc.)

## License

MIT

## Acknowledgments

- [OpenWebRX](https://github.com/jketterl/openwebrx) — the gold standard of open-source WebSDR, major architectural inspiration
- [Intercept](https://github.com/smittix/intercept) — modern signal intelligence platform, UI/UX reference
- [fft.js](https://github.com/nicedoc/fft.js) by Fedor Indutny — fast pure-JS radix-4 FFT
- [RTL-SDR](https://www.rtl-sdr.com/) community — for making software-defined radio accessible to everyone
- [SolidJS](https://www.solidjs.com/) — reactive UI without the VDOM overhead
- [Hono](https://hono.dev/) — ultrafast web framework for the edge and Node.js
