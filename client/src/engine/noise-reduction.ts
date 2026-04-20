// ============================================================
// node-sdr — Noise Reduction Engine
// ============================================================
// Intelligent noise reduction for demodulated audio.
//
// Two complementary techniques:
// 1. Spectral NR (Wiener-style): estimates noise floor per FFT
//    bin using minimum statistics, applies frequency-domain gain.
//    Effective for broadband hiss on all modes.
// 2. Noise Blanker: impulse noise removal for AM/HF. Detects
//    amplitude spikes and replaces with interpolated samples.
//
// Both operate on Float32Array audio at the demodulator output
// rate (typically 48 kHz) before the AudioWorklet.
// ============================================================

// ---- Tiny FFT (radix-2 in-place, power-of-2 only) ----
// Minimal implementation for 512-point NR frames — no dependency.

function fftInPlace(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }

  // Cooley-Tukey butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (2 * Math.PI / len) * (inverse ? -1 : 1);
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = i + j + len / 2;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// ---- Spectral Noise Reduction (Wiener-style) ----

export class SpectralNoiseReducer {
  private fftSize: number;

  // 75% overlap (hop = fftSize/4) — much smoother than 50%
  private hopSize: number;
  private overlapCount = 4; // number of overlapping frames

  // Overlap-add state
  private inputBuffer: Float32Array;
  private inputPos = 0;
  private outputBuffer: Float32Array;    // overlap-add accumulator
  private outputReadPos = 0;
  private outputWritePos = 0;

  // Window function (Hann)
  private window: Float32Array;
  private winCompensation: number;       // COLA normalization factor

  // FFT workspace
  private fftRe: Float32Array;
  private fftIm: Float32Array;

  // Noise floor estimation (minimum statistics per bin)
  private noiseFloor: Float32Array;
  private noisePower: Float32Array;      // running estimate
  private minTracker: Float32Array;      // minimum tracker
  private minCounter: Uint16Array;       // frames since last minimum reset
  private readonly minTrackLen = 150;    // ~2s at 75% overlap (187 frames/s for 512-pt)

  // Per-bin gain smoothing
  private gainSmooth: Float32Array;

  // Parameters
  private _strength = 0.5;              // 0-1 aggressiveness
  private spectralFloor = 0.06;         // minimum gain (prevents musical noise)
  private overSubtraction = 1.0;        // noise over-subtraction factor

  // Primed: need ~0.5s of data before noise estimate is reliable
  private frameCount = 0;
  private readonly primeFrames = 40;

  constructor(fftSize = 512) {
    this.fftSize = fftSize;
    this.hopSize = fftSize >> 2; // 75% overlap (hop = N/4)

    this.inputBuffer = new Float32Array(fftSize);
    this.outputBuffer = new Float32Array(fftSize * 6); // larger ring for 75% overlap
    this.window = new Float32Array(fftSize);
    this.fftRe = new Float32Array(fftSize);
    this.fftIm = new Float32Array(fftSize);

    this.noiseFloor = new Float32Array(fftSize);
    this.noisePower = new Float32Array(fftSize);
    this.minTracker = new Float32Array(fftSize);
    this.minCounter = new Uint16Array(fftSize);

    // Hann window
    for (let i = 0; i < fftSize; i++) {
      this.window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
    }

    // Compute COLA normalization: sum of w² at each position across all overlapping frames
    // For Hann with 75% overlap (hop=N/4), the sum is 1.5 at all positions
    let wSum = 0;
    for (let i = 0; i < fftSize; i++) {
      wSum += this.window[i] * this.window[i];
    }
    this.winCompensation = this.fftSize / (wSum * this.overlapCount / this.fftSize * this.fftSize / this.hopSize);
    // Simpler: for Hann 75% overlap, compensation ≈ 1/1.5 * 4 = 2.667
    // Recompute properly: each output sample gets contributions from 4 frames
    // sum of w[n]^2 across 4 overlapping Hann windows at 75% overlap ≈ 1.5
    // so compensation = 1/1.5 = 0.667... but we apply w on analysis AND synthesis
    // so total is w^2 * compensation = 1.0
    this.winCompensation = 1.0 / 1.5; // Will be multiplied by each w[i] in OLA

    // Per-bin gain smoothing
    this.gainSmooth = new Float32Array(fftSize);
    this.gainSmooth.fill(1.0);

    // Initialize noise estimates
    this.noiseFloor.fill(1e-6);
    this.noisePower.fill(1e-6);
    this.minTracker.fill(1e10);
  }

