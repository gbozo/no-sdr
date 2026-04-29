// ============================================================
// node-sdr — Hang-Timer AGC (Moe Wheatley / gqrx design)
// ============================================================
// Automatic Gain Control with hang timer for SSB/CW/AM modes.
// Features:
//   - Signal delay line (look-ahead to prevent attack clipping)
//   - Fast attack / slow decay dual-path envelope tracking
//   - Hang timer: holds gain constant after signal drops (prevents pumping)
//   - Mode-specific presets (SSB, CW, AM, FM)
//
// Reference: gqrx src/dsp/agc_impl.cpp (BSD licensed)
// ============================================================

export interface AgcPreset {
  /** Attack time in ms (gain reduction) */
  attackMs: number;
  /** Decay time in ms (gain increase) */
  decayMs: number;
  /** Hang time in ms (hold gain after drop before releasing) */
  hangMs: number;
  /** Target output level (0-1, where 1 = full scale) */
  targetLevel: number;
  /** Maximum gain in dB (prevents noise amplification in silence) */
  maxGainDb: number;
}

/** Mode-specific AGC presets */
export const AGC_PRESETS: Record<string, AgcPreset> = {
  ssb: {
    attackMs: 2,
    decayMs: 250,
    hangMs: 300,
    targetLevel: 0.5,
    maxGainDb: 60,
  },
  cw: {
    attackMs: 2,
    decayMs: 100,
    hangMs: 200,
    targetLevel: 0.4,
    maxGainDb: 70,
  },
  am: {
    attackMs: 5,
    decayMs: 500,
    hangMs: 0, // No hang for AM (continuous carrier)
    targetLevel: 0.5,
    maxGainDb: 50,
  },
  fm: {
    attackMs: 10,
    decayMs: 1000,
    hangMs: 0,
    targetLevel: 0.6,
    maxGainDb: 40,
  },
};

export class HangAgc {
  private sampleRate = 48000;

  // Delay line for look-ahead (prevents clipping on attack)
  private delayLine: Float32Array;
  private delayIdx = 0;
  private delaySamples: number;

  // Envelope tracking
  private attackAlpha: number;
  private decayAlpha: number;
  private envelope = 0;

  // Hang timer state
  private hangSamples: number;
  private hangCounter = 0;
  private wasDecaying = false;

  // Gain state
  private gainLinear = 1;
  private maxGainLinear: number;
  private targetLevel: number;

  // Current preset name (for UI display)
  private currentPreset = 'ssb';

  constructor(sampleRate = 48000, preset: AgcPreset = AGC_PRESETS.ssb) {
    this.sampleRate = sampleRate;
    this.delaySamples = Math.round(sampleRate * 0.015); // 15ms look-ahead
    this.delayLine = new Float32Array(this.delaySamples);
    this.targetLevel = preset.targetLevel;
    this.maxGainLinear = Math.pow(10, preset.maxGainDb / 20);
    this.attackAlpha = 1 - Math.exp(-1000 / (preset.attackMs * sampleRate));
    this.decayAlpha = 1 - Math.exp(-1000 / (preset.decayMs * sampleRate));
    this.hangSamples = Math.round(sampleRate * preset.hangMs / 1000);
  }

  /** Switch to a named preset (ssb, cw, am, fm) */
  setPreset(name: string): void {
    const preset = AGC_PRESETS[name] ?? AGC_PRESETS.ssb;
    this.currentPreset = name;
    this.targetLevel = preset.targetLevel;
    this.maxGainLinear = Math.pow(10, preset.maxGainDb / 20);
    this.attackAlpha = 1 - Math.exp(-1000 / (preset.attackMs * this.sampleRate));
    this.decayAlpha = 1 - Math.exp(-1000 / (preset.decayMs * this.sampleRate));
    this.hangSamples = Math.round(this.sampleRate * preset.hangMs / 1000);
  }

  /** Set custom decay time in ms (user adjustment) */
  setDecayMs(ms: number): void {
    this.decayAlpha = 1 - Math.exp(-1000 / (ms * this.sampleRate));
  }

  /** Set custom hang time in ms (user adjustment) */
  setHangMs(ms: number): void {
    this.hangSamples = Math.round(this.sampleRate * ms / 1000);
  }

  /** Get current preset name */
  getPreset(): string {
    return this.currentPreset;
  }

