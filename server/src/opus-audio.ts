/**
 * Server-side demodulator + Opus encoder pipeline.
 * 
 * Takes Int16 IQ sub-band from IqExtractor and produces Opus audio packets.
 * Supports mono (NFM/AM/SSB/CW) and stereo (WFM stereo, C-QUAM AM stereo).
 */

import { createRequire } from 'node:module';
import type { DemodMode } from '@node-sdr/shared';
import { logger } from './logger.js';
import { RdsDecoder, type RdsData } from './rds-decoder.js';

const require = createRequire(import.meta.url);

// opusscript WASM encoder — works in both tsx dev mode and production
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let OpusScriptClass: any;
try {
  OpusScriptClass = require('opusscript');
} catch {
  logger.warn('[opusscript] not available — Opus codec disabled');
}

/** Opus frame: 20ms at 48kHz = 960 samples */
export const OPUS_FRAME_SAMPLES = 960;

// ========================================================================
//  DSP Building Blocks (lightweight server-side versions)
// ========================================================================

/**
 * Fast atan2 approximation — replaces Math.atan2 in FM discriminator hot loops.
 * Uses a 3rd-order minimax polynomial for the atan(y/x) core.
 * Max error: ~0.005 rad (~0.3°) — far below what FM demodulation requires.
 * ~4–6× faster than Math.atan2 on V8 (avoids libm transcendental lookup).
 */
function fastAtan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const swapped = ax < ay;
  const a = swapped ? ax / ay : ay / ax;
  const s = a * a;
  // Minimax polynomial for atan(a) on [0, 1]: error < 0.005 rad
  let r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (swapped) r = 1.5707963268 - r;
  if (x < 0) r = 3.1415926536 - r;
  if (y < 0) r = -r;
  return r;
}

/** Single biquad IIR filter section */
class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0;
  private y1 = 0; private y2 = 0;

  setCoeffs(b0: number, b1: number, b2: number, a1: number, a2: number): void {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  static bandpass(freq: number, Q: number, fs: number): Biquad {
    const w0 = 2 * Math.PI * freq / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    const bq = new Biquad();
    bq.setCoeffs(alpha / a0, 0, -alpha / a0, -2 * Math.cos(w0) / a0, (1 - alpha) / a0);
    return bq;
  }
}

/** Simple FIR lowpass (sinc + Blackman-Harris window) */
class SimpleFir {
  // Float32Array instead of Float64Array — halves memory bandwidth on the
  // inner MAC loop (24.5M iterations/sec for WFM) and allows V8 SIMD paths.
  // Float32 gives ~150 dB dynamic range — more than sufficient for audio LPF.
  private taps: Float32Array;
  private buf: Float32Array;
  private pos = 0;
  /** Power-of-2 buffer size for fast bitwise-AND wrap */
  private readonly bufMask: number;

  constructor(numTaps: number, cutoff: number) {
    this.taps = new Float32Array(numTaps);
    // Round buffer size up to next power of 2 — enables bitwise AND in inner loop
    let bufSize = 1;
    while (bufSize < numTaps) bufSize <<= 1;
    this.buf = new Float32Array(bufSize);
    this.bufMask = bufSize - 1;
    this.design(cutoff);
  }

  design(cutoff: number): void {
    const n = this.taps.length;
    const m = (n - 1) / 2;
    let sum = 0;
    // Use double precision for design math, store result as Float32
    for (let i = 0; i < n; i++) {
      const x = i - m;
      const sinc = Math.abs(x) < 1e-12 ? 2 * Math.PI * cutoff : Math.sin(2 * Math.PI * cutoff * x) / x;
      const w = 0.35875 - 0.48829 * Math.cos(2 * Math.PI * i / (n - 1))
              + 0.14128 * Math.cos(4 * Math.PI * i / (n - 1))
              - 0.01168 * Math.cos(6 * Math.PI * i / (n - 1));
      this.taps[i] = sinc * w;
      sum += this.taps[i];
    }
    for (let i = 0; i < n; i++) this.taps[i] /= sum;
  }

  process(x: number): number {
    const buf = this.buf;
    const taps = this.taps;
    const mask = this.bufMask;
    buf[this.pos] = x;
    let acc = 0;
    let idx = this.pos;
    const numTaps = taps.length;
    for (let i = 0; i < numTaps; i++) {
      acc += taps[i] * buf[idx];
      idx = (idx - 1) & mask; // bitwise AND — no branch, no division
    }
    this.pos = (this.pos + 1) & mask;
    return acc;
  }

  reset(): void {
    this.buf.fill(0);
    this.pos = 0;
  }
}

/** 1st-order IIR de-emphasis filter */
class Deemph {
  private alpha: number;
  private prev = 0;

  constructor(tau: number, sampleRate: number) {
    const dt = 1 / sampleRate;
    this.alpha = dt / (tau + dt);
  }

  process(x: number): number {
    this.prev += this.alpha * (x - this.prev);
    return this.prev;
  }

  reset(): void { this.prev = 0; }
}

/** DC blocking filter */
class DcBlock {
  private prev = 0;
  private prevOut = 0;

  process(x: number): number {
    const y = x - this.prev + 0.995 * this.prevOut;
    this.prev = x;
    this.prevOut = y;
    return y;
  }

