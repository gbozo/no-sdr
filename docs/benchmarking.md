# Benchmarking Guide — serverng DSP Pipeline

## Purpose

This document provides instructions for running DSP benchmarks on different architectures and comparing results against the baseline. Use this to evaluate hardware suitability for deployment, detect regressions, and quantify GPU offload benefit.

---

## Quick Start

```bash
cd serverng
go test -bench=. -benchmem -count=3 -timeout=5m ./internal/dsp/ ./internal/codec/ ./internal/demod/
```

Save output to a file for comparison:

```bash
go test -bench=. -benchmem -count=3 -timeout=5m \
  ./internal/dsp/ ./internal/codec/ ./internal/demod/ \
  2>/dev/null | tee bench-$(uname -m)-$(date +%Y%m%d).txt
```

---

## Benchmarks Explained

### DSP (`internal/dsp/`)

| Benchmark | What it measures | Input size |
|-----------|-----------------|------------|
| `BenchmarkFullFFTPipeline` | FFT 65536 + windowing + dB conversion | 48000 bytes (10ms @ 2.4 MSPS) |
| `BenchmarkFullFFTPipeline4096` | FFT 4096 (aviation mode) | 48000 bytes |
| `BenchmarkIqExtractorNFM` | Full IQ pipeline: NCO + Butterworth + Decimate (factor 50) | 48000 bytes → 960 int16 |
| `BenchmarkIqExtractorWFM` | Full IQ pipeline: NCO + Butterworth + Decimate (factor 10) | 48000 bytes → 4800 int16 |
| `BenchmarkIqExtractorSSB` | Full IQ pipeline: NCO + Butterworth + Decimate (factor 100) | 48000 bytes → 480 int16 |
| `BenchmarkIqExtractor` | Same as NFM (legacy name) | 48000 bytes |
| `BenchmarkIqExtractor_WFM` | Same as WFM (legacy name) | 48000 bytes |
| `BenchmarkFFT65536` | Raw radix-4 FFT only (no windowing/dB) | 65536 complex64 |
| `BenchmarkFFT4096` | Raw radix-4 FFT only | 4096 complex64 |
| `BenchmarkButterworth` | 4th-order Butterworth LPF (2 biquad sections, I+Q) | 65536 complex64 |
| `BenchmarkNCO` | NCO frequency shift (LUT-based sin/cos) | 2.4M complex64 |
| `BenchmarkDecimate` | Integer decimation (stride read) | 2.4M complex64 |
| `BenchmarkNoiseBlanker` | Impulse noise blanker | 48000 complex64 |
| `BenchmarkBlackmanHarris65536` | Window function generation | 65536 float64 |

### Codec (`internal/codec/`)

| Benchmark | What it measures |
|-----------|-----------------|
| `BenchmarkEncode` | IMA-ADPCM encoder (IQ compression, 4:1) |
| `BenchmarkDecode` | IMA-ADPCM decoder |
| `BenchmarkEncodeFftAdpcm` | FFT-specific ADPCM (dB × 100 → ADPCM) |
| `BenchmarkCompressFft65536` | FFT uint8 quantization (65536 bins) |
| `BenchmarkDeflateFft65536` | FFT deflate compression (65536 bins) |
| `BenchmarkFftDeflateEncoder65536` | Full FFT deflate encoder with reusable writer |

### Demodulation (`internal/demod/`)

| Benchmark | What it measures | Input size |
|-----------|-----------------|------------|
| `BenchmarkFmMono` | FM mono demodulation | 4096 complex64 |
| `BenchmarkFmStereo` | FM stereo (pilot PLL + 2×51-tap FIR) | 4800 complex64 |
| `BenchmarkFmStereoWithRds` | FM stereo + RDS decoder | 4800 complex64 |
| `BenchmarkAmDemod` | AM envelope detection | 4096 complex64 |
| `BenchmarkSsbDemod` | SSB passthrough | 4096 complex64 |
| `BenchmarkCwDemod` | CW narrow-band + tone detect | 4096 complex64 |
| `BenchmarkDemodPipeline` | Full pipeline: IQ extract + FM demod | 48000 bytes |
| `BenchmarkRdsDecoder` | RDS bit decoder only | 2400 float32 |

---

## Baseline Results — Apple M4 (arm64, 10 cores)

Recorded 2025-05-12. All results are median of 3 runs.

### Critical Path (per 10ms chunk)

| Benchmark | ns/op | MB/s | Allocs |
|-----------|-------|------|--------|
| FullFFTPipeline (65536) | 387,000 | 125 | 0 |
| FullFFTPipeline (4096) | 267,000 | 180 | 8 |
| IqExtractorNFM | 200,000 | 240 | 0 |
| IqExtractorWFM | 204,000 | 235 | 0 |
| IqExtractorSSB | 200,000 | 240 | 0 |

### Component Breakdown

| Benchmark | ns/op | MB/s | Allocs |
|-----------|-------|------|--------|
| FFT65536 | 849,000 | - | 0 |
| FFT4096 | 33,800 | - | 0 |
| Butterworth | 450,700 | 1,163 | 0 |
| NCO (2.4M samples) | 1,780,000 | 10,770 | 0 |
| Decimate | 195,000 | 98,307 | 0 |
| NoiseBlanker | 183,000 | 2,094 | 0 |

