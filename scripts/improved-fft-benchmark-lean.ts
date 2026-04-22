#!/usr/bin/env tsx
// Lean 4-variant FFT benchmark: thresholds -3/-6, Deflate DeltaWindow2, BitGroom6
// Data: fft-capture-uint8.bin (FFT frames in 8-bit domain)
// CLI-only, console output, no json.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const uint8Path = path.join(process.cwd(), 'scripts', 'fft-capture-uint8.bin');
if (!fs.existsSync(uint8Path)) {
  console.error('Need fft-capture-uint8.bin at scripts/');
  process.exit(1);
}
const uint8Buf = fs.readFileSync(uint8Path);
const frameCount = uint8Buf.readUInt32LE(0);
const binCount = uint8Buf.readUInt32LE(4);
const minDb = uint8Buf.readInt16LE(8);
const maxDb = uint8Buf.readInt16LE(10);

const frames: Uint8Array[] = [];
for (let i = 0; i < frameCount; i++) {
  const off = 12 + i * binCount;
  frames.push(new Uint8Array(uint8Buf.buffer, uint8Buf.byteOffset + off, binCount));
}

function deflate(frame: Uint8Array): number {
  return zlib.deflateRawSync(Buffer.from(frame)).length;
}
function delta(frame: Uint8Array): Uint8Array {
  const out = Buffer.alloc(frame.length);
  out[0] = frame[0];
  for (let i = 1; i < frame.length; i++) out[i] = (frame[i] - frame[i-1]) & 0xff;
  return new Uint8Array(out);
}

// delta with window parameter (for Deflate DeltaWindow variants)
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
function bitGroom(frame: Uint8Array, bitsKeep = 6): Uint8Array {
  const mask = ~((1 << (8 - bitsKeep)) - 1) & 0xff; // top bitsMask
  const out = new Uint8Array(frame.length);
  for (let i=0;i<frame.length;i++) out[i] = frame[i] & mask;
  return out;
}
function thresholdIndex(minDb: number, maxDb: number, thresholdDb: number, frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length);
  const range = maxDb - minDb;
  const t = Math.max(0, Math.min(255, Math.round((thresholdDb - minDb) * 255 / range)));
  for (let i=0;i<frame.length;i++) out[i] = frame[i] < t ? 0 : frame[i];
  return out;
}

interface Row { strategy:string; avg:number; raw:number; adpcm:number; micro:number; cpu:number; fidelity:number }
function avg(arr:number[]):number { const s=arr.reduce((a,b)=>a+b,0); return arr.length? s/arr.length:0 }

const results: Row[] = [];

function run(name:string, test: ()=>number[]): void {
  const t0 = process.hrtime.bigint();
  const sizes = test();
  const t1 = process.hrtime.bigint();
  const total = sizes.reduce((a,b)=>a+b,0);
  const avgSize = total / sizes.length;
  const elapsed = Number(t1 - t0) / 1e6; // ms
  const perFrameMs = elapsed / sizes.length;
  results.push({
    strategy:name,
    avg:avgSize,
    raw: binCount,
    adpcm: 0,
    micro: perFrameMs*1000,
    cpu: perFrameMs,
    fidelity: 0,
  } as any);
}

// Baseline Uncompressed Uint8 (lean)
function adpcmUint8Estimate(frame: Uint8Array): number {
  return Math.ceil(frame.length / 4);
}

run('Baseline: Uncompressed Uint8', ()=> frames.map(f => f.length));
run('ADPCM Uint8 (est) lean', ()=> frames.map(f => adpcmUint8Estimate(f)));

// 1) Threshold -3dB
run('Threshold -3dB + Deflate Uint8', ()=> frames.map(f => {
  const t = thresholdIndex(minDb, maxDb, -3, f);
  return deflate(t);
}));

// 2) Threshold -6dB
run('Threshold -6dB + Deflate Uint8', ()=> frames.map(f => {
  const t = thresholdIndex(minDb, maxDb, -6, f);
  return deflate(t);
}));

// 3) Deflate Delta Window 2
run('Deflate DeltaWindow2 Uint8', ()=> frames.map(f => {
  const d = deltaUint8WithWindow(f, 2);
  return deflate(d);
}));

// 4) Bit Groom6 + Deflate Uint8
run('BitGroom6 + Deflate Uint8', ()=> frames.map(f => {
  const g = bitGroom(f,6);
  return deflate(g);
}));

console.log('\n=== Improved FFT Benchmark Lean (console) ===');
console.table(results.map(r => ({Strategy: r.strategy, AvgBytes: r.avg, CpuMs: r.cpu, Fidelity: r.fidelity})))
console.log('=== End ===');
