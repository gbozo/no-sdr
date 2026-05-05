# no-sdr — Architecture Plans

See [WORK.md](./WORK.md) for the current active backlog.

---

# Go Backend Architecture (serverng)

> **Status: COMPLETE** — Implemented in v2.0.0. This is a reference document for the architecture as built.

**Goal:** Replace Node.js server with Go for native concurrency, lower CPU, single-binary deployment (including RPi)  
**Constraint:** Same WebSocket binary protocol, same REST API shape — client unchanged

---

## 1. Why Go

| Problem (Node.js) | Go Solution |
|-------------------|-------------|
| IqExtractor is O(clients) sync per chunk | Goroutine per client, true parallelism |
| OpusAudioPipeline blocks event loop 2-3ms/client | Goroutine per client, CGo libopus |
| Single-threaded: 29% CPU with 1 dongle | Goroutines scale across all cores |
| fft.js uses number[] (64-bit), no SIMD | float32 arrays, compiler autovectorization |
| deflateRaw goes to libuv pool (async dance) | `compress/flate` in goroutine (native) |
| Deployment: node_modules + npm install | Single static binary, `curl` to install |
| RPi: V8 memory overhead (~80MB idle) | ~5-10MB RSS for Go binary |

---

## 2. Technology Stack

| Component | Library | Rationale |
|-----------|---------|-----------|
| FFT | Custom radix-4 float32 | Go FFT libs are all float64. Port our fft.js radix-4. Hot path needs float32. |
| IIR Filters | Custom cascaded biquad | Port 4th-order Butterworth from `iq-extractor.ts` (~50 LOC) |
| NCO | Custom lookup table | sin/cos table, same as current TS implementation |
| ADPCM | Custom IMA-ADPCM | Port from `shared/src/adpcm.ts` (~80 LOC) |
| Opus | `hraban/opus` (CGo) | System libopus-dev required. Build tag: `+opus` |
| RTL-SDR local | `jpoirier/gortlsdr` | Mature, used by stratux (aviation) |
| RTL-SDR network | Custom rtl_tcp client | Trivial TCP: 5-byte commands + raw IQ stream |
| WebSocket | `coder/websocket` | Binary, concurrent writes, context-aware, backpressure |
| HTTP | `chi` router + net/http | Lightweight, idiomatic, middleware-compatible |
| Config | `gopkg.in/yaml.v3` | YAML struct tags, compatible with existing config.yaml |
| Logging | `log/slog` (stdlib) | Structured JSON, zero deps |
| Deflate | `compress/flate` (stdlib) | Native, no CGo |
| Build | `go build -tags opus` | Optional Opus via build tags |

---

## 3. Data Flow

```
One IQ chunk (10ms, 48000 bytes at 2.4 MSPS) from the dongle:
  ├─ FftProcessor.ProcessIqData()       ← shared, runs ONCE per chunk
  └─ For each subscribed client (parallel):
       IqExtractor.Process()            ← per-client NCO+LPF+decimate
       demod (FM/AM/SSB/CW)             ← per-client
       ADPCM encode or Opus encode      ← per-client
```

```
main goroutine
  │
  ├─► HTTP server (chi + coder/websocket upgrade)
  │     └─► per-connection goroutine (ws read loop)
  │
  ├─► per-dongle goroutine (DongleReader)
  │     │ reads raw IQ, writes to fan-out buffer
  │     │
  │     ├─► FFT goroutine (shared, 1×)
  │     │     window → fft → magnitude → rate-cap → codec → broadcast
  │     │
  │     └─► per-client goroutine (×N)
  │           shift → lpf → decimate → [demod → opus] or [adpcm]
  │           writes encoded frames to client's WS write channel
  │
  └─► per-client WS write goroutine
        reads from write channel, sends to coder/websocket
        backpressure: if write channel full, drop oldest frame
```

---

## 4. Performance (measured v2.0.0, Apple M4, 10ms chunks)

| Metric | Node.js | Go | Notes |
|--------|---------|-----|-------|
| CPU (1 dongle, 5 clients) | ~29% single-core | <15% total | Parallelism eliminates serial bottleneck |
| Memory (idle) | ~80 MB | <10 MB | No V8 heap |
| Shared FFT N=4096 | — | ~488 µs | Once per chunk, amortised across all clients |
| IqExtract WFM (per client) | ~0.5ms sync | ~215 µs parallel | Same work, now concurrent |
| Single client WFM full | — | ~451 µs | Extract + FM demod + ADPCM |
| Fan-out 5 clients WFM | — | ~1.35 ms wall | +27% vs 1 client (parallel goroutines) |
| Fan-out 10 clients WFM | — | ~2.09 ms wall | +97% vs 1 client |
| Binary size | ~150MB node_modules | ~15 MB static | Single file deployment |
| Startup | ~2s (V8 warmup) | <100ms | |

---

## 5. Build Tags

```go
//go:build opus   → requires libopus-dev; enables server-side demod+Opus path
//go:build rtlsdr → requires librtlsdr-dev; enables local USB dongle via CGo
```

Default build (no tags) = pure Go static binary — works over network (rtl_tcp) or demo mode. Ideal for RPi / Docker.

---

## 6. Compatibility Matrix

| Feature | Node.js server | Go serverng | Client change? |
|---------|---------------|-------------|----------------|
| WS binary protocol | Identical | Identical | No |
| REST API shape | Identical | Identical | No |
| config.yaml | YAML + Zod | YAML + Go validation | No |
| FFT codecs | deflate/adpcm/uint8 | deflate/adpcm/uint8 | No |
| IQ codecs | raw/adpcm | raw/adpcm | No |
| Opus codec | opusscript WASM | hraban/opus CGo | No |
| Demo mode | SignalSimulator | Go equivalent | No |
| Local RTL-SDR | spawn rtl_sdr | gortlsdr (direct USB) | No |
| rtl_tcp/airspy/hfp/rsp | TCP client | TCP client (same protocol) | No |
| Admin panel | Cookie sessions | Cookie sessions | No |

---

## 7. Settings & Admin Panel Revamp

> **Status: COMPLETE** — Implemented in v2.2.0. All 14 phases complete.

Key decisions made during this revamp:

| Decision | Choice |
|----------|--------|
| Admin panel layout | Full-page route `/admin` |
| Feature report data source | Server API endpoint |
| Client monitoring | REST polling (5-10s) in admin only |
| Concurrent admin safety | Optimistic concurrency (ETag/version) |
| SDR client config delivery | WebSocket push only (no polling) |
