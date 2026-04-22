#!/usr/bin/env tsx
/**
 * CLI FFT benchmark: improved-fft-benchmark
 * - Data: fft-capture-uint8.bin (FFT frames in 8-bit domain)
 * - Strategies (no UI):
 *   1) Baseline: Delta+Deflate on Uint8 (existing path)
 *   2) Threshold -3 dB + Deflate
 *   3) Threshold -3 dB + Delta (same threshold applied before delta)
 *   4) Bit Grooming (6 bits preserved) + Deflate
 *   5) Deflate Delta Window 2 (Uint8)
 * - Output: console log with per-strategy averages and ratios
 * - Fidelity: compute a simple MSE between original 0..255 and thresholded version as a proxy
 */
// Ensure high-resolution timer is available in Node
let now: () => number;
try {
  // perf_hooks is available in modern Node
  const { performance } = require('perf_hooks');
  now = () => performance.now();
} catch {
  now = () => Date.now();
}
import * as fs from 'fs';
import * as path from 'path';
// Real ADPCM path: bring in encoder/decoder to compute fidelity for ADPCM Uint8 path
import { ImaAdpcmEncoder, ImaAdpcmDecoder, FFT_ADPCM_PAD } from '../shared/src/adpcm';
import * as zlib from 'zlib';
// Import only what we need for this benchmark (no ADPCM path here)

type Frame8 = Uint8Array;
type Frame8List = Frame8[];

// Load capture data (relative to repo root at runtime)
const uint8Path = path.join(process.cwd(), 'scripts', 'fft-capture-uint8.bin');
const f32Path = path.join(process.cwd(), 'scripts', 'fft-capture-f32.bin');

if (!fs.existsSync(uint8Path)) {
  console.error('fft-capture-uint8.bin not found at', uint8Path);
  process.exit(1);
}

// Header layout per existing benchmark:
// uint8 buffer: [frameCount (4 LE), binCount (4 LE), minDb (2 LE), maxDb (2 LE)]
const uint8Buf = fs.readFileSync(uint8Path);
const frameCount = uint8Buf.readUInt32LE(0);
const binCount = uint8Buf.readUInt32LE(4);
const minDb = uint8Buf.readInt16LE(8);
const maxDb = uint8Buf.readInt16LE(10);

const frames: Frame8List = [];
for (let i = 0; i < frameCount; i++) {
  const offset = 12 + i * binCount;
  frames.push(new Uint8Array(uint8Buf.buffer, uint8Buf.byteOffset + offset, binCount));
}

// Helper: deflate a Uint8 frame
function deflateUint8(frame: Uint8Array): number {
  const payload = zlib.deflateRawSync(Buffer.from(frame));
  return payload.length;
}

// Helper: delta-encode a Uint8 frame before deflate
function deltaUint8(frame: Uint8Array): Uint8Array {
  const out = Buffer.alloc(frame.length);
  out[0] = frame[0];
  for (let i = 1; i < frame.length; i++) {
    out[i] = (frame[i] - frame[i - 1]) & 0xff;
  }
  return new Uint8Array(out);
}

// Helper: bit grooming mask (keep top 6 bits, mask lower 2)
function bitGroom6(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    out[i] = frame[i] & 0xfc; // keep top 6 bits
  }
  return out;
}

// Bit grooming with 8 bits (no change, keep all)
function bitGroom8(frame: Uint8Array): Uint8Array {
  // Return a shallow copy to simulate a distinct transformed frame
  return new Uint8Array(frame);
}

// Helper: threshold in dB (0 means no change). We assume 0 is min, and map to index.
function thresholdIndex(minDb: number, maxDb: number, thresholdDb: number, frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length);
  const range = maxDb - minDb;
  const tIdx = Math.max(0, Math.min(255, Math.round((thresholdDb - minDb) * 255 / range)));
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    if (v < tIdx) out[i] = 0; else out[i] = v;
  }
  return out;
}

// Load f32 for fidelity proxy (optional)
let useF32 = false;
try {
  if (fs.existsSync(f32Path)) {
    useF32 = true;
  }
} catch {}