  reset(): void { this.prev = this.prevOut = 0; }
}

/** Simple AGC */
class SimpleAgc {
  constructor(
    private target = 0.3,
    private attack = 0.01,
    private decay = 0.0001,
    private maxGain = 100,
    private gain = 1,
  ) {}

  process(x: number): number {
    const absVal = Math.abs(x * this.gain);
    if (absVal > this.target) this.gain *= (1 - this.attack);
    else this.gain *= (1 + this.decay);
    this.gain = Math.min(this.maxGain, Math.max(0.001, this.gain));
    return x * this.gain;
  }

  reset(): void { this.gain = 1; }
}

// ========================================================================
//  Demod output types
// ========================================================================

interface MonoResult { left: Float32Array; right?: undefined; stereo: false; rdsData?: undefined }
interface StereoResult { left: Float32Array; right: Float32Array; stereo: boolean; rdsData?: undefined }
interface WfmStereoResult { left: Float32Array; right: Float32Array; stereo: boolean; rdsData: RdsData | null }
type DemodResult = MonoResult | StereoResult | WfmStereoResult;

type ServerDemod = {
  process(iq: Int16Array): DemodResult;
  reset(): void;
  readonly isStereoCapable: boolean;
};

// ========================================================================
//  Mono Demodulators (NFM, AM, SSB, CW)
// ========================================================================

class FmMonoDemod implements ServerDemod {
  readonly isStereoCapable = false;
  private prevI = 0; private prevQ = 0;
  private gain: number;
  private deemph: Deemph;
  private decimFactor: number;
  private decimCounter = 0;
  // Pre-allocated output buffer — reused every process() call
  private outBuf: Float32Array;

  constructor(inputRate: number, isWideband: boolean) {
    const deviation = isWideband ? 75_000 : 5_000;
    this.gain = inputRate / (2 * Math.PI * deviation);
    this.deemph = new Deemph(75e-6, inputRate);
    this.decimFactor = isWideband ? Math.round(inputRate / 48_000) : 1;
    this.outBuf = new Float32Array(Math.ceil(OPUS_FRAME_SAMPLES * 2 * this.decimFactor / this.decimFactor + 16));
  }

  process(iq: Int16Array): MonoResult {
    const pairs = iq.length >> 1;
    const maxOut = Math.ceil(pairs / this.decimFactor);
    if (maxOut > this.outBuf.length) this.outBuf = new Float32Array(maxOut * 2);
    let outIdx = 0;
    const scale = 1 / 32768;
    for (let i = 0; i < pairs; i++) {
      const curI = iq[i * 2] * scale;
      const curQ = iq[i * 2 + 1] * scale;
      const dot = curI * this.prevI + curQ * this.prevQ;
      const cross = curQ * this.prevI - curI * this.prevQ;
      let sample = fastAtan2(cross, dot) * this.gain;
      this.prevI = curI; this.prevQ = curQ;
      sample = this.deemph.process(sample);
      this.decimCounter++;
      if (this.decimCounter >= this.decimFactor) {
        this.decimCounter = 0;
        this.outBuf[outIdx++] = sample;
      }
    }
    return { left: this.outBuf.subarray(0, outIdx), stereo: false as const };
  }

  reset(): void {
    this.prevI = this.prevQ = 0;
    this.deemph.reset();
    this.decimCounter = 0;
  }
}

class AmMonoDemod implements ServerDemod {
  readonly isStereoCapable = false;
  private dc = new DcBlock();
  private agc = new SimpleAgc();
  private outBuf: Float32Array = new Float32Array(OPUS_FRAME_SAMPLES * 2);

  process(iq: Int16Array): MonoResult {
    const pairs = iq.length >> 1;
    if (pairs > this.outBuf.length) this.outBuf = new Float32Array(pairs * 2);
    const scale = 1 / 32768;
    for (let i = 0; i < pairs; i++) {
      const iV = iq[i * 2] * scale;
      const qV = iq[i * 2 + 1] * scale;
      this.outBuf[i] = this.agc.process(this.dc.process(Math.sqrt(iV * iV + qV * qV)));
    }
    return { left: this.outBuf.subarray(0, pairs), stereo: false as const };
  }

  reset(): void { this.dc.reset(); this.agc.reset(); }
}

class SsbMonoDemod implements ServerDemod {
  readonly isStereoCapable = false;
  private dc = new DcBlock();
  private agc = new SimpleAgc(0.3, 0.005, 0.0001, 200);
  private outBuf: Float32Array = new Float32Array(OPUS_FRAME_SAMPLES * 2);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_isLsb: boolean) {}

  process(iq: Int16Array): MonoResult {
    const pairs = iq.length >> 1;
    if (pairs > this.outBuf.length) this.outBuf = new Float32Array(pairs * 2);
    const scale = 1 / 32768;
    for (let i = 0; i < pairs; i++) {
      this.outBuf[i] = this.agc.process(this.dc.process(iq[i * 2] * scale));
    }
    return { left: this.outBuf.subarray(0, pairs), stereo: false as const };
  }

  reset(): void { this.dc.reset(); this.agc.reset(); }
}

