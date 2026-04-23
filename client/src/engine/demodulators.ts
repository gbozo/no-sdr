// ============================================================
// node-sdr — Client-Side Demodulators
// ============================================================
// Pure TypeScript DSP demodulators for analog modes.
// Takes IQ sub-band data (Int16 interleaved) from the server
// and produces Float32 audio samples for the AudioEngine.
//
// The server extracts the relevant IQ sub-band for each user's
// tuning offset and sends it via MSG_IQ. These demodulators
// process that data entirely in the browser.
// ============================================================

import type { DemodMode } from '@node-sdr/shared';
import { RdsDecoder } from './rds-decoder.js';
import type { RdsData } from './rds-decoder.js';

// ---- Stereo Output ----

export interface StereoAudio {
  left: Float32Array;
  right: Float32Array;
  /** True if stereo pilot was detected */
  stereo: boolean;
}

// ---- Base Demodulator Interface ----

export interface Demodulator {
  /** Human-readable name */
  readonly name: string;
  /** Mode identifier */
  readonly mode: DemodMode;
  /** Whether this demodulator can produce stereo output */
  readonly stereoCapable: boolean;
  /** Process interleaved IQ Int16 samples, return mono audio Float32 */
  process(iq: Int16Array): Float32Array;
  /**
   * Process interleaved IQ Int16 samples, return stereo audio.
   * Only available when stereoCapable is true.
   * Falls back to duplicated mono if stereo is not detected.
   */
  processStereo?(iq: Int16Array): StereoAudio;
  /** Reset internal state (e.g., on frequency change) */
  reset(): void;
  /** Set the IQ input sample rate (from server's IQ extractor) */
  setInputSampleRate(rate: number): void;
  /** Set the filter bandwidth in Hz */
  setBandwidth(hz: number): void;
  /** Register RDS data callback (WFM only) */
  setRdsCallback?(cb: (data: RdsData) => void): void;
  /** Get current RDS data snapshot (WFM only) */
  getRdsData?(): RdsData | null;
}

export type { RdsData } from './rds-decoder.js';

// ---- Low-Pass FIR Filter ----

class FirFilter {
  private coeffs: Float32Array;
  private buffer: Float32Array;
  private bufferIndex = 0;
  private taps: number;

  constructor(taps: number, cutoffRatio: number) {
    this.taps = taps;
    this.coeffs = new Float32Array(taps);
    this.buffer = new Float32Array(taps);
    this.design(cutoffRatio);
  }

  /**
   * Design a low-pass FIR filter using windowed sinc (Blackman-Harris)
   * @param cutoffRatio - cutoff frequency / sample rate (0 to 0.5)
   */
  design(cutoffRatio: number): void {
    const M = this.taps - 1;
    const fc = Math.min(0.5, Math.max(0.001, cutoffRatio));
    let sum = 0;

    for (let i = 0; i <= M; i++) {
      // Sinc function
      const n = i - M / 2;
      let h: number;
      if (Math.abs(n) < 1e-10) {
        h = 2 * fc;
      } else {
        h = Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      }

      // Blackman-Harris window
      const w =
        0.35875 -
        0.48829 * Math.cos((2 * Math.PI * i) / M) +
        0.14128 * Math.cos((4 * Math.PI * i) / M) -
        0.01168 * Math.cos((6 * Math.PI * i) / M);

      this.coeffs[i] = h * w;
      sum += this.coeffs[i];
    }

    // Normalize
    for (let i = 0; i <= M; i++) {
      this.coeffs[i] /= sum;
    }
  }

  /** Filter a single sample */
  process(sample: number): number {
    this.buffer[this.bufferIndex] = sample;
    let output = 0;

    let j = this.bufferIndex;
    for (let i = 0; i < this.taps; i++) {
      output += this.coeffs[i] * this.buffer[j];
      j--;
      if (j < 0) j = this.taps - 1;
    }

    this.bufferIndex = (this.bufferIndex + 1) % this.taps;
    return output;
  }

  reset(): void {
    this.buffer.fill(0);
    this.bufferIndex = 0;
  }
}

// ---- DC Blocker ----

class DcBlocker {
  private xPrev = 0;
  private yPrev = 0;
  private alpha: number;

  constructor(alpha = 0.995) {
    this.alpha = alpha;
  }

  process(x: number): number {
    const y = x - this.xPrev + this.alpha * this.yPrev;
    this.xPrev = x;
    this.yPrev = y;
    return y;
  }

  reset(): void {
    this.xPrev = 0;
    this.yPrev = 0;
  }
}

// ---- De-emphasis Filter (for FM) ----

class DeemphasisFilter {
  private prev = 0;
  private alpha: number;

  /**
   * @param tau - time constant in seconds (75µs for US, 50µs for EU)
   * @param sampleRate - sample rate at which the filter operates
   */
  constructor(tau: number, sampleRate: number) {
    // α = dt / (τ + dt)  — matches server-side Deemph formula
    const dt = 1 / sampleRate;
    this.alpha = dt / (tau + dt);
  }

  process(x: number): number {
    this.prev = this.prev + this.alpha * (x - this.prev);
    return this.prev;
  }

  setParams(tau: number, sampleRate: number): void {
    const dt = 1 / sampleRate;
    this.alpha = dt / (tau + dt);
  }

  reset(): void {
    this.prev = 0;
  }
}

// ---- AGC (Automatic Gain Control) ----

class Agc {
  private gain = 1;
  private targetLevel: number;
  private attack: number;
  private decay: number;
  private maxGain: number;

  constructor(targetLevel = 0.5, attack = 0.01, decay = 0.0001, maxGain = 100) {
    this.targetLevel = targetLevel;
    this.attack = attack;
    this.decay = decay;
    this.maxGain = maxGain;
  }

  process(x: number): number {
    const output = x * this.gain;
    const absOut = Math.abs(output);

    if (absOut > this.targetLevel) {
      this.gain -= this.attack * (absOut - this.targetLevel);
    } else {
      this.gain += this.decay * (this.targetLevel - absOut);
    }

    this.gain = Math.max(0.001, Math.min(this.maxGain, this.gain));
    return output;
  }

  reset(): void {
    this.gain = 1;
  }
}

// ---- Decimator ----

class Decimator {
  private filter: FirFilter;
  private factor: number;
  private counter = 0;

  constructor(factor: number, taps = 31) {
    this.factor = Math.max(1, Math.floor(factor));
    // Anti-aliasing filter at 0.45/factor (slightly below Nyquist)
    this.filter = new FirFilter(taps, 0.45 / this.factor);
  }

