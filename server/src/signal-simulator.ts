// ============================================================
// node-sdr — Signal Simulator for Demo Mode
// ============================================================
// Generates realistic synthetic IQ data for development and
// demonstration without RTL-SDR hardware.
//
// Simulates:
// - Noise floor with configurable level
// - FM broadcast signals (WFM with stereo pilot)
// - Narrowband FM signals (voice-like bursts)
// - AM signals (carriers with modulation)
// - CW signals (Morse-like tones)
// - Drifting signals that move slowly across the band
// ============================================================

import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

export interface SimulatedSignal {
  /** Offset from center frequency in Hz */
  offsetHz: number;
  /** Signal type */
  type: 'wfm' | 'nfm' | 'am' | 'cw' | 'noise-burst';
  /** Signal amplitude (0.0 to 1.0) */
  amplitude: number;
  /** Bandwidth in Hz */
  bandwidth: number;
  /** Whether signal drifts over time */
  drift?: { rateHz: number; rangeHz: number };
  /** Whether signal is intermittent */
  intermittent?: { onMs: number; offMs: number };
  /** Label for logging */
  label?: string;
}

export interface SimulatorOptions {
  /** Center frequency in Hz */
  centerFrequency: number;
  /** Sample rate in Hz */
  sampleRate: number;
  /** FFT size for chunk sizing */
  fftSize: number;
  /** Noise floor amplitude (0.0 to 1.0) */
  noiseFloor: number;
  /** Signals to simulate */
  signals: SimulatedSignal[];
  /** Chunk emission interval in ms (~33ms = 30fps FFT) */
  intervalMs: number;
}

/**
 * Default FM broadcast band simulation (87.5-108 MHz range around 100 MHz center)
 */
export function createFmBroadcastSimulation(centerFreq = 100_000_000, sampleRate = 2_400_000): SimulatorOptions {
  return {
    centerFrequency: centerFreq,
    sampleRate,
    fftSize: 2048,
    noiseFloor: 0.02,
    intervalMs: 33,
    signals: [
      // Strong FM station at +200kHz
      {
        offsetHz: 200_000,
        type: 'wfm',
        amplitude: 0.7,
        bandwidth: 150_000,
        label: 'FM Station 1 (100.2 MHz)',
      },
      // Medium FM station at -400kHz
      {
        offsetHz: -400_000,
        type: 'wfm',
        amplitude: 0.45,
        bandwidth: 150_000,
        label: 'FM Station 2 (99.6 MHz)',
      },
      // Weak FM station at +800kHz
      {
        offsetHz: 800_000,
        type: 'wfm',
        amplitude: 0.15,
        bandwidth: 150_000,
        label: 'FM Station 3 (100.8 MHz)',
      },
      // Another station at -900kHz
      {
        offsetHz: -900_000,
        type: 'wfm',
        amplitude: 0.55,
        bandwidth: 150_000,
        label: 'FM Station 4 (99.1 MHz)',
      },
      // Weak drifting signal
      {
        offsetHz: 500_000,
        type: 'nfm',
        amplitude: 0.08,
        bandwidth: 12_500,
        drift: { rateHz: 50, rangeHz: 5000 },
        label: 'Drifting Signal',
      },
    ],
  };
}

/**
 * Aviation band simulation (118-137 MHz range around 125 MHz center)
 */
export function createAviationSimulation(centerFreq = 125_000_000, sampleRate = 2_400_000): SimulatorOptions {
  return {
    centerFrequency: centerFreq,
    sampleRate,
    fftSize: 2048,
    noiseFloor: 0.015,
    intervalMs: 33,
    signals: [
      // Tower on 118.7
      {
        offsetHz: -6_300_000 + (centerFreq - 125_000_000),
        type: 'am',
        amplitude: 0.5,
        bandwidth: 8_330,
        intermittent: { onMs: 3000, offMs: 5000 },
        label: 'Tower 118.7',
      },
      // ATIS on 125.0
      {
        offsetHz: 0,
        type: 'am',
        amplitude: 0.35,
        bandwidth: 8_330,
        label: 'ATIS 125.0',
      },
      // Ground on 121.9
      {
        offsetHz: -3_100_000,
        type: 'am',
        amplitude: 0.4,
        bandwidth: 8_330,
        intermittent: { onMs: 2000, offMs: 8000 },
        label: 'Ground 121.9',
      },
      // Approach on 127.4
      {
        offsetHz: 2_400_000,
        type: 'am',
        amplitude: 0.3,
        bandwidth: 8_330,
        intermittent: { onMs: 4000, offMs: 3000 },
        label: 'Approach 127.4',
      },
    ],
  };
}

/**
 * Two-meter amateur band simulation (144-148 MHz around 146 MHz)
 */