class CwMonoDemod implements ServerDemod {
  readonly isStereoCapable = false;
  private bfoPhase = 0;
  private bfoPhaseInc: number;
  private dc = new DcBlock();
  private agc = new SimpleAgc(0.3, 0.01, 0.0005, 300);
  private outBuf: Float32Array = new Float32Array(OPUS_FRAME_SAMPLES * 2);
  // NCO lookup table for BFO (avoids Math.cos/sin per sample)
  private readonly bfoTableSize = 1024;
  private readonly bfoTableMask = 1023;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;
  private readonly bfoTableScale: number;
  private bfoTablePhase = 0;

  constructor(sampleRate: number) {
    this.bfoPhaseInc = 2 * Math.PI * 700 / sampleRate;
    this.bfoTableScale = this.bfoTableSize / (2 * Math.PI);
    this.cosTable = new Float32Array(this.bfoTableSize);
    this.sinTable = new Float32Array(this.bfoTableSize);
    for (let i = 0; i < this.bfoTableSize; i++) {
      const a = (2 * Math.PI * i) / this.bfoTableSize;
      this.cosTable[i] = Math.cos(a);
      this.sinTable[i] = Math.sin(a);
    }
  }

  process(iq: Int16Array): MonoResult {
    const pairs = iq.length >> 1;
    if (pairs > this.outBuf.length) this.outBuf = new Float32Array(pairs * 2);
    const scale = 1 / 32768;
    let phase = this.bfoTablePhase;
    const inc = this.bfoPhaseInc * this.bfoTableScale;
    const mask = this.bfoTableMask;
    const cos = this.cosTable;
    const sin = this.sinTable;
    for (let i = 0; i < pairs; i++) {
      const iV = iq[i * 2] * scale;
      const qV = iq[i * 2 + 1] * scale;
      const idx = (phase | 0) & mask;
      const s = iV * cos[idx] + qV * sin[idx];
      phase += inc;
      if (phase >= this.bfoTableSize) phase -= this.bfoTableSize;
      this.outBuf[i] = this.agc.process(this.dc.process(s));
    }
    this.bfoTablePhase = phase;
    return { left: this.outBuf.subarray(0, pairs), stereo: false as const };
  }

  reset(): void {
    this.dc.reset();
    this.agc.reset();
    this.bfoPhase = 0;
    this.bfoTablePhase = 0;
  }
}

// ========================================================================
//  WFM Stereo Demodulator (PLL + L-R + SNR-proportional blend)
// ========================================================================

class FmStereoDemod implements ServerDemod {
  readonly isStereoCapable = true;

  private prevI = 0; private prevQ = 0;
  private gain: number;
  private decimFactor: number;
  private decimCounterL = 0;

  // Pilot PLL
  private pllPhase = 0;
  private pllPhaseInc: number;
  private pllFreqErr = 0;
  private pllAlpha: number;
  private pllBeta: number;

  // NCO lookup tables for PLL sin/cos — eliminates Math.sin/cos at 240 kHz.
  // 4096 entries, power-of-2 size for bitwise-AND index wrap (no division).
  // Float32 precision is sufficient: ~150 dB, far beyond audio SNR requirements.
  private readonly ncoTableSize = 4096;
  private readonly ncoTableMask = 4095;
  private readonly ncoTableScale: number; // tableSize / (2π)
  private readonly pllCosTable: Float32Array;
  private readonly pllSinTable: Float32Array;

  // Pilot detection
  private pilotBpf: Biquad;
  private pilotEnergy = 0;
  private noiseEnergy = 0;
  private blendFactor = 0;
  private pilotDetected = false;
  private holdCounter = 0;
  private holdSamples: number;
  private readonly energyAlpha = 0.002;

  // Audio filters
  private lprFilter: SimpleFir;  // L+R lowpass 15kHz
  private lrFilter: SimpleFir;   // L-R lowpass 15kHz
  private deemphL: Deemph;
  private deemphR: Deemph;
  private dcL = new DcBlock();
  private dcR = new DcBlock();

  // Pre-allocated stereo output buffers
  private leftOutBuf: Float32Array;
  private rightOutBuf: Float32Array;

  // RDS decoder — taps composite at 240kHz
  private rdsDecoder: RdsDecoder;
  /** Latest decoded RDS data, or null if no group has been parsed yet */
  private latestRdsData: RdsData | null = null;