  /** Process one sample; returns the decimated sample or null if skipped */
  process(sample: number): number | null {
    const filtered = this.filter.process(sample);
    this.counter++;
    if (this.counter >= this.factor) {
      this.counter = 0;
      return filtered;
    }
    return null;
  }

  reset(): void {
    this.filter.reset();
    this.counter = 0;
  }
}

// ---- Utility: Convert interleaved Int16 IQ to normalized Float32 I and Q ----

function iqInt16ToFloat(iq: Int16Array): [Float32Array, Float32Array] {
  const n = iq.length >> 1;
  const iSamples = new Float32Array(n);
  const qSamples = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    iSamples[k] = iq[k * 2] / 32768;
    qSamples[k] = iq[k * 2 + 1] / 32768;
  }
  return [iSamples, qSamples];
}

// ============================================================
// FM Demodulator (Wideband + Narrowband)
// ============================================================
// Uses polar discriminator: θ[n] = atan2(Q[n]I[n-1] - I[n]Q[n-1],
//                                        I[n]I[n-1] + Q[n]Q[n-1])
//
// WFM stereo: The FM discriminator output at 240 kHz is the
// composite MPX signal containing:
//   0-15 kHz:  L+R (mono compatible)
//   19 kHz:    Pilot tone
//   23-53 kHz: L-R DSB-SC (suppressed carrier at 38 kHz)
//   57 kHz:    RDS subcarrier (not decoded)
//
// Stereo decoding:
//   1. Bandpass 19 kHz pilot → PLL to lock phase
//   2. Multiply composite by cos(2×pilot_phase) → L-R baseband
//   3. LPF L+R and L-R to 15 kHz
//   4. Matrix: L = (L+R + L-R)/2, R = (L+R - L-R)/2
//   5. De-emphasis on each channel
//   6. Decimate 240k → 48k (factor 5)
// ============================================================

/**
 * 2nd-order IIR biquad filter for pilot bandpass and other uses.
 * Uses Direct Form II Transposed for numerical stability.
 */
class BiquadFilter {
  private b0: number;
  private b1: number;
  private b2: number;
  private a1: number;
  private a2: number;
  private z1 = 0;
  private z2 = 0;

