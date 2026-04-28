# Signal Quality Improvements — Weak Signal Reception

Research into practical DSP techniques for improving weak signal reception in the node-sdr WebSDR application.

## Current DSP Chain

```
RTL-SDR (8-bit ADC, ~48dB ENOB)
  → uint8 IQ normalize to ±1 float
  → NCO frequency shift → 4th-order Butterworth LPF → decimate → Int16 wire
  → Client demod: FM discriminator / AM envelope / SSB (I channel) / CW (BFO)
  → Spectral NR (Wiener, has artifacts) + Noise blanker (EMA + hang)
  → 5-band EQ → loudness compression → squelch → AudioWorklet
```

---

## Prioritized Implementation Plan

### Phase 1 — High Impact, Low Effort

| # | Technique | Where | Lines | Impact |
|---|-----------|-------|-------|--------|
| 1 | DC offset removal (IIR blocker at dongle input) | Server IqExtractor | ~20 | Removes center spike + intermod |
| 2 | Hang-timer AGC (Moe Wheatley/gqrx design) | Client (new module) | ~200 | 10-15 dB perceptual on SSB/CW |
| 3 | Variable CW/SSB bandwidth (200Hz/50Hz modes) | Server IqExtractor | ~30 | 4-10 dB SNR from BW reduction |
| 4 | Pre-filter noise blanker (blank IQ before LPF) | Server IqExtractor | ~30 | 10-20 dB impulse removal |

### Phase 2 — Significant Quality Jump

| # | Technique | Where | Lines | Impact |
|---|-----------|-------|-------|--------|
| 5 | LMS Adaptive NR (WDSP ANR algorithm) | Client | ~150 | 6-12 dB, no musical noise artifacts |
| 6 | Synchronous AM (PLL carrier lock + selectable sideband) | Client | ~200 | 6-10 dB on fading signals |
| 7 | FM hi-blend + soft mute | Client | ~50 | Better subjective quality |
| 8 | Kaiser window + slow-scan integration | Server FFT | ~40 | 3-12 dB spectrum sensitivity |

### Phase 3 — Polish

| # | Technique | Where | Lines | Impact |
|---|-----------|-------|-------|--------|
| 9 | Auto-notch filter (LMS heterodyne removal) | Client | ~150 | 20-30 dB on individual carriers |
| 10 | RNNoise WASM (neural voice NR) | Client | Integration | 10-15 dB on voice modes |
| 11 | MMSE-LSA spectral NR (replace Wiener) | Client | ~300 | Fewer artifacts on AM/WFM |

---

## Detailed Technique Descriptions

### 1. DC Offset Removal

**Priority: HIGHEST | Complexity: Low | Side: Server | Improvement: 3-6 dB effective dynamic range**

RTL-SDR dongles have a significant DC spike. The current code uses `(rawData[i] - 127.5) / 127.5` which is close but not adaptive. Add a simple IIR DC blocker at the input:

```typescript
// First-order DC blocker (alpha ≈ 0.9999 for <1Hz corner at 2.4MHz)
const alpha = 1 - (2 * Math.PI * 1.0 / sampleRate); // 1Hz corner
let dcI = 0, dcQ = 0;
for (let i = 0; i < n; i++) {
  const rawI = (buf[i*2] - 127.5) / 127.5;
  const rawQ = (buf[i*2+1] - 127.5) / 127.5;
  dcI = alpha * dcI + (1 - alpha) * rawI;
  dcQ = alpha * dcQ + (1 - alpha) * rawQ;
  iOut[i] = rawI - dcI;
  qOut[i] = rawQ - dcQ;
}
```

Also add TPDF dither before Int16 quantization to linearize quantization noise:

```typescript
// In IqExtractor, before Int16 quantization:
const dither = (Math.random() + Math.random() - 1.0) * 0.5; // TPDF, ±0.5 LSB
const iOut = Math.round(filteredI * 32767 + dither);
```

---

### 2. Hang-Timer AGC (Moe Wheatley Design)

**Priority: HIGHEST | Complexity: Medium | Side: Client | Improvement: 10-15 dB perceptual**

The system currently has no proper AGC between demodulation and audio output. This is the single biggest improvement for weak SSB/CW/AM signals.

Reference implementation: gqrx `src/dsp/agc_impl.cpp` (BSD licensed)

