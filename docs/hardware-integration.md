# Hardware Integration Roadmap

## Scope

This document tracks planned SDR hardware integrations, extended features, and protocol enhancements beyond the initial network-TCP (rtl_tcp-compatible) implementations.

## Source Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ DongleManager                                                   │
│                                                                  │
│  source.type routing:                                            │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  local   │  │  rtl_tcp  │  │   demo   │  │ CLI (future) │  │
│  │ spawn    │  │ TCP client│  │ simulator│  │ spawn stdout │  │
│  │ rtl_sdr  │  │ to remote │  │ fake IQ  │  │ hackrf/airspy│  │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │               │             │                │           │
│       └───────────────┴──────┬──────┴────────────────┘           │
│                              │                                    │
│                              ▼                                    │
│                   Buffer (uint8 IQ interleaved)                   │
│                              │                                    │
│                    ┌─────────┴─────────┐                         │
│                    │                   │                          │
│                    ▼                   ▼                          │
│             FftProcessor        IqExtractor (per client)         │
│             (shared FFT)        (NCO + filter + decimate)        │
└────────────────────────────────────────────────────────────────┘

Network-TCP variants (implemented):
  rtl_tcp    — RTL-SDR via rtl_tcp server (12B header + 5-byte commands)
  airspy_tcp — AirSpy Mini/R2 via airspy_tcp (same protocol, higher rates)
  hfp_tcp   — AirSpy HF+ via hfp_tcp (same protocol, HF coverage)
  rsp_tcp   — SDRplay RSP via rsp_tcp (extended commands: antenna, notch, LNA)