  constructor(b0: number, b1: number, b2: number, a1: number, a2: number) {
    this.b0 = b0;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  /**
   * Design a 2nd-order bandpass filter (constant-Q).
   * @param centerFreq - center frequency in Hz
   * @param Q - quality factor (higher = narrower)
   * @param sampleRate - sample rate in Hz
   */
  static bandpass(centerFreq: number, Q: number, sampleRate: number): BiquadFilter {
    const w0 = 2 * Math.PI * centerFreq / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosW0 = Math.cos(w0);

    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cosW0;
    const a2 = 1 - alpha;

    return new BiquadFilter(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }
}

/**
 * Phase-Locked Loop for tracking the 19 kHz stereo pilot tone.
 * Uses a simple 2nd-order PLL with proportional-integral loop filter.
 * Output: locked phase at 2× pilot frequency (38 kHz) for L-R demodulation.
 */
class PilotPll {
  private phase = 0;
  private freq: number;
  private phaseIncrement: number;
  private sampleRate: number;

  // Loop filter gains (PI controller)
  private alpha: number; // proportional gain
  private beta: number;  // integral gain

  // PLL state
  private freqError = 0;

  // Pilot detection via SNR: compare narrowband pilot energy to broadband noise
  private pilotDetected = false;
  private _blendFactor = 0;    // continuous 0-1 stereo blend (0=mono, 1=full stereo)
  private pilotEnergy = 0;     // smoothed energy of BPF'd pilot
  private noiseEnergy = 0;     // smoothed broadband composite energy
  private energyAlpha = 0.002; // smoothing (~500 sample time constant ≈ 2ms at 240kHz)

  // Detection hold timer — prevents rapid on/off cycling
  private holdCounter = 0;
  private holdSamples: number; // ~200ms worth of samples

  // Bandpass filter for pilot extraction (used for detection only)
  private bpf: BiquadFilter;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.freq = 19000; // 19 kHz
    this.phaseIncrement = 2 * Math.PI * this.freq / sampleRate;
    this.holdSamples = Math.round(sampleRate * 0.2); // 200ms hold

    // PLL loop bandwidth ~50 Hz (tight enough for stable lock, fast enough to acquire)
    const BL = 50;
    const dampingFactor = 0.707;
    const Kp = 2 * dampingFactor * BL * 2 * Math.PI / sampleRate;
    const Ki = (BL * 2 * Math.PI / sampleRate) ** 2;
    this.alpha = Kp;
    this.beta = Ki;

    // Narrow BPF at 19 kHz for pilot detection (Q=30 → ~633 Hz bandwidth)
    // Slightly wider than before (was Q=50) for more robust detection
    this.bpf = BiquadFilter.bandpass(19000, 30, sampleRate);
  }

  /**
   * Process one sample of the composite MPX signal.
   * Returns cos(2 × pilotPhase) for L-R demodulation.
   */
  process(composite: number): number {
    // Generate local oscillator at current estimated pilot frequency
    const pilotRef = Math.sin(this.phase);

    // Phase detector: multiply input by reference
    const phaseError = composite * pilotRef;

    // Loop filter (PI)
    this.freqError += this.beta * phaseError;
    const correction = this.alpha * phaseError + this.freqError;

    // Update phase
    this.phase += this.phaseIncrement + correction;

    // Keep phase in [0, 2π)
    while (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;
    while (this.phase < 0) this.phase += 2 * Math.PI;

    // --- Pilot detection via SNR ---
    // Extract 19 kHz via narrow BPF and compare energy to broadband
    const pilotBpfOut = this.bpf.process(composite);
    this.pilotEnergy = this.pilotEnergy * (1 - this.energyAlpha) + (pilotBpfOut * pilotBpfOut) * this.energyAlpha;
    this.noiseEnergy = this.noiseEnergy * (1 - this.energyAlpha) + (composite * composite) * this.energyAlpha;

    // SNR = pilot energy / total energy
    const snr = this.noiseEnergy > 1e-12 ? this.pilotEnergy / this.noiseEnergy : 0;

    // Hysteresis with hold timer:
    // - Turn ON when SNR exceeds upper threshold
    // - Turn OFF only after SNR stays below lower threshold for holdSamples (~200ms)
    // This prevents rapid toggling from multipath fading or signal fluctuations
    if (snr > 0.006) {
      this.pilotDetected = true;
      this.holdCounter = this.holdSamples;
    } else if (snr < 0.002) {
      if (this.holdCounter > 0) {
        this.holdCounter--;
      } else {
        this.pilotDetected = false;
      }
    } else {
      // In the hysteresis band — maintain current state, keep hold alive if detected
      if (this.pilotDetected) {
        this.holdCounter = this.holdSamples;
      }
    }

    // Continuous stereo blend factor: smooth transition from mono to stereo
    // Maps SNR range [0.002, 0.012] to blend [0.0, 1.0]
    const targetBlend = this.pilotDetected
      ? Math.max(0, Math.min(1, (snr - 0.002) / (0.012 - 0.002)))
      : 0;
    // Smooth blend factor (fast attack for stereo onset, slow release for graceful fade)
    const blendAlpha = targetBlend > this._blendFactor ? 0.015 : 0.003;
    this._blendFactor += blendAlpha * (targetBlend - this._blendFactor);

    // Return cos(2 × phase) for 38 kHz L-R demod
    return Math.cos(2 * this.phase);
  }

  get detected(): boolean {
    return this.pilotDetected;
  }

  get blendFactor(): number {
    return this._blendFactor;
  }

  reset(): void {
    this.phase = 0;
    this.freqError = 0;
    this.pilotEnergy = 0;
    this.noiseEnergy = 0;
    this.pilotDetected = false;
    this._blendFactor = 0;
    this.holdCounter = 0;
    this.bpf.reset();
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.phaseIncrement = 2 * Math.PI * this.freq / rate;
    this.holdSamples = Math.round(rate * 0.2);

    const BL = 50;
    const dampingFactor = 0.707;
    const Kp = 2 * dampingFactor * BL * 2 * Math.PI / rate;
    const Ki = (BL * 2 * Math.PI / rate) ** 2;
    this.alpha = Kp;
    this.beta = Ki;

    this.bpf = BiquadFilter.bandpass(19000, 30, rate);
  }
}

class FmDemodulator implements Demodulator {
  readonly name: string;
  readonly mode: DemodMode;
  readonly stereoCapable: boolean;

  private prevI = 0;
  private prevQ = 0;
  private lpFilter: FirFilter;      // mono/composite LP
  private deemphL: DeemphasisFilter; // de-emphasis for left/mono
  private deemphR: DeemphasisFilter; // de-emphasis for right
  private dcBlocker: DcBlocker;
  private dcBlockerR: DcBlocker;     // separate DC blocker for right channel
  private decimator: Decimator | null = null;
  private decimatorR: Decimator | null = null; // separate decimator for right channel
  private gain: number;

  private inputSampleRate: number;
  private outputSampleRate = 48000;
  private bandwidth: number;
  private wideband: boolean;

  // Stereo FM components (WFM only)
  private pilotPll: PilotPll | null = null;
  private lrFilter: FirFilter | null = null;        // L-R low-pass at 15 kHz
  private lprFilter: FirFilter | null = null;       // L+R low-pass at 15 kHz
  private stereoEnabled = true;                     // user can disable stereo
  private _stereoDetected = false;

  // RDS decoder (WFM only)
  private rdsDecoder: RdsDecoder | null = null;
  private onRdsCallback?: (data: RdsData) => void;

  constructor(wideband: boolean) {
    this.wideband = wideband;
    this.mode = wideband ? 'wfm' : 'nfm';
    this.name = wideband ? 'Wideband FM' : 'Narrowband FM';
    this.stereoCapable = wideband; // only WFM has stereo

    this.bandwidth = wideband ? 200_000 : 12_500;
    this.inputSampleRate = wideband ? 240_000 : 48_000;

    // FM deviation → gain factor
    // For WFM: ±75kHz deviation, for NFM: ±5kHz deviation
    const deviation = wideband ? 75_000 : 5_000;
    this.gain = this.inputSampleRate / (2 * Math.PI * deviation);

    // Low-pass filter for demodulated audio (or composite for WFM stereo)
    // For WFM stereo, we need the full composite up to ~53 kHz,
    // but our audio cutoff at 15 kHz for mono-only path
    const audioCutoff = wideband ? 15_000 : 4_000;
    this.lpFilter = new FirFilter(51, audioCutoff / this.inputSampleRate);

    // De-emphasis: 75µs (US/Japan) or 50µs (EU) — using 75µs as default
    const deemphRate = wideband ? this.inputSampleRate : this.outputSampleRate;
    this.deemphL = new DeemphasisFilter(75e-6, deemphRate);
    this.deemphR = new DeemphasisFilter(75e-6, deemphRate);

    this.dcBlocker = new DcBlocker();
    this.dcBlockerR = new DcBlocker();

    // Decimation for WFM: 240kHz → 48kHz = factor 5
    // 63-tap AA filter gives a much sharper transition band than the default
    // 31-tap, preventing high-frequency aliasing into the audio band.
    if (wideband) {
      this.decimator  = new Decimator(Math.floor(this.inputSampleRate / this.outputSampleRate), 63);
      this.decimatorR = new Decimator(Math.floor(this.inputSampleRate / this.outputSampleRate), 63);
    }

    // Initialize stereo components for WFM
    if (wideband) {
      this.initStereo();
      // Initialize RDS decoder (taps composite at 240 kHz)
      this.rdsDecoder = new RdsDecoder(this.inputSampleRate);
    }
  }

  private initStereo(): void {
    // PLL to lock onto 19 kHz pilot (includes internal BPF for SNR-based detection)
    this.pilotPll = new PilotPll(this.inputSampleRate);

    // L+R low-pass: 15 kHz cutoff — 101 taps for sharp transition band
    this.lprFilter = new FirFilter(101, 15000 / this.inputSampleRate);

    // L-R low-pass: 15 kHz cutoff — 101 taps for sharp transition band
    this.lrFilter  = new FirFilter(101, 15000 / this.inputSampleRate);
  }

  process(iq: Int16Array): Float32Array {
    // Mono-only path (backward compatible)
    const result = this.processInternal(iq);
    return result.mono;
  }

  processStereo(iq: Int16Array): StereoAudio {
    const result = this.processInternal(iq);
    if (result.stereo && result.left && result.right) {
      return { left: result.left, right: result.right, stereo: true };
    }
    // Fall back to mono on both channels
    return { left: result.mono, right: result.mono, stereo: false };
  }

  private processInternal(iq: Int16Array): {
    mono: Float32Array;
    left?: Float32Array;
    right?: Float32Array;
    stereo: boolean;
  } {
    const [iSamples, qSamples] = iqInt16ToFloat(iq);
    const n = iSamples.length;

    // For WFM stereo, we need the raw FM discriminator output (composite MPX)
    // without low-pass filtering to preserve the 19-53 kHz stereo subcarrier
    if (this.wideband && this.stereoEnabled && this.pilotPll && this.lrFilter && this.lprFilter) {
      return this.processWfmStereo(iSamples, qSamples, n);
    }

    // Mono path (NFM or WFM with stereo disabled)
    return { mono: this.processMonoPath(iSamples, qSamples, n), stereo: false };
  }

  private processMonoPath(iSamples: Float32Array, qSamples: Float32Array, n: number): Float32Array {
    const output: number[] = [];

    for (let k = 0; k < n; k++) {
      const i = iSamples[k];
      const q = qSamples[k];

      // Polar discriminator
      const cross = q * this.prevI - i * this.prevQ;
      const dot = i * this.prevI + q * this.prevQ;
      let phase = Math.atan2(cross, dot);

      this.prevI = i;
      this.prevQ = q;

      // Scale by gain factor
      phase *= this.gain;

      // Low-pass filter
      phase = this.lpFilter.process(phase);

      // De-emphasis (applied before decimation for WFM)
      if (this.wideband) {
        phase = this.deemphL.process(phase);
      }

      // Decimate for WFM
      if (this.decimator) {
        const decimated = this.decimator.process(phase);
        if (decimated !== null) {
          output.push(this.dcBlocker.process(decimated));
        }
      } else {
        // NFM: no decimation needed (input is already at audio rate).
        // De-emphasis already applied above (line 630) — do NOT apply again.
        output.push(this.dcBlocker.process(phase));
      }
    }

    return new Float32Array(output);
  }

  private processWfmStereo(
    iSamples: Float32Array,
    qSamples: Float32Array,
    n: number,
  ): { mono: Float32Array; left?: Float32Array; right?: Float32Array; stereo: boolean } {
    const leftOut: number[] = [];
    const rightOut: number[] = [];
    const monoOut: number[] = [];

    const pll = this.pilotPll!;
    const lprLpf = this.lprFilter!; // L+R filter
    const lrLpf = this.lrFilter!;   // L-R filter

    for (let k = 0; k < n; k++) {
      const i = iSamples[k];
      const q = qSamples[k];

      // FM discriminator → composite MPX signal
      const cross = q * this.prevI - i * this.prevQ;
      const dot = i * this.prevI + q * this.prevQ;
      const composite = Math.atan2(cross, dot) * this.gain;

      this.prevI = i;
      this.prevQ = q;

      // Feed composite to RDS decoder (before any filtering)
      this.rdsDecoder?.pushSample(composite);

      // --- Stereo decoding ---

      // 1. PLL tracks 19 kHz pilot (includes internal BPF for detection),
      //    returns cos(2×pilotPhase) = 38 kHz reference
      const carrier38 = pll.process(composite);

      // 3. Extract L+R (low-pass at 15 kHz)
      const lpr = lprLpf.process(composite);

      // 4. Demodulate L-R: multiply composite by 38 kHz carrier
      //    DSB-SC demod: baseband = composite × cos(38kHz) → L-R at 0-15 kHz
      //    The factor of 2 compensates for the DSB-SC modulation (each sideband
      //    carries half power)
      const lrRaw = 2 * composite * carrier38;

      // 5. Low-pass L-R to 15 kHz
      const lr = lrLpf.process(lrRaw);

      // 6. Stereo matrix with SNR-proportional blend
      //    blend=0: pure mono (L+R on both), blend=1: full stereo
      const blend = pll.blendFactor;
      let left: number;
      let right: number;

      if (blend > 0.001) {
        left = lpr + blend * lr;
        right = lpr - blend * lr;
      } else {
        // Pure mono — no L-R contribution
        left = lpr;
        right = lpr;
      }

      // 7. De-emphasis on each channel (before decimation)
      left = this.deemphL.process(left);
      right = this.deemphR.process(right);

      // 8. Decimate: 240 kHz → 48 kHz
      if (this.decimator && this.decimatorR) {
        const decL = this.decimator.process(left);
        const decR = this.decimatorR.process(right);
        if (decL !== null && decR !== null) {
          leftOut.push(this.dcBlocker.process(decL));
          rightOut.push(this.dcBlockerR.process(decR));
          // Mono is the average
          monoOut.push((leftOut[leftOut.length - 1] + rightOut[rightOut.length - 1]) / 2);
        }
      }
    }

    this._stereoDetected = pll.detected;

    const mono = new Float32Array(monoOut);

    if (pll.blendFactor > 0.01) {
      return {
        mono,
        left: new Float32Array(leftOut),
        right: new Float32Array(rightOut),
        stereo: true,
      };
    }

    return { mono, stereo: false };
  }

  get stereoDetected(): boolean {
    return this._stereoDetected;
  }

  setStereoEnabled(enabled: boolean): void {
    this.stereoEnabled = enabled;
  }

  reset(): void {
    this.prevI = 0;
    this.prevQ = 0;
    this.lpFilter.reset();
    this.deemphL.reset();
    this.deemphR.reset();
    this.dcBlocker.reset();
    this.dcBlockerR.reset();
    this.decimator?.reset();
    this.decimatorR?.reset();
    this.pilotPll?.reset();
    this.lrFilter?.reset();
    this.lprFilter?.reset();
    this._stereoDetected = false;
    this.rdsDecoder?.reset();
  }

  /** Register a callback for RDS data updates (WFM only) */
  setRdsCallback(cb: (data: RdsData) => void): void {
    this.onRdsCallback = cb;
    if (this.rdsDecoder) {
      this.rdsDecoder.setCallback(cb);
    }
  }

  /** Get current RDS data snapshot */
  getRdsData(): RdsData | null {
    return this.rdsDecoder?.getData() ?? null;
  }

  setInputSampleRate(rate: number): void {
    this.inputSampleRate = rate;

    // Recalculate gain based on new input rate
    const deviation = this.wideband ? 75_000 : 5_000;
    this.gain = this.inputSampleRate / (2 * Math.PI * deviation);

    // Recalculate audio cutoff filter
    const audioCutoff = this.wideband ? 15_000 : 4_000;
    this.lpFilter.design(audioCutoff / this.inputSampleRate);

    // Recalculate decimation factor
    if (this.wideband) {
      const factor = Math.max(1, Math.floor(this.inputSampleRate / this.outputSampleRate));
      this.decimator = new Decimator(factor);
      this.decimatorR = new Decimator(factor);
      this.deemphL.setParams(75e-6, this.inputSampleRate);
      this.deemphR.setParams(75e-6, this.inputSampleRate);

      // Re-init stereo components for new sample rate
      this.initStereo();
    } else {
      // NFM: input rate should be ~48kHz, no decimation
      this.decimator = null;
      this.decimatorR = null;
      this.deemphL.setParams(75e-6, this.inputSampleRate);
      this.deemphR.setParams(75e-6, this.inputSampleRate);
    }
  }

  setBandwidth(hz: number): void {
    this.bandwidth = hz;
    if (!this.wideband) {
      // Adjust audio cutoff based on bandwidth
      const audioCutoff = Math.min(hz / 2, 4000);
      this.lpFilter.design(audioCutoff / this.inputSampleRate);
    }
  }
}

// ============================================================
// AM Demodulator
// ============================================================
// Envelope detection: audio = sqrt(I² + Q²)
// ============================================================

class AmDemodulator implements Demodulator {
  readonly name = 'AM';
  readonly mode: DemodMode = 'am';
  stereoCapable = false;

  private dcBlocker: DcBlocker;
  private agc: Agc;
  private lpFilter: FirFilter;
  private inputSampleRate: number;
  private outputSampleRate = 48000;

  // C-QUAM stereo detection: two-stage verification
  // Stage 1: 25 Hz Goertzel pilot detector (cheap, runs always)
  private gCoeff = 0;
  private gS1 = 0;
  private gS2 = 0;
  private gBlockSize = 0;
  private gSampleCount = 0;
  private pilotMag = 0;
  private pilotCandidate = false;

  // Stage 2: C-QUAM PLL lock verification (runs only when pilot candidate)
  private cquamDemod: CQuamDemodulator | null = null;
  private verifyCount = 0;        // how many chunks we've fed to C-QUAM for verification
  private readonly VERIFY_CHUNKS = 15; // ~0.5s of verification before declaring stereo
  private stereoConfirmed = false;

  constructor() {
    this.inputSampleRate = 48_000;
    this.dcBlocker = new DcBlocker();
    this.agc = new Agc(0.3);
    this.lpFilter = new FirFilter(31, 4000 / this.inputSampleRate);
    this.computeGoertzelCoeff();
  }

  private computeGoertzelCoeff(): void {
    this.gCoeff = 2 * Math.cos(2 * Math.PI * 25 / this.inputSampleRate);
    this.gBlockSize = Math.round(this.inputSampleRate * 0.08); // 80ms blocks
  }

  /** Stage 1: 25 Hz Goertzel on IQ phase — detects pilot candidate */
  private detectPilotCandidate(iq: Int16Array): void {
    const n = iq.length >> 1;
    const scale = 1 / 32768;

    for (let i = 0; i < n; i++) {
      const I = iq[i * 2] * scale;
      const Q = iq[i * 2 + 1] * scale;
      const env = Math.abs(I) + 0.4 * Math.abs(Q) + 1e-9;
      const phase = Q / env;

      const s0 = phase + this.gCoeff * this.gS1 - this.gS2;
      this.gS2 = this.gS1;
      this.gS1 = s0;
      this.gSampleCount++;

      if (this.gSampleCount >= this.gBlockSize) {
        const power = this.gS1 * this.gS1 + this.gS2 * this.gS2 - this.gS1 * this.gS2 * this.gCoeff;
        this.pilotMag = 0.85 * this.pilotMag + 0.15 * (Math.sqrt(Math.max(0, power)) / this.gSampleCount);
        this.gS1 = 0;
        this.gS2 = 0;
        this.gSampleCount = 0;

        // Pilot candidate: moderately strong 25 Hz in phase domain
        if (this.pilotMag > 0.005) {
          if (!this.pilotCandidate) {
            this.pilotCandidate = true;
            this.verifyCount = 0;
            // Lazy-init C-QUAM demodulator for verification
            if (!this.cquamDemod) {
              this.cquamDemod = new CQuamDemodulator();
              this.cquamDemod.setInputSampleRate(this.inputSampleRate);
            } else {
              this.cquamDemod.reset();
            }
          }
        } else if (this.pilotMag < 0.002) {
          this.pilotCandidate = false;
          if (this.stereoConfirmed) {
            this.stereoConfirmed = false;
            this.stereoCapable = false;
          }
        }
      }
    }
  }

  /** Stage 2: verify C-QUAM PLL lock — confirms real C-QUAM stereo */
  private verifyCquamLock(iq: Int16Array): void {
    if (!this.cquamDemod) return;

    // Feed IQ to C-QUAM demod (result discarded, we just need the PLL state)
    this.cquamDemod.processStereo(iq);
    this.verifyCount++;

    if (this.verifyCount >= this.VERIFY_CHUNKS) {
      // Check if PLL actually locked AND pilot detected by C-QUAM's own Goertzel
      if (this.cquamDemod.lockLevel > 0.7 && this.cquamDemod.pilotMag > 0.001) {
        if (!this.stereoConfirmed) {
          this.stereoConfirmed = true;
          this.stereoCapable = true;
        }
      } else {
        // PLL didn't lock — false alarm, not C-QUAM
        this.pilotCandidate = false;
        if (this.stereoConfirmed) {
          this.stereoConfirmed = false;
          this.stereoCapable = false;
        }
      }
      // Keep verifying periodically (every VERIFY_CHUNKS)
      this.verifyCount = this.VERIFY_CHUNKS - 5; // re-check every ~5 chunks
    }
  }

  process(iq: Int16Array): Float32Array {
    // Stage 1: always run pilot detection
    this.detectPilotCandidate(iq);

    // Stage 2: if pilot candidate found but not yet confirmed, run verification
    if (this.pilotCandidate && !this.stereoConfirmed) {
      this.verifyCquamLock(iq);
    }

    const [iSamples, qSamples] = iqInt16ToFloat(iq);
    const n = iSamples.length;
    const output = new Float32Array(n);

    for (let k = 0; k < n; k++) {
      let sample = Math.sqrt(iSamples[k] * iSamples[k] + qSamples[k] * qSamples[k]);
      sample = this.lpFilter.process(sample);
      sample = this.dcBlocker.process(sample);
      sample = this.agc.process(sample);
      output[k] = sample;
    }

    return output;
  }

  processStereo(iq: Int16Array): StereoAudio {
    // Run pilot detection (stage 1 still needed for ongoing monitoring)
    this.detectPilotCandidate(iq);

    // Delegate to C-QUAM demodulator when confirmed
    if (this.stereoConfirmed && this.cquamDemod) {
      const result = this.cquamDemod.processStereo(iq);

      // Continuously verify lock — if PLL loses lock, revert to mono
      if (this.cquamDemod.lockLevel < 0.4) {
        this.stereoConfirmed = false;
        this.stereoCapable = false;
        this.pilotCandidate = false;
      }

      return result;
    }
    // Fallback: mono as dual-mono
    const mono = this.process(iq);
    return { left: mono, right: new Float32Array(mono), stereo: false };
  }

  reset(): void {
    this.dcBlocker.reset();
    this.agc.reset();
    this.lpFilter.reset();
    this.gS1 = 0;
    this.gS2 = 0;
    this.gSampleCount = 0;
    this.pilotMag = 0;
    this.pilotCandidate = false;
    this.stereoConfirmed = false;
    this.stereoCapable = false;
    this.verifyCount = 0;
    this.cquamDemod?.reset();
  }

  setInputSampleRate(rate: number): void {
    this.inputSampleRate = rate;
    this.lpFilter.design(4000 / this.inputSampleRate);
    this.computeGoertzelCoeff();
    this.cquamDemod?.setInputSampleRate(rate);
  }

  setBandwidth(hz: number): void {
    const cutoff = Math.min(hz / 2, 5000);
    this.lpFilter.design(cutoff / this.inputSampleRate);
    this.cquamDemod?.setBandwidth(hz);
  }
}


/**
 * C-QUAM (Compatible QAM) AM Stereo Demodulator
 *
 * Motorola C-QUAM (1977) — the dominant AM stereo standard worldwide.
 * Patents expired — fully public domain.
 *
 * Signal model:
 *   s(t) = A(t)·cos(ωt + θ(t))
 *   A(t) = Ac·(1 + Ms·(L+R))          — envelope carries mono L+R
 *   θ(t) = arctan(Md·(L-R)/(1+Ms·S))  — phase carries stereo L-R
 *   + 25 Hz pilot in phase domain (flag only)
 *
 * Decoding: PLL → envelope + quadrature → cosGamma correction → L/R matrix
 * Reference: VK4MTV/CQUAM-AM-Stereo-Universal-Tuner-for-GNUradio
 */
class CQuamDemodulator implements Demodulator {
  readonly name = 'AM Stereo (C-QUAM)';
  readonly mode: DemodMode = 'am-stereo';
  readonly stereoCapable = true;

  private inputSampleRate = 48_000;

  // PLL state
  private omega2 = 0;       // frequency integrator
  private cosGamma = 1.0;   // C-QUAM envelope correction factor
  private vcoRe = 1.0;      // VCO complex phasor — real part
  private vcoIm = 0.0;      // VCO complex phasor — imaginary part

  // PLL gains (2nd-order, zeta=0.707, omegaN=100)
  private alpha = 0;
  private beta = 0;

  // 25 Hz Goertzel pilot detection
  private gCoeff = 0;
  private gS1 = 0;
  private gS2 = 0;
  private gBlockSize = 0;
  private gSampleCount = 0;
  private _pilotMag = 0;
  private _lockLevel = 0;
  get pilotMag(): number  { return this._pilotMag; }
  get lockLevel(): number { return this._lockLevel; }

  // Notch filter state (biquad, per-channel)
  private nb0 = 0; private nb1 = 0; private nb2 = 0;
  private na1 = 0; private na2 = 0;
  private w1L = 0; private w2L = 0;
  private w1R = 0; private w2R = 0;

  // Audio post-processing
  private dcBlockerL: DcBlocker;
  private dcBlockerR: DcBlocker;
  private agcL: Agc;
  private agcR: Agc;
  private lpFilterL: FirFilter;
  private lpFilterR: FirFilter;

  constructor() {
    this.dcBlockerL = new DcBlocker();
    this.dcBlockerR = new DcBlocker();
    this.agcL = new Agc(0.3, 0.01, 0.0001, 100);
    this.agcR = new Agc(0.3, 0.01, 0.0001, 100);
    this.lpFilterL = new FirFilter(31, 5000 / this.inputSampleRate);
    this.lpFilterR = new FirFilter(31, 5000 / this.inputSampleRate);
    this.computePllGains();
    this.computeGoertzelCoeff();
    this.designNotchFilter(9000, 50);
  }

  private computePllGains(): void {
    const T = 1 / this.inputSampleRate;
    const zeta = 0.707;
    const omegaN = 100;
    const denom = 1 + 2 * zeta * omegaN * T + (omegaN * T) ** 2;
    this.alpha = (2 * zeta * omegaN * T) / denom;
    this.beta = ((omegaN * T) ** 2) / denom;
  }

  private computeGoertzelCoeff(): void {
    this.gCoeff = 2 * Math.cos(2 * Math.PI * 25 / this.inputSampleRate);
    // Evaluate pilot every ~50ms (at least one full 25 Hz cycle)
    this.gBlockSize = Math.round(this.inputSampleRate * 0.05);
  }

  private designNotchFilter(freq: number, Q: number): void {
    const w0 = 2 * Math.PI * freq / this.inputSampleRate;
    const alphaN = Math.sin(w0) / (2 * Q);
    const cosW0 = Math.cos(w0);
    const a0 = 1 + alphaN;
    this.nb0 = 1 / a0;
    this.nb1 = -2 * cosW0 / a0;
    this.nb2 = 1 / a0;
    this.na1 = -2 * cosW0 / a0;
    this.na2 = (1 - alphaN) / a0;
  }

  process(iq: Int16Array): Float32Array {
    // Mono path: sum L+R (standard AM envelope detection with C-QUAM correction)
    const stereo = this.processStereo(iq);
    const n = stereo.left.length;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      mono[i] = 0.5 * (stereo.left[i] + stereo.right[i]);
    }
    return mono;
  }

  processStereo(iq: Int16Array): StereoAudio {
    const n = iq.length >> 1;
    const left = new Float32Array(n);
    const right = new Float32Array(n);

    let { omega2, cosGamma, vcoRe, vcoIm, gS1, gS2, gSampleCount } = this;
    let { w1L, w2L, w1R, w2R, lockLevel } = this;
    const { alpha, beta, gCoeff, nb0, nb1, nb2, na1, na2, gBlockSize } = this;
    const scale = 1 / 32768;

    for (let i = 0; i < n; i++) {
      const inI = iq[i * 2] * scale;
      const inQ = iq[i * 2 + 1] * scale;

      // 1. Complex demodulation: bb = input * conjugate(vco)
      const I = inI * vcoRe + inQ * vcoIm;
      const Q = -inI * vcoIm + inQ * vcoRe;

      // 2. Fast envelope approximation
      const absI = Math.abs(I);
      const absQ = Math.abs(Q);
      const env = (absI > absQ ? absI + 0.4 * absQ : absQ + 0.4 * absI) + 1e-9;

      // 3. PLL phase error + frequency integrator
      const det = Q / env;
      omega2 += beta * det;
      cosGamma += 0.005 * (I / env - cosGamma);

      // 4. VCO phase update (incremental rotation)
      const dPhz = alpha * det + omega2;
      const cd = Math.cos(dPhz);
      const sd = Math.sin(dPhz);
      const newVcoRe = vcoRe * cd + vcoIm * sd;
      const newVcoIm = -vcoRe * sd + vcoIm * cd;
      vcoRe = newVcoRe;
      vcoIm = newVcoIm;

      // Renormalize VCO every 512 samples to prevent magnitude drift
      if ((i & 511) === 0) {
        const mag = Math.sqrt(vcoRe * vcoRe + vcoIm * vcoIm);
        vcoRe /= mag;
        vcoIm /= mag;
      }

      // 5. C-QUAM stereo extraction
      // cosGamma can converge to ±1 depending on PLL lock polarity;
      // use absolute value for envelope correction and sign for L-R
      const absCosGamma = Math.abs(cosGamma) > 1e-9 ? Math.abs(cosGamma) : 1e-9;
      const cosSign = cosGamma >= 0 ? 1 : -1;
      const LpR = env * absCosGamma - 1.0;
      const LmR = (Q * cosSign) / absCosGamma;
      let rawL = 0.5 * (LpR + LmR);
      let rawR = 0.5 * (LpR - LmR);

      // 6. 25 Hz Goertzel pilot detection
      const s0 = LmR + gCoeff * gS1 - gS2;
      gS2 = gS1;
      gS1 = s0;
      gSampleCount++;

      // Evaluate pilot magnitude periodically
      if (gSampleCount >= gBlockSize) {
        const power = gS1 * gS1 + gS2 * gS2 - gS1 * gS2 * gCoeff;
        this._pilotMag = 0.9 * this._pilotMag + 0.1 * (Math.sqrt(Math.max(0, power)) / gSampleCount);
        gS1 = 0;
        gS2 = 0;
        gSampleCount = 0;
      }

      // 7. Lock level tracking (use abs — PLL can lock at 0° or 180°)
      lockLevel += 0.001 * (Math.abs(I / env) - lockLevel);

      // 8. Notch filter — left channel (Direct Form II biquad)
      const wn0l = rawL - na1 * w1L - na2 * w2L;
      rawL = nb0 * wn0l + nb1 * w1L + nb2 * w2L;
      w2L = w1L;
      w1L = wn0l;

      // 9. Notch filter — right channel
      const wn0r = rawR - na1 * w1R - na2 * w2R;
      rawR = nb0 * wn0r + nb1 * w1R + nb2 * w2R;
      w2R = w1R;
      w1R = wn0r;

      // 10. LP filter + DC block + AGC per channel
      left[i] = this.agcL.process(this.dcBlockerL.process(this.lpFilterL.process(rawL)));
      right[i] = this.agcR.process(this.dcBlockerR.process(this.lpFilterR.process(rawR)));
    }

    // Save state back
    this.omega2 = omega2;
    this.cosGamma = cosGamma;
    this.vcoRe = vcoRe;
    this.vcoIm = vcoIm;
    this.gS1 = gS1;
    this.gS2 = gS2;
    this.gSampleCount = gSampleCount;
    this.w1L = w1L;
    this.w2L = w2L;
    this.w1R = w1R;
    this.w2R = w2R;
    this._lockLevel = lockLevel;

    // Stereo detection: PLL locked + 25 Hz pilot present
    const isStereo = lockLevel > 0.8 && this._pilotMag > 0.001;

    return { left, right, stereo: isStereo };
  }

  reset(): void {
    this.omega2 = 0;
    this.cosGamma = 1.0;
    this.vcoRe = 1.0;
    this.vcoIm = 0.0;
    this.gS1 = 0;
    this.gS2 = 0;
    this.gSampleCount = 0;
    this._pilotMag = 0;
    this._lockLevel = 0;
    this.w1L = 0;
    this.w2L = 0;
    this.w1R = 0;
    this.w2R = 0;
    this.dcBlockerL.reset();
    this.dcBlockerR.reset();
    this.agcL.reset();
    this.agcR.reset();
    this.lpFilterL.reset();
    this.lpFilterR.reset();
  }

  setInputSampleRate(rate: number): void {
    this.inputSampleRate = rate;
    this.computePllGains();
    this.computeGoertzelCoeff();
    this.designNotchFilter(9000, 50);
    this.lpFilterL.design(5000 / rate);
    this.lpFilterR.design(5000 / rate);
  }

  setBandwidth(hz: number): void {
    const cutoff = Math.min(hz / 2, 10000);
    this.lpFilterL.design(cutoff / this.inputSampleRate);
    this.lpFilterR.design(cutoff / this.inputSampleRate);
    // Adapt notch to channel spacing
    if (hz >= 18000) {
      this.designNotchFilter(10000, 50);
    } else if (hz >= 9000) {
      this.designNotchFilter(9000, 50);
    } else {
      this.designNotchFilter(hz / 2, 30);
    }
  }
}

// ============================================================
// SSB Demodulator (USB / LSB)
// ============================================================
// Frequency-shifts the IQ signal then takes the real part.
// USB: no shift (upper sideband is already at baseband)
// LSB: conjugate the signal to flip spectrum
// ============================================================

class SsbDemodulator implements Demodulator {
  readonly name: string;
  readonly mode: DemodMode;
  readonly stereoCapable = false;