**Algorithm:**
- Signal delay line (15ms) — lets AGC "look ahead" to avoid clipping attacks
- Sliding window peak detector (18ms window) — tracks envelope without full-sample scanning
- Dual-path averaging: fast attack (2ms rise / 5ms fall) + slow decay (user-adjustable 20-5000ms)
- Hang mode: when signal drops, hold gain constant for `hangTime` ms before releasing (prevents pumping between words in SSB)
- Knee/slope: below threshold → fixed gain; above → variable slope (0-10 dB compression)

```typescript
// client/src/engine/agc.ts
export class HangAgc {
  private delaySamples: number;    // 15ms worth
  private windowSamples: number;   // 18ms worth
  private attackAve = -5.0;
  private decayAve = -5.0;
  private hangTimer = 0;
  private hangTime: number;
  private sigDelayBuf: Float32Array;  // look-ahead ring buffer
  private magBuf: Float32Array;       // peak detection window
  // ... attack/decay alpha coefficients from sample rate
}
```

**Per-mode tuning:**

| Mode | Decay ms | Hang | Threshold dB |
|------|----------|------|-------------|
| SSB  | 250      | Yes  | -80         |
| CW   | 100      | Yes  | -90         |
| AM   | 500      | No   | -70         |
| FM   | 1000     | No   | -60         |

---

### 3. Variable Bandwidth IF Filters for CW/SSB

**Priority: HIGH | Complexity: Low-Medium | Side: Server | Improvement: 3-10 dB SNR**

Current fixed output rates per mode (CW=12kHz, SSB=24kHz). For weak signal work, narrower is dramatically better.

**CW filter bandwidth progression:**
- Normal: 500 Hz (current effective BW at 12kHz output)
- Narrow: 200 Hz (needs 1200 Hz output rate, decimate by 2000 at 2.4MS/s)
- Ultra-narrow: 50 Hz (practical only with good frequency stability)

**Implementation:**
The server's `IqExtractor` already decimates — change the output rate dynamically based on a bandwidth command:

```typescript
// When client sends { cmd: 'bandwidth', hz: 200 }:
// outputSampleRate = bandwidth * 2.5 (need 2.5× oversampling for Butterworth rolloff)
// For 200Hz CW: outputRate = 500 Hz, decimation = 4800
```

**SNR improvement from bandwidth reduction:**
SNR gain = 10 × log10(BW_old / BW_new) = 10 × log10(500/200) = ~4 dB

For 6th-order Butterworth (3 biquad sections), upgrade the filter for very narrow bandwidths to get sharper skirt selectivity.

---

### 4. Pre-Filter Noise Blanker

**Priority: HIGH | Complexity: Low | Side: Server | Improvement: 10-20 dB impulse removal**

**Critical insight:** The current noise blanker operates after demodulation. A 1µs impulse at 2.4 MS/s is 2-3 samples. After the 4th-order Butterworth, it rings for hundreds of samples. Blanking BEFORE the decimation filter is far more effective.

```typescript
// Server-side blanking in IqExtractor, BEFORE Butterworth LPF:
const mag = Math.sqrt(rawI * rawI + rawQ * rawQ);
if (mag > avgMag * nbThreshold) { // threshold: 5-15× average
  rawI = 0; rawQ = 0; // or linear interpolate from edges
  blankCount = guardSamples; // blank for N more samples
} else if (blankCount > 0) {
  rawI = 0; rawQ = 0;
  blankCount--;
}
// Then feed rawI, rawQ into NCO + filter chain
```

The key difference: blanking 2-3 samples of raw IQ vs. blanking hundreds of samples of filter-rung audio.

---

### 5. LMS Adaptive Noise Reduction (ANR)

**Priority: HIGH | Complexity: Medium | Side: Client | Improvement: 6-12 dB, no artifacts**

The current Wiener spectral NR produces "musical noise" artifacts on tonal signals. The WDSP ANR is the gold standard for CW/SSB — it's an LMS adaptive predictor that extracts correlated (signal) components while suppressing uncorrelated (noise).

Reference: WDSP `anr.cpp` (from SDRangel `f4exb/sdrangel`)

**Algorithm (NLMS with leakage):**

```typescript
// Per sample:
d[in_idx] = input;
y = sum(w[j] * d[(in_idx + j + delay) & mask], j=0..n_taps-1);
sigma = sum(d[idx]², j=0..n_taps-1);
error = input - y;
output = y;  // noise-reduced signal (the prediction)

// Adaptive leakage (prevents divergence on non-stationary signals):
nel = |error * (1 - two_mu * sigma / (sigma + eps))|;
nev = |input - (1 - two_mu * ngamma) * y - two_mu * error * sigma / (sigma + eps)|;
if (nev < nel) lidx += lincr;  // leakage up
else            lidx -= ldecr;  // leakage down
ngamma = gamma * lidx⁴ * den_mult;

// Weight update:
w[j] = (1 - two_mu * ngamma) * w[j] + (two_mu * error / (sigma + eps)) * d[idx];
```

