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
  /** Wet/dry mix (0 = input, 1 = full prediction). */
  mix?: number;
}

/** Presets for different signal types */
export const ANR_PRESETS: Record<string, AnrOptions> = {
  ssb: { taps: 128, delay: 24, gain: 1e-4, leakage: 0.1 },
  cw:  { taps: 64,  delay: 8,  gain: 2e-4, leakage: 0.1 },
  am:  { taps: 64,  delay: 48, gain: 5e-5, leakage: 0.05 },
};

/** Map a 0-1 UI strength to an NLMS adaptation gain. Single source of truth so
 *  a restored session and a live slider move behave identically. */
export function anrGainForStrength(strength: number): number {
  const s = Math.max(0, Math.min(1, strength));
  return s * 1e-4;
}

/**
 * Maximum allowed `twoMu * ngamma`. With the WDSP constants this stays around
 * 1e-5; the cap only exists so a future parameter change can never invert the
 * leak factor (which flips the weight sign every sample).
 */
export const MAX_LEAK_RATIO = 0.1;

/**
 * Leakage scale from WDSP's `RXA.cpp` (`den_mult = 6.25e-10`). It is a fixed
 * constant, NOT derived from the tap count: the old `1 / (taps² * 500)` was
 * 195× too large at 128 taps and made the quartic ramp saturate the leak.
 */
export const WDSP_DEN_MULT = 6.25e-10;

/** Leakage index limits / ramp steps from WDSP's RXA.cpp. */
const LIDX_MIN = 120;
const LIDX_MAX = 200;
const LIDX_INCR = 1;
const LIDX_DECR = 3;

export class LmsAnr {
  private taps: number;
  private delay: number;
  private twoMu: number; // 2 × adaptation gain
  private gamma: number; // leakage base
  private mix = 1; // wet/dry output mix
  private enabled = false;

  // Delay line (ring buffer)
  private dline: Float32Array;
  private dlineSize: number;
  private dlineMask: number;
  private inIdx = 0;

  // Adaptive filter weights
  private weights: Float32Array;

  // Leakage adaptation state
  private lidx = LIDX_MIN;
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

  /** Set the 0-1 UI strength as both adaptation rate and wet/dry mix. */
  setStrength(strength: number): void {
    this.mix = Math.max(0, Math.min(1, strength));
    this.twoMu = 2 * anrGainForStrength(strength);
  }

  /** Change adaptation parameters */
  setOptions(options: Partial<AnrOptions>): void {
    if (options.gain !== undefined) this.twoMu = 2 * options.gain;
    if (options.leakage !== undefined) this.gamma = options.leakage;
    if (options.delay !== undefined) this.delay = options.delay;
    if (options.mix !== undefined) this.mix = Math.max(0, Math.min(1, options.mix));
    // Tap count change requires weight resize
    if (options.taps !== undefined && options.taps !== this.taps) {
      this.taps = options.taps;
      this.weights = new Float32Array(this.taps);
      this.lidx = LIDX_MIN;
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
    this.lidx = LIDX_MIN;
    this.ngamma = 0;
  }

  /**
   * Process a block of audio samples in-place.
   * Output = predicted signal (noise removed).
   * If disabled or gain is 0, samples pass through unchanged.
   */
  process(samples: Float32Array): void {
    if (!this.enabled) return;
    if (this.twoMu <= 0 || this.mix <= 0) return; // strength = 0 → passthrough

    const n = this.taps;
    const dly = this.delay;
    const dline = this.dline;
    const mask = this.dlineMask;
    const w = this.weights;
    const twoMu = this.twoMu;
    const gamma = this.gamma;
    const mix = this.mix;
    let idx = this.inIdx;
    let lidx = this.lidx;
    let ngamma = this.ngamma;
    const lincr = LIDX_INCR;
    const ldecr = LIDX_DECR;
    const denMult = WDSP_DEN_MULT;
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

      // Wet/dry mix: strength 0 is passthrough, strength 1 is full prediction.
      // Scaling only the adaptation gain made every non-zero setting converge
      // to the same steady-state filter, so the UI was effectively on/off.
      const out = input + mix * (y - input);
      // Clamp to prevent downstream Web Audio biquad instability
      samples[i] = out > 1.0 ? 1.0 : out < -1.0 ? -1.0 : out;

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
      // Clamp lidx to the WDSP ANR range (120..200): the leakage is a gentle
      // trim, never a dominant term.
      if (lidx < LIDX_MIN) lidx = LIDX_MIN;
      if (lidx > LIDX_MAX) lidx = LIDX_MAX;

      // Compute effective ngamma from lidx (quartic ramp), capped so that the
      // leakage term `twoMu * ngamma` stays below 1. Without the cap the
      // quartic ramp can reach >2 for the preset gamma/denMult values, which
      // makes leakFactor negative: weights flip sign every sample, pin to the
      // clamps below and the filter *amplifies* instead of predicting.
      const lidx2 = lidx * lidx;
      const maxNg = MAX_LEAK_RATIO / twoMu;
      ngamma = Math.min(gamma * lidx2 * lidx2 * denMult, maxNg);

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
