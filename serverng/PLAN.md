# serverng — Go Backend Architecture Plan

**Target:** v2.0.0  
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

## 3. Flow Graph Engine (csdr-inspired)

### Block Interface

```go
// A Block processes samples from input to output.
// Blocks are connected via Pipes (buffered channels or ring buffers).
type Block interface {
    Name() string
    Init(ctx BlockContext) error
    Process(ctx context.Context) error  // long-running: reads from inputs, writes to outputs
    Close() error
}

// BlockContext provides rate info and pipe handles.
type BlockContext struct {
    SampleRate float64
    BlockSize  int               // preferred processing chunk size (0 = any)
    Inputs     []ReadPort        // typed read ends
    Outputs    []WritePort       // typed write ends
    Logger     *slog.Logger
}

// Typed ports
type ReadPort  interface{ Read(buf any) (int, error) }
type WritePort interface{ Write(buf any) (int, error) }
```

### Concrete Port Types (Generic)

```go
// Pipe[T] connects two blocks with a ring buffer.
type Pipe[T any] struct {
    ring *RingBuffer[T]  // lock-free SPSC ring buffer
    done chan struct{}
}

// Common sample types
type Complex64 = complex64       // IQ samples (float32 real + float32 imag)
type Int16IQ   = [2]int16        // Wire format IQ
type Float32   = float32         // FFT magnitude, audio
```

### Pipeline Construction (config-driven)

```yaml
# config.yaml — per-profile DSP pipeline
pipelines:
  wfm:
    - block: shift
      params: { offset_hz: 0 }  # overridden per-client
    - block: butterworth_lpf
      params: { order: 4, cutoff_hz: 120000 }
    - block: decimate
      params: { factor: 10 }
    - block: fm_demod
      params: { stereo: true, deemph_us: 50 }
    - block: opus_encode
      params: { bitrate: 64000, channels: 2 }
  
  nfm:
    - block: shift
    - block: butterworth_lpf
      params: { order: 4, cutoff_hz: 6250 }
    - block: decimate
      params: { factor: 50 }
    - block: fm_demod
      params: { stereo: false, deemph_us: 750 }
    - block: opus_encode
      params: { bitrate: 32000, channels: 1 }
```

### Block Registry

```go
var Registry = map[string]BlockFactory{
    "shift":           NewShiftBlock,
    "butterworth_lpf": NewButterworthBlock,
    "decimate":        NewDecimateBlock,
    "fir_filter":      NewFirBlock,
    "fm_demod":        NewFmDemodBlock,
    "am_demod":        NewAmDemodBlock,
    "ssb_demod":       NewSsbDemodBlock,
    "cw_demod":        NewCwDemodBlock,
    "sam_demod":       NewSamDemodBlock,
    "cquam_demod":     NewCquamDemodBlock,
    "agc":             NewAgcBlock,
    "noise_blanker":   NewNoiseBlankerBlock,
    "dc_block":        NewDcBlockBlock,
    "opus_encode":     NewOpusEncodeBlock,
    "adpcm_encode":    NewAdpcmEncodeBlock,
    "resample":        NewResampleBlock,
    "rds_decode":      NewRdsDecodeBlock,
    "squelch":         NewSquelchBlock,
}
```

### Composite Blocks

```go
// CompositeBlock wraps a sub-pipeline into a single reusable block.
// Example: "tuner" = shift + butterworth + decimate
type CompositeBlock struct {
    name   string
    blocks []Block
    pipes  []Pipe[any]
}
```

### Data Flow Model

```
Per-dongle (shared):
  ┌──────────────────────────────────────────────────┐
  │ DongleReader goroutine                            │
  │  → reads raw uint8 IQ from device/TCP/demo       │
  │  → writes to fan-out ring buffer                  │
  └──────────┬───────────────────────────────────────┘
             │ fan-out (one reader per consumer)
             ├────────────────────────────────┐
             │                                │
  ┌──────────▼──────────┐      ┌─────────────▼─────────────┐
  │ FFT Pipeline         │      │ Client Pipeline (×N)      │
  │ goroutine (shared)   │      │ goroutine per client       │
  │ window → fft →       │      │ shift → lpf → decimate →  │
  │ magnitude → codec →  │      │ [demod → opus_encode] OR   │
  │ broadcast            │      │ [adpcm_encode]             │
  └──────────────────────┘      └───────────────────────────┘
```

### Key Design Decisions (from csdr/luaradio analysis)

1. **Vector-based processing** — blocks process slices (`[]float32`, `[]complex64`), never sample-by-sample. Minimum 256 samples per call.
2. **SPSC ring buffers between stages** — lock-free, pre-allocated, zero-copy where possible. Not Go channels (too much overhead for 2.4M samples/sec).
3. **Rate propagation** — each block knows input/output sample rates. Framework validates rate compatibility at pipeline construction time.
4. **Fixed-size blocks vs any-length blocks** — FFT requires exact N samples; filters process any amount. Framework handles buffering for fixed-size blocks.
5. **Pipeline instantiation per client** — each client gets its own goroutine + pipeline. No shared mutable state between client pipelines.

