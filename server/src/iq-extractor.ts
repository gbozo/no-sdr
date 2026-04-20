// ============================================================
// node-sdr — IQ Sub-Band Extractor
// ============================================================
// Extracts a narrow IQ sub-band from the full dongle bandwidth.
// Performs: frequency shift → low-pass filter → decimate
//
// Input: raw uint8 IQ from rtl_sdr (full bandwidth)
// Output: Int16 IQ centered on the client's tuned frequency
//
// Filter: 4th-order Butterworth IIR (2 cascaded biquad sections)
// gives -24 dB/octave rolloff — sufficient for 10:1 decimation.
// ============================================================

import { logger } from './logger.js';

export interface IqExtractorOptions {
  /** Full dongle sample rate (e.g. 2.4 MHz) */
  inputSampleRate: number;
  /** Desired output sample rate (e.g. 240kHz for WFM, 48kHz for NFM) */
  outputSampleRate: number;
  /** Frequency offset from center to shift to (Hz) */
  tuneOffset: number;
}

/**
 * A single biquad filter section (2nd-order IIR).
 * Transfer function: H(z) = (b0 + b1·z^-1 + b2·z^-2) / (1 + a1·z^-1 + a2·z^-2)
 */
interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/**
 * State for one biquad channel (I or Q).
 * Uses Direct Form II transposed for numerical stability.
 */
interface BiquadState {
  z1: number; z2: number;
}

/**
 * Design a 4th-order Butterworth low-pass as 2 cascaded biquad sections.
 * Uses bilinear transform with frequency pre-warping.
 */
function designButterworth4(cutoffHz: number, sampleRate: number): BiquadCoeffs[] {
  // Pre-warp cutoff frequency
  const wc = Math.tan(Math.PI * cutoffHz / sampleRate);
  const wc2 = wc * wc;

  // 4th-order Butterworth has 2 conjugate pole pairs.
  // Analog pole angles: (2k+1)·π/(2n) for k=0..n-1, n=4
  // Section 1: poles at angles π·5/8 and π·3/8 → Q = 1/(2·cos(π/8)) ≈ 0.5412
  // Section 2: poles at angles π·7/8 and π·1/8 → Q = 1/(2·cos(3π/8)) ≈ 1.3066
  const sections: BiquadCoeffs[] = [];

  const Qs = [
    1 / (2 * Math.cos(Math.PI / 8)),   // ≈ 0.5412
    1 / (2 * Math.cos(3 * Math.PI / 8)), // ≈ 1.3066
  ];

  for (const Q of Qs) {
    // Bilinear transform of 2nd-order analog LP: H(s) = wc² / (s² + s·wc/Q + wc²)
    const K = wc;
    const K2 = K * K;
    const norm = 1 + K / Q + K2;

    const b0 = K2 / norm;
    const b1 = 2 * K2 / norm;
    const b2 = K2 / norm;
    const a1 = 2 * (K2 - 1) / norm;
    const a2 = (1 - K / Q + K2) / norm;

    sections.push({ b0, b1, b2, a1, a2 });
  }

  return sections;
}

/**
 * Apply one biquad section (Direct Form II Transposed).
 */
function biquadProcess(
  x: number,
  c: BiquadCoeffs,
  s: BiquadState,
): number {
  const y = c.b0 * x + s.z1;
  s.z1 = c.b1 * x - c.a1 * y + s.z2;
  s.z2 = c.b2 * x - c.a2 * y;
  return y;
}

export class IqExtractor {
  private inputSampleRate: number;
  private outputSampleRate: number;
  private decimationFactor: number;
  private tuneOffset: number;

  // NCO (Numerically Controlled Oscillator) for frequency shifting
  private ncoPhase = 0;
  private ncoFreq: number; // radians per sample

  // NCO lookup table for cos/sin (avoids per-sample Math.cos/sin)
  private ncoTableSize = 4096;
  private cosTable: Float64Array;
  private sinTable: Float64Array;

  // 4th-order Butterworth LPF (2 cascaded biquads, separate for I and Q)
  private biquadCoeffs: BiquadCoeffs[] = [];
  private biquadStatesI: BiquadState[] = [];
  private biquadStatesQ: BiquadState[] = [];

  // Decimation counter
  private decimCounter = 0;

  // Residual byte from odd-length chunk
  private residualByte: number | null = null;

