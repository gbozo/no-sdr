# no-sdr Technical Specification

Version 0.8.0 — April 2026

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

no-sdr is a multi-user WebSDR (Software Defined Radio) application that bridges RTL-SDR USB hardware to web browsers over a local network or the internet. It implements a hybrid DSP architecture where computationally shared work (FFT) runs on the server while per-user work (demodulation, audio) runs in each client's browser.

### Design Goals

1. **Multi-user efficiency** — one dongle, many listeners, minimal server CPU per user
2. **Zero client install** — standard browser, no plugins, no WebUSB
3. **Low latency** — real-time waterfall, spectrum, and audio with sub-second delay
4. **Extensibility** — new demodulation modes and decoders added through simple interfaces
5. **Deployability** — Docker, Raspberry Pi, bare metal, cloud VM with remote antenna
6. **Flexible connectivity** — local USB dongles, remote `rtl_tcp` servers, or demo simulation

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
│         │ USB            │ rtl_tcp         │ demo               │
└─────────┼────────────────┼────────────────┼─────────────────────┘
          │                │                │
┌─────────▼────────────────▼────────────────▼─────────────────────┐
│  Server Process (Node.js)                                        │
│                                                                   │
│  ┌──────────────┐                                                │
│  │ DongleManager│ ── local: spawn rtl_sdr                        │
│  │              │ ── rtl_tcp: TCP client (12B header + commands)  │
│  │              │ ── demo: SignalSimulator                        │
│  └──────┬───────┘                                                │
│         │ Buffer (uint8 IQ)                                      │
│         ▼                                                        │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────────┐     │
│  │ FftProcessor │    │ IqExtractor  │    │ DecoderManager │     │
│  │ (per dongle) │    │ (per client) │    │ (per profile)  │     │
│  └──────┬───────┘    └──────┬───────┘    └───────┬────────┘     │
│         │ Float32 dB        │ Int16 IQ           │ JSON          │
│         ▼                   ▼                    ▼               │
│  ┌───────────────────────────────────────────────────────┐      │
│  │                  WebSocketManager                      │      │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐                 │      │
│  │  │Client A │ │Client B │ │Client C │                 │      │
│  │  └─────────┘ └─────────┘ └─────────┘                 │      │
│  └───────────────────────────────────────────────────────┘      │
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
│  └──────────────┘    (FM stereo/      (AudioWorklet              │
│                       AM/SSB/CW)       + 5-band EQ              │
│                                        + balance                 │
│                                        + loudness                │
│                                        + squelch gate)           │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

**Shared path (all clients on a dongle):**
```
Dongle source → Buffer chunks → FftProcessor → Float32Array dB → WebSocket MSG_FFT → client waterfall + spectrum
```

**Per-user path:**
```
Dongle source → Buffer chunks → IqExtractor(offset, bandwidth, outputRate) → Int16Array IQ → WebSocket MSG_IQ → client demodulator → Float32 audio → AudioWorklet → 5-band EQ → balance → loudness → speakers
```

**Digital decoder path:**
```
Dongle source → DecoderManager → stdin of decoder binary → stdout parsed → JSON → WebSocket MSG_DECODER → client UI
```

### 2.3 Monorepo Layout

| Package | Name | Purpose | Dependencies |
|---------|------|---------|-------------|
| `shared/` | `@node-sdr/shared` | Types, protocol, mode definitions | None |
| `server/` | `@node-sdr/server` | HTTP, WebSocket, hardware, FFT, IQ extraction | hono, fft.js, js-yaml, zod, pino |
| `client/` | `@node-sdr/client` | UI, Canvas, DSP, stereo FM, audio + EQ | solid-js, fft.js, tailwindcss |

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
| `0x02` | `MSG_IQ` | `Int16Array` — interleaved I,Q,I,Q... samples of user's sub-band | Variable (depends on bandwidth/mode) | Per-user |
| `0x03` | `MSG_META` | UTF-8 JSON string — `ServerMeta` union type | Variable | Per-user |
| `0x04` | `MSG_FFT_COMPRESSED` | `[Int16 minDb LE][Int16 maxDb LE][Uint8...]` — 4-byte header + dB mapped to 0-255 | fftSize + 5 bytes | Broadcast to dongle |
| `0x05` | `MSG_AUDIO` | `Int16Array` — mono PCM audio samples | Variable | Per-user |
| `0x06` | `MSG_DECODER` | UTF-8 JSON — `{ decoderType, data }` | Variable | Broadcast to dongle |
| `0x07` | `MSG_SIGNAL_LEVEL` | `Float32` — signal strength in dB | 5 bytes | Per-user |
| `0x08` | `MSG_FFT_ADPCM` | IMA-ADPCM encoded FFT: `[Int16 minDb LE][Int16 maxDb LE][10 warmup samples][ADPCM bytes]` | ~fftSize/2 + 15 bytes | Broadcast to dongle |
| `0x09` | `MSG_IQ_ADPCM` | `[Uint32 sampleCount LE][ADPCM bytes]` — IMA-ADPCM compressed IQ | Variable (~50% of raw) | Per-user |
| `0x0B` | `MSG_FFT_DEFLATE` | `[Int16 minDb LE][Int16 maxDb LE][Uint32 binCount LE][raw deflate bytes]` — delta+deflate lossless FFT | Variable (~12% of raw) | Broadcast to dongle |
| `0x0C` | `MSG_AUDIO_OPUS` | `[Uint16 sampleCount LE][Uint8 channels][Opus packet bytes]` — server-side demodulated Opus VBR audio | Variable (~2–24 KB/s) | Per-user |

### 3.3 Server Meta Messages (`MSG_META`)

```typescript
type ServerMeta =
  | { type: 'welcome'; clientId: string; serverVersion: string }
  | { type: 'subscribed'; dongleId: string; profileId: string;
      centerFreq: number; sampleRate: number; fftSize: number;
      iqSampleRate: number; mode: string }
  | { type: 'profile_changed'; dongleId: string; profileId: string;
      centerFreq: number; sampleRate: number; fftSize: number;
      iqSampleRate: number; mode: string }
  | { type: 'dongle_status'; dongleId: string; running: boolean;
      clientCount: number }
  | { type: 'error'; message: string; code?: string }
  | { type: 'admin_auth_ok' }
  | { type: 'decoder_data'; decoderType: string; data: unknown };
```

Note: `iqSampleRate` tells the client the actual output sample rate from the server's IQ extractor (e.g., 240000 for WFM, 48000 for NFM). The client uses this to configure its demodulator.

### 3.4 Client → Server (JSON Text)

All client messages are JSON text with a `cmd` field:

```typescript
type ClientCommand =
  | { cmd: 'subscribe'; dongleId: string; profileId?: string }
  | { cmd: 'unsubscribe' }
  | { cmd: 'tune'; offset: number }      // Hz offset from center
  | { cmd: 'mode'; mode: DemodMode }
  | { cmd: 'bandwidth'; hz: number }
  | { cmd: 'volume'; level: number }      // 0.0 – 1.0
  | { cmd: 'mute'; muted: boolean }
  | { cmd: 'waterfall_settings'; minDb: number; maxDb: number }
  | { cmd: 'codec'; fftCodec?: FftCodecType; iqCodec?: IqCodecType }
  | { cmd: 'audio_enabled'; enabled: boolean }
  | { cmd: 'stereo_enabled'; enabled: boolean }
  | { cmd: 'admin_auth'; password: string }
  | { cmd: 'admin_set_profile'; dongleId: string; profileId: string }
  | { cmd: 'admin_stop_dongle'; dongleId: string }
  | { cmd: 'admin_start_dongle'; dongleId: string };

type FftCodecType = 'none' | 'adpcm' | 'deflate';
type IqCodecType = 'none' | 'adpcm' | 'opus' | 'opus-hq';
type CodecType = FftCodecType | IqCodecType;  // union for backward compat
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
  │ ◄─── MSG_META subscribed ───────── │  (includes iqSampleRate, mode)
  │      (IqExtractor created)         │
  │                                    │
  │ ──── { cmd: codec,                 │
  │        fftCodec: "deflate",        │
  │        iqCodec: "adpcm" } ────────►│  (per-client codec negotiation)
  │                                    │
  │ ◄─── MSG_FFT_DEFLATE (30fps) ───── │  (continuous, broadcast, delta+deflate)
  │                                    │
  │ ──── { cmd: audio_enabled,         │
  │        enabled: true } ───────────►│  (IQ gating: only now sends IQ data)
  │ ◄─── MSG_IQ_ADPCM (per-user) ──── │  (continuous, narrowband, ADPCM compressed)
  │                                    │
  │ ──── { cmd: stereo_enabled,        │
  │        enabled: true } ───────────►│  (server-side stereo toggle for Opus)
  │                                    │
  │ ──── { cmd: tune, offset: 25000 }► │
  │      (IqExtractor NCO retuned)     │
  │                                    │
  │ ──── { cmd: mode, mode: "am" } ──► │
  │      (IqExtractor output rate      │
  │       adjusted: 240k→48k)          │
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
| `POST` | `/api/admin/dongles/:id/profiles` | Profile object | `{ ok, profile }` — creates new profile |
| `PUT` | `/api/admin/dongles/:id/profiles/:pid` | Partial profile | `{ ok, profile }` — updates profile |
| `DELETE` | `/api/admin/dongles/:id/profiles/:pid` | — | `{ ok }` — deletes profile (not active, not last) |
| `POST` | `/api/admin/save-config` | — | `{ ok }` — persists config to YAML on disk |
| `GET` | `/api/admin/status` | — | Full status + memory usage + demoMode flag |

---

## 5. Server Components

### 5.1 DongleManager

**File:** `server/src/dongle-manager.ts`

Manages the lifecycle of RTL-SDR devices. Supports three source types.

**Source types:**

| Source | Mechanism | Connection |
|--------|-----------|------------|
| `local` | Spawns `rtl_sdr -f <freq> -s <rate> -g <gain> -d <index> -` | Child process stdout |
| `rtl_tcp` | TCP socket client to remote `rtl_tcp` server | TCP socket with binary protocol |
| `demo` | `SignalSimulator` instance | In-process EventEmitter |

**rtl_tcp protocol implementation:**
- 12-byte header on connect: 4-byte magic (`RTL0`), 4-byte tuner type, 4-byte gain count
- 5-byte command packets (1 byte command ID + 4 bytes big-endian value):
  - `0x01` SET_FREQUENCY, `0x02` SET_SAMPLE_RATE, `0x03` SET_GAIN_MODE
  - `0x04` SET_GAIN, `0x05` SET_FREQ_CORRECTION, `0x08` SET_AGC_MODE
- Auto-reconnect on disconnect with exponential backoff

**Responsibilities:**
- Spawn/connect to dongle based on source type
- Parse raw IQ data (uint8 interleaved I/Q) into Buffer chunks
- Emit `iq-data` events for downstream consumers (FFT, IQ extractors, decoders)
- Handle profile switching (stop, reconfigure, restart)
- Auto-restart on crash with exponential backoff (max 5 retries)
- Demo mode: global `demoMode` flag overrides per-dongle source type
- Profile CRUD: `addProfile()`, `updateProfile()`, `deleteProfile()` with guardrails

**Events:**
- `iq-data(dongleId, buffer)` — raw IQ chunk available
- `dongle-started(dongleId)` — process/connection established
- `dongle-stopped(dongleId)` — process/connection closed
- `dongle-error(dongleId, error)` — hardware/connection error
- `profile-changed(dongleId, profile)` — active profile switched

### 5.2 FftProcessor

**File:** `server/src/fft-processor.ts`

Computes FFT from raw IQ data and outputs dB magnitude arrays.

**Pipeline:**
1. Accumulate IQ chunks into a buffer of `fftSize` complex samples
2. Convert uint8 IQ pairs to float32 (normalize: `(val - 127.5) / 127.5`)
3. Apply window function (Blackman-Harris default, Hann and Hamming available)
4. Compute FFT via `fft.js` radix-4 algorithm
5. Calculate magnitude: `10 * log10(re² + im²) - normalizationDb`
6. Normalization: `20*log10(N) + 20*log10(windowCoherentGain)` (~57dB for 2048-point Blackman-Harris)
7. DC-center reorder (swap halves)
8. Apply exponential smoothing (configurable averaging factor)
9. **Rate cap**: emit at configurable `targetFps` (default 30, per-profile `fftFps`). Frames between emissions are averaged into a pending frame using incremental mean.
10. Output `Float32Array` of dB values, length = `fftSize`

**Window functions available:** Blackman-Harris (default, best sidelobe suppression), Hann (good general purpose), Hamming (narrower main lobe).

### 5.3 IqExtractor

**File:** `server/src/iq-extractor.ts`

Extracts a narrowband IQ sub-band from the full-bandwidth dongle stream for per-client demodulation.

**Pipeline:**
1. **NCO frequency shift** — numerically controlled oscillator with 4096-entry cos/sin lookup table. Shifts the user's tuned frequency to DC (baseband).
2. **4th-order Butterworth anti-aliasing filter** — two cascaded biquad sections (24 dB/octave rolloff). Designed via bilinear transform with frequency pre-warping. Cutoff at 40% of output sample rate.
3. **Integer decimation** — reduces sample rate from dongle rate (e.g., 2.4 MSPS) to mode-appropriate rate.
4. **Residual byte handling** — seamless processing across chunk boundaries.

**Output sample rates by mode:**

| Mode | Output Rate | Decimation from 2.4 MSPS |
|------|------------|--------------------------|
| WFM | 240,000 Hz | 10× |
| NFM | 48,000 Hz | 50× |
| AM | 48,000 Hz | 50× |
| AM Stereo | 48,000 Hz | 50× |
| USB/LSB | 24,000 Hz | 100× |
| CW | 12,000 Hz | 200× |

**Butterworth filter coefficients** (example for WFM, cutoff 96kHz at 2.4MHz):
- b0 ≈ 0.013, b1 = 2×b0, b2 = b0
- a1 ≈ -1.6, a2 ≈ 0.6

Filter state is reset on frequency change to prevent transient artifacts.

### 5.4 WebSocketManager

**File:** `server/src/ws-manager.ts`

Routes data between dongles and connected clients.

**Per-client state:**
- `dongleId` — subscribed dongle (null if not subscribed)
- `tuneOffset` — frequency offset from center in Hz
- `mode` — demodulation mode
- `bandwidth` — filter bandwidth in Hz
- `isAdmin` — admin-authenticated flag
- `iqExtractor` — per-client IqExtractor instance (created on subscribe)
- `fftCodec` — per-client FFT codec preference (`'none'` | `'adpcm'` | `'deflate'`)
- `iqCodec` — per-client IQ codec preference (`'none'` | `'adpcm'` | `'opus'` | `'opus-hq'`)
- `iqAdpcmEncoder` — per-client IMA-ADPCM encoder instance (created when iqCodec is `'adpcm'`)
- `opusPipeline` — per-client Opus audio pipeline (created when iqCodec is `'opus'` or `'opus-hq'`), includes server-side demodulators
- `iqAccumBuffer` — IQ accumulation buffer for fixed-size chunk delivery (~20ms per message)
- `audioEnabled` — whether client has enabled audio (IQ data only sent when true)

**Data routing:**
- FFT data → broadcast to all clients subscribed to the dongle, lazy-encoded per codec (Uint8 for `none`, ADPCM for `adpcm`, delta+deflate for `deflate`)
- IQ sub-band → extracted per-client via `iqExtractor.process()`, accumulated into fixed ~20ms chunks, optionally ADPCM-compressed, sent only if `audioEnabled`
- Opus audio → when `iqCodec` is `'opus'`/`'opus-hq'`, IQ is demodulated server-side and encoded as Opus VBR packets, sent as `MSG_AUDIO_OPUS`
- Decoder output → broadcast to all clients on the dongle

**Backpressure:**
- FFT broadcast checks `ws.raw.bufferedAmount` against 256KB threshold; skips frame for slow clients
- IQ send checks against 1MB threshold; drops IQ frames for slow clients
- Warning logged once per client until buffer drains

**Command handling:**
- `tune` → updates `tuneOffset`, resets IqExtractor NCO offset + filter state
- `mode` → updates `mode`, adjusts IqExtractor output sample rate + re-initializes filter
- `bandwidth` → updates client bandwidth
- `subscribe` → creates IqExtractor for client, sends `subscribed` meta with `iqSampleRate`
- `codec` → sets per-client `fftCodec`/`iqCodec`, creates/destroys ADPCM encoder or Opus pipeline as needed
- `audio_enabled` → sets `audioEnabled` flag; IQ data only sent when true
- `stereo_enabled` → toggles stereo/mono for Opus pipeline (server-side stereo demod)

**Throughput logging:** Every 5 seconds, logs IQ samples/s in, IQ samples/s out, and total bytes.

### 5.5 DecoderManager

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

### 5.6 SignalSimulator

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
- Signal level computation from FFT data (peak dB in tuned bandwidth, updated every 2 frames at ~15Hz)
- Auto-range dB scaling: tracks min/max/avg over 16 frames, exponential smoothing, targets avg-15 to avg+35 dB
- Squelch gate: mutes IQ audio when `signalLevel < squelchLevel`, with 500ms bypass after tune/mode change
- Stereo control: checks `stereoEnabled && stereoCapable && signalLevel >= stereoThreshold` before using stereo path
- Bandwidth statistics: tracks FFT frames/s, IQ samples/s, total WS bytes/s with 30-second history
- All audio parameters (volume, balance, EQ, loudness) delegated to AudioEngine

### 6.2 WaterfallRenderer

**File:** `client/src/engine/waterfall.ts`

Canvas 2D implementation of a scrolling waterfall spectrogram.

**Algorithm:**
1. `drawRow(fftData, minDb, maxDb)` called from MSG_FFT handler, throttled to 30fps
2. Scroll existing content down 1px using `getImageData` / `putImageData`
3. Create 1-pixel-height ImageData for new row
4. Map each FFT bin to normalized 0-255 index, look up palette color from 256-entry LUT
5. Write RGBA pixels via `putImageData` at row 0

Canvas context created with `{ willReadFrequently: true }` for `getImageData` optimization.

**Palette:** 256-entry `[r, g, b]` lookup table, pre-computed from gradient color stops. Five themes available (turbo, viridis, classic, grayscale, hot).

### 6.3 SpectrumRenderer

**File:** `client/src/engine/spectrum.ts`

Canvas 2D real-time power spectral density chart.

**Features:**
- dB grid lines with labels
- Gradient fill under the spectrum curve
- Tuning indicator: semi-transparent rectangle showing bandwidth window + center frequency dashed line
- Uses CSS `var(--sdr-accent)` for theme-reactive coloring
- Dimension guards: skips drawing when canvas has zero width or height

### 6.4 Demodulators

**File:** `client/src/engine/demodulators.ts`

Pure TypeScript DSP implementations. All operate on Int16 interleaved IQ input and produce Float32 audio output.

**Interface:**
```typescript
interface Demodulator {
  process(iqData: Int16Array): Float32Array;
  processStereo?(iqData: Int16Array): StereoAudio;
  stereoCapable: boolean;
  setInputSampleRate(rate: number): void;
  setBandwidth(hz: number): void;
  reset(): void;
}

