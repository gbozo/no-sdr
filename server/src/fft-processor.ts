// ============================================================
// node-sdr — Server-Side FFT Processor
// ============================================================
// Converts raw IQ data from rtl_sdr into FFT magnitude (dB) arrays.
// Uses fft.js (indutny) — radix-4, fastest pure JS FFT.
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
}

export class FftProcessor {
  private fft: any;
  private fftSize: number;
  private windowFunc: Float32Array;
  private averagedMagnitudes: Float32Array | null = null;
  private readonly averaging: number;

  // Reusable buffers to avoid GC pressure
  private complexInput: number[];
  private complexOutput: number[];
  private iqBuffer: Float32Array;

  // Accumulator for partial IQ chunks from rtl_sdr
  private iqAccumulator: Buffer = Buffer.alloc(0);
  private readonly samplesNeeded: number; // bytes needed for one FFT frame

  // FFT normalization: 10 * log10(N²) + window coherent gain correction
  private normalizationDb: number;

  constructor(private options: FftProcessorOptions) {
    this.fftSize = options.fftSize;
    this.averaging = options.averaging;
    this.fft = new FFT(this.fftSize);
    this.complexInput = this.fft.createComplexArray();
    this.complexOutput = this.fft.createComplexArray();
    this.iqBuffer = new Float32Array(this.fftSize * 2);
    this.windowFunc = this.createWindow(options.window ?? 'blackman-harris');
    this.samplesNeeded = this.fftSize * 2; // 2 bytes per sample (I+Q interleaved uint8)
    this.normalizationDb = this.computeNormalization();

    logger.debug(
      { fftSize: this.fftSize, window: options.window ?? 'blackman-harris', normalizationDb: this.normalizationDb.toFixed(1) },
      'FFT processor initialized',
    );
  }

  /**
   * Feed raw IQ data from rtl_sdr. Returns FFT frames as they become available.
   * rtl_sdr outputs unsigned 8-bit interleaved I/Q: [I0, Q0, I1, Q1, ...]
   */
  processIqData(rawData: Buffer): Float32Array[] {
    // Accumulate incoming data
    this.iqAccumulator = Buffer.concat([this.iqAccumulator, rawData]);

    const frames: Float32Array[] = [];

    // Process complete FFT frames
    while (this.iqAccumulator.length >= this.samplesNeeded) {
      const frame = this.processOneFrame(this.iqAccumulator.subarray(0, this.samplesNeeded));
      frames.push(frame);

      // Advance buffer (50% overlap for smoother waterfall)
      const advance = this.samplesNeeded; // no overlap for now; can do /2 for 50%
      this.iqAccumulator = this.iqAccumulator.subarray(advance);
    }

    return frames;
  }

  private processOneFrame(rawIq: Buffer): Float32Array {
    // Convert uint8 IQ to float [-1, +1] and apply window
    for (let i = 0; i < this.fftSize; i++) {
      const iVal = (rawIq[i * 2] - 127.5) / 127.5;
      const qVal = (rawIq[i * 2 + 1] - 127.5) / 127.5;
      // Apply window function
      const w = this.windowFunc[i];
      this.complexInput[i * 2] = iVal * w;       // real
      this.complexInput[i * 2 + 1] = qVal * w;   // imag
    }

    // Perform FFT
    this.fft.transform(this.complexOutput, this.complexInput);

    // Compute magnitude in dB and reorder (DC center)
    const magnitudes = new Float32Array(this.fftSize);
    const half = this.fftSize / 2;

    for (let i = 0; i < this.fftSize; i++) {
      // FFT output bin index (reorder so DC is in center)
      const srcIdx = (i + half) % this.fftSize;
      const re = this.complexOutput[srcIdx * 2];
      const im = this.complexOutput[srcIdx * 2 + 1];
      const mag = re * re + im * im;
      // Convert to dB with proper FFT normalization:
      // dB = 10*log10(|X|²) - 10*log10(N²) - windowCorrectionDb
      magnitudes[i] = 10 * Math.log10(Math.max(mag, 1e-20)) - this.normalizationDb;
    }

    // Apply exponential averaging for smoother display
    if (this.averaging > 0) {
      if (!this.averagedMagnitudes) {
        this.averagedMagnitudes = new Float32Array(magnitudes);
      } else {
        const a = this.averaging;
        const b = 1 - a;
        for (let i = 0; i < this.fftSize; i++) {
          this.averagedMagnitudes[i] = a * this.averagedMagnitudes[i] + b * magnitudes[i];
        }
        return new Float32Array(this.averagedMagnitudes);
      }
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
    this.iqAccumulator = Buffer.alloc(0);
    this.averagedMagnitudes = null;
  }

  /**
   * Update FFT size (requires reinit)
   */
  resize(newFftSize: number): void {
    this.fftSize = newFftSize;
    this.fft = new FFT(newFftSize);
    this.complexInput = this.fft.createComplexArray();
    this.complexOutput = this.fft.createComplexArray();
    this.iqBuffer = new Float32Array(newFftSize * 2);
    this.windowFunc = this.createWindow(this.options.window ?? 'blackman-harris');
    this.averagedMagnitudes = null;
    this.normalizationDb = this.computeNormalization();
    (this as any).samplesNeeded = newFftSize * 2;
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