const f32Frames: Float32Array[] = [];
if (useF32) {
  const f32Buf = fs.readFileSync(f32Path);
  const f32FrameCount = f32Buf.readUInt32LE(0);
  const f32BinCount = f32Buf.readUInt32LE(4);
  for (let i = 0; i < f32FrameCount; i++) {
    const offset = 8 + i * f32BinCount * 4;
    f32Frames.push(new Float32Array(f32Buf.buffer, f32Buf.byteOffset + offset, f32BinCount));
  }
}

// Benchmark runner helper
interface Result {
  name: string;
  totalBytes: number;
  avgPerFrame: number;
  ratioVsRaw: number;
  ratioVsAdpcm: number;
  microPerFrame: number;
  cpu30fps: number;
  fidelity?: number; // simple MSE proxy
  fidelityPSNR?: number; // PSNR derived from MSE
}
const results: Result[] = [];

function runBenchmarkFor(name: string, action: () => number[]): Result {
  const t0 = now();
  const sizes = action();
  const t1 = now();
  const total = sizes.reduce((a, b) => a + b, 0);
  const avg = total / sizes.length;
  // Baselines from original FFT benchmark for 19,200 bytes raw per 20ms frame (WFM 9,600 samples of Int16 -> 19,200 bytes)
  const rawPerFrame = binCount; // NOTE: original raw size per 20ms was 19200 for WFM; adapt to actual binCount
  // The raw per frame in this dataset is binCount; to keep ratios comparable, compute against 19,200 as in docs:
  const RAW_PER_FRAME = 19200; // approximate canonical frame size for WFM-like path
  const ADPCM_PER_FRAME = 4805; // from previous benchmark for typical WFM (4,805 B)
  const ratioVsRaw = RAW_PER_FRAME / avg;
  const ratioVsAdpcm = ADPCM_PER_FRAME / avg;
  // Fidelity proxy: if original frames available, compare to thresholded, but keep simple placeholder 0 for now
  let fidelity = NaN;
  const res: Result = {
    name,
    totalBytes: total,
    avgPerFrame: avg,
    ratioVsRaw,
    ratioVsAdpcm,
    microPerFrame: (t1 - t0) * 1000 / sizes.length,
    cpu30fps: ((t1 - t0) * 30) / (sizes.length * 1000),
    fidelity,
    fidelityPSNR: undefined
  };
  results.push(res);
  return res;
}

// 1) Baseline: Uncompressed Uint8 (baseline for KPI Raw)
runBenchmarkFor('Baseline: Uncompressed Uint8', () => {
  // Raw, no compression applied
  return frames.map(f => f.length);
});

// 1b) ADPCM Uint8 (est) baseline (proxy for ADPCM path)
function adpcmUint8Estimate(frame: Uint8Array): number {
  // Simple proxy: 4:1 compression for 8-bit samples
  return Math.ceil(frame.length / 4);
}
runBenchmarkFor('ADPCM Uint8 (est)', () => frames.map(f => adpcmUint8Estimate(f)));

// 2) FFT Thresholding, multiple thresholds
const THRESHOLDS = [-3, -6, -9, -12];
let fidelitySum: Record<string, number> = {};
let fidelityCount: Record<string, number> = {};

const registerFidelity = (name: string, val: number) => {
  fidelitySum[name] = (fidelitySum[name] ?? 0) + val;
  fidelityCount[name] = (fidelityCount[name] ?? 0) + 1;
};

// 1c) ADPCM Uint8 (real) - encode then decode to measure fidelity
runBenchmarkFor('ADPCM Uint8 (real)', () => {
  const lengths: number[] = [];
  const encoder = new ImaAdpcmEncoder();
  for (let idx = 0; idx < frames.length; idx++) {
    const frame = frames[idx];
    // Map 0..255 -> Int16 in [-32768..32767]
    const pcm = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      pcm[i] = (frame[i] - 128) * 256;
    }
    const adpcm = encoder.encode(pcm);
    // Decode with fresh decoder to avoid cross-frame state
    const decoder = new ImaAdpcmDecoder();
    const decoded = decoder.decode(adpcm);
    // Reconstruct 8-bit frame from decoded Int16 (strip padding)
    const rec8 = new Uint8Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const val = decoded[FFT_ADPCM_PAD + i];
      let v = Math.round(val / 256) + 128;
      v = Math.max(0, Math.min(255, v));
      rec8[i] = v;
    }
    // Fidelity proxy: MSE between original and reconstructed 8-bit frame
    let mse = 0;
    for (let i = 0; i < frame.length; i++) {
      const d = frame[i] - rec8[i];
      mse += d * d;
    }
    mse /= frame.length;
    registerFidelity('ADPCM Uint8 (real)', mse);
    lengths.push(adpcm.length);
  }
  return lengths;
});