  private upper: boolean;
  private lpFilter: FirFilter;
  private agc: Agc;
  private dcBlocker: DcBlocker;
  private inputSampleRate: number;
  private outputSampleRate = 48000;

  // For frequency shift (BFO - Beat Frequency Oscillator)
  private bfoPhase = 0;
  private bfoFreq = 0; // Hz offset for fine tuning
  private bfoPhaseDelta = 0;

  constructor(upper: boolean) {
    this.upper = upper;
    this.mode = upper ? 'usb' : 'lsb';
    this.name = upper ? 'Upper Sideband' : 'Lower Sideband';

    this.inputSampleRate = 12_000;
    this.lpFilter = new FirFilter(63, 2400 / this.inputSampleRate);
    this.agc = new Agc(0.3, 0.005, 0.0001, 200);
    this.dcBlocker = new DcBlocker();
  }

  process(iq: Int16Array): Float32Array {
    const [iSamples, qSamples] = iqInt16ToFloat(iq);
    const n = iSamples.length;
    const output = new Float32Array(n);

    for (let k = 0; k < n; k++) {
      let i = iSamples[k];
      let q = qSamples[k];

      // For LSB, conjugate to flip spectrum
      if (!this.upper) {
        q = -q;
      }

      // Apply BFO frequency shift if set
      if (this.bfoPhaseDelta !== 0) {
        const cos = Math.cos(this.bfoPhase);
        const sin = Math.sin(this.bfoPhase);
        const newI = i * cos - q * sin;
        const newQ = i * sin + q * cos;
        i = newI;
        q = newQ;
        this.bfoPhase += this.bfoPhaseDelta;
        if (this.bfoPhase > 2 * Math.PI) this.bfoPhase -= 2 * Math.PI;
        if (this.bfoPhase < 0) this.bfoPhase += 2 * Math.PI;
      }

      // Take real part (I component contains the demodulated audio)
      let sample = this.lpFilter.process(i);

      // DC removal
      sample = this.dcBlocker.process(sample);

      // AGC
      sample = this.agc.process(sample);

      output[k] = sample;
    }

    return output;
  }