  constructor(inputRate: number) {
    const deviation = 75_000;
    this.gain = inputRate / (2 * Math.PI * deviation);
    this.decimFactor = Math.round(inputRate / 48_000);

    // PLL at 19kHz
    this.pllPhaseInc = 2 * Math.PI * 19000 / inputRate;
    const BL = 50;
    const damp = 0.707;
    this.pllAlpha = 2 * damp * BL * 2 * Math.PI / inputRate;
    this.pllBeta = (BL * 2 * Math.PI / inputRate) ** 2;

    // Build NCO tables for PLL — both sin and cos needed (pilot ref + 38kHz carrier)
    this.ncoTableScale = this.ncoTableSize / (2 * Math.PI);
    this.pllCosTable = new Float32Array(this.ncoTableSize);
    this.pllSinTable = new Float32Array(this.ncoTableSize);
    for (let i = 0; i < this.ncoTableSize; i++) {
      const a = (2 * Math.PI * i) / this.ncoTableSize;
      this.pllCosTable[i] = Math.cos(a);
      this.pllSinTable[i] = Math.sin(a);
    }

    this.pilotBpf = Biquad.bandpass(19000, 30, inputRate);
    this.holdSamples = Math.round(inputRate * 0.2);

    // 15kHz LPF (51-tap FIR at 240kHz → cutoff at 15/240 = 0.0625)
    this.lprFilter = new SimpleFir(51, 15000 / inputRate);
    this.lrFilter = new SimpleFir(51, 15000 / inputRate);

    this.deemphL = new Deemph(75e-6, inputRate);
    this.deemphR = new Deemph(75e-6, inputRate);

    // Pre-allocate stereo output buffers
    this.leftOutBuf  = new Float32Array(Math.ceil(OPUS_FRAME_SAMPLES * 5 * 2)); // 5× decimation headroom
    this.rightOutBuf = new Float32Array(this.leftOutBuf.length);

    // RDS decoder at the same input rate (240kHz)
    this.rdsDecoder = new RdsDecoder(inputRate);
    this.rdsDecoder.setCallback((data) => {
      this.latestRdsData = { ...data };
    });
  }

  process(iq: Int16Array): WfmStereoResult {
    const pairs = iq.length >> 1;
    const maxOut = Math.ceil(pairs / this.decimFactor);
    // Grow output buffers if needed (larger-than-expected IQ chunk)
    if (maxOut > this.leftOutBuf.length) {
      this.leftOutBuf  = new Float32Array(maxOut * 2);
      this.rightOutBuf = new Float32Array(maxOut * 2);
    }
    const leftOut  = this.leftOutBuf;
    const rightOut = this.rightOutBuf;
    let outIdxL = 0;
    const scale = 1 / 32768;

    // Snapshot and clear pending RDS data so each process() call returns
    // only the groups decoded from this chunk of IQ.
    const rdsDataToReturn = this.latestRdsData;
    this.latestRdsData = null;

    // Hoist NCO table refs into locals — avoids property lookups inside hot loop
    const pllCos = this.pllCosTable;
    const pllSin = this.pllSinTable;
    const tblMask = this.ncoTableMask;
    const tblScale = this.ncoTableScale;
    const TWO_PI = 6.283185307179586;

    for (let k = 0; k < pairs; k++) {
      const curI = iq[k * 2] * scale;
      const curQ = iq[k * 2 + 1] * scale;

      // FM discriminator
      const dot = curI * this.prevI + curQ * this.prevQ;
      const cross = curQ * this.prevI - curI * this.prevQ;
      const composite = fastAtan2(cross, dot) * this.gain;
      this.prevI = curI;
      this.prevQ = curQ;

      // Feed composite to RDS decoder (before any filtering)
      this.rdsDecoder.pushSample(composite);

      // PLL tracks 19kHz pilot — NCO table replaces Math.sin/Math.cos
      const pllIdx = ((this.pllPhase * tblScale + 0.5) | 0) & tblMask;
      const pilotRef = pllSin[pllIdx];
      const phaseError = composite * pilotRef;
      this.pllFreqErr += this.pllBeta * phaseError;
      this.pllPhase += this.pllPhaseInc + this.pllAlpha * phaseError + this.pllFreqErr;
      // Single if instead of while — PLL correction is small, never wraps >1× per sample
      if (this.pllPhase >= TWO_PI) this.pllPhase -= TWO_PI;
      if (this.pllPhase < 0) this.pllPhase += TWO_PI;

      // Pilot detection
      const bpfOut = this.pilotBpf.process(composite);
      this.pilotEnergy = this.pilotEnergy * (1 - this.energyAlpha) + bpfOut * bpfOut * this.energyAlpha;
      this.noiseEnergy = this.noiseEnergy * (1 - this.energyAlpha) + composite * composite * this.energyAlpha;
      const snr = this.noiseEnergy > 1e-12 ? this.pilotEnergy / this.noiseEnergy : 0;

      if (snr > 0.006) { this.pilotDetected = true; this.holdCounter = this.holdSamples; }
      else if (snr < 0.002) {
        if (this.holdCounter > 0) this.holdCounter--;
        else this.pilotDetected = false;
      } else if (this.pilotDetected) {
        this.holdCounter = this.holdSamples;
      }

      const targetBlend = this.pilotDetected ? Math.max(0, Math.min(1, (snr - 0.002) / 0.01)) : 0;
      const blendAlpha = targetBlend > this.blendFactor ? 0.015 : 0.003;
      this.blendFactor += blendAlpha * (targetBlend - this.blendFactor);

      // L+R extraction
      const lpr = this.lprFilter.process(composite);
      // 38kHz carrier: cos(2 × pllPhase) — use double-angle formula to avoid a second table lookup:
      // cos(2θ) = 2cos²(θ) - 1 (need cosIdx, sin is already pllIdx)
      const cosVal = pllCos[pllIdx];
      const carrier38 = 2 * cosVal * cosVal - 1; // cos(2θ) = 2cos²θ − 1
      const lr = this.lrFilter.process(2 * composite * carrier38);

      // Stereo matrix with blend
      const blend = this.blendFactor;
      let left = blend > 0.001 ? lpr + blend * lr : lpr;
      let right = blend > 0.001 ? lpr - blend * lr : lpr;

      // De-emphasis
      left = this.deemphL.process(left);
      right = this.deemphR.process(right);

      // Decimate
      this.decimCounterL++;
      if (this.decimCounterL >= this.decimFactor) {
        this.decimCounterL = 0;
        if (outIdxL < maxOut) {
          leftOut[outIdxL] = this.dcL.process(left);
          rightOut[outIdxL] = this.dcR.process(right);
          outIdxL++;
        }
      }
    }

    const isStereo = this.blendFactor > 0.01;
    const n = outIdxL;

    return {
      left: leftOut.subarray(0, n),
      right: rightOut.subarray(0, n),
      stereo: isStereo,
      rdsData: rdsDataToReturn,
    };
  }