interface StereoAudio {
  left: Float32Array;
  right: Float32Array;
  stereo: boolean;  // true if pilot detected
}
```

**DSP building blocks:**
- `FirFilter` — windowed-sinc FIR, Blackman-Harris window, configurable taps + cutoff
- `DcBlocker` — single-pole IIR high-pass (alpha = 0.995)
- `DeemphasisFilter` — single-pole IIR low-pass (75µs US / 50µs EU time constant)
- `Agc` — automatic gain control with configurable attack/decay/maxGain
- `Decimator` — anti-aliasing FIR + integer decimation factor
- `BiquadFilter` — 2nd-order IIR with static `bandpass(centerFreq, Q, sampleRate)` factory
- `PilotPll` — phase-locked loop for 19kHz stereo pilot tracking with SNR-based detection

**Implementations:**

| Class | Modes | Algorithm |
|-------|-------|-----------|
| `FmDemodulator` | WFM, NFM | Polar discriminator, de-emphasis, decimation. WFM: stereo via PLL + 38kHz carrier + L-R matrix with SNR-proportional blend |
| `AmDemodulator` | AM | Envelope detection: `sqrt(I² + Q²)`, DC blocker, AGC |
| `CQuamDemodulator` | AM Stereo | C-QUAM: PLL carrier lock, cosGamma correction, L+R from envelope, L-R from quadrature, 25Hz Goertzel pilot, notch filter |
| `SsbDemodulator` | USB, LSB | Conjugate flip for LSB, BFO frequency shift via complex oscillator, take real part, AGC |
| `CwDemodulator` | CW | 700Hz BFO mixing, narrow FIR bandpass, AGC |
| `RawDemodulator` | RAW | Passthrough (I channel only) |

**Stereo FM (WFM only):**
1. FM discriminator → composite MPX signal at 240kHz sample rate
2. PLL locks onto 19kHz pilot tone (PI loop filter, ~50Hz loop bandwidth)
3. SNR-based detection: narrowband BPF (Q=50) energy vs broadband energy. Hysteresis: ON > 0.008, OFF < 0.003
4. **SNR-proportional stereo blend**: `blendFactor` = continuous 0.0–1.0 mapped from SNR range [0.003, 0.015] with smoothed attack (alpha=0.02) and release (alpha=0.005). Replaces hard on/off switch.
5. PLL output: `cos(2 × pilotPhase)` = 38kHz carrier for L-R demodulation
6. L+R: low-pass 15kHz from composite
7. L-R: `2 × composite × cos(38kHz)` → low-pass 15kHz
8. Stereo matrix: `L = L+R + blend × L-R`, `R = L+R - blend × L-R`
9. Per-channel de-emphasis (75µs) + decimation (240k→48k) + DC blocking
10. Falls back to mono (blend=0) when pilot signal is weak

**AM Stereo — C-QUAM (AM Stereo mode):**
1. 2nd-order PLL (zeta=0.707, omegaN=100) locks to carrier
2. Fast envelope: `max(|I|,|Q|) + 0.4*min(|I|,|Q|)`
3. `cosGamma` IIR correction: `cosGamma += 0.005 * (I/env - cosGamma)`
4. Stereo extraction: `L+R = env*cosGamma - 1`, `L-R = Q/cosGamma`
5. 25Hz Goertzel pilot detection (evaluated every 50ms, stereo when lockLevel > 0.8 && pilotMag > 0.001)
6. Per-channel biquad notch filter (9kHz, adaptive to bandwidth) + FIR LPF (5kHz, 31-tap) + DC blocker + AGC
7. No de-emphasis needed (C-QUAM uses flat frequency response)

**Factory:** `getDemodulator(mode)` returns cached demodulator instances. `resetDemodulator(mode)` clears a specific cache entry.

### 6.5 AudioEngine

**File:** `client/src/engine/audio.ts`

Web Audio API with AudioWorklet for low-latency stereo playback and audio processing.

**Audio graph:**
```
AudioWorkletNode (jitter buffer, stereo L/R ring buffers)
    ↓
