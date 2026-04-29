// ============================================================
// node-sdr — Audio Filters (Rumble HPF + Auto-Notch)
// ============================================================
// Two filters for FM stereo broadcast listening:
//
// 1. Rumble Filter: 4th-order Butterworth high-pass (configurable cutoff).
//    Removes hum fundamentals (50/60Hz) and wind/blowing noise.
//    No artifacts on music — broadcast audio has nothing below ~50Hz.
//
// 2. Auto-Notch: LMS adaptive filter that removes discrete tones (hum
//    harmonics, heterodynes, carriers). Outputs the ERROR signal from an
//    LMS predictor — everything EXCEPT predictable narrowband tones.
//    Music passes through; only pure tones are cancelled (~20-30dB each).
// ============================================================

// ---- Biquad HPF (2nd-order section) ----

interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

interface BiquadState {
  z1: number; z2: number;
}

function biquadProcess(x: number, c: BiquadCoeffs, s: BiquadState): number {
  const y = c.b0 * x + s.z1;
  s.z1 = c.b1 * x - c.a1 * y + s.z2;
  s.z2 = c.b2 * x - c.a2 * y;
  return y;
}

/**
 * Design a 2nd-order Butterworth high-pass section.
 */
function designHpf2(cutoffHz: number, sampleRate: number): BiquadCoeffs {
  const wc = Math.tan(Math.PI * cutoffHz / sampleRate);
  const wc2 = wc * wc;
  const sqrt2 = Math.SQRT2;
  const norm = 1 + sqrt2 * wc + wc2;

  const b0 = 1 / norm;
  const b1 = -2 / norm;
  const b2 = 1 / norm;
  const a1 = 2 * (wc2 - 1) / norm;
  const a2 = (1 - sqrt2 * wc + wc2) / norm;

  return { b0, b1, b2, a1, a2 };
}

// ============================================================
// Rumble Filter (4th-order Butterworth HPF)
// ============================================================

export class RumbleFilter {
  private enabled = false;
  private cutoffHz: number;
  private sampleRate: number;
  // 4th-order = 2 cascaded 2nd-order sections
  private coeffs: BiquadCoeffs[] = [];
  private statesL: BiquadState[] = [];
  private statesR: BiquadState[] = [];

  constructor(sampleRate = 48000, cutoffHz = 65) {
    this.sampleRate = sampleRate;
    this.cutoffHz = cutoffHz;
    this.designFilter();
  }