  reset(): void {
    this.prevI = this.prevQ = 0;
    this.pllPhase = this.pllFreqErr = 0;
    this.pilotEnergy = this.noiseEnergy = this.blendFactor = 0;
    this.pilotDetected = false;
    this.holdCounter = 0;
    this.decimCounterL = 0;
    this.lprFilter.reset(); this.lrFilter.reset();
    this.deemphL.reset(); this.deemphR.reset();
    this.dcL.reset(); this.dcR.reset();
    this.pilotBpf.reset();
    this.rdsDecoder.reset();
    this.latestRdsData = null;
  }
}

// ========================================================================
//  C-QUAM AM Stereo Demodulator
// ========================================================================

class CQuamStereoDemod implements ServerDemod {
  readonly isStereoCapable = true;

  // PLL
  private omega2 = 0;
  private cosGamma = 1.0;
  private vcoRe = 1.0; private vcoIm = 0.0;
  private alpha = 0; private beta = 0;

  // Goertzel 25Hz
  private gCoeff = 0;
  private gS1 = 0; private gS2 = 0;
  private gBlockSize = 0; private gSampleCount = 0;
  private pilotMag = 0; private lockLevel = 0;

  // Notch filter
  private nb0 = 0; private nb1 = 0; private nb2 = 0;
  private na1 = 0; private na2 = 0;
  private w1L = 0; private w2L = 0; private w1R = 0; private w2R = 0;

  // Audio
  private dcL = new DcBlock();
  private dcR = new DcBlock();
  private agcL = new SimpleAgc(0.3, 0.01, 0.0001, 100);
  private agcR = new SimpleAgc(0.3, 0.01, 0.0001, 100);
  private lpL: SimpleFir;
  private lpR: SimpleFir;

  // Pre-allocated stereo output buffers (same pattern as FmStereoDemod)
  private leftOutBuf: Float32Array;
  private rightOutBuf: Float32Array;

  private inputRate: number;

  constructor(inputRate = 48000) {
    this.inputRate = inputRate;
    this.lpL = new SimpleFir(31, 5000 / inputRate);
    this.lpR = new SimpleFir(31, 5000 / inputRate);
    // Pre-allocate with 2× headroom over expected Opus frame size
    this.leftOutBuf  = new Float32Array(OPUS_FRAME_SAMPLES * 2);
    this.rightOutBuf = new Float32Array(OPUS_FRAME_SAMPLES * 2);
    this.computePll();
    this.computeGoertzel();
    this.designNotch(9000, 50);
  }

  private computePll(): void {
    const T = 1 / this.inputRate;
    const zeta = 0.707, omegaN = 100;
    const denom = 1 + 2 * zeta * omegaN * T + (omegaN * T) ** 2;
    this.alpha = (2 * zeta * omegaN * T) / denom;
    this.beta = ((omegaN * T) ** 2) / denom;
  }

  private computeGoertzel(): void {
    this.gCoeff = 2 * Math.cos(2 * Math.PI * 25 / this.inputRate);
    this.gBlockSize = Math.round(this.inputRate * 0.05);
  }

  private designNotch(freq: number, Q: number): void {
    const w0 = 2 * Math.PI * freq / this.inputRate;
    const alphaN = Math.sin(w0) / (2 * Q);
    const cosW0 = Math.cos(w0);
    const a0 = 1 + alphaN;
    this.nb0 = 1 / a0; this.nb1 = -2 * cosW0 / a0; this.nb2 = 1 / a0;
    this.na1 = -2 * cosW0 / a0; this.na2 = (1 - alphaN) / a0;
  }