### Codec

| Benchmark | ns/op | MB/s | Allocs |
|-----------|-------|------|--------|
| ADPCM Encode | 41,000 | 585 | 0 |
| ADPCM Decode | 24,000 | 1,000 | 1 |
| FftDeflateEncoder65536 | 818,000 | - | 1 |

### Demod

| Benchmark | ns/op | MB/s | Allocs |
|-----------|-------|------|--------|
| FmMono | 15,800 | 2,070 | 0 |
| FmStereo | 235,000 | 139 | 0 |
| FmStereoWithRds | 304,000 | 126 | 0 |
| AmDemod | 6,900 | 4,760 | 0 |
| SsbDemod | 6,300 | 5,218 | 0 |
| CwDemod | 351,000 | 93 | 0 |
| DemodPipeline | 203,000 | 237 | 1 |

---

## How to Compare Results

### Using `benchstat` (recommended)

Install:
```bash
go install golang.org/x/perf/cmd/benchstat@latest
```

Compare two runs:
```bash
benchstat bench-arm64-baseline.txt bench-amd64-new.txt
```

### Manual comparison

Key metrics to compare:

1. **IqExtractorNFM ns/op** — determines max clients per core. Divide 10,000,000 (10ms budget) by ns/op to get clients per core.
2. **FFT65536 ns/op** — determines FFT fps headroom. At 30fps: must be < 33,000,000 ns.
3. **FmStereoWithRds ns/op** — determines max WFM Opus clients per core.
4. **Allocs/op** — should be 0 for all hot-path benchmarks. Any non-zero value is a regression.

### Capacity formula

```
Max NFM clients (single core) = 10,000,000 / IqExtractorNFM_ns
Max WFM+Opus clients (single core) = 10,000,000 / (IqExtractorWFM_ns + FmStereoWithRds_ns)
```

With parallelism across N cores (assuming 80% scaling efficiency):
```
Max clients total ≈ max_per_core × N_cores × 0.8
```

---

## Target Architectures

Run benchmarks on these platforms and add results below:

| Platform | CPU | Expected vs M4 |
|----------|-----|-----------------|
| Raspberry Pi 5 | Cortex-A76 (4 cores, 2.4 GHz) | ~2-3x slower |
| Raspberry Pi 4 | Cortex-A72 (4 cores, 1.8 GHz) | ~4-5x slower |
| Intel N100 | 4× E-cores (3.4 GHz) | ~1.5-2x slower |
| AMD Ryzen 5 5600X | Zen 3 (6 cores, 4.6 GHz) | ~0.8-1.2x (comparable) |
| Intel i7-12700 | 8P+4E (5.0 GHz) | ~0.7-1.0x (slightly faster) |
| Orange Pi 5 | RK3588 (4×A76 + 4×A55) | ~2-3x slower |

### Adding Your Results

1. Run the benchmark command above
2. Save output to `docs/bench-results/bench-<arch>-<date>.txt`
3. Add a summary row to this table:

| Architecture | IqNFM (us) | IqWFM (us) | FFT65536 (us) | FmStereo+RDS (us) | Max NFM/core | Max WFM+Opus/core |
|--------------|-----------|-----------|--------------|-------------------|--------------|-------------------|
| **Apple M4** | **200** | **204** | **849** | **304** | **50** | **19** |
| _Your arch_ | _..._ | _..._ | _..._ | _..._ | _..._ | _..._ |

---

## GPU Benchmarks (Phase 2+)

When GPU acceleration is available (`-tags gpu_vulkan`):

```bash
# Build with GPU support
go build -tags gpu_vulkan ./...

# Run GPU-specific benchmarks (when available)
go test -tags gpu_vulkan -bench=BenchmarkGPU -benchmem -count=3 -timeout=5m ./internal/gpu/
```

Compare GPU vs CPU for the same operations:
- **GPU FFT 65536**: target < 100 us (8x faster than CPU)
- **GPU IQ batch (20 clients)**: target < 100 us total (vs 4000 us on CPU)

The GPU benefit is primarily **batching** — processing N clients in a single dispatch rather than N sequential goroutines. On Apple M4 the CPU is already fast (~200 us/client), so GPU payoff starts at ~10+ concurrent clients.

---

## Performance Regression Checklist

Before merging any DSP changes:

1. Run benchmarks: `go test -bench=. -benchmem -count=5 ./internal/dsp/`
2. Compare with `benchstat old.txt new.txt`
3. Reject if:
   - Any hot-path benchmark regresses > 5%
   - Any hot-path allocs/op increases from 0
   - `IqExtractor*` throughput drops below 200 MB/s on arm64
4. Accept if:
   - Performance improves or stays within noise (< 3% delta)
   - No new allocations introduced

---

## Environment Notes

- Disable CPU frequency scaling (performance governor) for stable results:
  ```bash
  # Linux
  echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
  
  # macOS — not needed (always runs at full speed during benchmarks)
  ```
- Close other CPU-intensive applications
- Run at least `-count=3` (preferably `-count=5`) for statistical significance
- Use `-benchtime=2s` for short benchmarks if default iteration count is too low
- Ensure thermal throttling is not active (laptop users: plug in, monitor temps)