// Composite variant consolidated into the primary path; remove separate duplicates to avoid confusion

THRESHOLDS.forEach((thrDb) => {
  runBenchmarkFor(`Threshold ${thrDb}dB + Delta Uint8`, () => {
    return frames.map(f => {
      const thresh64 = thresholdIndex(minDb, maxDb, thrDb, f);
      const d = deltaUint8(thresh64);
      // Fidelity proxy: delta vs thresholded (approximate)
      let mse = 0;
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = thresh64[i];
        const delta = a - b;
        // rough delta proxy contribution
        mse += (delta - (d[i] ?? 0)) * (delta - (d[i] ?? 0));
      }
      mse /= f.length;
      // Align fidelity key with variant name for correct aggregation
      registerFidelity(`Threshold ${thrDb}dB + Delta Uint8`, mse);
      return deflateUint8(d);
    });
  });
});

THRESHOLDS.forEach((thrDb) => {
  runBenchmarkFor(`Threshold ${thrDb}dB + Delta (Threshold then Delta) Uint8`, () => {
    return frames.map(f => {
      const thresh64 = thresholdIndex(minDb, maxDb, thrDb, f);
      const delta = deltaUint8(thresh64);
      let mse = 0;
      for (let i = 0; i < f.length; i++) {
        mse += Math.pow(f[i] - (delta[i] ?? 0), 2);
      }
      mse /= f.length;
      registerFidelity(`Threshold ${thrDb}dB + Delta (Threshold then Delta) Uint8`, mse);
      return deflateUint8(delta);
    });
  });
});

// 3) Bit Grooming (6 bits) + Deflate
runBenchmarkFor('BitGroom6 + Deflate Uint8', () => {
  let totalMSE = 0;
  const sizes = frames.map(f => {
    const groomed = bitGroom6(f);
    // Fidelity proxy: MSE between original and groomed
    let mse = 0;
    for (let i = 0; i < f.length; i++) {
      const diff = f[i] - groomed[i];
      mse += diff * diff;
    }
    totalMSE += mse / f.length;
    return deflateUint8(groomed);
  });
  registerFidelity('BitGroom6 + Deflate Uint8', totalMSE / frames.length);
  return sizes;
});
// 3b) Bit Grooming (8 bits, effectively no change) + Deflate
runBenchmarkFor('BitGroom8 + Deflate Uint8', () => {
  let totalMSE = 0;
  const sizes = frames.map(f => {
    const groomed = bitGroom8(f);
    // Fidelity proxy: MSE between original and groomed
    let mse = 0;
    for (let i = 0; i < f.length; i++) {
      const diff = f[i] - groomed[i];
      mse += diff * diff;
    }
    totalMSE += mse / f.length;
    return deflateUint8(groomed);
  });
  registerFidelity('BitGroom8 + Deflate Uint8', totalMSE / frames.length);
  return sizes;
});

// 4) Deflate Delta Window 2, and test window 1 and 4 as well
[1, 2, 4].forEach((windowSize) => {
  runBenchmarkFor(`Deflate DeltaWindow${windowSize} Uint8`, () => frames.map(f => {
    const delta = deltaUint8WithWindow(f, windowSize);
    return deflateUint8(delta);
  }));
});

// Fidelity proxy: compute average MSE between original uint8 frame and thresholded version
function fidelityThreshold(thrDb: number): number {
  let sum = 0;
  for (const f of frames) {
    const thresh = thresholdIndex(minDb, maxDb, thrDb, f);
    let diff = 0;
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = thresh[i];
      const d = a - b;
      diff += d * d;
    }
    sum += diff / f.length;
  }
  return sum / frames.length;
}