  reset(): void {
    this.lpFilter.reset();
    this.agc.reset();
    this.dcBlocker.reset();
    this.bfoPhase = 0;
  }

  setInputSampleRate(rate: number): void {
    this.inputSampleRate = rate;
    this.lpFilter.design(2400 / this.inputSampleRate);
    if (this.bfoFreq !== 0) {
      this.bfoPhaseDelta = (2 * Math.PI * this.bfoFreq) / this.inputSampleRate;
    }
  }

  setBandwidth(hz: number): void {
    const cutoff = Math.min(hz, 4000);
    this.lpFilter.design(cutoff / this.inputSampleRate);
  }

  /** Set BFO offset for fine tuning (Hz) */
  setBfoOffset(hz: number): void {
    this.bfoFreq = hz;
    this.bfoPhaseDelta = (2 * Math.PI * hz) / this.inputSampleRate;
  }
}

// ============================================================
// CW Demodulator
// ============================================================
// Mixes with a BFO tone (typically 600-800 Hz) to make the
// CW signal audible, then narrow bandpass filters.
// ============================================================

class CwDemodulator implements Demodulator {
  readonly name = 'CW';
  readonly mode: DemodMode = 'cw';
  readonly stereoCapable = false;

  private lpFilter: FirFilter;
  private agc: Agc;
  private dcBlocker: DcBlocker;
  private inputSampleRate: number;

