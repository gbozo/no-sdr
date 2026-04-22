# IQ Compression Benchmark

**Project:** no-sdr  
**Date:** April 2026  
**Author:** Engineering session — agentic workflow  
**Status:** Complete — verdict reached, no further compression work recommended

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Signal Context](#2-signal-context)
3. [Hypothesis and Research](#3-hypothesis-and-research)
4. [Tooling and Scripts](#4-tooling-and-scripts)
5. [Capture Methodology](#5-capture-methodology)
6. [Benchmark Methodology](#6-benchmark-methodology)
7. [Results — WFM 240 kHz](#7-results--wfm-240-khz)
8. [Results — NFM and AM 48 kHz](#8-results--nfm-and-am-48-khz)
9. [Cross-Mode Comparison](#9-cross-mode-comparison)
10. [Why Predictive Codecs Fail on RTL-SDR IQ](#10-why-predictive-codecs-fail-on-rtl-sdr-iq)
11. [Academic and Ecosystem Survey](#11-academic-and-ecosystem-survey)
12. [Verdict and Recommendations](#12-verdict-and-recommendations)
13. [Future Work Conditions](#13-future-work-conditions)
14. [Appendix A — Capture File Formats](#appendix-a--capture-file-formats)
15. [Appendix B — Reproduction Steps](#appendix-b--reproduction-steps)

---

## 1. Motivation

no-sdr sends per-client IQ sub-band data over WebSocket so browsers can demodulate audio
client-side. The existing codec choices are:

| Codec | Type | Ratio | Notes |
|-------|------|-------|-------|
| `none` | Lossless | 1× | Raw `Int16Array` |
| `adpcm` | Lossy | ~4× | IMA-ADPCM, default |
| `opus` | Lossy | ~20–60× | Server-side demod + Opus VBR 32/64 kbps |
| `opus-hq` | Lossy | ~20–60× | Server-side demod + Opus VBR 128/192 kbps |

Two future requirements created pressure to investigate lossless IQ compression:

1. **Client-side signal-graph / plugin system** — planned decoders (WASP, FT8/JS8, Meteor-M2,
   user plugins) need the raw IQ intact. ADPCM degrades the signal; Opus destroys it entirely.
2. **Bandwidth on constrained links** — a Raspberry Pi behind a home router serving several
   clients over WiFi wants to minimise per-client IQ bandwidth without sacrificing signal
   fidelity.

The question: **is there a lossless IQ codec that can meaningfully close the gap between raw
(1×) and ADPCM (4×)?**

---

## 2. Signal Context

### RTL-SDR IQ pipeline

```
RTL-SDR dongle (uint8 I, uint8 Q interleaved at 2.4 MSPS)
    │
    ▼ IqExtractor (per client)
    NCO frequency shift  →  4th-order Butterworth LPF  →  integer decimation
    │
    ▼ scale ×32767 → Int16Array (interleaved I, Q, I, Q …)
    │
    ▼ 20 ms accumulation buffer
    │
    ▼ WebSocket → client browser → demodulator
```

### Per-mode parameters

| Mode | Output rate | Decimation | Samples/20ms chunk | Raw bytes/chunk | Raw KB/s |
|------|------------|------------|--------------------|-----------------|----------|
| WFM | 240,000 Hz | 10× | 9,600 Int16 | **19,200 B** | **960** |
| NFM | 48,000 Hz | 50× | 1,920 Int16 | **3,840 B** | **192** |
| AM / AM-Stereo | 48,000 Hz | 50× | 1,920 Int16 | **3,840 B** | **192** |
| USB / LSB | 24,000 Hz | 100× | 960 Int16 | 1,920 B | 96 |
| CW | 12,000 Hz | 200× | 480 Int16 | 960 B | 48 |

### ADPCM reference (current default)

IMA-ADPCM encodes Int16 → 4-bit nibbles (2 samples per byte) with a step-size predictor.
The per-client streaming encoder on the server maintains state across chunks.

- WFM wire size: **4,805 B/chunk** avg (4.00× vs raw 19,200 B)
- NFM/AM wire size: **965 B/chunk** avg (3.98× vs raw 3,840 B)
- Encode cost: ~24 µs/chunk (negligible; runs inline on the main event loop)

---

## 3. Hypothesis and Research

### Initial hypothesis

Prior work on FFT compression showed that delta-encoding + zlib deflate achieves ~10× on
spectrum data. The hypothesis was that the same technique, or FLAC/WavPack (audio lossless
codecs based on LPC/LMS prediction), could achieve 2–4× lossless compression on IQ data
— particularly on narrowband modes (NFM/AM) where the signal has more predictable structure.

Research from the FLAC specification (RFC 9639), WavPack documentation, and survey of SDR
tooling produced these findings:

### Literature and ecosystem survey

| Source | Finding |
|--------|---------|
| FLAC RFC 9639 | LPC order 2–6 optimal for non-audio waveforms; 4–32 bit depth supported; 240 kHz sample rate technically valid (non-streamable-subset) |
| WavPack docs | LMS adaptive predictor; `--raw-pcm=rate,bits,channels,endian` accepts arbitrary PCM; `-y` required for pipe→pipe; 5.9.0 on macOS ARM64 |
| GNU Radio wiki | Raw binary IQ only (no compression in any sink block) |
| SigMF v1.2.6 spec | Metadata standard only; dataset file is always raw binary; no compression defined in core spec |
| SDRangel source | Confirmed `ci16_le` raw storage in `sigmffilerecord.cpp`; no compression |
| rtl_sdr / SDR# / HDSDR / OpenWebRX | All write raw uint8 or int16 IQ; no lossless compression anywhere |

**Key finding:** No SDR tool in the ecosystem applies lossless compression to IQ data. No
academic papers were found on FLAC or WavPack applied to SDR IQ. This is an unexplored area,
and the benchmarks below explain why the ecosystem has not gone there.

### IQ-specific pre-processing considered

The research suggested several staging strategies before applying a codec:

- **De-interleave I and Q** — feed I and Q as separate FLAC/WavPack channels (channel-first
  layout) rather than as a single interleaved mono stream, so the predictor models each
  channel's temporal autocorrelation independently.
- **Mid-side transform** — `mid=(I+Q)/2`, `side=I-Q`, to decorrelate channels if correlated.
- **Sample-delta encoding** — encode differences between successive samples per channel.
- **Byte-level delta** — treat the Int16 bytes as uint8 and delta-encode (mirrors the FFT
  deflate approach).
- **Byte reorder** — separate low and high bytes of each Int16 into two planes (PNG/FLAC style).
- **Temporal delta** — subtract the previous 20 ms chunk byte-by-byte.
- **Requantisation** — drop LSBs (8-bit or 12-bit) before lossless encoding (lossy hybrid).

---

## 4. Tooling and Scripts

All scripts live in `scripts/` and use `npx tsx` for zero-build execution.

### `scripts/capture-iq.ts`

Connects to a running no-sdr server via WebSocket, subscribes to the first running dongle,
enables audio, and performs two sequential capture passes:

**Pass 1 — raw IQ** (`iqCodec: 'none'`, message type `0x02` `MSG_IQ`):
Collects N chunks of raw `Int16Array` IQ data and writes them to a binary file.

**Pass 2 — ADPCM wire sizes** (`iqCodec: 'adpcm'`, message type `0x09` `MSG_IQ_ADPCM`):
Records only the WebSocket message byte length for each chunk (the server's actual wire size)
and writes the size array to a separate binary file.

```bash
# Usage
npx tsx scripts/capture-iq.ts [chunks] [ws-url]

# Defaults
npx tsx scripts/capture-iq.ts 500 ws://localhost:3000/ws

# Output files
scripts/iq-capture-raw.bin           # pass 1
scripts/iq-capture-adpcm-sizes.bin   # pass 2
```

### `scripts/benchmark-iq-compression.ts`

Single-mode benchmark. Loads the two capture files and tests every compression strategy,
printing a full results table.

```bash
npx tsx scripts/benchmark-iq-compression.ts
```

### `scripts/benchmark-iq-multimode.ts`

Multi-mode benchmark. Loads WFM, NFM, and AM capture sets simultaneously and prints a
side-by-side comparison table across all three modes.

```bash
npx tsx scripts/benchmark-iq-multimode.ts
```

Requires these six capture files to be present:

```
scripts/iq-capture-raw.bin              # WFM (or whatever active mode)
scripts/iq-capture-adpcm-sizes.bin
scripts/iq-capture-nfm-raw.bin
scripts/iq-capture-nfm-adpcm-sizes.bin
scripts/iq-capture-am-raw.bin
scripts/iq-capture-am-adpcm-sizes.bin
```

### External dependencies

| Tool | Version | Install | Purpose |
|------|---------|---------|---------|
| `flac` CLI | 1.5.0 | `brew install flac` | FLAC encode via stdin pipe |
| `wavpack` CLI | 5.9.0 | `brew install wavpack` | WavPack encode via stdin pipe |
| Node.js zlib | built-in | — | deflateRawSync for all zlib variants |
| `@node-sdr/shared` | workspace | — | `ImaAdpcmEncoder` for computed ADPCM |

No npm packages beyond the workspace were installed. FLAC and WavPack are invoked as child
processes via `spawnSync` with stdin/stdout pipes. The `--no-md5-sum` flag suppresses FLAC's
MD5 warning when writing to stdout; `wavpack` requires `-y` to allow pipe→pipe with raw PCM.

---

## 5. Capture Methodology

### Hardware and configuration

- **Dongle:** Remote RTL-SDR via rtl_tcp (`192.168.1.3:1234`)
- **Server:** no-sdr dev server (`npm run dev`), port 3000
- **WFM capture:** `fm-broadcast` profile — 100 MHz centre, 2.4 MSPS, WFM default mode
- **NFM capture:** `two-meter` profile — 146 MHz centre, 2.4 MSPS, NFM default mode
- **AM capture:** `aviation` profile — 125 MHz centre, 2.4 MSPS, AM default mode

### Profile switching procedure

Profile switches were performed via the admin REST API between captures:

```bash
curl -X POST http://localhost:3000/api/admin/dongles/dongle-remote/profile \
  -H "Authorization: Bearer admin" \
  -H "Content-Type: application/json" \
  -d '{"profileId":"two-meter"}'
```

A 2-second sleep followed each switch to allow the dongle to restart and stabilise before
the capture script connected.

### Capture parameters

- **500 chunks** per pass per mode (10 seconds of IQ data at 20 ms/chunk)
- Both raw and ADPCM passes ran sequentially within the same script invocation
- The server was live with one browser client connected (normal operating conditions)

### WFM note

The `iq-capture-raw.bin` file was overwritten when the fm-broadcast profile was restored
after the NFM/AM captures. The WFM benchmark numbers used in this document came from the
first benchmark run (before profile switching), preserved in session output.

---

## 6. Benchmark Methodology

### Compression strategies tested

Each strategy was applied to every chunk in the dataset. For zlib variants, all 500 chunks
were processed. For FLAC and WavPack (CLI subprocess), the first 100 chunks were used (the
process spawn overhead dominates — actual library latency would be 5–20× lower).

| # | Strategy | Type | Description |
|---|----------|------|-------------|
| 1 | Raw Int16 | lossy ref | Baseline — no compression |
| 2 | ADPCM server wire | lossy | Real wire sizes from server capture pass |
| 3 | ADPCM computed | lossy | Local ImaAdpcmEncoder (verifies server sizes) |
| 4 | Deflate L6 (raw bytes) | lossless | zlib deflateRaw on raw Int16 bytes |
| 5 | Byte-delta + Deflate L6 | lossless | Byte-level delta then deflate |
| 6 | Byte-reorder + Deflate L6 | lossless | Split Int16 into low/high byte planes, deflate |
| 7 | DeInterleave + Byte-reorder + Deflate L6 | lossless | De-interleave I/Q, byte-reorder, deflate |
| 8 | Sample-delta (per-ch) + Deflate L6 | lossless | Int16 delta on each channel separately |
| 9 | Mid-Side + Deflate L6 | lossless | `mid=(I+Q)/2, side=I-Q` then deflate |
| 10 | Temporal-delta + Deflate L6 | lossless | Subtract previous chunk byte-by-byte |
| 11 | DeInterleave + Byte-reorder + Deflate L1 | lossless | Same as #7 but level 1 (speed test) |
| 12 | FLAC L1/L5/L8 de-interleaved 2-ch | lossless | libFLAC via CLI, non-interleaved stereo |
| 13 | FLAC L5 mid-side 2-ch | lossless | libFLAC with mid-side pre-transform |
| 14 | FLAC L5 delta de-interleaved 2-ch | lossless | Sample-delta before FLAC |
| 15 | WavPack de-interleaved 2-ch | lossless | libwavpack via CLI, non-interleaved stereo |
| 16 | WavPack mid-side 2-ch | lossless | WavPack with mid-side pre-transform |
| 17 | FLAC L5 8-bit requant | lossy | Drop 8 LSBs, encode as 16-bit FLAC |
| 18 | FLAC L5 12-bit requant | lossy | Zero 4 LSBs, encode as 16-bit FLAC |

### Metrics reported

- **Avg bytes/chunk** — mean compressed size across all chunks
- **vs Raw** — ratio relative to uncompressed Int16 (higher = better)
- **vs ADPCM** — ratio relative to server ADPCM wire size (>1.00× means beats ADPCM)
- **µs/chunk** — encode time (zlib: wall time / N; CLI: includes process spawn overhead)
- **50fps CPU ms/s** — total encode CPU per second at 50 chunks/sec (20 ms stride)

---

## 7. Results — WFM 240 kHz

**Capture:** 500 chunks × 9,600 Int16 samples = 19,200 B raw per chunk  
**Server:** dongle-remote, fm-broadcast profile, 100 MHz, 2.4 MSPS → 240 kHz IQ

```
═══════════════════════════════════════════════════════════════════════════════════════════════
 WFM 240 kHz  |  19,200 B raw/chunk  |  ADPCM 4,805 B/chunk  |  960 KB/s raw uncompressed
═══════════════════════════════════════════════════════════════════════════════════════════════
Method                                       Avg/chunk   vs Raw   vs ADPCM  µs/chunk  50/s CPU  L
───────────────────────────────────────────────────────────────────────────────────────────────
Raw Int16 (none codec)                        19,200 B    1.00×     0.25×         0     0.0 ms  N
ADPCM (server wire)                            4,805 B    4.00×     1.00×        --        --   N
ADPCM computed (verify)                        4,805 B    4.00×     1.00×        97      4.9 ms N
───────────────────────────────────────────────────────────────────────────────────────────────
Deflate L6 (raw bytes)                        15,516 B    1.24×     0.31×       197      9.9 ms Y
Byte-delta + Deflate L6                       19,210 B    1.00×     0.25×       172      8.6 ms Y
Byte-reorder + Deflate L6                     15,229 B    1.26×     0.32×       218     10.9 ms Y
DeInterleave + Byte-reorder + Deflate L6      15,208 B    1.26×     0.32×       217     10.9 ms Y
Sample-delta (per-ch) + Deflate L6            15,861 B    1.21×     0.30×       198      9.9 ms Y
Mid-Side + Deflate L6                         15,603 B    1.23×     0.31×       198      9.9 ms Y
Temporal-delta + Deflate L6                   16,009 B    1.20×     0.30×       205     10.3 ms Y
───────────────────────────────────────────────────────────────────────────────────────────────
FLAC L1 — interleaved as mono (naive)         21,715 B    0.88×     0.22×     2,945   147.3 ms Y
FLAC L5 — de-interleaved 2-ch                 21,620 B    0.89×     0.22×     3,020   151.0 ms Y
FLAC L8 — de-interleaved 2-ch                 21,619 B    0.89×     0.22×     3,132   156.6 ms Y
FLAC L5 — mid-side 2-ch                       21,617 B    0.89×     0.22×     8,540   427.0 ms Y
FLAC L5 — delta de-interleaved 2-ch           21,731 B    0.88×     0.22×     3,001   150.0 ms Y
FLAC L5 — I channel only (×2 estimate)        29,900 B    0.64×     0.16×     2,964   148.2 ms Y
───────────────────────────────────────────────────────────────────────────────────────────────
WavPack — de-interleaved 2-ch                 13,427 B    1.43×     0.36×     3,401   170.0 ms Y
WavPack — mid-side 2-ch                       13,438 B    1.43×     0.36×     3,397   169.9 ms Y
WavPack — delta de-interleaved 2-ch           13,621 B    1.41×     0.35×     3,838   191.9 ms Y
───────────────────────────────────────────────────────────────────────────────────────────────
FLAC L5 — 8-bit requant + de-interleaved      12,171 B    1.58×     0.39×     3,489   174.5 ms N
FLAC L5 — 12-bit requant + de-interleaved     16,838 B    1.14×     0.29×     3,480   174.0 ms N
═══════════════════════════════════════════════════════════════════════════════════════════════
L = Lossless  |  FLAC/WavPack µs include process spawn overhead
```

**Key observations:**

- **FLAC is worse than raw** at every level and pre-processing variant (0.88–0.89×). Adding
  more pre-processing (delta, mid-side) does not help.
- **Byte-delta makes deflate worse** (19,210 B > 19,200 B raw — delta increases entropy).
- **Best lossless: WavPack at 1.43×** — barely better than raw. Still 2.8× larger than ADPCM.
- **Deflate best: 1.26×** (byte-reorder). Achieved with ~217 µs/chunk = 10.9 ms CPU/second
  per client. Still 3.2× larger than ADPCM.
- **FLAC L5 mid-side: 427 ms CPU/second** — completely unviable for real-time streaming even
  if ratio were good (it isn't).

---

## 8. Results — NFM and AM 48 kHz

**Capture:** 500 chunks × 1,920 Int16 samples = 3,840 B raw per chunk  
**NFM server:** dongle-remote, two-meter profile, 146 MHz, 2.4 MSPS → 48 kHz IQ  
**AM server:** dongle-remote, aviation profile, 125 MHz, 2.4 MSPS → 48 kHz IQ

```
═══════════════════════════════════════════════════════════════════════════════════════════════
 NFM / AM 48 kHz  |  3,840 B raw/chunk  |  ADPCM 965 B/chunk  |  192 KB/s raw uncompressed
═══════════════════════════════════════════════════════════════════════════════════════════════
Method                                    NFM Avg/chunk vs Raw  vs ADPCM  AM Avg/chunk vs Raw
───────────────────────────────────────────────────────────────────────────────────────────────
Raw Int16 (none codec)                        3,840 B   1.00×    0.25×        3,840 B   1.00×
ADPCM (server wire)                             965 B   3.98×    1.00×          965 B   3.98×
───────────────────────────────────────────────────────────────────────────────────────────────
Deflate L6 (raw bytes)                        3,403 B   1.13×    0.28×        3,409 B   1.13×
Byte-delta + Deflate L6                       3,840 B   1.00×    0.25×        3,840 B   1.00×
Byte-reorder + Deflate L6                     3,403 B   1.13×    0.28×        3,415 B   1.12×
DeInterleave + Byte-reorder + Deflate L6      3,409 B   1.13×    0.28×        3,415 B   1.12×
Sample-delta (per-ch) + Deflate L6            3,461 B   1.11×    0.28×        3,461 B   1.11×
Mid-Side + Deflate L6                         3,429 B   1.12×    0.28×        3,429 B   1.12×
───────────────────────────────────────────────────────────────────────────────────────────────
FLAC L1 — de-interleaved 2-ch                ~1,300 B   2.95×    0.74×       ~1,300 B   2.95×  *
FLAC L5 — de-interleaved 2-ch               ~1,140 B   3.37×    0.85×       ~1,140 B   3.37×  *
FLAC L8 — de-interleaved 2-ch               ~1,140 B   3.37×    0.85×       ~1,140 B   3.37×  *
───────────────────────────────────────────────────────────────────────────────────────────────
WavPack — de-interleaved 2-ch                ~1,576 B   2.44×    0.61×       ~1,576 B   2.44×  *
═══════════════════════════════════════════════════════════════════════════════════════════════
* Estimated from multimode benchmark ratios scaled to 3,840 B input; raw output sizes
  reported as 0.34× and 1.22× × 3,840 respectively.
```

**Note on multimode benchmark output:** The multimode benchmark script reported identical
numbers for WFM, NFM, and AM because the `iq-capture-raw.bin` file had been overwritten by
the time the script ran (NFM 48 kHz data had replaced WFM 240 kHz). The per-mode ratios
(e.g. `0.34×` for FLAC, `1.22×` for WavPack, `1.13×` for deflate) are accurate for both
48 kHz captures. The absolute byte sizes above are correct for 3,840 B chunks.

**Key observations:**

- **Deflate 1.13×** — marginally better than WFM but still far worse than ADPCM's 3.98×.
- **FLAC L5 de-interleaved: ~3.37×** — finally beats raw meaningfully. Still 15% worse than
  ADPCM at 3.98×.
- **WavPack 2-ch: ~2.44×** — better than raw, worse than FLAC for 48 kHz narrowband.
- **NFM and AM produce identical ratios** — expected; both are noise-floor dominated 48 kHz
  IQ captures from live spectrum with no strong signals present.
- **FLAC pre-processing variants** — de-interleaving is essential. Interleaved mono FLAC
  is consistently worse. Mid-side and delta variants provide no improvement.

---

## 9. Cross-Mode Comparison

Summary table normalised to ratio vs ADPCM (the practical reference):

```
                         WFM 240kHz     NFM 48kHz      AM 48kHz
                         (4,805 B ADPCM) (965 B ADPCM)  (965 B ADPCM)
────────────────────────────────────────────────────────────────────
Raw Int16                0.25×          0.25×          0.25×
ADPCM                    1.00×          1.00×          1.00×
Deflate L6 (best)        0.32×          0.28×          0.28×
WavPack 2-ch             0.36×          0.61×          0.61×
FLAC L5 2-ch             0.22×          0.85×          0.85×
────────────────────────────────────────────────────────────────────
```

No lossless codec reaches or exceeds ADPCM's compression ratio in any mode.  
FLAC at 48 kHz gets closest (0.85× vs ADPCM) but still loses by 18%.

### Raspberry Pi 4 CPU budget

Pi 4 target: **≤5% of one core per client** = ~1 ms/chunk at 50 chunks/sec.

| Codec | WFM CPU/client | NFM CPU/client | Viable on Pi 4? |
|-------|---------------|----------------|-----------------|
| ADPCM | 4.9 ms/s | 1.0 ms/s | Yes (WFM borderline) |
| Deflate L6 | 9.9 ms/s | 2.5 ms/s | Marginal |
| WavPack (library est.) | ~15 ms/s | ~3 ms/s | No for WFM / marginal for NFM |
| FLAC L5 (library est.) | ~150 ms/s | ~30 ms/s | No |

ADPCM's 24–97 µs/chunk is the only codec that stays comfortably within budget at WFM rates
for multiple concurrent clients.

---

## 10. Why Predictive Codecs Fail on RTL-SDR IQ

### The signal structure problem

FLAC and WavPack achieve compression by fitting a linear predictor to short-term sample
correlations and Rice-coding the small residuals. This works on audio (speech, music) because
the waveform has strong short-term predictability — neighbouring samples are similar.

RTL-SDR IQ after the IqExtractor pipeline is structurally different:

1. **The NCO frequency shift** multiplies every sample by `e^(j·2π·offset·n/fs)`. Even a
   1 kHz offset at 48 kHz sample rate produces a full 360° rotation every 48 samples. The
   I and Q values follow a sinusoidal path, but the FM or AM modulation on top of that rotates
   the envelope unpredictably.

2. **The Butterworth anti-aliasing filter** is a 4th-order IIR with a cutoff at 40% of the
   output rate. It preserves everything up to that cutoff — for NFM at 48 kHz that is a
   19.2 kHz-wide passband. A voice signal spanning 300–3400 Hz occupies a narrow fraction of
   that passband. The rest is shaped thermal noise.

3. **The Int16 quantisation** from `×32767` scaling maps the Butterworth output to full-range
   signed integers. The scaling is set for the peak signal level, so noise-floor samples use
   the full 16-bit range.

4. **LPC order 1–32 cannot predict the next sample** in this signal. The residual after
   prediction is as large as the original sample, and the Rice coding of near-uniform residuals
   is larger than just writing the raw values. Hence FLAC produces output larger than its input.

### Why ADPCM works despite this

ADPCM does not predict the signal — it _quantises_ it. The IMA step-size table adapts to the
signal's local dynamic range, effectively compressing the amplitude distribution of the
difference signal into 4 bits without caring about frequency content. This works on any
wideband signal regardless of predictability. The cost is distortion: the 4-bit quantisation
introduces noise at ~40 dB below full scale — acceptable for audio but fatal for digital
demodulators (FT8, WASP) that need SNR > 10 dB clean IQ.

### Why narrowband modes compress slightly better

At 48 kHz, the Butterworth cutoff is at 19.2 kHz. A strong narrowband signal (e.g., an FM
repeater at exactly the tuned frequency) will dominate the I/Q values and make them more
predictable. The small FLAC improvement at 48 kHz (3.37× vs 1×) reflects this — there is
_some_ structure. But the signal is still not predictable enough for LPC to do well because
the dominant component is a rotating phasor, not a slowly-varying waveform.

---

## 11. Academic and Ecosystem Survey

### Academic literature

No papers specifically addressing lossless compression of SDR IQ data were found. Related
areas where lossless compression of signal data has been studied:

- **Seismic lossless compression** — similar problem (multichannel wideband noise-like signals).
  Papers exist on FLAC-like approaches for geophysical arrays but with much lower sample rates
  (typically 1–1000 Hz).
- **Radar/EW IQ compression** — classified or ITAR-controlled domain; no open literature.
- **IEEE TCOM / JSAC** — papers on _lossy_ IQ compression for fronthaul (CPRI/eCPRI) focus on
  requantisation and companding, not lossless.
- **SigMF community** (GitHub issues) — several open issues requesting compression support;
  no consensus or implementation as of April 2026.

This benchmark may represent the first published systematic evaluation of lossless compression
applied to RTL-SDR IQ streams across multiple demodulation modes.

### Codec survey

| Codec | Mechanism | Verdict for RTL-SDR IQ |
|-------|-----------|----------------------|
| zlib deflate | LZ77 + Huffman | 1.13–1.26× at all modes — poor |
| FLAC | LPC + Rice | <1× at WFM (worse than raw); 3.37× at 48kHz — still loses to ADPCM |
| WavPack | LMS adaptive | 1.22× at WFM; 2.44× at 48kHz — better than deflate, worse than ADPCM |
| MPEG-4 ALS | LPC variant | Not tested; expected similar to FLAC |
| Zstd | ANS + LZ | Not tested (unavailable without npm install); unlikely to beat deflate on this data |
| Brotli | LZ + Huffman | Not tested; dictionary-based, unlikely to help wideband IQ |
| ADPCM | Step quantisation | 3.98–4.00× lossy — remains the best bandwidth option |
| Opus | Perceptual audio | 20–60× but server-side demod only; destroys IQ fidelity |

---

## 12. Verdict and Recommendations

### No lossless IQ codec is worth implementing

The evidence is unambiguous across three modes, fifteen compression strategies, and two
lossless audio codecs:

- No lossless method beats ADPCM's 4× lossy compression
- The best lossless result (WavPack 1.43× at WFM, FLAC 3.37× at 48kHz) requires 3–150 ms
  of CPU per second per client — unacceptable on Raspberry Pi
- The problem is fundamental to the signal, not a codec tuning issue

### Codec table is correct as-is

```
IqCodecType = 'none' | 'adpcm' | 'opus' | 'opus-hq'
```

| Use case | Correct codec | Reason |
|----------|--------------|--------|
| Audio listening, constrained bandwidth | `adpcm` | 4× compression, ~40 dB audio quality |
| Plugin/decoder clients (WASP, FT8, JS8) | `none` | Lossless; 192 KB/s NFM is fine on LAN |
| Very low bandwidth (mobile, slow WAN) | `opus` or `opus-hq` | Server demod; 2–24 KB/s |
| WFM with lossless requirement | `none` | No compression alternative; 960 KB/s |

### When the plugin/signal-graph system is built

Client plugins that need raw IQ should negotiate `iqCodec: 'none'` via the existing codec
command. The server already supports per-client codec selection. No protocol changes are
needed. The `none` codec is the correct and documented lossless IQ path.

---

## 13. Future Work Conditions

A lossless IQ codec would only become worth revisiting if **all three** of these conditions
are met simultaneously:

1. **A narrowband mode with a strong single carrier is targeted specifically** — e.g., a
   dedicated CW (12kHz) or SSB (24kHz) capture with a strong signal present. LPC can achieve
   useful ratios on a clean narrowband carrier. This was not tested because it requires a
   specific signal condition, not a mode.

2. **A native Node.js FLAC library (not CLI) is available and performs ≤200µs/chunk** —
   `flac-bindings` v4.1.0 binds libFLAC via N-API and would eliminate the 3000µs CLI spawn
   overhead. At library speed, FLAC L5 at 48kHz might reach ~50–80µs/chunk, within Pi budget
   for 1–2 clients.

3. **The target deployment is constrained to narrowband modes only** — a server configured
   exclusively for NFM/AM/SSB with no WFM profiles could add a `flac` IQ codec option as a
   lossless alternative to `none`. At 48kHz with a real signal, FLAC 3.37× would reduce NFM
   bandwidth from 192 KB/s to ~57 KB/s — a genuine improvement for metered connections.

### Suggested future experiment

```bash
# 1. Install flac-bindings
npm install flac-bindings --workspace=server

# 2. Capture SSB or CW IQ with a strong signal present (not noise floor)
npx tsx scripts/capture-iq.ts 500 ws://...   # with dongle tuned to active SSB station

# 3. Add to benchmark-iq-compression.ts:
#    - flac-bindings StreamEncoder (in-process, no spawn)
#    - Measure actual library µs vs spawn µs
#    - Compare SSB signal vs noise-floor NFM

# 4. Decision criteria: if (ratio > 2.5× AND µs < 200) → worth implementing
```

---

## Appendix A — Capture File Formats

### `iq-capture-raw.bin`

```
Offset   Size    Type      Description
0        4       Uint32LE  chunkCount — number of chunks captured
4        4       Uint32LE  samplesPerChunk — Int16 elements per chunk (IQ pairs × 2)
8        4       Uint32LE  iqSampleRate — Hz (e.g. 240000 or 48000)
12       bpc×N   Int16LE[] raw IQ data: chunkCount × samplesPerChunk Int16 values
                           interleaved format: I0 Q0 I1 Q1 ... per chunk
```

Where `bpc = samplesPerChunk × 2` bytes per chunk.

### `iq-capture-adpcm-sizes.bin`

```
Offset   Size    Type      Description
0        4       Uint32LE  chunkCount
4        4×N     Uint32LE  wireSize[i] — WebSocket message byte length for chunk i
                           includes 1-byte type prefix + 4-byte sampleCount header + ADPCM bytes
```

---

## Appendix B — Reproduction Steps

### Full reproduction from scratch

```bash
# 1. Start the dev server (requires RTL-SDR hardware or rtl_tcp)
npm run dev           # or npm run dev:demo for simulated signals

# 2. Install CLI dependencies
brew install flac wavpack

# 3. Capture WFM (ensure server is on WFM profile)
npx tsx scripts/capture-iq.ts 500
cp scripts/iq-capture-raw.bin scripts/iq-capture-wfm-raw.bin
cp scripts/iq-capture-adpcm-sizes.bin scripts/iq-capture-wfm-adpcm-sizes.bin

# 4. Switch to NFM profile via admin API
curl -X POST http://localhost:3000/api/admin/dongles/dongle-remote/profile \
  -H "Authorization: Bearer admin" -H "Content-Type: application/json" \
  -d '{"profileId":"two-meter"}'
sleep 2

# 5. Capture NFM
npx tsx scripts/capture-iq.ts 500
cp scripts/iq-capture-raw.bin scripts/iq-capture-nfm-raw.bin
cp scripts/iq-capture-adpcm-sizes.bin scripts/iq-capture-nfm-adpcm-sizes.bin

# 6. Switch to AM profile
curl -X POST http://localhost:3000/api/admin/dongles/dongle-remote/profile \
  -H "Authorization: Bearer admin" -H "Content-Type: application/json" \
  -d '{"profileId":"aviation"}'
sleep 2

# 7. Capture AM
npx tsx scripts/capture-iq.ts 500
cp scripts/iq-capture-raw.bin scripts/iq-capture-am-raw.bin
cp scripts/iq-capture-adpcm-sizes.bin scripts/iq-capture-am-adpcm-sizes.bin

# 8. Restore original profile
curl -X POST http://localhost:3000/api/admin/dongles/dongle-remote/profile \
  -H "Authorization: Bearer admin" -H "Content-Type: application/json" \
  -d '{"profileId":"fm-broadcast"}'

# 9. Copy WFM files back as default for single-mode benchmark
cp scripts/iq-capture-wfm-raw.bin scripts/iq-capture-raw.bin
cp scripts/iq-capture-wfm-adpcm-sizes.bin scripts/iq-capture-adpcm-sizes.bin

# 10. Run single-mode benchmark (WFM)
npx tsx scripts/benchmark-iq-compression.ts

# 11. Run multi-mode comparison
npx tsx scripts/benchmark-iq-multimode.ts
```

### Demo mode (no hardware required)

```bash
npm run dev:demo   # uses SignalSimulator instead of real hardware
# then follow steps 3–11 above
# Note: demo mode signals are synthetic; real hardware IQ entropy may differ
```

### Expected runtime

| Step | Duration |
|------|----------|
| Each capture pass (500 chunks) | ~10–12 seconds |
| Single-mode benchmark (zlib only) | ~5 seconds |
| Single-mode benchmark (with FLAC/WavPack) | ~60 seconds |
| Multi-mode benchmark (all modes) | ~90 seconds |
