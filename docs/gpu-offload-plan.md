# GPU Offload Plan — serverng DSP Pipeline

## Motivation

The Go DSP pipeline runs entirely on CPU. At 2.4 MSPS with a 65536-point FFT at 30 fps
and N concurrent IQ clients, the dominant costs are:

| Operation | Per-frame cost (single client) | Scales with |
|-----------|-------------------------------|-------------|
| FFT (N=65536, Blackman-Harris window) | ~4–8 ms (single-threaded Go) | per dongle |
| IQ: uint8→complex64 convert | ~0.3 ms / 2400 samples | per client |
| IQ: DCBlocker | ~0.2 ms | per client |
| IQ: NoiseBlanker | ~0.3 ms | per client |
| IQ: NCO frequency shift | ~0.5 ms | per client |
| IQ: 4th-order Butterworth LPF (2×biquad cascade) | ~0.8 ms | per client |
| IQ: Decimation | ~0.1 ms | per client |
| Demod: FM stereo (2×51-tap FIR L+R + pilot PLL) | ~3–5 ms @ 240 kHz | per Opus client |

With 10 concurrent clients listening to WFM via Opus, CPU load from DSP alone is ~90 ms/frame
on a Raspberry Pi 5 (4-core Cortex-A76), leaving ~3 ms headroom at 30 fps.

GPU offload eliminates or drastically reduces all of the above.

---

## Architecture

```
CPU (Go)                              GPU (Vulkan / VkFFT)
────────────────────────────────────  ──────────────────────────────────
Dongle → uint8 IQ ringbuf
  │
  ├─► [Phase 2] FFT: upload uint8 IQ → texSubImage / SSBO
  │       VkFFT kernel (65536-pt)
  │       Magnitude + window + avg → download float32 dB[]
  │       Broadcast to clients (unchanged)
  │
  └─► per-client IQ:
        [Phase 3] NCO + Butterworth + Decimate  ← Compute shader (per-client batch)
          upload uint8 chunk → SSBO
          NCO shift kernel
          Butterworth biquad kernel (4 poles)
          Decimate kernel
          download Int16 IQ → existing ADPCM/Opus pipeline
        
        [Phase 4] FM Stereo FIR ← Compute shader
          upload Int16 IQ → SSBO
          Pilot PLL + L-R FIR (2×51-tap) kernel
          download Int16 L, R → Opus encode
```

All GPU operations use **Vulkan compute shaders** via CGO wrappers in
`serverng/internal/gpu/`. CPU paths remain the default; GPU is gated by
a build tag and a runtime capability check.

---

## Phase 0 — Prerequisite: Go module + build tags (1–2 hours)

**Goal:** Establish the package skeleton and build infrastructure before any GPU code.

### New package: `serverng/internal/gpu/`

```
serverng/internal/gpu/
  gpu.go           // exported interface + capability report (no CGO)
  gpu_stub.go      // build tag: !gpu_vulkan — all-CPU stub
  vulkan.go        // build tag: gpu_vulkan — Vulkan init + device selection
  vkfft.go         // build tag: gpu_vulkan — VkFFT wrapper
  shader.go        // build tag: gpu_vulkan — SPIR-V loader
  shaders/
    nco_butter_decimate.comp   // GLSL compute shader
    fm_stereo_fir.comp         // GLSL compute shader
```

### `gpu.go` (tag-free interface, always compiled)

```go
package gpu

// Capability reports what GPU acceleration is available at runtime.
type Capability struct {
    Available        bool
    DeviceName       string
    DeviceType       string // "discrete", "integrated", "cpu", "virtual"
    VRAM             uint64 // bytes
    MaxWorkgroupSize uint32
    VkFFTAvailable   bool
}

// Probe detects GPU capabilities. Never panics; returns Available=false on any error.
func Probe() Capability { return probe() }  // implemented by tag-selected file

// Backend is the GPU computation backend. Use NewBackend to obtain one.
// All methods are safe to call on a nil Backend (no-op / CPU fallback).
type Backend struct{ impl backendImpl }

func NewBackend(cap Capability) (*Backend, error) { return newBackend(cap) }
func (b *Backend) Close()                         { if b != nil { b.impl.close() } }
func (b *Backend) FFT(iq []byte, size int) ([]float32, error) { ... }
```