  process(iq: Int16Array): DemodResult {
    const n = iq.length >> 1;
    // Grow output buffers if needed (larger-than-expected IQ chunk)
    if (n > this.leftOutBuf.length) {
      this.leftOutBuf  = new Float32Array(n * 2);
      this.rightOutBuf = new Float32Array(n * 2);
    }
    const left  = this.leftOutBuf;
    const right = this.rightOutBuf;
    let { omega2, cosGamma, vcoRe, vcoIm, gS1, gS2, gSampleCount, lockLevel } = this;
    let { w1L, w2L, w1R, w2R } = this;
    const { alpha, beta, gCoeff, nb0, nb1, nb2, na1, na2, gBlockSize } = this;
    const scale = 1 / 32768;

    for (let i = 0; i < n; i++) {
      const inI = iq[i * 2] * scale;
      const inQ = iq[i * 2 + 1] * scale;

      const I = inI * vcoRe + inQ * vcoIm;
      const Q = -inI * vcoIm + inQ * vcoRe;
      const absI = Math.abs(I), absQ = Math.abs(Q);
      const env = (absI > absQ ? absI + 0.4 * absQ : absQ + 0.4 * absI) + 1e-9;

      const det = Q / env;
      omega2 += beta * det;
      cosGamma += 0.005 * (I / env - cosGamma);

      const dPhz = alpha * det + omega2;
      const cd = Math.cos(dPhz), sd = Math.sin(dPhz);
      const nRe = vcoRe * cd + vcoIm * sd;
      const nIm = -vcoRe * sd + vcoIm * cd;
      vcoRe = nRe; vcoIm = nIm;
      if ((i & 511) === 0) {
        const mag = Math.sqrt(vcoRe * vcoRe + vcoIm * vcoIm);
        vcoRe /= mag; vcoIm /= mag;
      }

      const absCG = Math.abs(cosGamma) > 1e-9 ? Math.abs(cosGamma) : 1e-9;
      const sign = cosGamma >= 0 ? 1 : -1;
      const LpR = env * absCG - 1.0;
      const LmR = (Q * sign) / absCG;
      let rawL = 0.5 * (LpR + LmR);
      let rawR = 0.5 * (LpR - LmR);

      // Goertzel
      const s0 = LmR + gCoeff * gS1 - gS2;
      gS2 = gS1; gS1 = s0;
      gSampleCount++;
      if (gSampleCount >= gBlockSize) {
        const power = gS1 * gS1 + gS2 * gS2 - gS1 * gS2 * gCoeff;
        this.pilotMag = 0.9 * this.pilotMag + 0.1 * (Math.sqrt(Math.max(0, power)) / gSampleCount);
        gS1 = gS2 = 0; gSampleCount = 0;
      }
      lockLevel += 0.001 * (Math.abs(I / env) - lockLevel);

      // Notch L
      const wn0l = rawL - na1 * w1L - na2 * w2L;
      rawL = nb0 * wn0l + nb1 * w1L + nb2 * w2L;
      w2L = w1L; w1L = wn0l;
      // Notch R
      const wn0r = rawR - na1 * w1R - na2 * w2R;
      rawR = nb0 * wn0r + nb1 * w1R + nb2 * w2R;
      w2R = w1R; w1R = wn0r;

      left[i] = this.agcL.process(this.dcL.process(this.lpL.process(rawL)));
      right[i] = this.agcR.process(this.dcR.process(this.lpR.process(rawR)));
    }

    this.omega2 = omega2; this.cosGamma = cosGamma;
    this.vcoRe = vcoRe; this.vcoIm = vcoIm;
    this.gS1 = gS1; this.gS2 = gS2; this.gSampleCount = gSampleCount;
    this.w1L = w1L; this.w2L = w2L; this.w1R = w1R; this.w2R = w2R;
    this.lockLevel = lockLevel;

    const isStereo = lockLevel > 0.8 && this.pilotMag > 0.001;
    return { left: left.subarray(0, n), right: right.subarray(0, n), stereo: isStereo };
  }

  reset(): void {
    this.omega2 = 0; this.cosGamma = 1; this.vcoRe = 1; this.vcoIm = 0;
    this.gS1 = this.gS2 = this.gSampleCount = 0;
    this.pilotMag = this.lockLevel = 0;
    this.w1L = this.w2L = this.w1R = this.w2R = 0;
    this.dcL.reset(); this.dcR.reset();
    this.agcL.reset(); this.agcR.reset();
    this.lpL.reset(); this.lpR.reset();
  }
}

// ========================================================================
//  Demod factory
// ========================================================================

function createDemod(mode: DemodMode, inputRate: number): ServerDemod {
  switch (mode) {
    case 'wfm': return new FmStereoDemod(inputRate);
    case 'nfm': return new FmMonoDemod(inputRate, false);
    case 'am': return new AmMonoDemod();
    case 'am-stereo': return new CQuamStereoDemod(inputRate);
    case 'sam': return new AmMonoDemod(); // SAM uses client-side PLL; server falls back to envelope AM
    case 'usb': return new SsbMonoDemod(false);
    case 'lsb': return new SsbMonoDemod(true);
    case 'cw': return new CwMonoDemod(inputRate);
    default: return new AmMonoDemod();
  }
}

// ========================================================================
//  Opus Audio Pipeline (mono + stereo)
// ========================================================================

/**
 * Server-side audio pipeline: IQ → demod (mono or stereo) → resample → Opus encode.
 * Automatically switches between 1-channel and 2-channel Opus.
 */
export class OpusAudioPipeline {
  private demod: ServerDemod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private encoder: any = null;
  private channels = 1;
  private pcmBuffer: Int16Array;
  private pcmBufferPos = 0;
  private mode: DemodMode;
  private inputRate: number;
  private needsResample: boolean;
  private resampleRatio: number;
  private resampleAccumL = 0;
  private resampleAccumR = 0;
  private lastSampleL = 0;
  private lastSampleR = 0;