  /** Process a block of mono audio samples in-place */
  process(samples: Float32Array): void {
    const delay = this.delayLine;
    const delayLen = this.delaySamples;
    let idx = this.delayIdx;
    let env = this.envelope;
    let gain = this.gainLinear;
    const target = this.targetLevel;
    const maxGain = this.maxGainLinear;
    const attackA = this.attackAlpha;
    const decayA = this.decayAlpha;
    let hangCount = this.hangCounter;
    let wasDecay = this.wasDecaying;
    const hangMax = this.hangSamples;

    for (let i = 0; i < samples.length; i++) {
      // Push current sample into delay line, get delayed sample
      const input = samples[i];
      const delayed = delay[idx];
      delay[idx] = input;
      idx = (idx + 1) % delayLen;

      // Envelope tracking on the INPUT (look-ahead)
      const magnitude = Math.abs(input);
      if (magnitude > env) {
        // Attack — fast rise
        env += attackA * (magnitude - env);
      } else {
        // Decay — check hang first
        if (hangMax > 0) {
          if (!wasDecay) {
            // Signal just dropped — start hang timer
            hangCount = hangMax;
            wasDecay = true;
          }
          if (hangCount > 0) {
            hangCount--;
            // During hang: envelope stays constant (no decay)
          } else {
            // Hang expired — allow decay
            env += decayA * (magnitude - env);
          }
        } else {
          // No hang mode — immediate decay
          env += decayA * (magnitude - env);
        }
      }

      // If envelope is rising, reset hang state
      if (magnitude > env * 0.95) {
        wasDecay = false;
        hangCount = 0;
      }

      // Compute desired gain from envelope
      if (env > 1e-10) {
        gain = target / env;
      } else {
        gain = maxGain;
      }
      // Clamp gain
      if (gain > maxGain) gain = maxGain;
      if (gain < 0.001) gain = 0.001;

      // Apply gain to the DELAYED sample (the look-ahead)
      samples[i] = delayed * gain;
    }

    this.delayIdx = idx;
    this.envelope = env;
    this.gainLinear = gain;
    this.hangCounter = hangCount;
    this.wasDecaying = wasDecay;
  }

  /** Process stereo audio (two separate channels) */
  processStereo(left: Float32Array, right: Float32Array): void {
    // Use combined envelope from both channels for consistent gain
    const delay = this.delayLine;
    const delayLen = this.delaySamples;

    // Need separate delay for right channel
    if (!this.delayLineR) {
      this.delayLineR = new Float32Array(delayLen);
      this.delayIdxR = 0;
    }
    const delayR = this.delayLineR;

    let idx = this.delayIdx;
    let idxR = this.delayIdxR;
    let env = this.envelope;
    let gain = this.gainLinear;
    const target = this.targetLevel;
    const maxGain = this.maxGainLinear;
    const attackA = this.attackAlpha;
    const decayA = this.decayAlpha;
    let hangCount = this.hangCounter;
    let wasDecay = this.wasDecaying;
    const hangMax = this.hangSamples;

    const len = Math.min(left.length, right.length);
    for (let i = 0; i < len; i++) {
      const inL = left[i];
      const inR = right[i];
      const delayedL = delay[idx];
      const delayedR = delayR[idxR];
      delay[idx] = inL;
      delayR[idxR] = inR;
      idx = (idx + 1) % delayLen;
      idxR = (idxR + 1) % delayLen;

      // Combined magnitude
      const magnitude = Math.max(Math.abs(inL), Math.abs(inR));

      if (magnitude > env) {
        env += attackA * (magnitude - env);
      } else {
        if (hangMax > 0) {
          if (!wasDecay) { hangCount = hangMax; wasDecay = true; }
          if (hangCount > 0) { hangCount--; }
          else { env += decayA * (magnitude - env); }
        } else {
          env += decayA * (magnitude - env);
        }
      }
      if (magnitude > env * 0.95) { wasDecay = false; hangCount = 0; }

      if (env > 1e-10) { gain = target / env; }
      else { gain = maxGain; }
      if (gain > maxGain) gain = maxGain;
      if (gain < 0.001) gain = 0.001;

      left[i] = delayedL * gain;
      right[i] = delayedR * gain;
    }

    this.delayIdx = idx;
    this.delayIdxR = idxR;
    this.envelope = env;
    this.gainLinear = gain;
    this.hangCounter = hangCount;
    this.wasDecaying = wasDecay;
  }

  // Right channel delay line (allocated on first stereo call)
  private delayLineR: Float32Array | null = null;
  private delayIdxR = 0;

  /** Reset all state (call on mode/frequency change) */
  reset(): void {
    this.delayLine.fill(0);
    this.delayLineR?.fill(0);
    this.delayIdx = 0;
    this.delayIdxR = 0;
    this.envelope = 0;
    this.gainLinear = 1;
    this.hangCounter = 0;
    this.wasDecaying = false;
  }
}