### Build tags

```bash
go build ./cmd/serverng                          # CPU only (default)
go build -tags gpu_vulkan ./cmd/serverng         # Vulkan + VkFFT
```

`gpu_stub.go` is compiled without `gpu_vulkan` tag; returns `Capability{Available: false}` and
no-op `Backend`. All callers work with either variant.

---

## Phase 1 — Vulkan device detection + CPU fallback (2–3 hours)

**Goal:** Detect Vulkan at runtime; log device name, type, VRAM. No actual compute yet.

### Dependencies (add to `go.mod` under `gpu_vulkan` guard)

```
github.com/vulkan-go/vulkan v0.0.0-20231122132155-...  // MIT
```

Note: `vulkan-go/vulkan` is a thin CGO binding to `vulkan/vulkan.h` from the Vulkan SDK.
It does not bundle the SDK — the target system must have `libvulkan.so.1` (Linux) or
`MoltenVK` (macOS/iOS).

### `vulkan.go` (build tag: `gpu_vulkan`)

```go
//go:build gpu_vulkan

package gpu

/*
#cgo LDFLAGS: -lvulkan
#include <vulkan/vulkan.h>
*/
import "C"

func probe() Capability {
    // 1. vkCreateInstance (headless, no window surface)
    // 2. vkEnumeratePhysicalDevices
    // 3. Pick device: prefer discrete > integrated > anything
    // 4. vkGetPhysicalDeviceProperties2 → device name, limits
    // 5. vkGetPhysicalDeviceMemoryProperties → VRAM
    // 6. Return Capability{}
}
```

### Config integration

Add to `serverng/internal/config/config.go`:

```go
type ServerConfig struct {
    // existing fields ...
    GPU GPUConfig `yaml:"gpu"`
}

type GPUConfig struct {
    Enabled     bool   `yaml:"enabled"`       // default: false (opt-in)
    DeviceIndex int    `yaml:"device_index"`  // 0 = auto-select best
    FFT         bool   `yaml:"fft"`           // enable GPU FFT (requires VkFFT)
    IQPipeline  bool   `yaml:"iq_pipeline"`   // enable GPU NCO+filter+decimate
    FMStereo    bool   `yaml:"fm_stereo"`     // enable GPU FM stereo FIR
}
```

`config.yaml`:
```yaml
gpu:
  enabled: false
  fft: true
  iq_pipeline: true
  fm_stereo: true
```

---

## Phase 2 — GPU FFT via VkFFT (4–6 hours)

**Goal:** Replace `dsp.FftProcessor`'s `fft.go` radix-4 FFT with VkFFT; keep the same
`ProcessIqData([]byte) [][]float32` API.

### VkFFT

- Repo: `github.com/DTolm/VkFFT` (MIT, header-only C library)
- Integration: via CGO as a single-file `vkfft_wrapper.c` that `#include`s `vkfft.h`
- Requires: Vulkan SDK `libvulkan.so.1`, `GLSL` → SPIR-V via `glslangValidator` or pre-compiled

### Data flow (GPU FFT)

```
CPU: rawIQ []byte (65536×2 = 131072 bytes)
  → vkCmdCopyBuffer (staging → device SSBO, ~0.1 ms)
GPU: window multiply + uint8→float32 (compute shader, 65536 threads)
GPU: VkFFT in-place (radix-4, 65536-pt, ~0.3 ms on iGPU)
GPU: magnitude + shift + averaging (compute shader)
  → vkCmdCopyBuffer (device → staging, ~0.1 ms)
CPU: []float32 dB magnitudes (existing broadcast path, unchanged)
```

Total round-trip: ~0.5–1 ms vs ~4–8 ms CPU. **4–8× speedup for the FFT stage.**

### Interface change