  // BFO for CW tone generation
  private bfoPhase = 0;
  private bfoFreq: number;
  private bfoPhaseDelta: number;

  constructor() {
    this.inputSampleRate = 12_000;
    this.bfoFreq = 700; // 700 Hz CW offset tone
    this.bfoPhaseDelta = (2 * Math.PI * this.bfoFreq) / this.inputSampleRate;

    // Narrow filter for CW
    this.lpFilter = new FirFilter(127, 500 / this.inputSampleRate);
    this.agc = new Agc(0.3, 0.01, 0.0005, 300);
    this.dcBlocker = new DcBlocker();
  }

  process(iq: Int16Array): Float32Array {
    const [iSamples, qSamples] = iqInt16ToFloat(iq);
    const n = iSamples.length;
    const output = new Float32Array(n);

    for (let k = 0; k < n; k++) {
      const i = iSamples[k];
      const q = qSamples[k];

      // Mix with BFO
      const cos = Math.cos(this.bfoPhase);
      const sin = Math.sin(this.bfoPhase);
      const mixed = i * cos - q * sin;
      this.bfoPhase += this.bfoPhaseDelta;
      if (this.bfoPhase > 2 * Math.PI) this.bfoPhase -= 2 * Math.PI;

      // Narrow bandpass via low-pass filter
      let sample = this.lpFilter.process(mixed);

      // DC block
      sample = this.dcBlocker.process(sample);

      // AGC
      sample = this.agc.process(sample);

      output[k] = sample;
    }

    return output;
  }

