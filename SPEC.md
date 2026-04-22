# no-sdr Technical Specification

Version 0.8.0 — April 2026

## Table of Contents
- 1. System Overview
- 2. Architecture
- 3. WebSocket Protocol
- 4. REST API
- 5. Server Components
- 6. Client Components
- 7. Configuration
- 8. DSP Pipeline
- 9. Digital Decoders
- 10. Multi-User Model
- 11. Theming System
- 12. Demo Mode
- 13. Deployment
- 14. Security
- 15. Performance
- 16. Visuals
- 17. Future Work

---

## 1. System Overview

no-sdr is a multi-user WebSDR (Software Defined Radio) application that bridges RTL-SDR USB hardware to web browsers over a local network or the internet. It implements a hybrid DSP architecture where computationally shared work (FFT) runs on the server while per-user work (demodulation, audio) runs in each client's browser.

### Design Goals

- Multi-user efficiency — one dongle, many listeners, minimal server CPU per user
- Zero client install — standard browser, no plugins, no WebUSB
- Low latency — real-time waterfall, spectrum, and audio with sub-second delay
- Extensibility — new demodulation modes and decoders added through simple interfaces
- Deployability — Docker, Raspberry Pi, bare metal, cloud VM with remote antenna
- Flexible connectivity — local USB dongles, remote `rtl_tcp` servers, or demo simulation

### Constraints

- RTL-SDR dongles have a maximum sample rate of ~3.2 MSPS (stable at 2.4 MSPS)
- RTL-SDR frequency range: 24 MHz – 1.766 GHz (R820T2 tuner)
- Each dongle can only tune to one center frequency at a time
- All users on a dongle share the same bandwidth window

---

## 2. Architecture

### 2.1 Architecture Diagram
![Architecture Diagram](docs/images/architecture-diagram-simple.svg)

### 2.2 Data Flow (SVG: data-flow-simple.svg)
![Data Flow Diagram](docs/images/data-flow-simple.svg)

- ### 2.3 Data Flow Details (brief)
- Shared path: Dongle source -> Buffer chunks -> FftProcessor -> Float32Array dB -> MSG_FFT -> client waterfall + spectrum
- Per-user path: Dongle source -> IqExtractor -> Int16 IQ -> MSG_IQ -> client demodulator -> Float32 audio
- 
- ### 3.5 Typical Session Flow
- ![Session Flow Diagram](docs/images/session-flow-simple.svg)
- 
- ---
- Per-user path: Dongle source -> IqExtractor -> Int16 IQ -> MSG_IQ -> client demodulator -> Float32 audio

---

## 3. WebSocket Protocol
![WebSocket Protocol Diagram](docs/images/websocket-simple.svg)

Overview of the binary protocol and exchange is defined in the README; see the code for details.

---

## 4. REST API
See server REST endpoints in the codebase:
- GET /api/status
- GET /api/dongles
- GET /api/dongles/:id
- etc.

---

## 5. Server Components
Documentation section exists in the repository; refer to server/src for exact details.

---

## 6. Client Components
Documentation section exists in the repository; refer to client/src for exact details.

---

## 7. Configuration
Specification for YAML config validated via Zod is in config/config.yaml and related TypeScript types.

---

## 8. DSP Pipeline
Outline of server-side FFT, per-client IQ extraction, demodulation, and client-side audio processing.

---

## 9. Digital Decoders
Spawns external binaries for decoding subsystems; see DecoderManager.

---

## 10. Multi-User Model
Details on dongle sharing and client multiplexing.

---

## 11. Theming System
Theme switching and color palettes.

---

## 12. Demo Mode
Demo signal simulators and presets.

---

## 13. Deployment
Docker, Raspberry Pi, and cloud deployment guidance.

---

## 14. Security
Security considerations and best practices.

---

## 15. Performance
Performance notes and planning.

---

## 16. Visuals
SVG-based visuals are preferred for reliability. See docs/spec-visuals.md for the latest set.

---

## 17. Future Work
Open topics and potential improvements.