**Parameters for CW/SSB:**
- `n_taps`: 64 (CW) or 128 (SSB)
- `delay`: 8 (CW) or 16 (SSB) — decorrelation delay
- `two_mu` (gain): 2e-4 (CW) or 1e-4 (SSB)
- `gamma` (leakage): 1e-1
- `dline_size`: 2048 (ring buffer)

**Why this is better than Wiener NR for voice/CW:**
- No "musical noise" artifacts — operates in time domain
- Self-adapting — automatically adjusts to signal characteristics
- Particularly effective on CW (narrow tonal signal pops out of noise)
- Lower latency (no FFT block delay)

---

### 6. Synchronous AM Detection (SAM)

**Priority: HIGH | Complexity: Medium | Side: Client | Improvement: 6-10 dB on fading signals**

The current AM demodulator uses envelope detection (`sqrt(I² + Q²)`), which suffers badly from selective fading. Synchronous AM locks a PLL to the carrier and coherently demodulates.

Reference: WDSP `amd.cpp` (from SDRangel)

**Algorithm:**

```
1. Generate VCO: cos(phs), sin(phs)
2. Mix input with VCO: ai = I*cos, aq = Q*cos, bi = I*sin, bq = Q*sin
3. Error signal: corr[0] = ai + bq, corr[1] = -bi + aq
4. Phase detector: det = atan2(corr[1], corr[0])
5. Loop filter: omega += g2*det; fil_out = g1*det + omega
6. Update phase: phs += fil_out
7. Audio output: corr[0] (both sidebands) or separated via allpass network
```

**Key parameters:**
- Loop bandwidth (omegaN): 250 Hz for strong signals, 50 Hz for weak
- Damping (zeta): 0.707 (critically damped)
- Frequency range: ±1000 Hz search, ±200 Hz lock
- Level fade compensation: DC tracking with tau_R=0.02s, tau_I=1.4s

**Bonus — Selectable Sideband AM:** The WDSP implementation includes a 7-stage allpass polyphase network (Hilbert approximation) that separates USB and LSB from the carrier-locked signal. This lets users select just the cleaner sideband when one is affected by adjacent channel interference.

Allpass coefficients from WDSP:
```
c0[] = {-0.328201, -0.744171, -0.923022, -0.978490, -0.994128, -0.998458, -0.999790}
c1[] = {-0.099122, -0.565619, -0.857467, -0.959123, -0.988739, -0.996959, -0.999282}
```

---

### 7. FM Stereo Blend Improvement + Soft Mute

**Priority: MEDIUM-HIGH | Complexity: Low | Side: Client | Improvement: Subjective quality**

**a) Hi-blend (high-frequency stereo reduction):**
Before full mono fallback, progressively reduce stereo separation only at high frequencies (where noise is most audible):

```typescript
// Frequency-dependent blend: full stereo below 2kHz,
// progressive mono above 2kHz when SNR is marginal
const hiBlendCutoff = 2000 + snr * 100; // Hz, increases with SNR
// Apply 1st-order LPF to L-R difference channel with variable cutoff
```

**b) Soft mute (noise-proportional volume):**

```typescript
const softMuteGain = Math.min(1.0, Math.max(0.0, (snr - noiseThreshold) / 10.0));
// Smooth with 50ms time constant to avoid pumping
```

**c) Multipath cancellation:**
Use 19kHz pilot phase error variance as multipath indicator. When variance exceeds threshold, narrow audio bandwidth.

---

### 8. Kaiser Window + Slow-Scan Integration

**Priority: MEDIUM | Complexity: Low | Side: Server | Improvement: 3-12 dB spectrum sensitivity**

**FFT Window comparison:**

| Window | Sidelobe (dB) | Main lobe width | Best for |
|--------|--------------|-----------------|----------|
| Blackman-Harris 4-term | -92 | 4 bins | General purpose (current) |
| Kaiser β=9 | -90 | 3.6 bins | Weak signals near strong |
| Kaiser β=14 | -110 | 5 bins | Very weak signal detection |
| Flat-top | -44 | 5 bins | Amplitude accuracy |