`FftProcessor.processOneFrame()` calls `p.fft.Transform(buf)`. The GPU path replaces this
call when a `gpu.Backend` is injected:

```go
// In FftProcessor:
type FftProcessor struct {
    // ... existing fields ...
    gpuBackend *gpu.Backend  // nil = CPU path
}

func (p *FftProcessor) SetGPUBackend(b *gpu.Backend) { p.gpuBackend = b }

func (p *FftProcessor) processOneFrame(rawIq []byte) {
    if p.gpuBackend != nil {
        mag, err := p.gpuBackend.FFT(rawIq, p.fftSize)
        if err == nil {
            copy(p.magBuf, mag)
            return
        }
        // Fallthrough to CPU on error
    }
    // ... existing CPU path ...
}
```

No changes to callers (`dongle/manager.go`).

### Build constraint

`vkfft.go` (tag: `gpu_vulkan`) wraps the CGO calls. `gpu_stub.go` provides
`func (b *Backend) FFT(...) { return nil, ErrNotAvailable }`. The fallthrough
in `processOneFrame` handles this transparently.

---

## Phase 3 — GPU IQ Pipeline: NCO + Butterworth + Decimate (6–8 hours)

**Goal:** Batch all per-client NCO → filter → decimate operations in a single Vulkan
dispatch, one workgroup per client. Eliminates O(N_clients) CPU loops per IQ chunk.

### Compute shader: `nco_butter_decimate.comp`

```glsl
#version 450
layout(local_size_x = 256) in;  // 256 samples per workgroup thread

// Per-dispatch uniforms (push constants)
layout(push_constant) uniform Params {
    uint  numSamples;       // input IQ samples
    float ncoFreq;          // normalized NCO frequency (radians/sample)
    float ncoPhase;         // current NCO phase (updated each dispatch)
    float b0, b1, b2, a1, a2;  // Butterworth biquad coefficients (2 stages)
    uint  decimFactor;
    uint  clientIdx;
} params;

// Input: raw uint8 IQ from dongle (shared across clients, read-only)
layout(binding = 0) readonly buffer InputIQ  { uint8_t iq[]; };
// Per-client output: Int16 decimated IQ
layout(binding = 1) buffer OutputIQ { int16_t out[]; };
// Per-client filter state: 2 biquad stages × {x1,x2,y1,y2} × I+Q = 16 floats
layout(binding = 2) buffer FilterState { float state[]; };
```

Key design decisions:
- One `vkCmdDispatch` call per IQ chunk (shared input buffer, all clients simultaneously)
- Clients are independent workgroups → no inter-workgroup synchronization
- Filter state (16 floats per client) persists in a device-local SSBO between dispatches
- NCO phase persists similarly (2 floats per client)

### Batching multiple clients

```
Dispatch: numWorkgroups = numClients
Each workgroup: processes numSamples/decimFactor output samples for its client
Input SSBO: single upload of raw IQ from dongle (zero-copy if on iGPU with shared VRAM)
```

On integrated GPUs (AMD APU, Intel UHD), the dongle IQ buffer may already be accessible
to the GPU via `VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | DEVICE_LOCAL` — zero upload cost.

### Per-client state management

Each `IqExtractor` in `dongle/manager.go` gets a GPU client slot index:

```go
type IqExtractor struct {
    // ... existing ...
    gpuSlot  int         // -1 = CPU path
    gpuBackend *gpu.Backend
}
```

`gpu.Backend` manages a pool of SSBO slots. When a client disconnects, its slot is freed.
Maximum clients = `gpu.Backend.MaxClients()` (typically 256 on modern GPUs).

---

## Phase 4 — GPU FM Stereo FIR (4–6 hours)

**Goal:** Offload the 2×51-tap FIR filter used in `demod/fm.go`'s stereo decoder
(L+R pilot extraction + L-R separation). This is the highest per-client CPU cost for
WFM/Opus clients.

### Current CPU path (`demod/fm.go:processWfmStereo`)