  reset(): void {
    this.lpFilter.reset();
    this.agc.reset();
    this.dcBlocker.reset();
    this.bfoPhase = 0;
  }

  setInputSampleRate(rate: number): void {
    this.inputSampleRate = rate;
    this.bfoPhaseDelta = (2 * Math.PI * this.bfoFreq) / this.inputSampleRate;
    this.lpFilter.design(500 / this.inputSampleRate);
  }

  setBandwidth(hz: number): void {
    this.lpFilter.design(Math.max(50, hz) / this.inputSampleRate);
  }
}

// ============================================================
// Raw/Passthrough Demodulator (no processing)
// ============================================================

class RawDemodulator implements Demodulator {
  readonly name = 'Raw IQ';
  readonly mode: DemodMode = 'raw';
  readonly stereoCapable = false;

  process(iq: Int16Array): Float32Array {
    // Just output the I channel as audio (for monitoring)
    const n = iq.length >> 1;
    const output = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      output[k] = iq[k * 2] / 32768;
    }
    return output;
  }

  reset(): void {}
  setInputSampleRate(_rate: number): void {}
  setBandwidth(_hz: number): void {}
}

// ============================================================
// Demodulator Factory
// ============================================================

const demodulatorCache = new Map<DemodMode, Demodulator>();

/**
 * Create or retrieve a cached demodulator for the given mode.
 */
export function getDemodulator(mode: DemodMode): Demodulator {
  let demod = demodulatorCache.get(mode);
  if (demod) return demod;

  switch (mode) {
    case 'wfm':
      demod = new FmDemodulator(true);
      break;
    case 'nfm':
      demod = new FmDemodulator(false);
      break;
    case 'am':
      demod = new AmDemodulator();
      break;
    case 'am-stereo':
      demod = new CQuamDemodulator();
      break;
    case 'usb':
      demod = new SsbDemodulator(true);
      break;
    case 'lsb':
      demod = new SsbDemodulator(false);
      break;
    case 'cw':
      demod = new CwDemodulator();
      break;
    case 'raw':
      demod = new RawDemodulator();
      break;
    default:
      demod = new RawDemodulator();
  }

  demodulatorCache.set(mode, demod);
  return demod;
}

/**
 * Reset a specific demodulator's state (e.g., after frequency change)
 */
export function resetDemodulator(mode: DemodMode): void {
  demodulatorCache.get(mode)?.reset();
}

/**
 * Reset all cached demodulators
 */
export function resetAllDemodulators(): void {
  demodulatorCache.forEach((d) => d.reset());
}