---

## 4. Module Structure

```
serverng/
├── cmd/
│   └── serverng/
│       └── main.go              # Entry point, config load, start server
├── internal/
│   ├── config/
│   │   └── config.go            # YAML + validation (replaces Zod)
│   ├── dongle/
│   │   ├── manager.go           # Dongle lifecycle (local/tcp/demo)
│   │   ├── rtlsdr.go            # Local USB via gortlsdr
│   │   ├── rtltcp.go            # Network rtl_tcp client
│   │   ├── airspy.go            # airspy_tcp protocol
│   │   ├── rsp.go               # rsp_tcp + extended commands
│   │   └── demo.go              # Signal simulator
│   ├── dsp/
│   │   ├── block.go             # Block interface + context
│   │   ├── pipe.go              # SPSC ring buffer pipes
│   │   ├── pipeline.go          # Pipeline construction + lifecycle
│   │   ├── registry.go          # Block factory registry
│   │   ├── composite.go         # CompositeBlock (sub-pipelines)
│   │   ├── fft.go               # Radix-4 float32 FFT
│   │   ├── window.go            # Blackman-Harris, Hann, Kaiser
│   │   ├── filter.go            # Butterworth IIR, FIR
│   │   ├── nco.go               # Numerically-controlled oscillator
│   │   ├── decimate.go          # Integer decimation block
│   │   ├── resample.go          # Fractional resampler
│   │   ├── dc_block.go          # DC offset removal (IIR)
│   │   └── agc.go               # Hang-timer AGC
│   ├── demod/
│   │   ├── fm.go                # FM mono + stereo (PLL, blend, deemph)
│   │   ├── am.go                # AM envelope
│   │   ├── sam.go               # Synchronous AM (PLL carrier lock)
│   │   ├── cquam.go             # C-QUAM AM stereo
│   │   ├── ssb.go               # SSB (I-channel extraction)
│   │   ├── cw.go                # CW (BFO mix)
│   │   └── rds.go               # RDS decoder (57kHz subcarrier)
│   ├── codec/
│   │   ├── adpcm.go             # IMA-ADPCM encode/decode
│   │   ├── opus.go              # Opus encode via hraban/opus (build tag)
│   │   ├── deflate.go           # Delta+deflate for FFT
│   │   └── compress_fft.go      # Float32 → Uint8 quantization
│   ├── ws/
│   │   ├── manager.go           # Client registry, fan-out, lifecycle
│   │   ├── client.go            # Per-client state + pipeline
│   │   ├── protocol.go          # Binary protocol pack/unpack
│   │   └── backpressure.go      # Write buffering + frame drop
│   ├── api/
│   │   ├── router.go            # chi routes (/api/dongles, /api/admin, etc.)
│   │   ├── dongles.go           # GET/POST/PUT/DELETE dongles + profiles
│   │   ├── admin.go             # Auth, profile management
│   │   └── static.go            # Serve client dist/ files
│   └── history/
│       └── fft_buffer.go        # Ring buffer for FFT history (seek-back)
├── go.mod
├── go.sum
├── Makefile                     # Build targets: build, build-pi, docker
└── README.md
```

---

## 5. Concurrency Model

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

### Fan-Out Strategy

The dongle reader produces raw IQ at 2.4 MSPS. Each consumer (FFT + N clients) needs its own read position into the data.

```go
// FanOut distributes one writer's output to N readers.
// Each reader has an independent cursor into a shared ring buffer.
// If a reader falls behind, it skips forward (frame drop).
type FanOut[T any] struct {
    buf      []T
    writePos atomic.Uint64
    readers  []*FanOutReader[T]
}
```

This is the Go equivalent of our current architecture where `_handleIqDataAsync` iterates clients — except each client runs concurrently instead of serially.

---

## 6. Performance Targets

| Metric | Node.js (current) | Go (target) | Notes |
|--------|-------------------|-------------|-------|
| CPU (1 dongle, 5 clients) | ~29% single-core | <15% total across cores | Parallelism eliminates serial bottleneck |
| Memory (idle) | ~80 MB | <10 MB | No V8 heap |
| Latency per client | +0.5ms per additional client | ~0 | Clients don't block each other |
| FFT N=65536 | ~4ms (fft.js radix-4) | ~6-8ms (pure Go float32) | Acceptable: 30fps = 33ms budget |
| IQ extraction | ~0.5ms/client (sync) | ~0.5ms/client (parallel) | Same work, but concurrent |
| Binary size | ~150MB node_modules | ~15 MB static binary | Single file deployment |
| Startup | ~2s (V8 warmup) | <100ms | Go starts instantly |

---

## 7. Migration Strategy