  private designFilter(): void {
    // 4th-order Butterworth HPF = 2 cascaded 2nd-order sections with Q adjustments
    // Section 1: Q = 1/(2*cos(π/8)) ≈ 0.5412
    // Section 2: Q = 1/(2*cos(3π/8)) ≈ 1.3066
    const Qs = [
      1 / (2 * Math.cos(Math.PI / 8)),
      1 / (2 * Math.cos(3 * Math.PI / 8)),
    ];

    this.coeffs = [];
    this.statesL = [];
    this.statesR = [];

    for (const Q of Qs) {
      const wc = Math.tan(Math.PI * this.cutoffHz / this.sampleRate);
      const wc2 = wc * wc;
      const norm = 1 + wc / Q + wc2;

      const b0 = 1 / norm;
      const b1 = -2 / norm;
      const b2 = 1 / norm;
      const a1 = 2 * (wc2 - 1) / norm;
      const a2 = (1 - wc / Q + wc2) / norm;

      this.coeffs.push({ b0, b1, b2, a1, a2 });
      this.statesL.push({ z1: 0, z2: 0 });
      this.statesR.push({ z1: 0, z2: 0 });
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setCutoff(hz: number): void {
    this.cutoffHz = Math.max(20, Math.min(200, hz));
    this.designFilter();
  }

  getCutoff(): number {
    return this.cutoffHz;
  }

  /** Process mono audio in-place */
  process(samples: Float32Array): void {
    if (!this.enabled) return;
    for (let i = 0; i < samples.length; i++) {
      let x = samples[i];
      for (let s = 0; s < this.coeffs.length; s++) {
        x = biquadProcess(x, this.coeffs[s], this.statesL[s]);
      }
      samples[i] = x;
    }
  }

  /** Process stereo audio in-place */
  processStereo(left: Float32Array, right: Float32Array): void {
    if (!this.enabled) return;
    const len = Math.min(left.length, right.length);
    for (let i = 0; i < len; i++) {
      let l = left[i];
      let r = right[i];
      for (let s = 0; s < this.coeffs.length; s++) {
        l = biquadProcess(l, this.coeffs[s], this.statesL[s]);
        r = biquadProcess(r, this.coeffs[s], this.statesR[s]);
      }
      left[i] = l;
      right[i] = r;
    }
  }

  reset(): void {
    for (const s of this.statesL) { s.z1 = 0; s.z2 = 0; }
    for (const s of this.statesR) { s.z1 = 0; s.z2 = 0; }
  }
}

// ============================================================
// Auto-Notch (LMS tone removal)
// ============================================================
// Same LMS algorithm as ANR but outputs the ERROR signal:
//   output = input - prediction
// The predictor learns tones (predictable); the error is everything else (music + noise).
// Result: tones are removed, music passes through.

export class AutoNotch {
  private enabled = false;
  private taps: number;
  private delay: number;
  private twoMu: number;
  private gamma: number;

  // Delay line
  private dline: Float32Array;
  private dlineSize = 1024;
  private dlineMask = 1023;
  private inIdx = 0;

  // Adaptive weights
  private weights: Float32Array;

  // Leakage state
  private lidx = 0;
  private ngamma = 0;
  private denMult: number;

  constructor(sampleRate = 48000) {
    // Auto-notch parameters:
    // - Few taps: only models narrowband tones, can't capture complex music
    // - Large delay (128 samples = 2.7ms at 48kHz): decorrelates broadband audio
    //   (bass, music) while hum tones stay perfectly correlated at ANY delay
    //   (because they're periodic: 50Hz period = 960 samples, 100Hz = 480, etc.)
    // - Slow adaptation: only locks onto stationary tones, ignores transient music
    this.taps = 16;
    this.delay = 128; // 2.7ms — bass/music is decorrelated, hum harmonics are not
    this.twoMu = 4e-4; // Moderate — locks onto hum in ~200ms
    this.gamma = 0.01; // Low leakage — holds lock tightly
    this.dline = new Float32Array(this.dlineSize);
    this.weights = new Float32Array(this.taps);
    this.denMult = 1.0 / (this.taps * this.taps * 500.0);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Process mono audio in-place. Removes tones, keeps everything else. */
  process(samples: Float32Array): void {
    if (!this.enabled) return;

    const n = this.taps;
    const dly = this.delay;
    const dline = this.dline;
    const mask = this.dlineMask;
    const w = this.weights;
    const twoMu = this.twoMu;
    const gamma = this.gamma;
    let idx = this.inIdx;
    let lidx = this.lidx;
    let ngamma = this.ngamma;
    const denMult = this.denMult;
    const eps = 1e-30;
    const lincr = 2;
    const ldecr = 1;

    for (let i = 0; i < samples.length; i++) {
      const input = samples[i];
      dline[idx & mask] = input;

      // Prediction (captures tones)
      let y = 0;
      let sigma = 0;
      for (let j = 0; j < n; j++) {
        const dIdx = (idx - dly - j) & mask;
        const d = dline[dIdx];
        y += w[j] * d;
        sigma += d * d;
      }

      // Error = input minus predicted tones = music + noise (tones removed)
      const error = input - y;
      samples[i] = error; // ← KEY DIFFERENCE from ANR: output ERROR, not prediction

      // Leakage adaptation
      const nel = Math.abs(error * (1.0 - twoMu * sigma / (sigma + eps)));
      const nev = Math.abs(input - (1.0 - twoMu * ngamma) * y - twoMu * error * sigma / (sigma + eps));
      if (nev < nel) lidx += lincr; else lidx -= ldecr;
      if (lidx < 0) lidx = 0;
      if (lidx > 1000) lidx = 1000;
      const lidx2 = lidx * lidx;
      ngamma = gamma * lidx2 * lidx2 * denMult;

      // Weight update
      const normFactor = twoMu / (sigma + eps);
      const leakFactor = 1.0 - twoMu * ngamma;
      for (let j = 0; j < n; j++) {
        const dIdx = (idx - dly - j) & mask;
        w[j] = leakFactor * w[j] + normFactor * error * dline[dIdx];
      }

      idx = (idx + 1) & mask;
    }

    this.inIdx = idx;
    this.lidx = lidx;
    this.ngamma = ngamma;
  }

  /** Process stereo — apply same notch to both channels (shared weights) */
  processStereo(left: Float32Array, right: Float32Array): void {
    if (!this.enabled) return;
    // Process left channel (updates weights)
    this.process(left);
    // For right channel, use separate state but same concept
    // (Simple approach: process independently — hum is usually in both channels equally)
    this.processRight(right);
  }

  // Separate state for right channel
  private dlineR = new Float32Array(1024);
  private inIdxR = 0;
  private weightsR = new Float32Array(16);
  private lidxR = 0;
  private ngammaR = 0;

  private processRight(samples: Float32Array): void {
    const n = this.taps;
    const dly = this.delay;
    const dline = this.dlineR;
    const mask = this.dlineMask;
    const w = this.weightsR;
    const twoMu = this.twoMu;
    const gamma = this.gamma;
    let idx = this.inIdxR;
    let lidx = this.lidxR;
    let ngamma = this.ngammaR;
    const denMult = this.denMult;
    const eps = 1e-30;

    for (let i = 0; i < samples.length; i++) {
      const input = samples[i];
      dline[idx & mask] = input;

      let y = 0;
      let sigma = 0;
      for (let j = 0; j < n; j++) {
        const dIdx = (idx - dly - j) & mask;
        const d = dline[dIdx];
        y += w[j] * d;
        sigma += d * d;
      }

      const error = input - y;
      samples[i] = error;

      const nel = Math.abs(error * (1.0 - twoMu * sigma / (sigma + eps)));
      const nev = Math.abs(input - (1.0 - twoMu * ngamma) * y - twoMu * error * sigma / (sigma + eps));
      if (nev < nel) lidx += 2; else lidx -= 1;
      if (lidx < 0) lidx = 0;
      if (lidx > 1000) lidx = 1000;
      const lidx2 = lidx * lidx;
      ngamma = gamma * lidx2 * lidx2 * denMult;

      const normFactor = twoMu / (sigma + eps);
      const leakFactor = 1.0 - twoMu * ngamma;
      for (let j = 0; j < n; j++) {
        const dIdx = (idx - dly - j) & mask;
        w[j] = leakFactor * w[j] + normFactor * error * dline[dIdx];
      }

      idx = (idx + 1) & mask;
    }

    this.inIdxR = idx;
    this.lidxR = lidx;
    this.ngammaR = ngamma;
  }

  reset(): void {
    this.dline.fill(0);
    this.dlineR.fill(0);
    this.weights.fill(0);
    this.weightsR.fill(0);
    this.inIdx = 0;
    this.inIdxR = 0;
    this.lidx = 0;
    this.lidxR = 0;
    this.ngamma = 0;
    this.ngammaR = 0;
  }
}

// ============================================================
// FM Stereo Hi-Blend (frequency-dependent stereo reduction)
// ============================================================
// Reduces stereo separation at high frequencies where FM noise
// is most audible on weak stations. Works by low-passing the
// L-R difference channel — bass stays stereo, treble fades to mono.
//
// This is how every car radio and hi-fi tuner handles weak FM signals.
// The cutoff frequency can be adjusted: higher = more stereo preserved,
// lower = more noise reduction but less stereo imaging.
// ============================================================

export class HiBlendFilter {
  private enabled = false;
  private cutoffHz: number;
  private sampleRate: number;

  // 2nd-order LPF on the L-R difference signal
  private coeffs: BiquadCoeffs;
  private stateL: BiquadState = { z1: 0, z2: 0 }; // for (L-R) channel

  constructor(sampleRate = 48000, cutoffHz = 2500) {
    this.sampleRate = sampleRate;
    this.cutoffHz = cutoffHz;
    this.coeffs = this.designLpf(cutoffHz);
  }

  private designLpf(cutoffHz: number): BiquadCoeffs {
    // 2nd-order Butterworth LPF
    const wc = Math.tan(Math.PI * cutoffHz / this.sampleRate);
    const wc2 = wc * wc;
    const sqrt2 = Math.SQRT2;
    const norm = 1 + sqrt2 * wc + wc2;

    return {
      b0: wc2 / norm,
      b1: 2 * wc2 / norm,
      b2: wc2 / norm,
      a1: 2 * (wc2 - 1) / norm,
      a2: (1 - sqrt2 * wc + wc2) / norm,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setCutoff(hz: number): void {
    this.cutoffHz = Math.max(500, Math.min(8000, hz));
    this.coeffs = this.designLpf(this.cutoffHz);
  }

  getCutoff(): number {
    return this.cutoffHz;
  }

  /**
   * Process stereo audio in-place.
   * Applies LPF to the L-R difference: treble stereo content is reduced.
   * L+R (mono sum) passes unchanged — no loss of content, just stereo imaging.
   */
  processStereo(left: Float32Array, right: Float32Array): void {
    if (!this.enabled) return;

    const c = this.coeffs;
    const s = this.stateL;
    const len = Math.min(left.length, right.length);

    for (let i = 0; i < len; i++) {
      const l = left[i];
      const r = right[i];

      // Extract mid (L+R) and side (L-R)
      const mid = (l + r) * 0.5;
      let side = (l - r) * 0.5;

      // Low-pass the side channel — removes high-frequency stereo noise
      side = biquadProcess(side, c, s);

      // Reconstruct L and R from filtered mid/side
      left[i] = mid + side;
      right[i] = mid - side;
    }
  }

  reset(): void {
    this.stateL = { z1: 0, z2: 0 };
  }
}
