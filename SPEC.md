# node-sdr Technical Specification

Version 0.1.0 — April 2026

## Table of Contents

- [1. System Overview](#1-system-overview)
- [2. Architecture](#2-architecture)
- [3. WebSocket Protocol](#3-websocket-protocol)
- [4. REST API](#4-rest-api)
- [5. Server Components](#5-server-components)
- [6. Client Components](#6-client-components)
- [7. Configuration](#7-configuration)
- [8. DSP Pipeline](#8-dsp-pipeline)
- [9. Digital Decoders](#9-digital-decoders)
- [10. Multi-User Model](#10-multi-user-model)
- [11. Theming System](#11-theming-system)
- [12. Demo Mode](#12-demo-mode)
- [13. Deployment](#13-deployment)
- [14. Security](#14-security)
- [15. Performance](#15-performance)
- [16. Future Work](#16-future-work)

---

## 1. System Overview

node-sdr is a multi-user WebSDR (Software Defined Radio) application that bridges RTL-SDR USB hardware to web browsers over a local network or the internet. It implements a hybrid DSP architecture where computationally shared work (FFT) runs on the server while per-user work (demodulation, audio) runs in each client's browser.

### Design Goals

1. **Multi-user efficiency** — one dongle, many listeners, minimal server CPU per user
2. **Zero client install** — standard browser, no plugins, no WebUSB
3. **Low latency** — real-time waterfall, spectrum, and audio with sub-second delay
4. **Extensibility** — new demodulation modes and decoders added through simple interfaces
5. **Deployability** — Docker, Raspberry Pi, bare metal, cloud VM with remote antenna

### Constraints

- RTL-SDR dongles have a maximum sample rate of ~3.2 MSPS (stable at 2.4 MSPS)
- RTL-SDR frequency range: 24 MHz – 1.766 GHz (R820T2 tuner)
- Each dongle can only tune to one center frequency at a time
- All users on a dongle share the same bandwidth window

---

## 2. Architecture

### 2.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Hardware Layer                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ RTL-SDR #0  │  │ RTL-SDR #1  │  │ RTL-SDR #N  │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │ USB            │ USB            │ USB                 │
└─────────┼────────────────┼────────────────┼─────────────────────┘
          │                │                │
┌─────────▼────────────────▼────────────────▼─────────────────────┐
│  Server Process (Node.js)                                        │
│                                                                   │
│  ┌──────────────┐                                                │
│  │ DongleManager│ ── spawns rtl_sdr per dongle ──► child procs   │
│  └──────┬───────┘                                                │
│         │ Buffer (uint8 IQ)                                      │
│         ▼                                                        │
│  ┌──────────────┐    ┌────────────────┐                         │
│  │ FftProcessor │    │ DecoderManager │                         │
│  │ (per dongle) │    │ (per profile)  │                         │
│  └──────┬───────┘    └───────┬────────┘                         │
│         │ Float32 dB         │ JSON                              │
│         ▼                    ▼                                   │
│  ┌───────────────────────────────────────┐                      │
│  │         WebSocketManager              │                      │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ │                      │
│  │  │Client A │ │Client B │ │Client C │ │                      │
│  │  └─────────┘ └─────────┘ └─────────┘ │                      │
│  └───────────────────────────────────────┘                      │
│                                                                   │
│  ┌──────────────┐                                                │
│  │ Hono HTTP    │ ── REST API + static file serving              │
│  └──────────────┘                                                │
└──────────────────────────────────────────────────────────────────┘
          │ WebSocket (binary) + HTTP
          ▼
┌──────────────────────────────────────────────────────────────────┐
│  Client (Browser)                                                 │
│                                                                   │
│  ┌──────────────┐    ┌────────────────┐    ┌──────────────────┐ │
│  │ SdrEngine    │───▶│ WaterfallRender│    │ SolidJS UI       │ │
│  │ (WS client)  │───▶│ SpectrumRender │    │ (controls, theme)│ │
│  │              │    └────────────────┘    └──────────────────┘ │
│  │              │                                                │
│  │              │───▶ Demodulator ───▶ AudioEngine ───▶ Speaker │
│  └──────────────┘    (FM/AM/SSB/CW)    (AudioWorklet)          │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

**Shared path (all clients on a dongle):**
```
rtl_sdr stdout → Buffer chunks → FftProcessor → Float32Array dB → WebSocket MSG_FFT → client waterfall + spectrum
```

**Per-user path:**
```
rtl_sdr stdout → Buffer chunks → extractIqSubBand(offset, bandwidth) → Int16Array IQ → WebSocket MSG_IQ → client demodulator → Float32 audio → AudioWorklet → speakers
```

**Digital decoder path:**
```
rtl_sdr stdout → DecoderManager → stdin of decoder binary → stdout parsed → JSON → WebSocket MSG_DECODER → client UI
```

### 2.3 Monorepo Layout

| Package | Name | Purpose | Dependencies |
|---------|------|---------|-------------|
| `shared/` | `@node-sdr/shared` | Types, protocol, mode definitions | None |
| `server/` | `@node-sdr/server` | HTTP, WebSocket, hardware, FFT | hono, fft.js, js-yaml, zod, pino |
| `client/` | `@node-sdr/client` | UI, Canvas, DSP, audio | solid-js, fft.js, tailwindcss |

Build order: `shared` → `client` → `server`

---

## 3. WebSocket Protocol

### 3.1 Connection

Endpoint: `ws://<host>:<port>/ws`

On connection, the server assigns a unique client ID and sends a `welcome` meta message.

### 3.2 Server → Client (Binary)

All binary messages are prefixed with a single type byte. The remaining bytes are the payload.

```
┌──────────┬────────────────────────────────────────┐
│ Type (1B)│ Payload (variable length)               │
└──────────┴────────────────────────────────────────┘
```

| Type | Constant | Payload Format | Size per Message | Scope |
|------|----------|---------------|-----------------|-------|
| `0x01` | `MSG_FFT` | `Float32Array` — dB magnitudes, DC-centered, length = fftSize | fftSize × 4 + 1 bytes | Broadcast to dongle |
| `0x02` | `MSG_IQ` | `Int16Array` — interleaved I,Q,I,Q... samples of user's sub-band | Variable (depends on bandwidth) | Per-user |
| `0x03` | `MSG_META` | UTF-8 JSON string — `ServerMeta` union type | Variable | Per-user |
| `0x04` | `MSG_FFT_COMPRESSED` | `Uint8Array` — dB mapped to 0-255 range | fftSize + 1 bytes | Broadcast to dongle |
| `0x05` | `MSG_AUDIO` | `Int16Array` — mono PCM audio samples | Variable | Per-user |
| `0x06` | `MSG_DECODER` | UTF-8 JSON — `{ decoderType, data }` | Variable | Broadcast to dongle |
| `0x07` | `MSG_SIGNAL_LEVEL` | `Float32` — signal strength in dB | 5 bytes | Per-user |

### 3.3 Server Meta Messages (`MSG_META`)

```typescript
type ServerMeta =
  | { type: 'welcome'; clientId: string; serverVersion: string }
  | { type: 'subscribed'; dongleId: string; profileId: string;
      centerFreq: number; sampleRate: number; fftSize: number }
  | { type: 'profile_changed'; dongleId: string; profileId: string;
      centerFreq: number; sampleRate: number; fftSize: number }
  | { type: 'dongle_status'; dongleId: string; running: boolean;
      clientCount: number }
  | { type: 'error'; message: string; code?: string }
  | { type: 'admin_auth_ok' }
  | { type: 'decoder_data'; decoderType: string; data: unknown };
```

### 3.4 Client → Server (JSON Text)

All client messages are JSON text with a `cmd` field:

```typescript
type ClientCommand =
  | { cmd: 'subscribe'; dongleId: string; profileId?: string }
  | { cmd: 'unsubscribe' }
  | { cmd: 'tune'; offset: number }      // Hz offset from center
  | { cmd: 'mode'; mode: DemodMode }
  | { cmd: 'bandwidth'; hz: number }
  | { cmd: 'squelch'; db: number | null } // null = disabled
  | { cmd: 'volume'; level: number }      // 0.0 – 1.0
  | { cmd: 'mute'; muted: boolean }
  | { cmd: 'waterfall_settings'; minDb: number; maxDb: number }
  | { cmd: 'admin_auth'; password: string }
  | { cmd: 'admin_set_profile'; dongleId: string; profileId: string }
  | { cmd: 'admin_stop_dongle'; dongleId: string }
  | { cmd: 'admin_start_dongle'; dongleId: string };
```

### 3.5 Typical Session Flow

```
Client                              Server
  │                                    │
  │ ──── WS connect ─────────────────► │
  │ ◄─── MSG_META welcome ──────────── │
  │                                    │
  │ ──── { cmd: subscribe,             │
  │        dongleId: "dongle-0" } ───► │
  │ ◄─── MSG_META subscribed ───────── │
  │                                    │
  │ ◄─── MSG_FFT (30fps) ──────────── │  (continuous)
  │ ◄─── MSG_IQ (per-user) ────────── │  (continuous)
  │                                    │
  │ ──── { cmd: tune, offset: 25000 }► │
  │ (IQ sub-band shifts to new offset) │
  │                                    │
  │ ──── { cmd: mode, mode: "am" } ──► │
  │ (server notes mode, adjusts IQ BW) │
  │                                    │
  │ ◄─── MSG_DECODER (if decoders) ─── │  (async)
  │                                    │
```

---

## 4. REST API

### 4.1 Public Endpoints

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/api/status` | `{ version, uptime, totalClients, dongles: DongleInfo[] }` |
| `GET` | `/api/dongles` | `DongleInfo[]` |
| `GET` | `/api/dongles/:id` | `DongleInfo` or 404 |
| `GET` | `/api/dongles/:id/profiles` | `DongleProfile[]` |
| `GET` | `/api/decoders` | Running decoder list |
| `GET` | `/api/decoders/check` | `{ binary: string, available: boolean }[]` |

### 4.2 Admin Endpoints

All require `Authorization: Bearer <adminPassword>` header.

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/api/admin/login` | `{ password }` | `{ ok: true }` or 403 |
| `POST` | `/api/admin/dongles/:id/start` | — | `{ ok, dongleId }` |
| `POST` | `/api/admin/dongles/:id/stop` | — | `{ ok, dongleId }` |
| `POST` | `/api/admin/dongles/:id/profile` | `{ profileId }` | `{ ok, dongleId, profileId }` |
| `GET` | `/api/admin/status` | — | Full status + memory usage + demoMode flag |
| `POST` | `/api/admin/generate-config` | — | Writes default config to disk |

---

## 5. Server Components

### 5.1 DongleManager

**File:** `server/src/dongle-manager.ts`

Manages the lifecycle of RTL-SDR devices. Each dongle runs as a separate `rtl_sdr` child process.

**Responsibilities:**
- Spawn and monitor `rtl_sdr -f <freq> -s <rate> -g <gain> -d <index> -`
- Parse raw stdout (uint8 interleaved I/Q) into Buffer chunks
- Emit `iq-data` events for downstream consumers (FFT, decoders, per-user IQ extraction)
- Handle profile switching (stop process, reconfigure, restart)
- Auto-restart on crash with exponential backoff (max 5 retries)
- Demo mode: substitute `SignalSimulator` for real hardware

**Events:**
- `iq-data(dongleId, buffer)` — raw IQ chunk available
- `dongle-started(dongleId)` — process spawned successfully
- `dongle-stopped(dongleId)` — process exited
- `dongle-error(dongleId, error)` — hardware error
- `profile-changed(dongleId, profile)` — active profile switched

### 5.2 FftProcessor

**File:** `server/src/fft-processor.ts`

Computes FFT from raw IQ data and outputs dB magnitude arrays.

**Pipeline:**
1. Accumulate IQ chunks into a buffer of `fftSize` complex samples
2. Convert uint8 IQ pairs to float32 (normalize: `(val - 127.5) / 127.5`)
3. Apply window function (Blackman-Harris default, Hann and Hamming available)
4. Compute FFT via `fft.js` radix-4 algorithm
5. Calculate magnitude in dB: `10 * log10(re² + im²)`
6. DC-center reorder (swap halves)
7. Apply exponential smoothing (configurable averaging factor)
8. Output `Float32Array` of dB values, length = `fftSize`

**Additional function:** `extractIqSubBand(fullIq, centerOffset, bandwidth, sampleRate)` — extracts a frequency sub-band from the full IQ stream for per-user demodulation. Returns `Int16Array` of interleaved I/Q.

### 5.3 WebSocketManager

**File:** `server/src/ws-manager.ts`

Routes data between dongles and connected clients.

**Per-client state:**
- `dongleId` — subscribed dongle (null if not subscribed)
- `tuneOffset` — frequency offset from center in Hz
- `mode` — demodulation mode
- `bandwidth` — filter bandwidth in Hz
- `squelch` — squelch level (null = disabled)
- `volume` — 0.0–1.0
- `muted` — boolean
- `isAdmin` — admin-authenticated flag

**Data routing:**
- FFT data → broadcast to all clients subscribed to the dongle
- IQ sub-band → extracted per-client based on tuneOffset + bandwidth, sent individually
- Decoder output → broadcast to all clients on the dongle

### 5.4 DecoderManager

**File:** `server/src/decoder-manager.ts`

Spawns external C binaries for digital mode decoding.

**Supported decoders and their parsers:**

| Decoder | Binary | Input | Output Parser |
|---------|--------|-------|--------------|
| ADS-B | `dump1090` | Raw IQ stdin | JSON lines or `*hex;` frames |
| ACARS | `acarsdec` | IQ stdin (with `-j` flag) | JSON objects |
| VDL2 | `dumpvdl2` | IQ stdin | JSON objects |
| AIS | `rtl_ais` | IQ stdin | AIVDM/AIVDO sentences |
| APRS | `direwolf` | Audio stdin | `SRC>PATH:payload` lines |
| POCSAG | `multimon-ng` | Raw audio stdin | `POCSAG512/1200/2400: Address: ...` |
| FT8/FT4 | `jt9` | Audio file | JSON decode results |
| WSPR | `wsprd` | Audio file | Text decode results |

**Features:**
- Auto-restart on crash (max 3 retries, exponential backoff)
- `checkBinaryAvailable(name)` uses `which` to test availability
- IQ feeding via stdin pipe
- Stdout parsed line-by-line, routed to WebSocket clients as `MSG_DECODER`

### 5.5 SignalSimulator

**File:** `server/src/signal-simulator.ts`

Generates realistic simulated IQ data for demo mode.

**Signal types:** WFM (FM modulation, 75kHz deviation), NFM (voice-like tones), AM (envelope modulation), CW (Morse SOS pattern), noise-burst (intermittent).

**Presets:**
- FM Broadcast — 4 FM stations at different offsets + one drifting
- Aviation — tower, ATIS, ground, approach frequencies
- Two Meter — simplex, repeater, CW beacon, APRS-like signal

Gaussian noise floor via Box-Muller transform. Output format matches `rtl_sdr`: uint8 interleaved I/Q.

---

## 6. Client Components

### 6.1 SdrEngine

**File:** `client/src/engine/sdr-engine.ts`

Central orchestrator connecting WebSocket to renderers and audio.

**Responsibilities:**
- WebSocket connection management with auto-reconnect (exponential backoff)
- Binary message dispatch: MSG_FFT → waterfall + spectrum, MSG_IQ → demodulator → audio, MSG_META → store updates, MSG_DECODER → store
- Client command sending (tune, mode, bandwidth, etc.)
- Initial dongle discovery via REST `/api/dongles`
- Auto-subscribe to first running dongle on connect

### 6.2 WaterfallRenderer

**File:** `client/src/engine/waterfall.ts`

Canvas 2D implementation of a scrolling waterfall spectrogram.

**Algorithm:**
1. `drawRow(fftData)` called at ~30fps from MSG_FFT handler
2. Scroll existing canvas down 1px: `ctx.drawImage(canvas, 0, 0, w, h-1, 0, 1, w, h-1)`
3. Create 1-pixel-height ImageData
4. Map each FFT bin to normalized 0-255 index, look up palette color
5. Write RGBA pixels via `putImageData`

**Palette:** 256-entry `[r, g, b]` lookup table, pre-computed from gradient color stops. Five themes available (turbo, viridis, classic, grayscale, hot).

### 6.3 SpectrumRenderer

**File:** `client/src/engine/spectrum.ts`

Canvas 2D real-time power spectral density chart.

**Features:**
- dB grid lines with labels
- Gradient fill under the spectrum curve
- Tuning indicator: semi-transparent rectangle showing bandwidth window + center frequency dashed line
- Uses CSS `var(--sdr-accent)` for theme-reactive coloring

### 6.4 Demodulators

**File:** `client/src/engine/demodulators.ts`

Pure TypeScript DSP implementations. All operate on Int16 interleaved IQ input and produce Float32 audio output.

**Interface:**
```typescript
interface Demodulator {
  process(iqData: Int16Array): Float32Array;
  setBandwidth(hz: number): void;
  reset(): void;
}
```

**DSP building blocks:**
- `FirFilter` — windowed-sinc FIR, Blackman-Harris window, configurable taps + cutoff
- `DcBlocker` — single-pole IIR high-pass (alpha = 0.995)
- `DeemphasisFilter` — single-pole IIR low-pass (75µs US / 50µs EU time constant)
- `Agc` — automatic gain control with configurable attack/decay/maxGain
- `Decimator` — anti-aliasing FIR + integer decimation factor

**Implementations:**

| Class | Modes | Algorithm |
|-------|-------|-----------|
| `FmDemodulator` | WFM, NFM | Polar discriminator: `atan2(Q·I' - I·Q', I·I' + Q·Q')`, de-emphasis filter, decimation (WFM: 240k→48k) |
| `AmDemodulator` | AM | Envelope detection: `sqrt(I² + Q²)`, DC blocker, AGC |
| `SsbDemodulator` | USB, LSB | Conjugate flip for LSB, BFO frequency shift via complex oscillator, take real part, AGC |
| `CwDemodulator` | CW | 700Hz BFO mixing, narrow FIR bandpass, AGC |
| `RawDemodulator` | RAW | Passthrough (I channel only) |

**Factory:** `getDemodulator(mode)` returns cached demodulator instances. `resetDemodulator(mode)` clears a specific cache entry.

### 6.5 AudioEngine

**File:** `client/src/engine/audio.ts`

Web Audio API with AudioWorklet for low-latency playback.

**Architecture:**
```
pushDemodulatedAudio(Float32Array)
    ↓
AudioWorkletNode.port.postMessage(samples)
    ↓
SdrAudioProcessor (worklet thread)
    ↓ ring buffer → output
GainNode → AudioContext.destination
```

The worklet runs a ring buffer that drains into the audio output callback. Volume control is via a GainNode. Muting disconnects the GainNode from the destination.

### 6.6 SolidJS Store

**File:** `client/src/store/index.ts`

SolidJS signals for UI state only. Hot data (FFT, audio) bypasses the store entirely.

**Signal groups:**
- Connection: `connected`, `clientId`
- Dongle: `activeDongleId`, `activeProfileId`, `availableDongles`
- Tuning: `centerFrequency`, `tuneOffset`, `mode`, `bandwidth`
- Audio: `volume`, `muted`, `squelch`, `signalLevel`
- Display: `waterfallTheme`, `uiTheme`, `waterfallMin`, `waterfallMax`, `fftSize`
- UI: `sidebarOpen`, `decoderPanelOpen`, `isAdmin`

**Computed:** `tunedFrequency = centerFrequency + tuneOffset`

### 6.7 UI Components

**`App.tsx`** — Main layout: header bar (logo, connection dot, theme buttons), audio start prompt, collapsible sidebar (300px) + main area (frequency display, waterfall/spectrum), status bar footer.

**`WaterfallDisplay.tsx`** — Two stacked canvases: spectrum (180px fixed) and waterfall (flex). Click-to-tune via `pixelToFreqOffset()`. ResizeObserver for responsive sizing.

**`FrequencyDisplay.tsx`** — LCD-style dotted frequency readout (e.g., `100.000.000 MHz`). Digit groups are individually hoverable with scroll-to-tune (mouse wheel changes frequency in units matching the digit group).

**`ControlPanel.tsx`** — Sidebar panels: ModeSelector (7 buttons), AudioControls (volume slider, mute, squelch), BandwidthControl (mode-aware range), WaterfallSettings (5 palette buttons, min/max dB), SMeter (color-segmented bar), ConnectionStatus, DongleSelector, AdminPanel (login, dongle start/stop, profile switch).

---

## 7. Configuration

### 7.1 Schema

Configuration is loaded from YAML and validated with Zod schemas at startup.

```typescript
// Simplified schema structure
ServerConfig {
  server: {
    host: string        // default "0.0.0.0"
    port: number        // default 3000
    adminPassword: string
    demoMode?: boolean  // default false
  }
  dongles: DongleConfig[]
}

DongleConfig {
  id: string
  deviceIndex: number
  name: string
  serial?: string
  ppmCorrection: number  // default 0
  autoStart: boolean     // default true
  profiles: DongleProfile[]
}

DongleProfile {
  id: string
  name: string
  centerFrequency: number  // Hz
  sampleRate: number       // Hz
  fftSize: number          // power of 2, default 2048
  defaultMode: DemodMode
  defaultTuneOffset: number
  defaultBandwidth: number
  gain: number | null      // null = auto
  description: string
  decoders: DecoderConfig[]
}

DecoderConfig {
  type: DigitalMode
  enabled: boolean
  frequencyOffset: number  // Hz from center
  bandwidth: number        // Hz
  binary?: string          // override default binary
  args?: string[]          // override default args
  options: Record<string, unknown>
}
```

### 7.2 Profile System

Profiles are per-dongle frequency presets. Each profile defines:
- The center frequency and sample rate for the dongle
- FFT size for waterfall resolution
- Default demodulation mode and bandwidth for new connections
- Optional digital decoders to auto-start

**Profile switching** is an admin action. When a profile is switched:
1. The dongle process is stopped
2. The dongle is reconfigured with new frequency/rate/gain
3. The dongle process is restarted
4. All connected clients receive a `profile_changed` meta message
5. Client waterfall, spectrum, and frequency displays update automatically

### 7.3 File Locations

The config file is searched in order:
1. `$NODE_SDR_CONFIG` environment variable
2. `config/config.yaml` (relative to server working directory)
3. `../config/config.yaml` (relative to server dist directory)

---

## 8. DSP Pipeline

### 8.1 Server-Side FFT

**Input:** Raw uint8 interleaved IQ from rtl_sdr stdout.

**Processing chain:**
```
uint8 I,Q pairs
    ↓ normalize: (val - 127.5) / 127.5
float32 complex samples [re, im, re, im, ...]
    ↓ accumulate fftSize samples
    ↓ apply window function (Blackman-Harris)
    ↓ FFT (fft.js radix-4)
complex spectrum [re, im, re, im, ...]
    ↓ magnitude: 10 * log10(re² + im²)
    ↓ DC-center reorder (swap halves)
    ↓ exponential averaging
Float32Array dB magnitudes [fftSize values]
```

**Window functions available:** Blackman-Harris (default, best sidelobe suppression), Hann (good general purpose), Hamming (narrower main lobe).

**FFT rate:** Depends on sample rate and FFT size. At 2.4 MSPS and 2048-point FFT: ~1172 FFTs/second possible. Throttled to ~30 fps for WebSocket broadcast.

### 8.2 IQ Sub-Band Extraction

For per-user demodulation, the server extracts a frequency sub-band from the full IQ stream:

1. Apply frequency shift to center the user's tuned offset at DC
2. Low-pass filter to the user's bandwidth
3. Decimate to reduce data rate
4. Convert to Int16 for efficient WebSocket transport

### 8.3 Client-Side Demodulation

**FM Demodulation (WFM/NFM):**
```
Int16 IQ → float I,Q → polar discriminator → de-emphasis → decimate → Float32 audio
```
The polar discriminator computes instantaneous frequency: `atan2(Q[n]·I[n-1] - I[n]·Q[n-1], I[n]·I[n-1] + Q[n]·Q[n-1])`.

WFM decimates from 240kHz to 48kHz (factor 5). NFM operates at 48kHz directly.

**AM Demodulation:**
```
Int16 IQ → float I,Q → envelope: sqrt(I² + Q²) → DC block → AGC → Float32 audio
```

**SSB Demodulation (USB/LSB):**
```
Int16 IQ → float I,Q → [conjugate for LSB] → BFO shift → take real part → AGC → Float32 audio
```
BFO frequency depends on the sideband. The complex oscillator shifts the signal so the voice content falls in the audio range.

**CW Demodulation:**
```
Int16 IQ → float I,Q → 700Hz BFO mix → narrow bandpass FIR → AGC → Float32 audio
```

---

## 9. Digital Decoders

### 9.1 Architecture

Digital decoders run as separate child processes. The server pipes IQ data to their stdin and parses their stdout.

```
IQ data (from DongleManager)
    ↓ pipe to stdin
┌──────────────┐
│ C binary     │ (dump1090, acarsdec, etc.)
│ (child proc) │
└──────┬───────┘
       ↓ stdout (line-by-line)
Output Parser
    ↓ JSON
MSG_DECODER → WebSocket → Client
```

### 9.2 Output Formats

**dump1090 (ADS-B):** JSON lines with `hex`, `flight`, `alt`, `lat`, `lon`, `speed`, `track` fields. Also supports raw `*AABBCC...;` hex frames.

**acarsdec (ACARS):** JSON with `reg`, `flight`, `label`, `text`, `level` fields (requires `-j` flag).

**dumpvdl2 (VDL2):** Native JSON output with `--output decoded:json` flag.

**multimon-ng (POCSAG/FLEX):** Text lines parsed with regex:
```
POCSAG1200: Address: 1234567 Function: 0 Alpha: Hello World
FLEX: ...
```

**direwolf (APRS):** AX.25 frame format: `SRC>DEST,PATH:payload`

**rtl_ais (AIS):** AIVDM/AIVDO NMEA sentences.

### 9.3 Decoder Lifecycle

1. When a profile with decoders is activated, the DecoderManager starts configured decoders
2. IQ data is fed to decoders via `feedIqData()`
3. Decoder stdout is parsed line-by-line
4. Parsed messages are emitted as events and forwarded via WebSocket
5. When a profile is deactivated, decoders are stopped (SIGTERM, then SIGKILL after 3s)
6. Crashed decoders auto-restart with exponential backoff (max 3 retries)

---

## 10. Multi-User Model

### 10.1 Shared Resources

- **Dongle hardware** — one center frequency per dongle, shared by all users
- **FFT computation** — computed once per dongle, broadcast to all subscribers
- **Digital decoder output** — computed once, broadcast to all subscribers

### 10.2 Per-User Resources

- **Tune offset** — each user independently selects a frequency within the dongle's bandwidth
- **Demodulation mode** — each user independently selects WFM/NFM/AM/USB/LSB/CW
- **Bandwidth** — each user independently sets filter bandwidth
- **IQ sub-band** — server extracts and sends each user's portion of the spectrum
- **Audio** — demodulated in the client browser, played locally

### 10.3 Scaling

| Resource | Scaling Behavior |
|----------|-----------------|
| Server CPU (FFT) | O(1) per dongle — same FFT regardless of user count |
| Server CPU (IQ extraction) | O(N) per dongle — sub-band extraction per user |
| Server bandwidth (FFT) | O(N) — broadcast to each client |
| Server bandwidth (IQ) | O(N) — per-user IQ stream |
| Client CPU | O(1) — demodulation is local |
| Client bandwidth | Constant per user — one FFT stream + one IQ stream |

Typical bandwidth per user: ~500 KB/s (2048-point FFT at 30fps = ~240 KB/s, plus IQ sub-band).

### 10.4 Profile Switching

When an admin switches a dongle's profile:
1. The `rtl_sdr` process is killed and restarted with new parameters
2. All digital decoders for the old profile are stopped
3. New decoders for the new profile are started
4. A `profile_changed` meta message is sent to all connected clients
5. Clients automatically update their UI (center frequency, mode, waterfall range)

---

## 11. Theming System

### 11.1 UI Themes

Three themes switch via `data-theme` attribute on `<html>`:

| Theme | Attribute | Primary Accent | Aesthetic |
|-------|-----------|---------------|-----------|
| Default | `data-theme="default"` | `#4aa3ff` (cyan) | Modern LCD |
| CRT | `data-theme="crt"` | `#33ff77` (phosphor green) | Retro terminal |
| VFD | `data-theme="vfd"` | `#ffaa00` (amber) | Vacuum fluorescent |

Themes use CSS custom properties (`--sdr-accent`, `--sdr-freq-color`, `--sdr-glow`) that are overridden per-theme. Tailwind `@custom-variant crt/vfd` enables theme-specific utility classes.

### 11.2 Waterfall Color Palettes

Five palettes, independent of UI theme:

| Palette | Colors |
|---------|--------|
| Turbo | Blue → cyan → green → yellow → red (matplotlib turbo) |
| Viridis | Purple → blue → teal → green → yellow (matplotlib viridis) |
| Classic | Black → blue → cyan → yellow → red → white (traditional SDR) |
| Grayscale | Black → white |
| Hot | Black → red → orange → yellow → white |

Each palette is defined as gradient color stops in `client/src/engine/palettes.ts` and expanded to a 256-entry `[r, g, b]` lookup table via linear interpolation.

### 11.3 Tailwind CSS v4

All styling uses Tailwind CSS v4 with the `@theme` directive in `client/src/styles/app.css`. There is no `tailwind.config.js`. The Vite plugin `@tailwindcss/vite` handles compilation.

**Color system:**
- Backgrounds: Near-black with blue tint (`#07090e` → `#1a2435`)
- Text: Blue-white tints (`#d7e0ee` → `#445266`)
- Accents: Cyan, green, amber, red + neon variants
- Status: Online (green), warning (amber), error (red), offline (gray)

---

## 12. Demo Mode

Activated by `NODE_SDR_DEMO=1` environment variable or `demoMode: true` in config.

In demo mode, `DongleManager` substitutes `SignalSimulator` instances for `rtl_sdr` child processes. The simulator generates uint8 I/Q data that is indistinguishable from real hardware output to all downstream consumers.

**Simulation presets are selected based on center frequency:**
- 87–108 MHz → FM broadcast simulation (4 stations)
- 108–137 MHz → Aviation simulation (tower, ATIS, ground, approach)
- 144–148 MHz → Two-meter ham simulation (simplex, repeater, CW, APRS)
- Other → Random noise with a few scattered signals

Demo mode is useful for:
- Development without RTL-SDR hardware
- CI/CD testing
- Conference demos and presentations
- Evaluating the software before purchasing hardware

---

## 13. Deployment

### 13.1 Docker

Multi-stage build:
1. **Builder stage** — `node:22-slim`, installs deps, builds all workspaces
2. **Runtime stage** — `node:22-slim` + `rtl-sdr` + `dump1090-mutability` + `multimon-ng`, copies built artifacts, installs production deps only

USB passthrough requires `privileged: true` and `devices: [/dev/bus/usb:/dev/bus/usb]` on Linux.

### 13.2 Bare Metal

```bash
# Prerequisites
sudo apt install rtl-sdr librtlsdr-dev

# Optional decoders
sudo apt install dump1090-mutability multimon-ng

# Build and run
git clone https://github.com/gbozo/node-sdr.git
cd node-sdr
npm install && npm run build
npm start
```

### 13.3 Raspberry Pi

Tested on Pi 4 (4GB) and Pi 5. Use Node.js 22 ARM64 build. Performance considerations:
- FFT at 2048 points runs comfortably at 30fps
- Audio demodulation is client-side, so Pi CPU isn't affected by user count
- Consider reducing FFT size to 1024 on Pi 3

### 13.4 Reverse Proxy

WebSocket upgrade headers must be forwarded. nginx configuration:
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

---

## 14. Security

### Current State (v0.1)

- **Admin auth**: Simple plaintext password comparison via Bearer token. Suitable for trusted networks only.
- **No user auth**: All listeners are anonymous. The WebSocket endpoint is open.
- **No encryption**: HTTP/WS only. Use a reverse proxy with TLS for public deployments.
- **No rate limiting**: No protection against connection flooding.

### Recommendations for Production

1. Place behind a reverse proxy (nginx/Caddy) with TLS
2. Use HTTP basic auth or OAuth for listener access if needed
3. Set a strong admin password
4. Restrict network access to the server port
5. Consider running in a Docker container for isolation

---

## 15. Performance

### Typical Resource Usage

| Metric | Value | Conditions |
|--------|-------|-----------|
| Server memory | ~50–80 MB | 1 dongle, 10 clients |
| Server CPU | ~5–15% | 1 dongle, 2048 FFT, 2.4 MSPS (single core) |
| Client JS bundle | 51 KB (16 KB gzip) | Full application |
| Client CSS bundle | 23 KB (5 KB gzip) | Tailwind v4 |
| WS bandwidth per client | ~500 KB/s | 2048 FFT @ 30fps + IQ sub-band |
| Audio latency | ~100–200 ms | AudioWorklet ring buffer |

### Bottlenecks

1. **WebSocket broadcast** — O(N) bandwidth for FFT data. Mitigation: use compressed FFT (MSG_FFT_COMPRESSED, ~4x smaller)
2. **IQ extraction** — O(N) CPU for sub-band extraction. Mitigation: could be moved to a worker thread
3. **Canvas rendering** — CPU-bound for FFT sizes > 4096. Mitigation: WebGL renderer (not yet implemented)

---

## 16. Future Work

### Planned Features

- **WebGL waterfall** — GPU-accelerated rendering for large FFT sizes and zoom
- **IQ recording** — save raw IQ to SigMF format for offline analysis
- **Frequency bookmarks** — save and recall frequency/mode/bandwidth presets
- **Responsive mobile UI** — tablet and phone layouts
- **User sessions** — optional authentication for persistent settings
- **Multi-server** — aggregate multiple node-sdr instances behind a gateway
- **Worker threads** — offload FFT and IQ extraction from the main event loop

### Potential Decoder Additions

- DMR/D-Star/YSF (via digiham WASM port)
- DAB/DAB+ (via welle.io WASM port)
- NOAA APT satellite imagery
- Meteor M2 LRPT
- P25 / TETRA
- RDS (FM broadcast metadata)

### Protocol Extensions

- Compressed IQ transport (delta encoding or LZ4)
- Bi-directional audio (TX support for licensed operators)
- Waterfall history (seek-back in time)