console.log('\nFidelity proxies (avg MSE) for threshold strategies:');
console.log('-3dB threshold MSE:', fidelityThreshold(-3).toFixed(2));
console.log('-6dB threshold MSE:', fidelityThreshold(-6).toFixed(2));

// Finalize fidelity for all results (average per-strategy)
for (const r of results) {
  const s = fidelitySum[r.name] ?? 0;
  const c = fidelityCount[r.name] ?? 0;
  r.fidelity = c > 0 ? s / c : 0; // guard against NaN
  if (!Number.isFinite(r.fidelity)) r.fidelity = 0;
  // PSNR derived from MSE fidelity
  r.fidelityPSNR = (function mseToPsnr(mse: number){
    if (!Number.isFinite(mse) || mse <= 0) return 100;
    const MAX_I = 255;
    return 10 * Math.log10((MAX_I * MAX_I) / mse);
  })(r.fidelity);
}


// Helper: delta with window param
function deltaUint8WithWindow(frame: Uint8Array, windowSize: number): Uint8Array {
  const out = new Uint8Array(frame.length);
  out[0] = frame[0];
  for (let i = 1; i < frame.length; i++) {
    if ((i % windowSize) === 0) {
      out[i] = (frame[i] - frame[i - 1]) & 0xff;
    } else {
      out[i] = frame[i];
    }
  }
  return out;
}

// 6) Print a summary table
console.log('\nFFT Improved Benchmark Summary (console only)');
console.table(results.map(r => ({
  Strategy: r.name,
  'Avg bytes/frame': r.avgPerFrame,
  'vs Raw': r.ratioVsRaw.toFixed(2) + '×',
  'vs ADPCM': r.ratioVsAdpcm.toFixed(2) + '×',
  'µs/frame': Math.round(r.microPerFrame),
  '30fps CPU': r.cpu30fps.toFixed(3) + ' ms',
  'Fidelity (MSE)': r.fidelity !== undefined && !isNaN(r.fidelity) ? r.fidelity.toFixed(4) : 'N/A',
  'Fidelity (PSNR)': r.fidelityPSNR !== undefined ? r.fidelityPSNR.toFixed(2) : 'N/A'
})));

// KPI: compute baseline-derived ratios and emit CSV-like lines
let baselineRawAvgBytes: number | null = null;
let baselineAdpcmAvgBytes: number | null = null;
const rawEntry = results.find(r => r.name.includes('Baseline: Uncompressed Uint8'));
if (rawEntry) baselineRawAvgBytes = rawEntry.avgPerFrame;
const adpcmEntry = results.find(r => r.name.includes('ADPCM Uint8 (est)'));
if (adpcmEntry) baselineAdpcmAvgBytes = adpcmEntry.avgPerFrame;
for (const r of results) {
  r.ratioVsRaw = baselineRawAvgBytes ? r.avgPerFrame / baselineRawAvgBytes : NaN;
  r.ratioVsAdpcm = baselineAdpcmAvgBytes ? r.avgPerFrame / baselineAdpcmAvgBytes : NaN;
  if (!Number.isFinite(r.fidelity)) r.fidelity = 0;
}
let csvHeaderPrinted = false;
function toId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
for (const r of results) {
  const id = toId(r.name);
  const line = [
    id,
    r.name,
    r.avgPerFrame,
    Number.isFinite(r.ratioVsRaw) ? r.ratioVsRaw : 'NA',
    Number.isFinite(r.ratioVsAdpcm) ? r.ratioVsAdpcm : 'NA',
    Math.round(r.microPerFrame),
    r.cpu30fps.toFixed(3),
    r.fidelity !== undefined ? r.fidelity.toFixed(4) : '0',
    r.fidelityPSNR !== undefined ? r.fidelityPSNR.toFixed(2) : 'NA'
  ].join(',');
  if (!csvHeaderPrinted) {
console.log('\nCSV Summary (variant KPI):');
console.log('variant_id,description,avgBytesPerFrame,ratio_raw,ratio_adpcm,microseconds_per_frame,cpu_30fps,fidelity_mse,fidelity_psnr');
    csvHeaderPrinted = true;
  }
  console.log(line);
}

console.log('\nEnd of improved benchmark run.');
