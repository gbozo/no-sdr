// ============================================================
// node-sdr — LMS Adaptive Noise Reduction (ANR)
// ============================================================
// NLMS (Normalized Least Mean Squares) adaptive predictor that
// extracts correlated signal components and suppresses uncorrelated
// noise. Based on the WDSP ANR algorithm (Warren Pratt NR0V).
//
// Unlike spectral (Wiener) NR which produces "musical noise" artifacts,
// this time-domain approach has no such artifacts — it works by
// predicting the next sample from a decorrelated delay of itself.
// Correlated signals (voice, CW tones) are predictable; noise is not.
//
// Reference: WDSP anr.cpp (GPL, from SDRangel f4exb/sdrangel)
// ============================================================

export interface AnrOptions {
  /** Number of adaptive filter taps (32-256). More taps = better for wideband signals. */
  taps?: number;
  /** Decorrelation delay in samples (4-64). Larger = less signal removal risk. */
  delay?: number;
  /** Adaptation rate (1e-5 to 1e-3). Smaller = slower adaptation, less distortion. */
  gain?: number;
  /** Leakage factor (0.01-1.0). Prevents weight divergence on non-stationary signals. */
  leakage?: number;
}

/** Presets for different signal types */
export const ANR_PRESETS: Record<string, AnrOptions> = {
  ssb: { taps: 128, delay: 24, gain: 1e-4, leakage: 0.1 },
  cw:  { taps: 64,  delay: 8,  gain: 2e-4, leakage: 0.1 },
  am:  { taps: 64,  delay: 48, gain: 5e-5, leakage: 0.05 },
};

export class LmsAnr {
  private taps: number;
  private delay: number;
  private twoMu: number; // 2 × adaptation gain
  private gamma: number; // leakage base
  private enabled = false;

  // Delay line (ring buffer)
  private dline: Float32Array;
  private dlineSize: number;
  private dlineMask: number;
  private inIdx = 0;

  // Adaptive filter weights
  private weights: Float32Array;

  // Leakage adaptation state
  private lidx = 0;
  private lincr = 2;
  private ldecr = 1;
  private denMult: number;
  private ngamma = 0;

  constructor(options: AnrOptions = ANR_PRESETS.ssb) {
    this.taps = options.taps ?? 128;
    this.delay = options.delay ?? 16;
    this.twoMu = 2 * (options.gain ?? 1e-4);
    this.gamma = options.leakage ?? 0.1;

    // Delay line must be power of 2 for fast masking
    this.dlineSize = 2048;
    this.dlineMask = this.dlineSize - 1;
    this.dline = new Float32Array(this.dlineSize);

    // Adaptive filter weights
    this.weights = new Float32Array(this.taps);

    // Leakage denominator multiplier
    // denMult scales the leakage index (lidx) to a useful ngamma range
    this.denMult = 1.0 / (this.taps * this.taps * 500.0);
  }

  /** Enable/disable the ANR */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Don't reset weights — preserve learned state for quick re-enable
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Change adaptation parameters */
  setOptions(options: Partial<AnrOptions>): void {
    if (options.gain !== undefined) this.twoMu = 2 * options.gain;
    if (options.leakage !== undefined) this.gamma = options.leakage;
    if (options.delay !== undefined) this.delay = options.delay;
    // Tap count change requires weight resize
    if (options.taps !== undefined && options.taps !== this.taps) {
      this.taps = options.taps;
      this.weights = new Float32Array(this.taps);
      this.denMult = 1.0 / (this.taps * this.taps * 500.0);
      this.lidx = 0;
      this.ngamma = 0;
    }
  }

  /** Apply a preset by name */
  setPreset(name: string): void {
    const preset = ANR_PRESETS[name];
    if (preset) this.setOptions(preset);
  }

  /** Reset all adaptive state (call on frequency/mode change) */
  reset(): void {
    this.dline.fill(0);
    this.weights.fill(0);
    this.inIdx = 0;
    this.lidx = 0;
    this.ngamma = 0;
  }

  /**
   * Process a block of audio samples in-place.
   * Output = predicted signal (noise removed).
   * If disabled or gain is 0, samples pass through unchanged.
   */
  process(samples: Float32Array): void {
    if (!this.enabled) return;
    if (this.twoMu <= 0) return; // gain = 0 → passthrough

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
    const lincr = this.lincr;
    const ldecr = this.ldecr;
    const denMult = this.denMult;
    const eps = 1e-6; // Meaningful epsilon — prevents weight explosion on silence

    for (let i = 0; i < samples.length; i++) {
      const input = samples[i];

      // Store input in delay line
      dline[idx & mask] = input;

      // Compute filter output: y = sum(w[j] * dline[idx - delay - j])
      let y = 0;
      let sigma = 0; // power estimate for normalization
      for (let j = 0; j < n; j++) {
        const dIdx = (idx - dly - j) & mask;
        const d = dline[dIdx];
        y += w[j] * d;
        sigma += d * d;
      }

      // Error signal
      const error = input - y;

      // Output = prediction (contains the correlated/predictable part = signal)
      // Clamp to prevent downstream Web Audio biquad instability
      samples[i] = y > 1.0 ? 1.0 : y < -1.0 ? -1.0 : y;

      // ---- Adaptive leakage control ----
      // Prevents weight divergence on non-stationary signals
      const normFactor = twoMu / (sigma + eps);
      const nel = Math.abs(error * (1.0 - twoMu * sigma / (sigma + eps)));
      const nev = Math.abs(input - (1.0 - twoMu * ngamma) * y - twoMu * error * sigma / (sigma + eps));

      if (nev < nel) {
        lidx += lincr;
      } else {
        lidx -= ldecr;
      }
      // Clamp lidx to valid range
      if (lidx < 0) lidx = 0;
      if (lidx > 1000) lidx = 1000;

      // Compute effective ngamma from lidx (quartic ramp)
      const lidx2 = lidx * lidx;
      ngamma = gamma * lidx2 * lidx2 * denMult;

      // ---- Weight update (NLMS with leakage) ----
      const leakFactor = 1.0 - twoMu * ngamma;
      for (let j = 0; j < n; j++) {
        const dIdx = (idx - dly - j) & mask;
        let wNew = leakFactor * w[j] + normFactor * error * dline[dIdx];
        // Hard clamp weights to prevent divergence
        if (wNew > 10) wNew = 10;
        else if (wNew < -10) wNew = -10;
        w[j] = wNew;
      }

      idx = (idx + 1) & mask;
    }

    this.inIdx = idx;
    this.lidx = lidx;
    this.ngamma = ngamma;
  }
}