StereoPannerNode (balance: -1 to +1)
    ↓
BiquadFilterNode — lowshelf 80Hz (EQ LOW)
    ↓
BiquadFilterNode — peaking 500Hz Q=1.0 (EQ L-MID)
    ↓
BiquadFilterNode — peaking 1.5kHz Q=1.0 (EQ MID)
    ↓
BiquadFilterNode — peaking 4kHz Q=1.0 (EQ H-MID)
    ↓
BiquadFilterNode — highshelf 12kHz (EQ HIGH)
    ↓
GainNode (loudness pre-boost: 1.0 or 1.8×)
    ↓
DynamicsCompressorNode (loudness: threshold -30dB, ratio 8:1, or bypassed)
    ↓
GainNode (master volume: 0.0–1.0)
    ↓
AudioContext.destination
```

**AudioWorklet processor:**
- Separate L/R ring buffers (3 seconds at 48kHz each)
- Jitter buffer: 150ms minimum fill (7200 samples) before starting playback, 200ms target (9600 samples)
- Adaptive rate control: when buffer >300ms, consumes 129 samples/frame (drain); when <150ms, consumes 127 (fill); normal 128
- Overflow protection: drops oldest data + 100ms headroom when buffer would exceed capacity
- Underrun detection: goes silent and waits for minimum fill before resuming
- Message protocol: `'reset'` (flush), `{ left, right? }` (stereo/mono), `Float32Array` (legacy mono)

**Methods:**
- `pushDemodulatedAudio(Float32Array)` — mono (duplicated to both channels)
- `pushStereoAudio(left, right)` — true stereo from FM demodulator
- `resetBuffer()` — flushes worklet on frequency/mode change
- `setBalance(value)`, `setEqLow(dB)`, `setEqLowMid(dB)`, `setEqMid(dB)`, `setEqHighMid(dB)`, `setEqHigh(dB)` — all ±12dB
- `setLoudness(enabled)` — toggles compression + pre-boost
- `setVolume(volume)`, `setMuted(muted)`

### 6.6 SolidJS Store

**File:** `client/src/store/index.ts`

SolidJS signals for UI state only. Hot data (FFT, audio) bypasses the store entirely.

**Signal groups:**
- Connection: `connected`, `clientId`
- Dongle: `activeDongleId`, `activeProfileId`, `availableDongles`
- Tuning: `centerFrequency`, `tuneOffset`, `mode`, `bandwidth`, `sampleRate`
- Audio: `volume`, `muted`, `squelch`, `signalLevel`, `balance`, `loudness`
- EQ: `eqLow`, `eqLowMid`, `eqMid`, `eqHighMid`, `eqHigh` (all dB, default 0)
- Stereo: `stereoEnabled`, `stereoDetected`, `stereoThreshold`
- Noise Reduction: `nrEnabled`, `nrStrength`, `nbEnabled`, `nbLevel`
- Codec: `fftCodec` (`FftCodecType`, default `'deflate'`), `iqCodec` (`IqCodecType`, default `'adpcm'`)
- Codec Stats: `fftWireBytes`, `fftRawBytes`, `iqWireBytes`, `iqRawBytes` (bytes/sec)
- Display: `waterfallTheme`, `uiTheme`, `waterfallMin`, `waterfallMax`, `waterfallAutoRange`, `fftSize`, `iqSampleRate`, `meterStyle` (`'bar'` | `'needle'`)
- Stats: `fftRate`, `iqRate`, `wsBytes`, `wsBytesHistory` (30-second array)
- UI: `sidebarOpen`, `decoderPanelOpen`, `isAdmin`

**Computed:** `tunedFrequency = centerFrequency + tuneOffset`

### 6.7 UI Components

**`App.tsx`** — Main layout: header bar (logo, connection dot, theme buttons), audio start prompt, collapsible sidebar (320px) + main area (frequency display, waterfall/spectrum), status bar footer with bandwidth meter.

**`WaterfallDisplay.tsx`** — Two stacked canvases: spectrum (180px fixed) and waterfall (flex). Click-to-tune via `pixelToFreqOffset()`. ResizeObserver for responsive sizing. `requestAnimationFrame` initial resize.

**`FrequencyDisplay.tsx`** — LCD-style dotted frequency readout (e.g., `100.000.000 MHz`). Digit groups are individually hoverable with scroll-to-tune (mouse wheel changes frequency in units matching the digit group).

**`ControlPanel.tsx`** — Sidebar panels:
- **SMeter** — bar or classic analog needle meter (canvas-drawn, warm backlit face, dual S-unit + dB scale, red needle, peak hold). Toggle between bar/needle styles.
- **ModeSelector** — 8 mode buttons (WFM, NFM, AM, AMS, USB, LSB, CW, RAW) with active state + inline filter bandwidth slider
- **AudioControls** — volume slider, mute button, loudness toggle, stereo indicator (WFM/AMS: badge glows green when pilot detected)
- **NoiseReduction** — spectral NR (on/off + strength slider) and noise blanker (on/off + threshold slider)
- **StereoSettings** — on/off toggle + signal threshold slider (WFM/AMS only)
- **BalanceControl** — slider with L/C/R labels, min-width text display
- **5-Band EQ** — vertical sliders for LOW/L-M/MID/H-M/HIGH with dB labels, color feedback (cyan=boost, amber=cut), reset button
- **SquelchControl** — adjustable dB threshold slider
- **WaterfallSettings** — 5 palette buttons, min/max dB sliders, auto-scale toggle
- **CodecSettings** — FFT codec toggles (None/ADPCM/Deflate) and IQ codec toggles (None/ADPCM/Opus/Opus HQ) with live compression ratio, wire bandwidth, and savings stats
- **ConnectionStatus** — connected/disconnected indicator
- **DongleSelector** — dongle + profile dropdown
- **AdminPanel** — login, dongle start/stop, profile switch

---

## 7. Configuration

### 7.1 Schema

Configuration is loaded from YAML and validated with Zod schemas at startup.

```typescript
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
  deviceIndex?: number        // for local source
  name: string
  serial?: string
  ppmCorrection: number       // default 0
  autoStart: boolean          // default true
  source: SourceConfig
  profiles: DongleProfile[]
  // Hardware options (all optional)
  directSampling?: 0 | 1 | 2 // 0=off, 1=I-branch, 2=Q-branch (for HF <24MHz)
  biasT?: boolean             // bias-T power for active antennas
  digitalAgc?: boolean        // RTL2832U internal digital AGC
  offsetTuning?: boolean      // E4000 offset tuning mode
  ifGain?: [number, number][] // IF gain stages [[stage, dB], ...] (E4000 only)
  tunerBandwidth?: number     // hardware anti-alias filter Hz (rtl-sdr-blog fork)
}