export function createTwoMeterSimulation(centerFreq = 146_000_000, sampleRate = 2_400_000): SimulatorOptions {
  return {
    centerFrequency: centerFreq,
    sampleRate,
    fftSize: 2048,
    noiseFloor: 0.018,
    intervalMs: 33,
    signals: [
      // Repeater output on 146.52 (simplex)
      {
        offsetHz: 520_000,
        type: 'nfm',
        amplitude: 0.5,
        bandwidth: 12_500,
        intermittent: { onMs: 5000, offMs: 10000 },
        label: 'Simplex 146.52',
      },
      // Repeater on 146.94
      {
        offsetHz: 940_000,
        type: 'nfm',
        amplitude: 0.6,
        bandwidth: 12_500,
        intermittent: { onMs: 8000, offMs: 4000 },
        label: 'Repeater 146.94',
      },
      // Weak CW beacon
      {
        offsetHz: -500_000,
        type: 'cw',
        amplitude: 0.1,
        bandwidth: 500,
        label: 'CW Beacon 145.5',
      },
      // Packet/APRS on 144.39
      {
        offsetHz: -1_610_000,
        type: 'nfm',
        amplitude: 0.25,
        bandwidth: 12_500,
        intermittent: { onMs: 500, offMs: 15000 },
        label: 'APRS 144.39',
      },
    ],
  };
}

/**
 * Signal Simulator — generates synthetic IQ data chunks
 */
export class SignalSimulator extends EventEmitter {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Float64Array instead of Map — array index lookup is ~10x faster than Map.get/set
  private phases: Float64Array;
  private sampleCounter = 0;
  private startTime = 0;
  // Pre-allocated chunk buffer — avoids Buffer.alloc (zero-fill) on every interval
  private chunkBuf: Buffer | null = null;

  constructor(private options: SimulatorOptions) {
    super();
    this.phases = new Float64Array(options.signals.length);
  }

  /**
   * Start generating IQ data. Emits 'data' events with Buffer chunks.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();
    this.sampleCounter = 0;

    const chunkSamples = this.options.fftSize * 2;
    const bytesPerChunk = chunkSamples * 2;

    // Pre-allocate chunk buffer once — reused every interval tick
    this.chunkBuf = Buffer.allocUnsafe(bytesPerChunk);

    logger.info(
      {
        centerFreq: this.options.centerFrequency,
        sampleRate: this.options.sampleRate,
        signals: this.options.signals.length,
        chunkSize: bytesPerChunk,
      },
      'Starting signal simulator',
    );

    this.timer = setInterval(() => {
      const chunk = this.generateChunk(chunkSamples);
      this.emit('data', chunk);
    }, this.options.intervalMs);
    this.timer.unref(); // don't keep event loop alive after stop()
  }

  /**
   * Stop the simulator
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Signal simulator stopped');
  }

  /**
   * Generate a chunk of synthetic IQ data
   * Output format: Buffer of unsigned 8-bit interleaved I/Q (same as rtl_sdr)
   */
  private generateChunk(numSamples: number): Buffer {
    const buf = this.chunkBuf ?? Buffer.allocUnsafe(numSamples * 2);
    const elapsed = Date.now() - this.startTime; // computed once per chunk

    // Pre-compute per-signal drift offsets for this chunk (constant across all samples)
    const signals = this.options.signals;
    const numSignals = signals.length;
    const freqOffsets = new Float64Array(numSignals);
    for (let sigIdx = 0; sigIdx < numSignals; sigIdx++) {
      const sig = signals[sigIdx];
      let freqOffset = sig.offsetHz;
      if (sig.drift) {
        freqOffset += Math.sin(elapsed / 1000 * sig.drift.rateHz * 2 * Math.PI / sig.drift.rangeHz)
          * sig.drift.rangeHz;
      }
      freqOffsets[sigIdx] = freqOffset;
    }

    for (let n = 0; n < numSamples; n++) {
      let iSum = 0;
      let qSum = 0;

      for (let sigIdx = 0; sigIdx < numSignals; sigIdx++) {
        const sig = signals[sigIdx];

        if (sig.intermittent) {
          const cycle = sig.intermittent.onMs + sig.intermittent.offMs;
          const pos = elapsed % cycle;
          if (pos >= sig.intermittent.onMs) continue;
        }

        const normalizedFreq = freqOffsets[sigIdx] / this.options.sampleRate;
        let phase = this.phases[sigIdx];

        const { i, q } = this.generateSignalSample(sig, normalizedFreq, phase, elapsed, n);
        iSum += i;
        qSum += q;

        phase += 2 * Math.PI * normalizedFreq;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        if (phase < -2 * Math.PI) phase += 2 * Math.PI;
        this.phases[sigIdx] = phase;
      }

      // Gaussian noise via Box-Muller
      const noiseAmp = this.options.noiseFloor;
      const u1 = Math.random() || 1e-10;
      const u2 = Math.random();
      const noiseMag = Math.sqrt(-2 * Math.log(u1)) * noiseAmp;
      iSum += noiseMag * Math.cos(2 * Math.PI * u2);
      qSum += noiseMag * Math.sin(2 * Math.PI * u2);

      buf[n * 2]     = Math.max(0, Math.min(255, Math.round(iSum * 127.5 + 127.5)));
      buf[n * 2 + 1] = Math.max(0, Math.min(255, Math.round(qSum * 127.5 + 127.5)));

      this.sampleCounter++;
    }

    return buf;
  }