  /** Whether the last frame was stereo (so the client knows) */
  private _isStereo = false;

  /** Force mono output even when stereo is detected (user preference) */
  private _forceMono = false;

  /** Target bitrate for mono (stereo = 2x). Default: 32kbps mono / 64kbps stereo. HQ: 128kbps mono / 192kbps stereo. */
  private monoBitrate: number;
  private stereoBitrate: number;

  // Stereo/mono encoder switch hysteresis — only recreate encoder after
  // stereo state is stable for STEREO_HOLD_FRAMES consecutive frames.
  // Prevents encoder thrash when blend factor hovers near the 0.01 threshold.
  private stereoHoldCounter = 0;
  private static readonly STEREO_HOLD_FRAMES = 10;
  private pendingChannels: number | null = null; // channel count waiting for hold to expire

  // Pre-allocated Buffer view over pcmBuffer — avoids Buffer.from() every Opus frame
  private pcmBufferView: Buffer | null = null;

  // Pre-allocated resample output buffers
  private resampleBufL: Float32Array = new Float32Array(OPUS_FRAME_SAMPLES * 8);
  private resampleBufR: Float32Array = new Float32Array(OPUS_FRAME_SAMPLES * 8);

  constructor(mode: DemodMode, inputRate: number, hq = false) {
    this.mode = mode;
    this.inputRate = inputRate;
    this.demod = createDemod(mode, inputRate);

    // Bitrate profiles: standard (32k/64k) vs HQ (128k/192k)
    this.monoBitrate = hq ? 128_000 : 32_000;
    this.stereoBitrate = hq ? 192_000 : 64_000;

    // Determine channel count
    this.channels = this.demod.isStereoCapable ? 2 : 1;

    // After WFM demod with decimation, output is 48kHz.
    // For AM/AM-stereo at 48kHz, no resample needed.
    // SSB=24kHz, CW=12kHz — need resampling.
    const demodOutputRate = mode === 'wfm' ? 48_000 : inputRate;
    this.needsResample = demodOutputRate !== 48_000;
    this.resampleRatio = this.needsResample ? 48_000 / demodOutputRate : 1;

    // PCM buffer: interleaved L,R for stereo; mono for 1ch
    this.pcmBuffer = new Int16Array(OPUS_FRAME_SAMPLES * this.channels);

    this.createEncoder();
  }

  private createEncoder(): void {
    if (this.encoder) {
      try { this.encoder.delete(); } catch { /* ignore */ }
    }
    if (OpusScriptClass) {
      this.encoder = new OpusScriptClass(48_000, this.channels, OpusScriptClass.Application.AUDIO);
      this.encoder.setBitrate(this.channels === 2 ? this.stereoBitrate : this.monoBitrate);
    }
    // Rebuild the Buffer view over the new pcmBuffer
    this.pcmBufferView = Buffer.from(this.pcmBuffer.buffer, this.pcmBuffer.byteOffset, this.pcmBuffer.byteLength);
  }

  static isAvailable(): boolean {
    return !!OpusScriptClass;
  }

  /** Whether the most recently encoded audio was stereo */
  get isStereo(): boolean {
    return this._isStereo;
  }

