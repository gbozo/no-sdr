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

// ---- Base Demodulator Interface ----

export interface Demodulator {
  /** Human-readable name */
  readonly name: string;
  /** Mode identifier */
  readonly mode: DemodMode;
  /** Process interleaved IQ Int16 samples, return audio Float32 */
  process(iq: Int16Array): Float32Array;
  /** Reset internal state (e.g., on frequency change) */
  reset(): void;
  /** Set the audio output sample rate (for decimation) */
  setOutputSampleRate(rate: number): void;
  /** Set the filter bandwidth in Hz */
  setBandwidth(hz: number): void;
}

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
   * @param sampleRate - audio sample rate
   */
  constructor(tau: number, sampleRate: number) {
    // alpha = 1 / (1 + 2π * tau * fs)
    this.alpha = 1 / (1 + 2 * Math.PI * tau * sampleRate);
  }

  process(x: number): number {
    this.prev = this.prev + this.alpha * (x - this.prev);
    return this.prev;
  }

  setParams(tau: number, sampleRate: number): void {
    this.alpha = 1 / (1 + 2 * Math.PI * tau * sampleRate);
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
// ============================================================

class FmDemodulator implements Demodulator {
  readonly name: string;
  readonly mode: DemodMode;

  private prevI = 0;
  private prevQ = 0;
  private lpFilter: FirFilter;
  private deemph: DeemphasisFilter;
  private dcBlocker: DcBlocker;
  private decimator: Decimator | null = null;
  private gain: number;

  private inputSampleRate: number;
  private outputSampleRate = 48000;
  private bandwidth: number;
  private wideband: boolean;

  constructor(wideband: boolean) {
    this.wideband = wideband;
    this.mode = wideband ? 'wfm' : 'nfm';
    this.name = wideband ? 'Wideband FM' : 'Narrowband FM';

    this.bandwidth = wideband ? 200_000 : 12_500;
    this.inputSampleRate = wideband ? 240_000 : 48_000;

    // FM deviation → gain factor
    // For WFM: ±75kHz deviation, for NFM: ±5kHz deviation
    const deviation = wideband ? 75_000 : 5_000;
    this.gain = this.inputSampleRate / (2 * Math.PI * deviation);

    // Low-pass filter for demodulated audio
    const audioCutoff = wideband ? 15_000 : 4_000;
    this.lpFilter = new FirFilter(51, audioCutoff / this.inputSampleRate);

    // De-emphasis: 75µs (US/Japan) or 50µs (EU) — using 75µs as default
    const deemphRate = wideband ? this.inputSampleRate : this.outputSampleRate;
    this.deemph = new DeemphasisFilter(75e-6, deemphRate);

    this.dcBlocker = new DcBlocker();

    // Decimation for WFM: 240kHz → 48kHz = factor 5
    if (wideband) {
      this.decimator = new Decimator(Math.floor(this.inputSampleRate / this.outputSampleRate));
    }
  }

  process(iq: Int16Array): Float32Array {
    const [iSamples, qSamples] = iqInt16ToFloat(iq);
    const n = iSamples.length;
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
        phase = this.deemph.process(phase);
      }

      // Decimate for WFM
      if (this.decimator) {
        const decimated = this.decimator.process(phase);
        if (decimated !== null) {
          output.push(this.dcBlocker.process(decimated));
        }
      } else {
        // NFM: no decimation needed (input is already at audio rate)
        phase = this.deemph.process(phase);
        output.push(this.dcBlocker.process(phase));
      }
    }

    return new Float32Array(output);
  }

  reset(): void {
    this.prevI = 0;
    this.prevQ = 0;
    this.lpFilter.reset();
    this.deemph.reset();
    this.dcBlocker.reset();
    this.decimator?.reset();
  }

  setOutputSampleRate(rate: number): void {
    this.outputSampleRate = rate;
    if (this.wideband) {
      this.decimator = new Decimator(Math.floor(this.inputSampleRate / rate));
      this.deemph.setParams(75e-6, this.inputSampleRate);
    } else {
      this.deemph.setParams(75e-6, rate);
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

  private dcBlocker: DcBlocker;
  private agc: Agc;
  private lpFilter: FirFilter;
  private inputSampleRate: number;
  private outputSampleRate = 48000;

  constructor() {
    this.inputSampleRate = 48_000;
    this.dcBlocker = new DcBlocker();
    this.agc = new Agc(0.3);
    this.lpFilter = new FirFilter(31, 4000 / this.inputSampleRate);
  }

  process(iq: Int16Array): Float32Array {
    const [iSamples, qSamples] = iqInt16ToFloat(iq);
    const n = iSamples.length;
    const output = new Float32Array(n);

    for (let k = 0; k < n; k++) {
      // Envelope detection
      let sample = Math.sqrt(iSamples[k] * iSamples[k] + qSamples[k] * qSamples[k]);

      // Low-pass filter
      sample = this.lpFilter.process(sample);

      // Remove DC offset (envelope has a large DC component)
      sample = this.dcBlocker.process(sample);

      // AGC
      sample = this.agc.process(sample);

      output[k] = sample;
    }

    return output;
  }

  reset(): void {
    this.dcBlocker.reset();
    this.agc.reset();
    this.lpFilter.reset();
  }

  setOutputSampleRate(rate: number): void {
    this.outputSampleRate = rate;
  }

  setBandwidth(hz: number): void {
    const cutoff = Math.min(hz / 2, 5000);
    this.lpFilter.design(cutoff / this.inputSampleRate);
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

  setOutputSampleRate(rate: number): void {
    this.outputSampleRate = rate;
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

  setOutputSampleRate(_rate: number): void {
    // CW runs at input sample rate (typically 8-12kHz)
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
  setOutputSampleRate(_rate: number): void {}
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
