// ============================================================
// node-sdr — Server-Side FFT Processor
// ============================================================
// Converts raw IQ data from rtl_sdr into FFT magnitude (dB) arrays.
// Uses fft.js (indutny) — radix-4, fastest pure JS FFT for typical
// sizes (≤8192). For large FFT sizes (≥32768) the number[] overhead
// becomes significant, but radix-4 algorithmic advantage wins at
// the common 2048–4096 range used in production.
//
// IQ data from rtl_sdr: unsigned 8-bit interleaved [I0,Q0,I1,Q1,...]
// Output: Float32Array of dB magnitude values per FFT bin.
// ============================================================

// @ts-ignore — fft.js has no type declarations
import FFT from 'fft.js';
import { logger } from './logger.js';

export interface FftProcessorOptions {
  /** FFT size (power of 2) */
  fftSize: number;
  /** Sample rate for this dongle */
  sampleRate: number;
  /** Window function to apply */
  window?: 'blackman-harris' | 'hann' | 'hamming' | 'none';
  /** Averaging factor (0 = no averaging, 0.9 = heavy smoothing) */
  averaging: number;
  /** Target FFT output frame rate (fps). 0 = unlimited. Default 30. */
  targetFps?: number;
}

export class FftProcessor {
  private fft: any;
  private fftSize: number;
  private windowFunc: Float32Array;
  private averagedMagnitudes: Float32Array | null = null;
  private readonly averaging: number;

  // Reusable buffers for fft.js (requires number[] — radix-4 is faster at N≤8192)
  private complexInput: number[];
  private complexOutput: number[];

  // Pre-allocated magnitude scratch buffer — reused every processOneFrame call
  private magnitudesBuffer: Float32Array;

  // Ring buffer accumulator — pre-allocated, no Buffer.concat on every chunk
  private iqRingBuf: Buffer;
  private iqRingFill = 0;
  private readonly samplesNeeded: number;

  // FFT normalization: 10 * log10(N²) + window coherent gain correction
  private normalizationDb: number;

  // Rate limiting
  private targetFps: number;
  private minFrameInterval: number;
  private lastEmitTime = 0;
  // Pre-allocated pending frame buffer — avoids new Float32Array(fftSize) at 30fps.
  // framesAccumulated === 0 means the buffer is empty/unused for the current interval.
  private pendingFrame: Float32Array;
  private framesAccumulated = 0;

  constructor(private options: FftProcessorOptions) {
    this.fftSize = options.fftSize;
    this.averaging = options.averaging;
    this.fft = new FFT(this.fftSize);
    this.complexInput = this.fft.createComplexArray();
    this.complexOutput = this.fft.createComplexArray();
    this.windowFunc = this.createWindow(options.window ?? 'blackman-harris');
    this.samplesNeeded = this.fftSize * 2;
    this.normalizationDb = this.computeNormalization();
    this.targetFps = options.targetFps ?? 30;
    this.minFrameInterval = this.targetFps > 0 ? 1000 / this.targetFps : 0;

    // Pre-allocate magnitude scratch buffer, ring buffer (4 frames of headroom),
    // and pending frame buffer (one per emit interval — no alloc at 30fps).
    this.magnitudesBuffer = new Float32Array(this.fftSize);
    this.pendingFrame = new Float32Array(this.fftSize);
    this.iqRingBuf = Buffer.allocUnsafe(this.samplesNeeded * 4);

    logger.debug(
      { fftSize: this.fftSize, window: options.window ?? 'blackman-harris', normalizationDb: this.normalizationDb.toFixed(1), targetFps: this.targetFps },
      'FFT processor initialized',
    );
  }

  processIqData(rawData: Buffer): Float32Array[] {
    // Append into ring buffer — no alloc, no copy of existing data
    if (this.iqRingFill + rawData.length > this.iqRingBuf.length) {
      // Ring buffer too small (shouldn't happen with 4× headroom) — grow it
      const newBuf = Buffer.allocUnsafe((this.iqRingFill + rawData.length) * 2);
      this.iqRingBuf.copy(newBuf, 0, 0, this.iqRingFill);
      this.iqRingBuf = newBuf;
    }
    rawData.copy(this.iqRingBuf, this.iqRingFill);
    this.iqRingFill += rawData.length;

    const emitted: Float32Array[] = [];
    const now = Date.now(); // hoist out of loop — constant for this call

    let consumed = 0;
    while (this.iqRingFill - consumed >= this.samplesNeeded) {
      const frame = this.processOneFrame(this.iqRingBuf.subarray(consumed, consumed + this.samplesNeeded));
      consumed += this.samplesNeeded;

      if (this.minFrameInterval <= 0) {
        emitted.push(frame);
        continue;
      }

      if (this.framesAccumulated === 0) {
        // First frame of interval: copy into pre-allocated pendingFrame — no alloc
        this.pendingFrame.set(frame);
        this.framesAccumulated = 1;
      } else {
        // Incremental mean: avg += (new - avg) / count
        this.framesAccumulated++;
        const n = this.framesAccumulated;
        const pf = this.pendingFrame;
        for (let i = 0; i < frame.length; i++) {
          pf[i] += (frame[i] - pf[i]) / n;
        }
      }

      if (now - this.lastEmitTime >= this.minFrameInterval) {
        emitted.push(this.pendingFrame);
        this.framesAccumulated = 0;
        this.lastEmitTime = now;
      }
    }

    // Compact ring buffer: move remainder to front
    if (consumed > 0) {
      if (consumed < this.iqRingFill) {
        this.iqRingBuf.copyWithin(0, consumed, this.iqRingFill);
      }
      this.iqRingFill -= consumed;
    }

    return emitted;
  }