  /** Set NR strength: 0 = gentle, 1 = maximum reduction */
  set strength(v: number) {
    this._strength = Math.max(0, Math.min(1, v));
    // Wider range so the slider is more useful
    this.overSubtraction = 0.3 + v * 1.7;  // 0.3 at 0%, 2.0 at 100%
    this.spectralFloor = 0.20 - v * 0.14;  // 0.20 at 0%, 0.06 at 100%
  }

  get strength(): number {
    return this._strength;
  }

  /**
   * Process audio samples. Can handle any chunk size.
   * Returns filtered Float32Array (same length as input).
   */
  process(samples: Float32Array): Float32Array {
    if (this._strength < 0.01) return samples;

    const output = new Float32Array(samples.length);
    let outPos = 0;
    let inPos = 0;

    while (inPos < samples.length) {
      // Fill input buffer
      const canFill = Math.min(samples.length - inPos, this.fftSize - this.inputPos);
      this.inputBuffer.set(samples.subarray(inPos, inPos + canFill), this.inputPos);
      this.inputPos += canFill;
      inPos += canFill;

      // When we have a full frame, process it
      if (this.inputPos >= this.fftSize) {
        this.processFrame();
        // Shift input buffer by hop size (keep 75% overlap)
        this.inputBuffer.copyWithin(0, this.hopSize);
        this.inputPos = this.fftSize - this.hopSize;
      }
    }

    // Read available output
    const outBufLen = this.outputBuffer.length;
    while (outPos < output.length && this.outputReadPos !== this.outputWritePos) {
      output[outPos++] = this.outputBuffer[this.outputReadPos];
      this.outputBuffer[this.outputReadPos] = 0; // clear for next overlap-add
      this.outputReadPos = (this.outputReadPos + 1) % outBufLen;
    }

    // If we haven't produced enough output yet (during priming), pass through
    if (outPos < output.length) {
      for (let i = outPos; i < output.length; i++) {
        output[i] = samples[i];
      }
    }

    return output;
  }

  /**
   * Process a frame using an externally-provided gain mask.
   * Used for stereo: compute gain from one channel, apply same mask to both.
   */
  processWithGain(samples: Float32Array, gainMask: Float32Array | null): Float32Array {
    if (this._strength < 0.01) return samples;

    const output = new Float32Array(samples.length);
    let outPos = 0;
    let inPos = 0;

    while (inPos < samples.length) {
      const canFill = Math.min(samples.length - inPos, this.fftSize - this.inputPos);
      this.inputBuffer.set(samples.subarray(inPos, inPos + canFill), this.inputPos);
      this.inputPos += canFill;
      inPos += canFill;

      if (this.inputPos >= this.fftSize) {
        this.processFrameWithGain(gainMask);
        this.inputBuffer.copyWithin(0, this.hopSize);
        this.inputPos = this.fftSize - this.hopSize;
      }
    }

    const outBufLen = this.outputBuffer.length;
    while (outPos < output.length && this.outputReadPos !== this.outputWritePos) {
      output[outPos++] = this.outputBuffer[this.outputReadPos];
      this.outputBuffer[this.outputReadPos] = 0;
      this.outputReadPos = (this.outputReadPos + 1) % outBufLen;
    }

    if (outPos < output.length) {
      for (let i = outPos; i < output.length; i++) {
        output[i] = samples[i];
      }
    }

    return output;
  }

  /** Get the last computed gain mask (for sharing with stereo partner) */
  getLastGainMask(): Float32Array {
    return this.gainSmooth;
  }

  private processFrame(): void {
    this.processFrameWithGain(null);
  }