  /**
   * Process IQ sub-band data → zero or more Opus packets.
   * When mode is WFM and the demod has decoded RDS groups, the last parsed
   * RDS snapshot is included in every returned packet for that call.
   */
  process(iqSubBand: Int16Array): Array<{ packet: Uint8Array; samples: number; stereo: boolean; rdsData: RdsData | null }> {
    if (!this.encoder) return [];

    const result = this.demod.process(iqSubBand);
    const leftAudio = result.left;
    if (leftAudio.length === 0) return [];

    // Extract RDS data from WFM demod result (null for all other modes)
    const rdsData: RdsData | null = (result as any).rdsData ?? null;

    const isStereo = !this._forceMono && result.stereo && result.right !== undefined;
    const rightAudio = isStereo ? result.right! : undefined;

    // Stereo/mono encoder switch with hysteresis.
    // Only recreate the encoder after the stereo state has been stable for
    // STEREO_HOLD_FRAMES frames — prevents thrash near the blend threshold.
    const needChannels = isStereo ? 2 : 1;
    if (needChannels !== this.channels) {
      if (this.pendingChannels !== needChannels) {
        this.pendingChannels = needChannels;
        this.stereoHoldCounter = 0;
      } else {
        this.stereoHoldCounter++;
        if (this.stereoHoldCounter >= OpusAudioPipeline.STEREO_HOLD_FRAMES) {
          this.channels = needChannels;
          this.pcmBuffer = new Int16Array(OPUS_FRAME_SAMPLES * this.channels);
          this.pcmBufferPos = 0;
          this.createEncoder();
          this.pendingChannels = null;
          this.stereoHoldCounter = 0;
        }
      }
    } else {
      // State matches — clear any pending transition
      this.pendingChannels = null;
      this.stereoHoldCounter = 0;
    }
    this._isStereo = isStereo;

    // Snapshot channels NOW — after the switch logic above has settled.
    // The accumulation loop below must use a stable channel count for the
    // entire duration of this call; reading this.channels mid-loop after a
    // switch would corrupt pcmBufferPos and produce malformed Opus frames.
    const channels = this.channels;

    // Resample if needed
    const resampledL = this.needsResample ? this.resampleCh(leftAudio, true) : leftAudio;
    const resampledR = isStereo && rightAudio
      ? (this.needsResample ? this.resampleCh(rightAudio, false) : rightAudio)
      : undefined;

    // Accumulate and encode
    const packets: Array<{ packet: Uint8Array; samples: number; stereo: boolean; rdsData: RdsData | null }> = [];
    const samplesPerFrame = OPUS_FRAME_SAMPLES * channels;
    let offset = 0;

    while (offset < resampledL.length) {
      const needed = samplesPerFrame - this.pcmBufferPos;
      const available = (resampledL.length - offset) * channels;
      const framesToCopy = Math.min(needed / channels, resampledL.length - offset);

      for (let i = 0; i < framesToCopy; i++) {
        const cL = Math.max(-1, Math.min(1, resampledL[offset + i]));
        if (channels === 2) {
          const cR = resampledR ? Math.max(-1, Math.min(1, resampledR[offset + i])) : cL;
          this.pcmBuffer[this.pcmBufferPos++] = Math.round(cL * 32767);
          this.pcmBuffer[this.pcmBufferPos++] = Math.round(cR * 32767);
        } else {
          this.pcmBuffer[this.pcmBufferPos++] = Math.round(cL * 32767);
        }
      }
      offset += framesToCopy;

      if (this.pcmBufferPos >= samplesPerFrame) {
        try {
          const buf = this.pcmBufferView!;
          const encoded: Buffer = this.encoder.encode(buf, OPUS_FRAME_SAMPLES);
          packets.push({
            packet: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
            samples: OPUS_FRAME_SAMPLES,
            stereo: isStereo,
            rdsData: packets.length === 0 ? rdsData : null,
          });
        } catch (err) {
          logger.error({ err }, 'Opus encode failed');
        }
        this.pcmBufferPos = 0;
      }
    }

    return packets;
  }

  private resampleCh(input: Float32Array, isLeft: boolean): Float32Array {
    const outLen = Math.ceil(input.length * this.resampleRatio);
    const buf = isLeft ? this.resampleBufL : this.resampleBufR;
    if (outLen > buf.length) {
      if (isLeft) this.resampleBufL = new Float32Array(outLen * 2);
      else        this.resampleBufR = new Float32Array(outLen * 2);
    }
    const out = isLeft ? this.resampleBufL : this.resampleBufR;
    let outIdx = 0;
    let accum = isLeft ? this.resampleAccumL : this.resampleAccumR;
    let last = isLeft ? this.lastSampleL : this.lastSampleR;

    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      while (accum < 1 && outIdx < outLen) {
        out[outIdx++] = last + accum * (sample - last);
        accum += 1 / this.resampleRatio;
      }
      accum -= 1;
      last = sample;
    }

    if (isLeft) { this.resampleAccumL = accum; this.lastSampleL = last; }
    else { this.resampleAccumR = accum; this.lastSampleR = last; }
    return out.subarray(0, outIdx);
  }

  setMode(mode: DemodMode, inputRate: number): void {
    this.mode = mode;
    this.inputRate = inputRate;
    this.demod = createDemod(mode, inputRate);

    const newChannels = this.demod.isStereoCapable ? 2 : 1;
    if (newChannels !== this.channels) {
      this.channels = newChannels;
      this.pcmBuffer = new Int16Array(OPUS_FRAME_SAMPLES * this.channels);
      this.createEncoder();
    }

    const demodOutputRate = mode === 'wfm' ? 48_000 : inputRate;
    this.needsResample = demodOutputRate !== 48_000;
    this.resampleRatio = this.needsResample ? 48_000 / demodOutputRate : 1;
    this.pcmBufferPos = 0;
    this.resampleAccumL = this.resampleAccumR = 0;
    this.lastSampleL = this.lastSampleR = 0;
  }

  /** Enable/disable stereo output (user preference). When disabled, forces mono even on stereo-capable modes. */
  setStereoEnabled(enabled: boolean): void {
    const wasForceMono = this._forceMono;
    this._forceMono = !enabled;
    // If transitioning from stereo to forced-mono, reset encoder to 1ch
    if (!wasForceMono && this._forceMono && this.channels === 2) {
      this.channels = 1;
      this.pcmBuffer = new Int16Array(OPUS_FRAME_SAMPLES);
      this.pcmBufferPos = 0;
      this.createEncoder();
    }
    // If transitioning from forced-mono to enabled, let process() handle the channel switch
  }

  get stereoEnabled(): boolean {
    return !this._forceMono;
  }

  reset(): void {
    this.demod.reset();
    this.pcmBufferPos = 0;
    this.resampleAccumL = this.resampleAccumR = 0;
    this.lastSampleL = this.lastSampleR = 0;
  }

  destroy(): void {
    if (this.encoder) {
      try { this.encoder.delete(); } catch { /* ignore */ }
      this.encoder = null;
    }
  }
}