```
Int16 IQ @ 240 kHz
  → pilot PLL (19 kHz)
  → L+R FIR (51 taps, 15 kHz LPF)
  → L-R FIR (51 taps, pilot-modulated)
  → L = (L+R + L-R) / 2
  → R = (L+R - L-R) / 2
```

51 taps × 2 filters × 240000 samples/sec = **24.5 million MACs/sec** per WFM client.
On a Pi 5, this is ~3–5 ms/frame.

### Compute shader: `fm_stereo_fir.comp`

```glsl
layout(local_size_x = 64) in;

layout(push_constant) uniform Params {
    uint numSamples;
    float pilotPhase;
    float pilotFreq;  // ~2π * 19000 / 240000
};

// Input: Int16 IQ demodulated FM baseband
layout(binding = 0) readonly buffer Input { int16_t samples[]; };
// Output: Int16 stereo L, R interleaved
layout(binding = 1) buffer Output { int16_t stereo[]; };
// FIR coefficients (51 taps, constant)
layout(binding = 2) readonly buffer Taps { float taps[51]; };
// FIR history state (51 samples × I+Q)
layout(binding = 3) buffer History { float hist[]; };
```

This dispatch runs after Phase 3 (IQ pipeline output → FM stereo input).
The output feeds directly into the Opus encoder.

---

## Phase 5 — Multi-client command buffer batching (2–3 hours)

**Goal:** Replace per-client individual Vulkan submits with a single `vkQueueSubmit`
containing all client dispatches in one command buffer. Reduces Vulkan driver overhead
from O(N) submit calls to O(1).

### Pattern

```go
// In gpu.Backend.ProcessAllClients():
cmd := b.beginCommandBuffer()
for _, client := range activeClients {
    cmd.bindPipeline(b.ncoPipeline)
    cmd.pushConstants(client.params)
    cmd.dispatch(numWorkgroups)
    cmd.pipelineBarrier() // output → next stage
}
cmd.end()
b.queue.submit(cmd)
b.queue.waitIdle()  // or use timeline semaphore for async
```

Timeline semaphores allow overlapping GPU execution with CPU encoding
(ADPCM/Opus can run while next IQ chunk is being processed).

---

## Phase 6 — iGPU zero-copy (optional, 1–2 hours)

On Intel UHD / AMD APU (unified memory), use
`VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT`
for the input IQ SSBO. The dongle DMA writes directly to memory readable by the GPU
with no staging copy.

Detection: `VkPhysicalDeviceMemoryProperties.memoryTypes` — look for flags
`DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT`.

Benefit: Input upload time drops from ~0.1 ms to ~0 ms for FFT and IQ pipeline.

---

## Hardware Tier Projections

| Tier | Example Hardware | FFT speedup | IQ pipeline (10 clients) | FM Stereo FIR |
|------|-----------------|-------------|--------------------------|---------------|
| 0 (CPU) | Pi 5 (4× A76) | baseline | ~40 ms | ~30 ms |
| 1 (iGPU) | Intel UHD 630, AMD Vega 8 | 3–5× | ~5 ms | ~3 ms |
| 2 (APU) | AMD 680M / Intel Xe | 5–8× | ~2 ms | ~1 ms |
| 3 (dGPU) | RTX 3060+, RX 6700+ | 10–15× | ~0.5 ms | ~0.3 ms |

At Tier 1 (typical miniPC / SBC with iGPU), 30+ concurrent WFM Opus clients become feasible
on hardware that currently saturates at ~8 clients.

---

## Build System

### go.mod additions (gated by `gpu_vulkan` tag)

In practice, the `vulkan-go/vulkan` binding is a pure CGO wrapper — no Go module entry
is needed beyond the system `libvulkan`. The VkFFT header is vendored as a single `.h` file
in `serverng/internal/gpu/clib/`.

```bash
# Prerequisites on Ubuntu/Debian
sudo apt-get install libvulkan-dev vulkan-tools glslang-tools

# Prerequisites on Arch / Manjaro
sudo pacman -S vulkan-devel glslang

# Prerequisites on macOS (MoltenVK)
brew install molten-vk vulkan-loader glslang
```