  private processFrameWithGain(externalGain: Float32Array | null): void {
    const n = this.fftSize;

    // Apply window and load into FFT buffers
    for (let i = 0; i < n; i++) {
      this.fftRe[i] = this.inputBuffer[i] * this.window[i];
      this.fftIm[i] = 0;
    }

    // Forward FFT
    fftInPlace(this.fftRe, this.fftIm, false);

    // Compute power spectrum and update noise estimate
    this.frameCount++;
    const primed = this.frameCount > this.primeFrames;

    for (let k = 0; k < n; k++) {
      const power = this.fftRe[k] * this.fftRe[k] + this.fftIm[k] * this.fftIm[k];

      // Minimum statistics noise estimation (Martin 2001 simplified)
      const smoothAlpha = 0.015; // slow — avoids tracking signal as noise
      this.noisePower[k] = (1 - smoothAlpha) * this.noisePower[k] + smoothAlpha * power;

      if (this.noisePower[k] < this.minTracker[k]) {
        this.minTracker[k] = this.noisePower[k];
        this.minCounter[k] = 0;
      } else {
        this.minCounter[k]++;
        if (this.minCounter[k] > this.minTrackLen) {
          this.minTracker[k] = this.noisePower[k];
          this.minCounter[k] = 0;
        }
      }

      // Noise floor = minimum × bias (1.5x — conservative to preserve tones)
      this.noiseFloor[k] = this.minTracker[k] * 1.5;

      if (primed) {
        let gain: number;

        if (externalGain) {
          // Use externally-provided gain mask (stereo slave channel)
          gain = externalGain[k];
        } else {
          // Compute Wiener gain
          const snr = power / (this.noiseFloor[k] + 1e-30);
          gain = Math.max(this.spectralFloor, 1 - this.overSubtraction / snr);

          // Light smoothing to prevent flutter
          const prev = this.gainSmooth[k];
          gain = prev * 0.3 + gain * 0.7;
          this.gainSmooth[k] = gain;
        }

        this.fftRe[k] *= gain;
        this.fftIm[k] *= gain;
      }
    }

    // Inverse FFT
    fftInPlace(this.fftRe, this.fftIm, true);

    // Overlap-add with COLA normalization for Hann 75% overlap
    const outBufLen = this.outputBuffer.length;
    const comp = this.winCompensation;
    for (let i = 0; i < n; i++) {
      const idx = (this.outputWritePos + i) % outBufLen;
      this.outputBuffer[idx] += this.fftRe[i] * this.window[i] * comp;
    }
    this.outputWritePos = (this.outputWritePos + this.hopSize) % outBufLen;
  }

  reset(): void {
    this.inputBuffer.fill(0);
    this.inputPos = 0;
    this.outputBuffer.fill(0);
    this.outputReadPos = 0;
    this.outputWritePos = 0;
    this.noiseFloor.fill(1e-6);
    this.noisePower.fill(1e-6);
    this.minTracker.fill(1e10);
    this.minCounter.fill(0);
    this.gainSmooth.fill(1.0);
    this.frameCount = 0;
  }
}

// ---- Noise Blanker (Impulse Noise Removal) ----

export class NoiseBlanker {
  private avgMag = 0;
  private hangTimer = 0;
  private threshold: number;

  // Delay line for look-ahead blanking (blank the spike AND preceding samples)
  private readonly delayLen = 8;
  private delayBuffer: Float32Array;
  private delayIdx = 0;

  // Interpolation: when blanking, blend to zero smoothly
  private blanking = false;
  private blankGain = 1;

  constructor(threshold = 3.5) {
    this.threshold = threshold;
    this.delayBuffer = new Float32Array(this.delayLen);
  }

  set level(v: number) {
    // Map 0-1 to threshold: 0 = very aggressive (2.0), 1 = gentle (6.0)
    this.threshold = 6.0 - v * 4.0;
  }