SourceConfig {
  type: 'local' | 'rtl_tcp' | 'demo'
  host?: string             // rtl_tcp only
  port?: number             // rtl_tcp only
  binary?: string           // local only (override rtl_sdr path)
  extraArgs?: string[]      // local only (additional CLI args)
}

DongleProfile {
  id: string
  name: string
  centerFrequency: number   // Hz
  sampleRate: number        // Hz
  fftSize: number           // power of 2, default 2048, max 65536
  fftFps: number            // FFT frame rate cap, 1-60, default 30
  defaultMode: DemodMode
  defaultTuneOffset: number
  defaultBandwidth: number
  gain: number | null       // null = auto
  description: string
  decoders: DecoderConfig[]
}

DecoderConfig {
  type: DigitalMode
  enabled: boolean
  frequencyOffset: number   // Hz from center
  bandwidth: number         // Hz
  binary?: string           // override default binary path
  args?: string[]           // override default command-line args
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
1. The dongle process/connection is stopped
2. The dongle is reconfigured with new frequency/rate/gain
3. The dongle process/connection is restarted
4. All connected clients receive a `profile_changed` meta message (includes `iqSampleRate` and `mode`)
5. Client waterfall, spectrum, frequency displays, and demodulators update automatically

**Runtime profile CRUD** via admin REST API:
- Create: `POST /api/admin/dongles/:id/profiles` — auto-saves to disk
- Update: `PUT /api/admin/dongles/:id/profiles/:pid` — auto-saves to disk
- Delete: `DELETE /api/admin/dongles/:id/profiles/:pid` — cannot delete active profile or last remaining profile

### 7.3 Config Persistence

The `saveConfig()` function serializes the current in-memory config back to YAML and writes it to disk at the resolved config path. This is called automatically on profile CRUD operations.

### 7.4 File Locations

The config file is searched in order:
1. `$NODE_SDR_CONFIG` environment variable
2. `config/config.yaml` (relative to project root, resolved via `import.meta.url`)
3. `../config/config.yaml` (relative to server dist directory)

If no config file is found, a default config with demo mode enabled is used.

---

## 8. DSP Pipeline

### 8.1 Server-Side FFT

**Input:** Raw uint8 interleaved IQ from dongle source.

**Processing chain:**
```
uint8 I,Q pairs
    ↓ normalize: (val - 127.5) / 127.5
float32 complex samples [re, im, re, im, ...]
    ↓ accumulate fftSize samples
    ↓ apply window function (Blackman-Harris)
    ↓ FFT (fft.js radix-4)
complex spectrum [re, im, re, im, ...]
    ↓ magnitude: 10 * log10(re² + im²) - normalizationDb
    ↓ normalizationDb = 20*log10(N) + 20*log10(windowCoherentGain)
    ↓ DC-center reorder (swap halves)
    ↓ exponential averaging
Float32Array dB magnitudes [fftSize values]
```

**Normalization:** The FFT output is normalized by subtracting `20*log10(N) + 20*log10(windowCoherentGain)` dB. For N=2048 with Blackman-Harris window, this is approximately 57 dB. This ensures output values represent meaningful signal power in dBFS.

**FFT rate:** Depends on sample rate and FFT size. At 2.4 MSPS and 2048-point FFT: ~1172 FFTs/second possible. Server-side rate cap (configurable `fftFps` per profile, default 30) averages excess frames into a pending frame using incremental mean. Effective broadcast rate matches `fftFps`.

### 8.2 Per-Client IQ Sub-Band Extraction

The `IqExtractor` performs per-client narrowband extraction from the wideband dongle stream:

```
uint8 IQ (full bandwidth, e.g., 2.4 MSPS)
    ↓ normalize to float [-1, +1]
    ↓ NCO frequency shift (4096-entry cos/sin LUT)
    ↓ 4th-order Butterworth LPF (2 cascaded biquads, 24 dB/oct)
    ↓ cutoff = 0.4 × outputRate
    ↓ integer decimate (e.g., 10× for WFM: 2.4M → 240k)
    ↓ scale to Int16 range (×32767)
Int16Array interleaved I,Q sub-band
```

**Butterworth filter design:**
- Bilinear transform with frequency pre-warping: `ωd = 2·fs·tan(π·fc/fs)`
- Two cascaded 2nd-order sections for 4th-order (24 dB/octave rolloff)
- Coefficients computed at startup and on mode change
- Filter state (`x1, x2, y1, y2` per section, per I and Q channel) reset on retune

**Performance:** At 2.4 MSPS, IQ extraction runs at ~6.7× real-time per client (149ms wall time for 1 second of input data).

### 8.3 Client-Side Demodulation

**FM Demodulation (WFM/NFM):**
```
Int16 IQ → float I,Q → polar discriminator → [stereo or mono path] → de-emphasis → decimate → Float32 audio
```
The polar discriminator computes instantaneous frequency: `atan2(Q[n]·I[n-1] - I[n]·Q[n-1], I[n]·I[n-1] + Q[n]·Q[n-1])`.

WFM stereo path: composite MPX → PLL pilot lock → 38kHz carrier generation → L-R DSB-SC demod → stereo matrix → per-channel de-emphasis → decimate 240k→48k.

WFM mono: discriminator → 15kHz LPF → de-emphasis → decimate 240k→48k.

NFM: discriminator → de-emphasis → direct 48kHz output (no decimation).

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

**Performance:** FM demodulation runs at ~38× real-time (26ms for 1 second of 240kHz IQ input).

### 8.4 Audio Processing Chain

After demodulation, audio passes through the Web Audio API graph:

```
Float32 samples (48kHz, mono or stereo)
    ↓ AudioWorklet adaptive jitter buffer (150ms min fill, 200ms target, 3s ring buffer)
    ↓ StereoPannerNode (balance control)
    ↓ 5-band parametric EQ (lowshelf 80Hz → peaking 500Hz → peaking 1.5kHz → peaking 4kHz → highshelf 12kHz)
    ↓ Loudness: GainNode pre-boost (1.8× when ON) → DynamicsCompressorNode (threshold -30dB, ratio 8:1)
    ↓ Master GainNode (volume)
    ↓ Speakers
```

**Squelch gate:** Implemented in SdrEngine (not AudioEngine). When `signalLevel < squelchLevel` and not in grace period, IQ audio samples are not pushed to the worklet. Grace period of 500ms after tune/mode changes prevents squelch from blocking audio while signal level is still updating.

### 8.5 IMA-ADPCM Compression

**File:** `shared/src/adpcm.ts`

Standard IMA-ADPCM codec providing 4:1 lossy compression (Int16 → 4-bit nibbles). Uses the standard 89-entry step table and 16-entry index table.

**Classes:**
- `ImaAdpcmEncoder` — streaming encoder with `encode(pcm: Int16Array): Uint8Array` and `reset()`
- `ImaAdpcmDecoder` — streaming decoder with `decode(adpcm: Uint8Array): Int16Array` and `reset()`
- State (predictor + stepIndex) persists across calls for streaming. Reset on reconnect or mode change.

**FFT compression helpers:**
- `encodeFftAdpcm(fftData, minDb, maxDb)` — scales Float32 dB to Int16 (dB×100), prepends 10 warmup samples (for predictor convergence), encodes with fresh encoder (stateless per frame), returns Uint8Array with 4-byte header (Int16 minDb + Int16 maxDb LE). ~8:1 total vs raw Float32.
- `decodeFftAdpcm(payload)` — reverses the above, returns Float32Array of dB values.

**IQ compression:**
- Per-client `ImaAdpcmEncoder` instance on server, per-client `ImaAdpcmDecoder` on client
- Wire format: `[0x09][Uint32 sampleCount LE][ADPCM bytes]`
- Sample count needed because ADPCM output is always even-length (pairs of nibbles)

**Codec negotiation:** Client sends `{ cmd: 'codec', fftCodec: 'deflate', iqCodec: 'adpcm' }`. Server creates per-client encoder instances. FFT codecs: `none` (Uint8), `adpcm` (~8:1), `deflate` (~10:1 lossless, default). IQ codecs: `none` (raw Int16), `adpcm` (4:1, default), `opus` (32kbps server-side demod), `opus-hq` (128kbps server-side demod).

### 8.6 Noise Reduction

**File:** `client/src/engine/noise-reduction.ts`

Client-side audio noise reduction applied after demodulation, before AudioWorklet.

**SpectralNoiseReducer:**
- 512-point FFT with Hann window, 75% overlap (hop = N/4), COLA normalization
- Minimum-statistics noise floor estimation (alpha=0.015, 150-frame window ≈1.5s, 1.5× bias correction, 40-frame priming)
- Wiener gain: `G(k) = max(spectralFloor, 1 - overSubtraction * N(k)/|X(k)|²)`
- Strength 0–1 maps: overSubtraction 0.3–2.0, spectralFloor 0.20–0.06
- Per-bin gain smoothing: `prev*0.3 + gain*0.7`
- Stereo: left channel computes gain mask, right channel reuses shared mask
- **Known limitation:** produces robotic artifacts on music/tonal signals. Noise blanker recommended instead for WFM.

**NoiseBlanker:**
- EMA amplitude tracking (alpha=0.001 ≈ 2ms at 48kHz)
- Threshold: maps strength 0–1 to multiplier 6–2× average amplitude
- 7-sample hang timer after spike detection
- 8-sample delay line for look-ahead
- Smooth gain transitions (0.25 attack, 0.1 recovery)
- Effective for impulse noise (AM/HF), power line interference

**NoiseReductionEngine:** Unified controller with dual L/R instances for stereo. Methods: `setNrEnabled()`, `setNrStrength()`, `setNbEnabled()`, `setNbLevel()`, `processMono()`, `processStereo()`, `reset()`.

### 8.7 Delta+Deflate FFT Compression

**Message type:** `MSG_FFT_DEFLATE` (0x0B)

Lossless FFT compression using spatial delta encoding + zlib raw deflate. The default FFT codec.

**Server encode pipeline:**
1. `compressFft()` quantizes Float32 dB to Uint8 (0-255) with fixed range (-130 to 0 dB)
2. Delta-encode the Uint8 array: first byte absolute, subsequent bytes are wrapping differences `uint8[i] - uint8[i-1]`
3. Compress delta buffer with `zlib.deflateRawSync(delta, { level: 6 })`
4. Prepend 8-byte header: `[Int16 minDb LE][Int16 maxDb LE][Uint32 binCount LE]`

**Client decode pipeline:**
1. Read 8-byte header (minDb, maxDb, binCount)
2. Inflate with `fflate.inflateSync()` (14KB pure JS library)
3. Undo delta: running sum to reconstruct Uint8 dB values
4. Map Uint8 to Float32 dB using header min/max range

**Performance:**
- Real-world FM broadcast: ~10:1 vs raw Float32 (better than ADPCM's fixed 8:1 because real spectra have smooth gradients that delta+deflate exploits)
- Demo simulator: ~7.5:1 at 16384 bins
- ADPCM is fixed 8:1 regardless of spectrum content
- Encode: ~20µs per frame, decode: ~60µs (vs ADPCM ~5µs each)
- Default codec since v0.7.0

### 8.8 Opus VBR Audio Compression

**File:** `server/src/opus-audio.ts`

Server-side demodulation + Opus VBR encoding for ultra-low-bandwidth audio delivery. When a client selects `iqCodec: 'opus'` or `'opus-hq'`, the server demodulates IQ data and sends compressed audio instead of raw IQ.

**Two quality tiers:**

| Codec | Mono Bitrate | Stereo Bitrate | Use Case |
|-------|-------------|---------------|----------|
| `opus` | 32 kbps | 64 kbps | Low bandwidth, voice-quality |
| `opus-hq` | 128 kbps | 192 kbps | High quality, music-capable |

**Server-side demodulators** (simplified versions of client-side DSP):
- `FmStereoDemod` — WFM with PLL stereo (19kHz pilot, SNR-proportional blend, de-emphasis, 240k→48k decimation)
- `CQuamStereoDemod` — C-QUAM AM stereo (PLL, cosGamma, 25Hz Goertzel pilot, notch filter)
- `FmMonoDemod` — NFM with de-emphasis
- `AmMonoDemod` — AM envelope detection + AGC
- `SsbMonoDemod` — SSB with AGC
- `CwMonoDemod` — CW with 700Hz BFO + AGC

**Pipeline:**
```
IQ (Int16Array from IqExtractor)
    ↓ Server-side demod → Float32 audio (mono or stereo)
    ↓ Resample to 48kHz if needed (linear interpolation for SSB/CW)
    ↓ Accumulate 960 samples (20ms frame)
    ↓ Convert to Int16 PCM buffer
    ↓ opusscript WASM encode → Opus packet (55-91 bytes typical)
    ↓ Pack: [0x0C][Uint16 sampleCount][Uint8 channels][Opus bytes]
    ↓ WebSocket send
```

**Dynamic stereo switching:** When the demodulator detects stereo (PLL lock + pilot), the pipeline switches from 1-channel to 2-channel Opus encoding dynamically. The `channels` byte in the wire format tells the client which mode each packet uses. Client auto-recreates the Opus decoder on stereo↔mono transitions.

**Dependencies:** `opusscript` (Emscripten WASM, ~948KB) on server, `opus-decoder` (85.5KB inline WASM) on client.

**Stereo control:** Client sends `{ cmd: 'stereo_enabled', enabled: boolean }` to toggle server-side stereo on/off. Server sets `forceMono` flag in the pipeline.

### 8.9 Server-Side IQ Chunk Accumulation

**File:** `server/src/ws-manager.ts`

IQ extractor output is variable-sized (depends on dongle chunk size and decimation ratio). To prevent audio fragmentation, the server accumulates IQ samples into fixed ~20ms chunks before sending.

**Per-client accumulation buffer:**
- Target duration: 20ms (`IQ_CHUNK_DURATION_S = 0.020`)
- Buffer size: `Math.ceil(sampleRate × 0.020) × 2 × 2` bytes (I+Q pairs as Int16)
- WFM (240kHz): 9600 Int16 values per chunk
- NFM (48kHz): 1920 Int16 values per chunk
- CW (12kHz): 480 Int16 values per chunk

Buffer is reset on subscribe, mode change, tune, and codec change. Opus path bypasses this (has its own 960-sample frame accumulation).

### 8.10 Client-Side Resampler

**File:** `client/src/engine/sdr-engine.ts`

Demodulators for SSB (24kHz) and CW (12kHz) output audio at rates below the 48kHz AudioWorklet sample rate. A linear interpolation resampler upsamples to 48kHz.

- `resampleRatio`: 1 for WFM/NFM/AM (48kHz output), 2 for SSB, 4 for CW
- `resampleTo48k(samples)`: fractional phase linear interpolation with phase continuity across calls
- `resampleStereoTo48k(left, right)`: synchronized dual-channel resampling
- Applied after noise reduction, before AudioWorklet push

### 8.11 RDS Decoder

**File:** `client/src/engine/rds-decoder.ts`

Client-side FM RDS (Radio Data System) decoder. Taps the composite MPX signal from the WFM FM discriminator at 240kHz.

**DSP chain:**
1. Cascaded BPF at 57kHz (2× biquad Q=10)
2. NCO mix-down to baseband (57kHz)
3. Decimate ÷10 → 24kHz
4. LPF 2.4kHz (biquad Butterworth)
5. SymbolSync (integrate-and-dump, ~10 samples/symbol at 2375 baud)
6. BiphaseDecoder (differential Manchester, 128-symbol clock polarity window)
7. DeltaDecoder (differential → absolute)
8. BlockSync (26-bit shift register, CRC syndrome check with IEC 62106 parity matrix, 5 block offsets A/B/C/C'/D)
9. GroupParser (types 0A/0B → PS name, 2A/2B → RadioText, 4A → Clock Time, AF decoding)

**Output data:**
```typescript
interface RdsData {
  pi?: number;       // Programme Identification (hex)
  ps?: string;       // Programme Service name (8 chars)
  rt?: string;       // RadioText (64 chars)
  pty?: number;      // Programme Type (0-31)
  ptyName?: string;  // PTY label
  tp?: boolean;      // Traffic Programme
  ta?: boolean;      // Traffic Announcement
  ms?: boolean;      // Music/Speech
  ct?: string;       // Clock Time
  af?: number[];     // Alternative Frequencies (MHz)
  synced: boolean;   // Block sync acquired
}
```

**Integration:** `FmDemodulator` creates `RdsDecoder` when wideband. `processWfmStereo()` feeds each composite sample to `rdsDecoder.pushSample()`. `SdrEngine` wires RDS callback to store signals. UI overlay in `WaterfallDisplay.tsx` shows RDS logo + PS name + RadioText + PTY/PI.

**CPU overhead:** <0.5% (57kHz BPF + NCO + ÷10 decimate + symbol sync + bit processing).

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
- **IQ sub-band** — server runs IqExtractor per client (NCO + Butterworth + decimate)
- **Audio** — demodulated in the client browser, played locally
- **Stereo** — each user can independently toggle stereo FM on/off
- **EQ/balance/loudness** — entirely client-side, independent per user

### 10.3 Scaling

| Resource | Scaling Behavior |
|----------|-----------------|
| Server CPU (FFT) | O(1) per dongle — same FFT regardless of user count |
| Server CPU (IQ extraction) | O(N) per dongle — one IqExtractor per client |
| Server bandwidth (FFT) | O(N) — broadcast to each client |
| Server bandwidth (IQ) | O(N) — per-user IQ stream (rate depends on mode) |
| Client CPU | O(1) — demodulation + audio processing is local |
| Client bandwidth | Constant per user — one FFT stream + one IQ stream |

Typical bandwidth per user (with ADPCM compression): ~125–300 KB/s (2048-point FFT ADPCM at 30fps ≈ 30 KB/s, plus IQ ADPCM sub-band: WFM ≈ 240 KB/s, NFM ≈ 48 KB/s, CW ≈ 12 KB/s). Without compression (raw): ~500–1200 KB/s.

### 10.4 Profile Switching

When an admin switches a dongle's profile:
1. The dongle source (process/socket/simulator) is stopped and restarted with new parameters
2. All digital decoders for the old profile are stopped
3. New decoders for the new profile are started
4. A `profile_changed` meta message is sent to all connected clients (includes new `iqSampleRate` and `mode`)
5. Clients automatically update their UI (center frequency, mode, waterfall range) and reconfigure demodulators

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

In demo mode, `DongleManager` substitutes `SignalSimulator` instances for real dongle sources. The global `demoMode` flag overrides per-dongle `source.type`. The simulator generates uint8 I/Q data that is indistinguishable from real hardware output to all downstream consumers.

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

### 13.2 Docker with rtl_tcp Sidecar

For environments where USB passthrough is impractical (cloud VMs, Kubernetes), run `rtl_tcp` in a sidecar container and configure the dongle source as `rtl_tcp`:

```yaml
services:
  rtl_tcp:
    image: kosniaz/rtl_tcp
    devices: [/dev/bus/usb:/dev/bus/usb]
    privileged: true
    command: ["-a", "0.0.0.0", "-p", "1234"]
  no-sdr:
    build: { context: .., dockerfile: docker/Dockerfile }
    ports: ["3000:3000"]
    depends_on: [rtl_tcp]
```

### 13.3 Bare Metal

```bash
sudo apt install rtl-sdr librtlsdr-dev        # prerequisites
sudo apt install dump1090-mutability multimon-ng  # optional decoders
git clone https://github.com/gbozo/no-sdr.git
cd no-sdr && npm install && npm run build && npm start
```

### 13.4 Raspberry Pi

Tested on Pi 4 (4GB) and Pi 5. Use Node.js 22 ARM64 build. Performance considerations:
- FFT at 2048 points runs comfortably at 30fps
- Audio demodulation is client-side, so Pi CPU isn't affected by user count
- IQ extraction is O(N) per client — consider reducing sample rate on Pi 3
- Consider reducing FFT size to 1024 on Pi 3

### 13.5 Reverse Proxy

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

### Current State (v0.2)

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
| IQ extraction | 6.7× real-time | Per client, 2.4 MSPS → 240k (WFM) |
| Client FM demod | 38× real-time | 240kHz IQ → 48kHz audio |
| Client JS bundle | ~213 KB (~60 KB gzip) | Full application (includes fflate + opus-decoder WASM) |
| Client CSS bundle | ~26 KB (~5.7 KB gzip) | Tailwind v4 |
| WS bandwidth (deflate FFT + ADPCM IQ) | ~55–270 KB/s | Deflate FFT ~20 KB/s + ADPCM IQ 48–240 KB/s |
| WS bandwidth (deflate FFT + Opus) | ~22–28 KB/s | Deflate FFT ~20 KB/s + Opus 2–8 KB/s |
| WS bandwidth (raw) | ~500–1200 KB/s | 2048 FFT Float32 @ 30fps + raw IQ sub-band |
| Audio latency | ~150–250 ms | AudioWorklet adaptive jitter buffer |

### Bottlenecks

1. **WebSocket broadcast** — O(N) bandwidth for FFT data. Mitigation: ADPCM compression (~8:1 vs raw Float32), backpressure with frame skipping for slow clients
2. **IQ extraction** — O(N) CPU for per-client sub-band extraction. Mitigation: could be moved to a worker thread; ADPCM compression reduces bandwidth 4:1
3. **Canvas rendering** — CPU-bound for FFT sizes > 4096. Mitigation: WebGL renderer (not yet implemented)

---

## 16. Future Work

### Planned Features

- **WebGL waterfall** — GPU-accelerated rendering for large FFT sizes and zoom
- **IQ recording** — save raw IQ to SigMF format for offline analysis
- **Frequency bookmarks** — save and recall frequency/mode/bandwidth presets
- **Responsive mobile UI** — tablet and phone layouts
- **User sessions** — optional authentication for persistent settings
- **Multi-server** — aggregate multiple no-sdr instances behind a gateway
- **Worker threads** — offload FFT and IQ extraction from the main event loop
- **Spectral NR rework** — current Wiener filter has robotic artifacts; consider RNNoise (WASM), multi-band expander

### Potential Decoder Additions

- DMR/D-Star/YSF (via digiham WASM port)
- DAB/DAB+ (via welle.io WASM port)
- NOAA APT satellite imagery
- Meteor M2 LRPT
- P25 / TETRA

### Protocol Extensions

- Bi-directional audio (TX support for licensed operators)
- Waterfall history (seek-back in time)