### npm / Makefile targets

```bash
npm run build:go:gpu         # CGO_ENABLED=1 go build -tags gpu_vulkan ./cmd/serverng
npm run test:go:gpu          # go test -tags gpu_vulkan ./serverng/internal/gpu/...
```

### Graceful CPU fallback

All GPU code paths check `gpuBackend != nil` before dispatching. If:
- `gpu.enabled: false` in config → `gpuBackend` is never created
- Vulkan init fails at runtime → `Probe()` returns `Available: false` → CPU path
- Any Vulkan call returns an error → log warning, fall through to CPU

No data is lost on GPU failure. The CPU path is the universal fallback.

---

## File Map

```
serverng/internal/gpu/
  gpu.go                       Phase 0 — interface + types (no CGO)
  gpu_stub.go                  Phase 0 — CPU stub (build: !gpu_vulkan)
  vulkan.go                    Phase 1 — Vulkan init + device selection
  device.go                    Phase 1 — physical device picker + memory props
  backend.go                   Phase 2 — Backend struct + FFT dispatch
  vkfft.go                     Phase 2 — VkFFT CGO wrapper
  pipeline_iq.go               Phase 3 — NCO+filter+decimate pipeline
  pipeline_fm.go               Phase 4 — FM stereo FIR pipeline
  batch.go                     Phase 5 — multi-client command buffer batching
  shaders/
    nco_butter_decimate.comp   Phase 3 — GLSL compute shader source
    fm_stereo_fir.comp         Phase 4 — GLSL compute shader source
    nco_butter_decimate.spv    Phase 3 — pre-compiled SPIR-V
    fm_stereo_fir.spv          Phase 4 — pre-compiled SPIR-V
  clib/
    vkfft.h                    Phase 2 — VkFFT header (vendored, MIT)
    vkfft_wrapper.c            Phase 2 — minimal CGO shim
```

Changes to existing files:

| File | Change |
|------|--------|
| `serverng/internal/dsp/fft_processor.go` | Add `SetGPUBackend(*gpu.Backend)`, fallthrough in `processOneFrame` |
| `serverng/internal/dsp/iq_extractor.go` | Add `SetGPUBackend(*gpu.Backend)`, GPU dispatch path in `Process` |
| `serverng/internal/demod/fm.go` | Add GPU FIR path in `processWfmStereo` |
| `serverng/internal/dongle/manager.go` | Initialize `gpu.Backend`, inject into FftProcessor + IqExtractors |
| `serverng/internal/config/config.go` | Add `GPUConfig` struct + YAML tags |
| `config/config.yaml` | Add `gpu:` section (disabled by default) |
| `package.json` | Add `build:go:gpu` script |

---

## Testing Strategy

1. **Unit tests** (`gpu_test.go`): FFT output matches CPU FFT to within 0.1 dB for all N
2. **Integration tests** (`gpu_integration_test.go`, requires `gpu_vulkan` tag + hardware):
   - Process 10 simulated clients × 100 frames; verify IQ output matches CPU reference
3. **Benchmark** (`gpu_bench_test.go`):
   - `BenchmarkFFT_CPU_65536` vs `BenchmarkFFT_GPU_65536`
   - `BenchmarkIQPipeline_10clients_CPU` vs `BenchmarkIQPipeline_10clients_GPU`
4. **Graceful fallback test**: `TestGPUFallback` — inject a failing `gpu.Backend`, verify
   output identical to CPU-only run

---

## Implementation Order (recommended)

1. **Phase 0** — Package skeleton, build tags, config struct, stub file
2. **Phase 1** — Vulkan probe, device selection, log output
3. **Phase 2** — VkFFT FFT (highest single-operation impact)
4. **Phase 3** — IQ pipeline (highest multi-client scaling impact)
5. **Phase 4** — FM stereo FIR (highest per-WFM-client impact)
6. **Phase 5** — Command buffer batching (optimization, not required for correctness)
7. **Phase 6** — iGPU zero-copy (optimization, hardware-specific)