```

## Implemented

### Network-TCP Sources (Phase 1)

| Source Type | SDR Hardware | Server Required | Sample Rate | Status |
|-----------|-----------|-------------|-----------|--------|
| `airspy_tcp` | AirSpy Mini / R2 | airspy_tcp | 2.5 / 6 MS/s | ✅ Done |
| `hfp_tcp` | AirSpy HF+ | hfp_tcp | 96k-768k | ✅ Done |
| `rsp_tcp` | SDRplay RSP1/2/duo/dx | rsp_tcp | 2-10 MS/s | ✅ Done |

See `config/config.yaml` for example configurations.

---

## Planned: CLI-Based Sources (Phase 2)

These SDRs require spawning a CLI tool that outputs IQ to stdout. No native bindings — use existing CLI tools.

### Priority 1

#### HackRF One

- **CLI**: `hackrf_transfer -r - -f {freq} -s {rate} -a 1 -l {lna} -g {vga}`
- **Output**: 8-bit signed IQ (interleaved)
- **Sample rates**: 1, 2, 4, 6, 8, 10, 12, 14, 16, 20 MS/s
- **Frequency range**: 1 MHz – 6 GHz
- **Integration points**:
  - `hackrf-stream` npm package (Node.js native wrapper)
  - Or spawn `hackrf_transfer` to stdout
- **Sample format**: 8-bit signed (NOT unsigned like RTL) — needs conversion
- **Gain stages**: RF amp (0/1), LNA (0-40 dB, 8dB steps), VGA (0-62 dB, 1dB steps)
- **Notes**: Cannot transmit and receive simultaneously
- **Reference**: `github.com/mossmann/hackrf` → `host/hackrf-tools/src/hackrf_transfer.c`

```yaml
# Planned config:
# - id: hackrf-local
#   name: "HackRF One"
#   source:
#     type: hackrf
#     binary: "/usr/local/bin/hackrf_transfer"
#     extraArgs: ["-a", "1"]  # RF amp enable
#   vgaGain: 40
#   lnaGain: 32
```

#### AirSpy Mini/R2 CLI

- **CLI**: `airspy_rx -r - -f {freq} -s {rate} -t 2` (INT16_IQ)
- **Output**: 16-bit signed IQ (`-t 2`)
- **Sample rates**: 2.5 / 6 MS/s
- **Integration**: Spawn `airspy_rx` to stdout
- **Gain stages**: VGA (0-15), Mixer (0-15), LNA (0-14)
- **Reference**: `github.com/airspy/airspyone_host` → `airspy-tools/src/airspy_rx.c`

#### AirSpy HF+ CLI

- **CLI**: `airspyhf_rx -r - -f {freq} -s {rate} -t 2` (INT16_IQ)
- **Output**: 16-bit signed IQ
- **Sample rates**: 96k, 192k, 384k, 768k, 1536k
- **Integration**: Spawn `airspyhf_rx` to stdout
- **Gain**: RF gain reduction (0-47 dB)
- **Reference**: `github.com/airspy/airspyhf` → `tools/src/airspyhf_rx.c`

#### PlutoSDR (ADALM-PLUTO)

- **CLI**: `iio_readdev -u usb:... -b {buf} -s 0 cf-ad9361-lpc`
- **Output**: 12-bit signed IQ (output as 16-bit)
- **Sample rates**: 2.083333–61.44 MS/s
- **Frequency range**: 325 MHz – 3.8 GHz
- **Integration**: `libiio` + `iio_readdev` CLI or network backend
- **Notes**: Network mode disabled per user request
- **Reference**: `github.com/analogdevicesinc/libiio` → `utils/iio_readdev.c`

### Priority 2

#### LimeSDR (via SoapySDR)

- **CLI**: `SoapySDRUtil --driver=lime --streamargs="driver=lime,format=CF32"`
- **Output**: Complex float32 via SoapySDR
- **Sample rates**: 0.5–61.44 MS/s
- **Integration**: `soapysdr-tools` + `soapysdr-module-lms7`
- **Notes**: Requires LimeSuite — complex dependency chain
- **Reference**: `github.com/myriadrf/LimeSuite` → `LimeUtil/`

---

## Planned: Extended Protocol Features

### RSP Extended Mode (rsp_tcp)

- **Issue**: Standard `rsp_tcp` uses 8-bit quantization, losing the RSP's 14-bit dynamic range
- **Solution**: Use `ExtIO_RSP_TCP` with extended mode (`-E` flag) + custom client protocol
- **Benefits**: Full 14-bit dynamic range remotely
- **Reference**: `github.com/SDRplay/ExtIO_RSP_TCP`

### SpyServer Protocol

- **Issue**: SpyServer sends only the tuned signal (not full IQ) — more efficient bandwidth
- **Benefits**: ~38-120 KB/s vs full-IQ streaming
- **Implementation complexity**: High — different protocol (custom header + compressed stream)
- **Use cases**: Remote access over limited bandwidth connections
- **Reference**: `github.com/SDRplay/sdrsharp-spy-server` (AirSpy SDR#)

### Multi-Client Architecture

- **rtl_tcp**: Single client per connection
- **airspy_tcp/hfp_tcp**: Same — single client
- **SpyServer**: Multi-client (multiple users can tune independently)
- **Possible enhancement**: Proxy architecture that distributes to multiple rtl_tcp instances

---

## Planned: CLI Integration Details

### Sample Format Normalization Layer

Different SDRs output different IQ formats. The IQ pipeline needs a normalization layer:

| SDR | Format | Bits | Signed | Conversion |
|-----|--------|------|--------|-----------|
| RTL-SDR | uint8 | 8 | No | N/A |
| HackRF | int8 | 8 | Yes | Invert sign: `val = val ^ 0x80` |
| AirSpy | int16 | 16 | Yes | Already signed |
| AirSpy HF+ | int16 | 16 | Yes | Already signed |
| SDRplay | uint8 | 8 | No | N/A |
| PlutoSDR | int12→int16 | 16 | Yes | Already signed |
| LimeSDR | float32 | 32 | N/A | Float32, no conversion |

**Implementation**: Add `SampleFormat` interface and `normalizeIQ()` function in `iq-extractor.ts`.

### CLI Process Management

CLI-based SDRs need the same lifecycle management as `rtl_sdr`:

1. Spawn CLI process
2. Pipe stdout to `iq-data` events
3. Forward frequency/gain changes as command-line args
4. Restart on crash with exponential backoff
5. Force kill after timeout

**Design consideration**: CLI args cannot be changed at runtime (unlike TCP). Profile changes require process restart.

---

## Planned: Device-Specific UI Features

### AirSpy Mini/R2

- VGA gain control (0-15)
- Mixer gain control (0-15)
- LNA gain control (0-14)
- Linearity vs Sensitivity mode toggle
- Bias-T toggle
- Sample rate selector (2.5 / 6 MS/s)

### AirSpy HF+

- HF LNA toggle
- HF vs VHF mode indicator
- RF gain reduction (0-47 dB)
- AGC vs Manual toggle
- Sample rate selector (96k-768k)

### SDRplay

- RF gain reduction (20-59 dB)
- LNA state (0-3)
- AGC mode (IQ/Both/Manual)
- Notch filter toggle
- Antenna port (A/B/C)
- Refclk output toggle
- Sample rate selector

### HackRF One

- RF amp toggle
- LNA gain (0-40 dB, 8dB steps)
- VGA gain (0-62 dB, 1dB steps)
- Sample rate selector
- Band selector indicator

### PlutoSDR

- RF bandwidth
- AGC mode
- Sample rate selector
- Direct frequency entry

### LimeSDR

- RF path selection
- LNA gain
- TIA gain
- PGA gain
- Sample rate selector
- Channels (1 or 2)

---

## Configuration Schema Extensions

```typescript
// New source types for CLI:
type SourceType = 'local' | 'rtl_tcp' | 'demo' | 'airspy_tcp' | 'hfp_tcp' | 'rsp_tcp'
  | 'airspy'    // CLI: airspy_rx
  | 'airspy_hf' // CLI: airspyhf_rx
  | 'hackrf'    // CLI: hackrf_transfer
  | 'pluto'     // CLI: iio_readdev
  | 'limesdr';  // CLI: SoapySDR

interface SourceConfig {
  // ... existing fields ...
  // HackRF
  rfAmp?: boolean;
  // AirSpy
  vgaGain?: number;
  mixerGain?: number;
  lnaGain?: number;
  // Pluto
  uri?: string;  // libiio URI (usb:... or ip:...)
  bufferSize?: number;
}
```

---

## Open Issues

- [ ] **HackRF**: Should we add native `hackrf-stream` npm support or stick to CLI?
- [ ] **Pluto network**: Disabled per user request — keep in roadmap or remove?
- [ ] **Sample rate validation**: Clamp to device-supported values or error?
- [ ] **CLI restart**: Profile changes require process restart — acceptable UX?
- [ ] **Multi-band profiles**: AirSpy HF+ has HF (0-31MHz) and VHF (60-260MHz) — model as one dongle with two profiles, or separate dongles?
- [ ] **LimeSDR dependencies**: LimeSuite is complex — prioritize or skip?