### Phase 1: Scaffold + FFT (foundation)
- Go module init, config loading (reuse config.yaml format)
- Custom radix-4 FFT (port from fft.js, float32)
- Window functions (Blackman-Harris, Hann)
- HTTP server with chi, static file serving
- WebSocket upgrade with coder/websocket
- Binary protocol pack/unpack (match TS exactly)
- Demo dongle source (signal simulator)
- FFT pipeline: DongleReader → FftProcessor → deflate codec → WS broadcast
- **Milestone: client waterfall + spectrum work against Go backend**

### Phase 2: IQ Pipeline + Demod
- Flow graph engine (Block interface, Pipe, Pipeline, Registry)
- IqExtractor blocks: NCO shift, Butterworth LPF, decimation
- ADPCM codec block
- Per-client pipeline instantiation
- Client subscribes → Go creates pipeline → streams IQ
- **Milestone: client can tune and hear audio via IQ+ADPCM codec**

### Phase 3: Opus + Advanced Demod
- Opus encode block (hraban/opus, build tag)
- FM stereo demod (PLL, 19kHz pilot, blend, de-emphasis)
- AM, SSB, CW, SAM, C-QUAM demods
- RDS decoder block
- Server-side demod → Opus path complete
- **Milestone: feature parity with Node.js server**

### Phase 4: Hardware + Admin
- gortlsdr integration (local USB)
- rtl_tcp, airspy_tcp, hfp_tcp, rsp_tcp clients
- REST API: dongles, profiles, admin auth
- Config save/reload
- FFT history buffer (seek-back)
- Rate limiting (per-IP WebSocket connections)
- **Milestone: production-ready, all source types**

### Phase 5: Polish + Release
- Benchmarks vs Node.js (FFT throughput, per-client latency, memory)
- Cross-compile: linux/amd64, linux/arm64 (RPi), darwin/arm64
- Docker scratch image
- Graceful shutdown (drain connections)
- Backpressure tuning under load
- v2.0.0 release

---

## 8. Build Tags & Conditional Compilation

```go
//go:build opus
// +build opus

// Only included when built with: go build -tags opus
package codec

import "gopkg.in/hraban/opus.v2"
```

Without `-tags opus`: no Opus support, binary is pure Go (no CGo, no system deps).  
With `-tags opus`: requires `libopus-dev`, enables server-side demod+Opus path.

Same pattern for `gortlsdr`:
- Without tag: only rtl_tcp/airspy_tcp/demo sources (network + simulation)
- With `-tags rtlsdr`: local USB dongle support via CGo

Default build (no tags) = **single static binary that works over network or demo mode**. Perfect for RPi or Docker.

---

## 9. Compatibility Matrix

| Feature | Node.js server | Go serverng | Client change needed? |
|---------|---------------|-------------|----------------------|
| WS binary protocol | Identical | Identical | No |
| REST API | Identical shape | Identical shape | No |
| config.yaml | YAML + Zod | YAML + Go validation | No (same file) |
| FFT codecs (deflate/adpcm/uint8) | All | All | No |
| IQ codecs (raw/adpcm) | All | All | No |
| Opus codec | opusscript WASM | hraban/opus CGo | No |
| Demo mode | SignalSimulator | Go equivalent | No |
| Local RTL-SDR | spawn rtl_sdr | gortlsdr (direct USB) | No |
| rtl_tcp/airspy/hfp/rsp | TCP client | TCP client (same protocol) | No |
| Admin panel | Cookie sessions | Cookie sessions | No |
| Static serving | Hono | chi / http.FileServer | No |

---

## 10. Reference Implementations

| Source | What to learn | License |
|--------|--------------|---------|
| [csdr](https://github.com/jketterl/csdr) | Block interface design, ring buffers, DSP algorithms | GPL-3.0 |
| [luaradio](https://github.com/vsergeev/luaradio) | Pipeline construction, rate propagation, composite blocks | MIT |
| [turbine](https://github.com/norasector/turbine) | Go + gortlsdr + Opus in production, goroutine architecture | GPL-3.0 |
| [openwebrx](https://github.com/jketterl/openwebrx) | Python orchestration of csdr pipelines, WebSocket streaming | AGPL |
| Our Node.js server | Exact protocol behavior, edge cases, codec details | — |

---

## 11. Open Questions

1. **FFTW via build tag?** — Pure Go FFT may be too slow for N=65536 on RPi 3. Offer optional FFTW acceleration?
2. **CGo static linking** — hraban/opus and gortlsdr need CGo. Can we produce a fully static binary with musl?
3. **Hot reload** — can we reconfigure pipelines (mode/bandwidth change) without restarting goroutines? Or tear down + rebuild per change?
4. **Client-side pipeline config** — should the flow graph config be exposed via REST so clients can request custom pipelines in future?
5. **Decoder integration** — digital mode decoders (DMR, DAB) — WASM in Go? Spawn C binaries? Skip for v2.0?