  private processOneFrame(rawIq: Buffer): Float32Array {
    // Convert uint8 IQ → float [-1, +1] and apply window into fft.js input array
    for (let i = 0; i < this.fftSize; i++) {
      const w = this.windowFunc[i];
      this.complexInput[i * 2]     = ((rawIq[i * 2]     - 127.5) / 127.5) * w;
      this.complexInput[i * 2 + 1] = ((rawIq[i * 2 + 1] - 127.5) / 127.5) * w;
    }

    this.fft.transform(this.complexOutput, this.complexInput);

    // Compute magnitude in dB into reusable scratch buffer — no allocation
    const magnitudes = this.magnitudesBuffer;
    const fftSize = this.fftSize;
    const half = fftSize >> 1;

    for (let i = 0; i < fftSize; i++) {
      // FFT-shift: remap so DC is in the center
      const srcIdx = (i + half) & (fftSize - 1);
      const re = this.complexOutput[srcIdx * 2];
      const im = this.complexOutput[srcIdx * 2 + 1];
      magnitudes[i] = 10 * Math.log10(Math.max(re * re + im * im, 1e-20)) - this.normalizationDb;
    }

    // Apply exponential averaging
    if (this.averaging > 0) {
      if (!this.averagedMagnitudes) {
        this.averagedMagnitudes = new Float32Array(magnitudes);
      } else {
        const a = this.averaging;
        const b = 1 - a;
        for (let i = 0; i < fftSize; i++) {
          this.averagedMagnitudes[i] = a * this.averagedMagnitudes[i] + b * magnitudes[i];
        }
      }
      return this.averagedMagnitudes;
    }

    return magnitudes;
  }

  /**
   * Create a window function array
   */
  private createWindow(type: string): Float32Array {
    const N = this.fftSize;
    const w = new Float32Array(N);

    switch (type) {
      case 'blackman-harris': {
        const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
        for (let i = 0; i < N; i++) {
          const x = (2 * Math.PI * i) / (N - 1);
          w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
        }
        break;
      }
      case 'hann': {
        for (let i = 0; i < N; i++) {
          w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
        }
        break;
      }
      case 'hamming': {
        for (let i = 0; i < N; i++) {
          w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1));
        }
        break;
      }
      default: {
        w.fill(1);
        break;
      }
    }

    return w;
  }

  /**
   * Compute FFT normalization in dB.
   * Accounts for FFT size (N²) and window function coherent gain.
   * The coherent gain of a window is sum(w[i]) / N.
   */
  private computeNormalization(): number {
    // FFT size normalization: 10 * log10(N²) = 20 * log10(N)
    const fftNorm = 20 * Math.log10(this.fftSize);

    // Window coherent gain: sum(w) / N
    let windowSum = 0;
    for (let i = 0; i < this.fftSize; i++) {
      windowSum += this.windowFunc[i];
    }
    const coherentGain = windowSum / this.fftSize;
    // Window correction in dB (for power): 20 * log10(coherentGain)
    const windowCorrectionDb = 20 * Math.log10(coherentGain);

    // Total normalization: subtract this from raw 10*log10(|X|²)
    return fftNorm + windowCorrectionDb;
  }

  /**
   * Reset internal buffers (call when switching profiles)
   */
  reset(): void {
    this.iqRingFill = 0;
    this.averagedMagnitudes = null;
    this.framesAccumulated = 0;
    this.lastEmitTime = 0;
  }

  resize(newFftSize: number): void {
    this.fftSize = newFftSize;
    this.fft = new FFT(newFftSize);
    this.complexInput = this.fft.createComplexArray();
    this.complexOutput = this.fft.createComplexArray();
    this.windowFunc = this.createWindow(this.options.window ?? 'blackman-harris');
    this.averagedMagnitudes = null;
    this.normalizationDb = this.computeNormalization();
    (this as any).samplesNeeded = newFftSize * 2;
    this.magnitudesBuffer = new Float32Array(newFftSize);
    this.pendingFrame = new Float32Array(newFftSize);
    this.iqRingBuf = Buffer.allocUnsafe(newFftSize * 2 * 4);
    this.iqRingFill = 0;
    this.framesAccumulated = 0;
  }
}

/**
 * Extract a sub-band of IQ data centered around a frequency offset.
 * Used to send per-user IQ data for client-side demodulation.
 *
 * @param fftOutput - Complex FFT output (interleaved re/im)
 * @param fftSize - FFT size
 * @param sampleRate - Full sample rate
 * @param centerOffsetHz - Desired center frequency offset from DC
 * @param bandwidthHz - Desired bandwidth
 * @returns Int16Array of interleaved I/Q sub-band samples
 */
export function extractIqSubBand(
  fftOutput: number[],
  fftSize: number,
  sampleRate: number,
  centerOffsetHz: number,
  bandwidthHz: number,
): Int16Array {
  const binWidth = sampleRate / fftSize;
  const centerBin = Math.round(centerOffsetHz / binWidth) + fftSize / 2;
  const halfBins = Math.round(bandwidthHz / binWidth / 2);

  const startBin = Math.max(0, centerBin - halfBins);
  const endBin = Math.min(fftSize - 1, centerBin + halfBins);
  const numBins = endBin - startBin + 1;

  // IFFT the sub-band to get time-domain IQ samples
  // For now, just extract the frequency-domain bins
  // The client will do the IFFT
  const subBand = new Int16Array(numBins * 2);

  for (let i = 0; i < numBins; i++) {
    const srcBin = startBin + i;
    const re = fftOutput[srcBin * 2];
    const im = fftOutput[srcBin * 2 + 1];
    // Scale to Int16 range
    subBand[i * 2] = Math.max(-32768, Math.min(32767, Math.round(re * 32767)));
    subBand[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(im * 32767)));
  }

  return subBand;
}