  constructor(options: IqExtractorOptions) {
    this.inputSampleRate = options.inputSampleRate;
    this.outputSampleRate = options.outputSampleRate;
    this.tuneOffset = options.tuneOffset;

    // Compute decimation factor
    this.decimationFactor = Math.max(1, Math.round(this.inputSampleRate / this.outputSampleRate));

    // NCO frequency: negative to shift down to baseband
    this.ncoFreq = (-2 * Math.PI * this.tuneOffset) / this.inputSampleRate;

    // Build cos/sin lookup table
    this.cosTable = new Float64Array(this.ncoTableSize);
    this.sinTable = new Float64Array(this.ncoTableSize);
    for (let i = 0; i < this.ncoTableSize; i++) {
      const angle = (2 * Math.PI * i) / this.ncoTableSize;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // Design anti-aliasing filter: cutoff at 80% of Nyquist of output rate
    // (slightly below Nyquist to leave transition band room)
    this.initFilter();

    logger.debug({
      inputRate: this.inputSampleRate,
      outputRate: this.outputSampleRate,
      decimation: this.decimationFactor,
      tuneOffset: this.tuneOffset,
    }, 'IQ extractor initialized');
  }

  private initFilter(): void {
    const cutoff = this.outputSampleRate * 0.4; // 80% of Nyquist = 40% of output rate
    this.biquadCoeffs = designButterworth4(cutoff, this.inputSampleRate);
    this.biquadStatesI = this.biquadCoeffs.map(() => ({ z1: 0, z2: 0 }));
    this.biquadStatesQ = this.biquadCoeffs.map(() => ({ z1: 0, z2: 0 }));
  }

  /**
   * Fast NCO lookup: get cos and sin for current phase.
   */
  private ncoLookup(phase: number): [number, number] {
    // Normalize phase to [0, 2π)
    let p = phase % (2 * Math.PI);
    if (p < 0) p += 2 * Math.PI;
    const idx = Math.round((p / (2 * Math.PI)) * this.ncoTableSize) % this.ncoTableSize;
    return [this.cosTable[idx], this.sinTable[idx]];
  }

  setTuneOffset(offsetHz: number): void {
    this.tuneOffset = offsetHz;
    this.ncoFreq = (-2 * Math.PI * this.tuneOffset) / this.inputSampleRate;
  }

  setOutputSampleRate(rate: number): void {
    this.outputSampleRate = rate;
    this.decimationFactor = Math.max(1, Math.round(this.inputSampleRate / this.outputSampleRate));
    this.initFilter();
  }

  /**
   * Process a chunk of raw uint8 IQ data.
   * Returns decimated, frequency-shifted Int16 IQ centered on the tuned frequency.
   */
  process(data: Buffer): Int16Array {
    let startOffset = 0;
    let extraI: number | undefined;

    // Handle residual byte from previous chunk
    if (this.residualByte !== null) {
      extraI = this.residualByte;
      this.residualByte = null;
      startOffset = 0;
    }

    // Total available IQ samples
    const availableBytes = (extraI !== undefined ? 1 : 0) + data.length;
    const totalSamples = Math.floor(availableBytes / 2);

    if (totalSamples === 0) {
      // Save residual if we have one odd byte
      if (data.length > 0 && extraI === undefined) {
        this.residualByte = data[0];
      }
      return new Int16Array(0);
    }

    // Pre-allocate output
    const maxOutput = Math.ceil(totalSamples / this.decimationFactor);
    const output = new Int16Array(maxOutput * 2);
    let outIdx = 0;

    let phase = this.ncoPhase;
    const freq = this.ncoFreq;
    let decimCount = this.decimCounter;

    const coeffs = this.biquadCoeffs;
    const statesI = this.biquadStatesI;
    const statesQ = this.biquadStatesQ;

    let dataIdx = startOffset;
    let sampleCount = 0;

    // Process first sample from residual if needed
    if (extraI !== undefined && data.length > 0) {
      const rawI = (extraI - 127.5) / 127.5;
      const rawQ = (data[dataIdx++] - 127.5) / 127.5;

      const [cosP, sinP] = this.ncoLookup(phase);
      let filtI = rawI * cosP - rawQ * sinP;
      let filtQ = rawI * sinP + rawQ * cosP;
      phase += freq;

      // Apply cascaded biquad filter
      for (let s = 0; s < coeffs.length; s++) {
        filtI = biquadProcess(filtI, coeffs[s], statesI[s]);
        filtQ = biquadProcess(filtQ, coeffs[s], statesQ[s]);
      }

      decimCount++;
      if (decimCount >= this.decimationFactor) {
        decimCount = 0;
        output[outIdx++] = Math.max(-32768, Math.min(32767, Math.round(filtI * 32767)));
        output[outIdx++] = Math.max(-32768, Math.min(32767, Math.round(filtQ * 32767)));
      }
      sampleCount++;
    }

    // Main processing loop
    const endByte = data.length - 1; // need pairs
    while (dataIdx < endByte) {
      const rawI = (data[dataIdx] - 127.5) / 127.5;
      const rawQ = (data[dataIdx + 1] - 127.5) / 127.5;
      dataIdx += 2;

      // Frequency shift via NCO
      const [cosP, sinP] = this.ncoLookup(phase);
      let filtI = rawI * cosP - rawQ * sinP;
      let filtQ = rawI * sinP + rawQ * cosP;
      phase += freq;

      // Cascaded biquad LP filter (4th-order Butterworth)
      for (let s = 0; s < coeffs.length; s++) {
        filtI = biquadProcess(filtI, coeffs[s], statesI[s]);
        filtQ = biquadProcess(filtQ, coeffs[s], statesQ[s]);
      }

      // Decimate
      decimCount++;
      if (decimCount >= this.decimationFactor) {
        decimCount = 0;
        output[outIdx++] = Math.max(-32768, Math.min(32767, Math.round(filtI * 32767)));
        output[outIdx++] = Math.max(-32768, Math.min(32767, Math.round(filtQ * 32767)));
      }
      sampleCount++;
    }

    // Handle trailing odd byte
    if (dataIdx < data.length) {
      this.residualByte = data[dataIdx];
    }

    // Save state
    this.ncoPhase = phase % (2 * Math.PI);
    this.decimCounter = decimCount;

    return output.subarray(0, outIdx);
  }

  reset(): void {
    this.ncoPhase = 0;
    this.decimCounter = 0;
    this.residualByte = null;
    for (const s of this.biquadStatesI) { s.z1 = 0; s.z2 = 0; }
    for (const s of this.biquadStatesQ) { s.z1 = 0; s.z2 = 0; }
  }
}

/**
 * Get the appropriate output sample rate for a demodulation mode
 */
export function getOutputSampleRate(mode: string): number {
  switch (mode) {
    case 'wfm': return 240_000;
    case 'nfm': return 48_000;
    case 'am': return 48_000;
    case 'am-stereo': return 48_000;
    case 'usb':
    case 'lsb': return 24_000;
    case 'cw': return 12_000;
    default: return 48_000;
  }
}