  /**
   * Generate one IQ sample for a specific signal type
   */
  private generateSignalSample(
    sig: SimulatedSignal,
    normalizedFreq: number,
    phase: number,
    elapsedMs: number,
    sampleIdx: number,
  ): { i: number; q: number } {
    const amp = sig.amplitude;
    const t = this.sampleCounter + sampleIdx;

    switch (sig.type) {
      case 'wfm': {
        // FM broadcast: carrier + frequency modulation
        // Simulate with a slowly varying modulation
        const modFreq1 = 1000 / this.options.sampleRate; // 1kHz audio tone
        const modFreq2 = 400 / this.options.sampleRate;  // 400Hz tone
        const deviation = 75000 / this.options.sampleRate; // ±75kHz deviation

        const modulation = 0.7 * Math.sin(2 * Math.PI * modFreq1 * t)
          + 0.3 * Math.sin(2 * Math.PI * modFreq2 * t);

        const fmPhase = phase + deviation * modulation;
        return {
          i: amp * Math.cos(fmPhase),
          q: amp * Math.sin(fmPhase),
        };
      }

      case 'nfm': {
        // Narrowband FM: voice-like modulation
        const modFreq = 800 / this.options.sampleRate;
        const modFreq2 = 1200 / this.options.sampleRate;
        const deviation = 5000 / this.options.sampleRate;

        // Simulate voice-like amplitude variation
        const voiceEnvelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * (3 / this.options.sampleRate) * t);
        const modulation = voiceEnvelope * (
          0.6 * Math.sin(2 * Math.PI * modFreq * t) +
          0.4 * Math.sin(2 * Math.PI * modFreq2 * t)
        );

        const fmPhase = phase + deviation * modulation;
        return {
          i: amp * Math.cos(fmPhase),
          q: amp * Math.sin(fmPhase),
        };
      }

      case 'am': {
        // AM: carrier with amplitude modulation
        const modFreq = 600 / this.options.sampleRate;
        const modDepth = 0.5;
        const envelope = 1 + modDepth * Math.sin(2 * Math.PI * modFreq * t);

        return {
          i: amp * envelope * Math.cos(phase),
          q: amp * envelope * Math.sin(phase),
        };
      }

      case 'cw': {
        // CW: on/off keyed carrier (Morse-like pattern)
        const dotLength = 100; // ms
        const pattern = [1, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0]; // SOS
        const patternIdx = Math.floor((elapsedMs / dotLength) % pattern.length);
        const keyState = pattern[patternIdx];

        if (!keyState) {
          return { i: 0, q: 0 };
        }

        return {
          i: amp * Math.cos(phase),
          q: amp * Math.sin(phase),
        };
      }

      case 'noise-burst': {
        // Burst of wideband noise
        const burstAmp = amp * (0.5 + 0.5 * Math.random());
        return {
          i: burstAmp * (Math.random() * 2 - 1),
          q: burstAmp * (Math.random() * 2 - 1),
        };
      }

      default:
        return { i: 0, q: 0 };
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}

/**
 * Get a preset simulation based on a profile's center frequency
 */
export function getSimulationForProfile(
  centerFreq: number,
  sampleRate: number,
): SimulatorOptions {
  // FM broadcast band (87.5-108 MHz)
  if (centerFreq >= 87_500_000 && centerFreq <= 108_000_000) {
    return createFmBroadcastSimulation(centerFreq, sampleRate);
  }
  // Aviation band (108-137 MHz)
  if (centerFreq >= 108_000_000 && centerFreq <= 137_000_000) {
    return createAviationSimulation(centerFreq, sampleRate);
  }
  // Two-meter amateur (144-148 MHz)
  if (centerFreq >= 144_000_000 && centerFreq <= 148_000_000) {
    return createTwoMeterSimulation(centerFreq, sampleRate);
  }

  // Generic simulation — a few carriers scattered around
  return {
    centerFrequency: centerFreq,
    sampleRate,
    fftSize: 2048,
    noiseFloor: 0.02,
    intervalMs: 33,
    signals: [
      {
        offsetHz: 100_000,
        type: 'nfm',
        amplitude: 0.4,
        bandwidth: 12_500,
        intermittent: { onMs: 5000, offMs: 8000 },
        label: 'Signal A',
      },
      {
        offsetHz: -300_000,
        type: 'am',
        amplitude: 0.3,
        bandwidth: 8_000,
        label: 'Signal B',
      },
      {
        offsetHz: 600_000,
        type: 'nfm',
        amplitude: 0.2,
        bandwidth: 12_500,
        drift: { rateHz: 30, rangeHz: 3000 },
        label: 'Drifting Signal',
      },
      {
        offsetHz: -700_000,
        type: 'cw',
        amplitude: 0.15,
        bandwidth: 500,
        label: 'CW Signal',
      },
    ],
  };
}