  /**
   * Process audio samples in-place.
   * Returns the same array (modified).
   */
  process(samples: Float32Array): Float32Array {
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const mag = Math.abs(sample);

      // Exponential moving average of magnitude (~2ms at 48kHz)
      this.avgMag = 0.999 * this.avgMag + 0.001 * mag;

      // Store in delay buffer
      const delayedSample = this.delayBuffer[this.delayIdx];
      this.delayBuffer[this.delayIdx] = sample;
      this.delayIdx = (this.delayIdx + 1) & (this.delayLen - 1);

      // Detect impulse
      if (this.avgMag > 1e-8 && mag > this.threshold * this.avgMag) {
        this.hangTimer = 7;
      }

      if (this.hangTimer > 0) {
        this.hangTimer--;
        // Smooth transition to zero (avoid clicks)
        this.blankGain = Math.max(0, this.blankGain - 0.25);
        samples[i] = delayedSample * this.blankGain;
      } else {
        // Smooth recovery
        this.blankGain = Math.min(1, this.blankGain + 0.1);
        samples[i] = delayedSample * this.blankGain;
      }
    }
    return samples;
  }

  reset(): void {
    this.avgMag = 0;
    this.hangTimer = 0;
    this.blankGain = 1;
    this.delayBuffer.fill(0);
    this.delayIdx = 0;
  }
}

// ---- Unified Noise Reduction Controller ----

export type NrMode = 'off' | 'light' | 'moderate' | 'aggressive';

export class NoiseReductionEngine {
  /** Spectral NR (Wiener-style, for broadband noise / hiss) */
  readonly spectralNr: SpectralNoiseReducer;
  readonly spectralNrR: SpectralNoiseReducer; // right channel for stereo

  /** Noise blanker (impulse removal, mainly for AM/HF) */
  readonly noiseBlanker: NoiseBlanker;
  readonly noiseBlankerR: NoiseBlanker; // right channel for stereo

  private _nrEnabled = false;
  private _nbEnabled = false;

  constructor() {
    this.spectralNr = new SpectralNoiseReducer(512);
    this.spectralNrR = new SpectralNoiseReducer(512);
    this.noiseBlanker = new NoiseBlanker();
    this.noiseBlankerR = new NoiseBlanker();
  }

  // ---- NR (spectral noise reduction) ----

  get nrEnabled(): boolean { return this._nrEnabled; }

  setNrEnabled(enabled: boolean): void {
    this._nrEnabled = enabled;
    if (!enabled) {
      this.spectralNr.reset();
      this.spectralNrR.reset();
    }
  }

  setNrStrength(strength: number): void {
    this.spectralNr.strength = strength;
    this.spectralNrR.strength = strength;
  }

  // ---- NB (noise blanker) ----

  get nbEnabled(): boolean { return this._nbEnabled; }

  setNbEnabled(enabled: boolean): void {
    this._nbEnabled = enabled;
    if (!enabled) {
      this.noiseBlanker.reset();
      this.noiseBlankerR.reset();
    }
  }

  setNbLevel(level: number): void {
    this.noiseBlanker.level = level;
    this.noiseBlankerR.level = level;
  }

  // ---- Process mono audio (NFM/AM/SSB/CW) ----

  processMono(samples: Float32Array): Float32Array {
    let out = samples;
    if (this._nbEnabled) {
      out = this.noiseBlanker.process(out);
    }
    if (this._nrEnabled) {
      out = this.spectralNr.process(out);
    }
    return out;
  }

  // ---- Process stereo audio (WFM) ----
  // Uses shared gain mask: compute from left channel, apply same to right.
  // This prevents stereo image distortion from independent L/R processing.

  processStereo(left: Float32Array, right: Float32Array): { left: Float32Array; right: Float32Array } {
    let l = left;
    let r = right;
    if (this._nbEnabled) {
      l = this.noiseBlanker.process(l);
      r = this.noiseBlankerR.process(r);
    }
    if (this._nrEnabled) {
      // Process left channel normally (computes gain mask)
      l = this.spectralNr.process(l);
      // Apply the same gain mask to right channel — preserves stereo coherence
      r = this.spectralNrR.processWithGain(r, this.spectralNr.getLastGainMask());
    }
    return { left: l, right: r };
  }

  reset(): void {
    this.spectralNr.reset();
    this.spectralNrR.reset();
    this.noiseBlanker.reset();
    this.noiseBlankerR.reset();
  }
}