```typescript
function kaiserWindow(N: number, beta: number): Float32Array {
  const w = new Float32Array(N);
  const denom = besselI0(beta);
  for (let i = 0; i < N; i++) {
    const x = 2.0 * i / (N - 1) - 1.0;
    w[i] = besselI0(beta * Math.sqrt(1 - x * x)) / denom;
  }
  return w;
}

function besselI0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 25; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}
```

**Integration for weak signals:**
Averaging N FFT frames improves SNR by 10×log10(N):
- 4 frames averaged: +6 dB sensitivity
- 16 frames averaged: +12 dB sensitivity

Add a user-adjustable "slow scan" mode for CW/digital signal spotting.

---

### 9. Auto-Notch Filter (LMS Heterodyne Removal)

**Priority: MEDIUM | Complexity: Medium | Side: Client | Improvement: 20-30 dB per heterodyne**

Same algorithm as ANR (item #5) but outputs the *error* signal (everything except predictable tones):

```typescript
// Same as ANR but:
output = error;  // residual = original minus predicted tones
// Parameters for ANF:
// n_taps: 64, delay: 0, two_mu: 1e-3, gamma: 1e-1
```

Alternative for known frequencies — cascaded biquad notch filters:

```typescript
function designNotch(freq: number, sampleRate: number, Q = 30): BiquadCoeffs {
  const w0 = 2 * Math.PI * freq / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const b0 = 1, b1 = -2 * Math.cos(w0), b2 = 1;
  const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 };
}
```

---

### 10. RNNoise (WASM) for Voice Modes

**Priority: LOW-MEDIUM | Complexity: Medium (integration) | Side: Client | Improvement: 10-15 dB on voice**

Neural network noise suppressor from Xiph.org/Mozilla, specifically trained on voice:
- Pre-compiled WASM module: ~200KB
- Operates at 48kHz, frame size 480 samples (10ms)
- Latency: 10ms
- CPU: negligible on modern browsers

**Caveats:**
- Destroys music (trained only on voice)
- Not suitable for CW or data modes
- Adds 10ms latency

Use `rnnoise-wasm` npm package. Offer as alternative NR option for voice SSB/AM only.

---

### 11. MMSE-LSA Spectral NR (Replace Wiener)

**Priority: MEDIUM | Complexity: High | Side: Client | Improvement: 3-6 dB better than Wiener**

Instead of hard spectral gain decisions (`gain = max(floor, 1 - noise/signal)`), MMSE-LSA uses speech presence probability:

```
gain = G_MMSE(xi, gamma) * speechPresenceProb + G_min * (1 - speechPresenceProb)
```

Where `xi` is the a-priori SNR (decision-directed). Eliminates musical noise artifacts.

Reference: Ephraim-Malah (1984/1985) papers. Python implementation in `pyroomacoustics`.

Most valuable for AM broadcast and WFM where spectral NR is the only option (ANR is better for CW/SSB).

---

## Key Insights

### Int16 Pipeline Assessment

The Int16 wire format is adequate:
- Processing gain from decimation: +10 dB (WFM), +17 dB (NFM), +23 dB (CW)
- After processing gain, weak signals at -45 dBFS in the 8-bit ADC sit at -22 dBFS in decimated output
- Int16 provides 96 dB dynamic range — plenty of headroom
- **No change needed** unless server-side AGC is added in future

### Why the Current Wiener NR Has Artifacts

Hard spectral gain decisions create "musical noise" — isolated spectral peaks that survive the gain floor appear as random tones. The LMS Adaptive NR (ANR) avoids this entirely by working in time domain with a decorrelation delay, extracting correlated signals and suppressing uncorrelated noise.

### The Noise Blanker Position Problem

The current noise blanker operates after demodulation. A 1µs impulse at 2.4 MS/s is 2-3 samples. After the 4th-order Butterworth IIR filter, it rings for hundreds of samples due to the filter's impulse response. Moving the blanker BEFORE the decimation filter is the single most impactful change for impulse noise environments (powerline noise, ignition interference, switching supply spurs).

---

## Reference Implementations

| Source | License | Techniques |
|--------|---------|-----------|
| gqrx (`gqrx-sdr/gqrx`) | BSD | AGC with hang timer |
| WDSP (in SDRangel `f4exb/sdrangel`) | GPL | ANR, ANF, SAM/AMD, MMSE |
| CuteSDR | BSD | Noise blanker, AGC, SAM |
| GNU Radio | GPL | General DSP blocks |
| OpenWebRX | AGPL | ADPCM codec, waterfall |
| SDR++ | GPL | Noise blanker, IF filters |
| RNNoise (`xiph/rnnoise`) | BSD-3 | Neural voice denoising |
