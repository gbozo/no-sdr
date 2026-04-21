#!/usr/bin/env npx tsx
/**
 * Benchmark FFT compression approaches using captured real data.
 * 
 * Tests:
 * 1. Current: Uint8 quantization only (MSG_FFT_COMPRESSED baseline)
 * 2. ADPCM: Int16 dB×100 → IMA-ADPCM (current MSG_FFT_ADPCM)
 * 3. Delta+Deflate per-frame: Uint8 → delta → deflateRawSync (current MSG_FFT_DEFLATE)
 * 4. Streaming deflate on Uint8: persistent deflate stream across frames (Z_SYNC_FLUSH)
 * 5. Delta+streaming deflate on Uint8: delta + persistent stream
 * 6. Deflate on raw Float32: Float32 → deflateRawSync per frame (no quantization loss)
 * 7. Delta+Deflate on Float32: byte-level delta on Float32 → deflateRawSync
 * 8. Streaming deflate on Float32: persistent stream
 * 
 * Usage: npx tsx scripts/benchmark-fft-compression.ts
 * Requires: scripts/fft-capture-uint8.bin and scripts/fft-capture-f32.bin
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { encodeFftAdpcm, ImaAdpcmEncoder } from '@node-sdr/shared';

const uint8File = path.join(import.meta.dirname, 'fft-capture-uint8.bin');
const f32File = path.join(import.meta.dirname, 'fft-capture-f32.bin');

if (!fs.existsSync(uint8File) || !fs.existsSync(f32File)) {
  console.error('Capture files not found. Run capture-fft.ts first.');
  process.exit(1);
}

// Load Uint8 frames
const uint8Buf = fs.readFileSync(uint8File);
const frameCount = uint8Buf.readUInt32LE(0);
const binCount = uint8Buf.readUInt32LE(4);
const minDb = uint8Buf.readInt16LE(8);
const maxDb = uint8Buf.readInt16LE(10);

console.log(`Loaded ${frameCount} frames × ${binCount} bins (${minDb} to ${maxDb} dB)`);

const uint8Frames: Uint8Array[] = [];
for (let i = 0; i < frameCount; i++) {
  const offset = 12 + i * binCount;
  uint8Frames.push(new Uint8Array(uint8Buf.buffer, uint8Buf.byteOffset + offset, binCount));
}

// Load Float32 frames
const f32Buf = fs.readFileSync(f32File);
const f32FrameCount = f32Buf.readUInt32LE(0);
const f32BinCount = f32Buf.readUInt32LE(4);
const f32Frames: Float32Array[] = [];
for (let i = 0; i < f32FrameCount; i++) {
  const offset = 8 + i * f32BinCount * 4;
  f32Frames.push(new Float32Array(f32Buf.buffer, f32Buf.byteOffset + offset, f32BinCount));
}

const rawFloat32Size = binCount * 4; // uncompressed Float32 per frame

console.log(`\nRaw Float32 per frame: ${rawFloat32Size} bytes`);
console.log(`Raw Uint8 per frame: ${binCount} bytes`);
console.log(`---`);

interface Result {
  name: string;
  totalBytes: number;
  avgPerFrame: number;
  ratioVsFloat32: number;
  ratioVsUint8: number;
  avgEncodeUs: number;
}

const results: Result[] = [];

function bench(name: string, encode: () => number[]): Result {
  const start = performance.now();
  const sizes = encode();
  const elapsed = performance.now() - start;
  const total = sizes.reduce((a, b) => a + b, 0);
  const avg = total / sizes.length;
  const result: Result = {
    name,
    totalBytes: total,
    avgPerFrame: avg,
    ratioVsFloat32: rawFloat32Size / avg,
    ratioVsUint8: binCount / avg,
    avgEncodeUs: (elapsed / sizes.length) * 1000,
  };
  results.push(result);
  return result;
}

// 1. Uint8 baseline (no compression beyond quantization)
bench('1. Uint8 (baseline)', () => uint8Frames.map(f => f.length));

// 2. ADPCM (current MSG_FFT_ADPCM)
bench('2. ADPCM', () => f32Frames.map(f => {
  const payload = encodeFftAdpcm(f, minDb, maxDb);
  return payload.length;
}));

// 3. Delta+Deflate per-frame on Uint8 (current MSG_FFT_DEFLATE)
bench('3. Delta+Deflate/frame (Uint8)', () => uint8Frames.map(f => {
  const delta = Buffer.allocUnsafe(f.length);
  delta[0] = f[0];
  for (let i = 1; i < f.length; i++) delta[i] = (f[i] - f[i - 1]) & 0xFF;
  return zlib.deflateRawSync(delta, { level: 6 }).length;
}));

// 4. Deflate per-frame on Uint8 (no delta)
bench('4. Deflate/frame (Uint8, no delta)', () => uint8Frames.map(f => {
  return zlib.deflateRawSync(Buffer.from(f), { level: 6 }).length;
}));

// 5. Streaming deflate on Uint8 (persistent context, Z_SYNC_FLUSH)
bench('5. Streaming deflate (Uint8)', () => {
  const sizes: number[] = [];
  const deflate = zlib.createDeflateRaw({ level: 6 });
  const chunks: Buffer[] = [];
  
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
  
  for (const frame of uint8Frames) {
    chunks.length = 0;
    deflate.write(Buffer.from(frame));
    deflate.flush(zlib.constants.Z_SYNC_FLUSH);
    // Collect flushed data synchronously (works because flush is sync-ish for buffered data)
    // Actually we need to drain. Let's use deflateRawSync with a workaround.
  }
  deflate.end();
  
  // The streaming API is async — use a sync workaround: accumulate all output
  // and measure per-frame by using SYNC_FLUSH markers.
  // Let me do this differently with a synchronous approach:
  return uint8Frames.map(() => 0); // placeholder
});

// 5b. Streaming deflate (sync workaround using raw deflate with dictionary)
// Simulate streaming by using the previous frame as a hint via the dictionary
bench('5b. Streaming deflate (Uint8, simulated)', () => {
  let prevFrame: Buffer | null = null;
  return uint8Frames.map(f => {
    const buf = Buffer.from(f);
    const opts: zlib.ZlibOptions = { level: 6 };
    if (prevFrame) {
      (opts as any).dictionary = prevFrame;
    }
    const compressed = zlib.deflateRawSync(buf, opts);
    prevFrame = buf;
    return compressed.length;
  });
});

// 6. Delta+Streaming deflate on Uint8 (delta + dictionary)
bench('6. Delta+Streaming deflate (Uint8)', () => {
  let prevDelta: Buffer | null = null;
  return uint8Frames.map(f => {
    const delta = Buffer.allocUnsafe(f.length);
    delta[0] = f[0];
    for (let i = 1; i < f.length; i++) delta[i] = (f[i] - f[i - 1]) & 0xFF;
    const opts: zlib.ZlibOptions = { level: 6 };
    if (prevDelta) {
      (opts as any).dictionary = prevDelta;
    }
    const compressed = zlib.deflateRawSync(delta, opts);
    prevDelta = delta;
    return compressed.length;
  });
});

// 7. Temporal delta (frame-to-frame) + deflate on Uint8
bench('7. Temporal delta+Deflate (Uint8)', () => {
  let prevFrame: Uint8Array | null = null;
  return uint8Frames.map(f => {
    let data: Buffer;
    if (prevFrame) {
      // XOR with previous frame (temporal delta)
      const diff = Buffer.allocUnsafe(f.length);
      for (let i = 0; i < f.length; i++) diff[i] = (f[i] - prevFrame[i]) & 0xFF;
      data = diff;
    } else {
      data = Buffer.from(f);
    }
    prevFrame = f;
    return zlib.deflateRawSync(data, { level: 6 }).length;
  });
});

// 8. Spatial delta + temporal delta + deflate on Uint8 (best of both)
bench('8. Spatial+Temporal delta+Deflate (Uint8)', () => {
  let prevFrame: Uint8Array | null = null;
  return uint8Frames.map(f => {
    // First: spatial delta
    const spatialDelta = Buffer.allocUnsafe(f.length);
    spatialDelta[0] = f[0];
    for (let i = 1; i < f.length; i++) spatialDelta[i] = (f[i] - f[i - 1]) & 0xFF;
    
    let data: Buffer;
    if (prevFrame) {
      // Previous frame's spatial delta
      const prevSpatial = Buffer.allocUnsafe(prevFrame.length);
      prevSpatial[0] = prevFrame[0];
      for (let i = 1; i < prevFrame.length; i++) prevSpatial[i] = (prevFrame[i] - prevFrame[i - 1]) & 0xFF;
      // Temporal delta on the spatial deltas
      const diff = Buffer.allocUnsafe(f.length);
      for (let i = 0; i < f.length; i++) diff[i] = (spatialDelta[i] - prevSpatial[i]) & 0xFF;
      data = diff;
    } else {
      data = spatialDelta;
    }
    prevFrame = f;
    return zlib.deflateRawSync(data, { level: 6 }).length;
  });
});

// --- Int16 dB×100 approaches ---

// Helper: Float32 dB → Int16 dB×100 (same as ADPCM's internal quantization)
function float32ToInt16Db100(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 100)));
  }
  return out;
}

// 9. Int16 dB×100 + Deflate per-frame
bench('9. Deflate/frame (Int16 dB×100)', () => f32Frames.map(f => {
  const int16 = float32ToInt16Db100(f);
  return zlib.deflateRawSync(Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength), { level: 6 }).length;
}));

// 10. Int16 dB×100 + Delta (sample-level) + Deflate per-frame
bench('10. Delta+Deflate/frame (Int16 dB×100)', () => f32Frames.map(f => {
  const int16 = float32ToInt16Db100(f);
  const delta = new Int16Array(int16.length);
  delta[0] = int16[0];
  for (let i = 1; i < int16.length; i++) {
    delta[i] = (int16[i] - int16[i - 1]) | 0; // wrapping 16-bit delta
  }
  return zlib.deflateRawSync(Buffer.from(delta.buffer, delta.byteOffset, delta.byteLength), { level: 6 }).length;
}));

// 11. Int16 dB×100 + Byte-reorder (all high bytes then all low bytes) + Deflate
bench('11. Byte-reorder+Deflate (Int16 dB×100)', () => f32Frames.map(f => {
  const int16 = float32ToInt16Db100(f);
  const bytes = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  // Separate high bytes and low bytes
  const reordered = Buffer.allocUnsafe(bytes.length);
  const half = int16.length;
  for (let i = 0; i < half; i++) {
    reordered[i] = bytes[i * 2];           // low bytes first
    reordered[half + i] = bytes[i * 2 + 1]; // high bytes second
  }
  return zlib.deflateRawSync(reordered, { level: 6 }).length;
}));

// 12. Int16 dB×100 + Delta + Byte-reorder + Deflate
bench('12. Delta+Byte-reorder+Deflate (Int16 dB×100)', () => f32Frames.map(f => {
  const int16 = float32ToInt16Db100(f);
  const delta = new Int16Array(int16.length);
  delta[0] = int16[0];
  for (let i = 1; i < int16.length; i++) {
    delta[i] = (int16[i] - int16[i - 1]) | 0;
  }
  const bytes = Buffer.from(delta.buffer, delta.byteOffset, delta.byteLength);
  const reordered = Buffer.allocUnsafe(bytes.length);
  const half = delta.length;
  for (let i = 0; i < half; i++) {
    reordered[i] = bytes[i * 2];
    reordered[half + i] = bytes[i * 2 + 1];
  }
  return zlib.deflateRawSync(reordered, { level: 6 }).length;
}));

// 13. Int16 dB×100 + ADPCM warmup (same as encodeFftAdpcm but measuring size only)
// Already tested as #2 above — this is the same thing

// --- Float32 approaches ---

// 14. Deflate on raw Float32 per frame
bench('14. Deflate/frame (Float32)', () => f32Frames.map(f => {
  return zlib.deflateRawSync(Buffer.from(f.buffer, f.byteOffset, f.byteLength), { level: 6 }).length;
}));

// 15. Byte-level delta on Float32 + deflate
bench('15. Byte delta+Deflate (Float32)', () => f32Frames.map(f => {
  const bytes = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
  const delta = Buffer.allocUnsafe(bytes.length);
  delta[0] = bytes[0];
  for (let i = 1; i < bytes.length; i++) delta[i] = (bytes[i] - bytes[i - 1]) & 0xFF;
  return zlib.deflateRawSync(delta, { level: 6 }).length;
}));

// 16. Temporal delta on Float32 + deflate (XOR frames)
bench('16. Temporal delta+Deflate (Float32)', () => {
  let prevFrame: Buffer | null = null;
  return f32Frames.map(f => {
    const buf = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
    let data: Buffer;
    if (prevFrame) {
      const diff = Buffer.allocUnsafe(buf.length);
      for (let i = 0; i < buf.length; i++) diff[i] = (buf[i] ^ prevFrame[i]) & 0xFF;
      data = diff;
    } else {
      data = buf;
    }
    prevFrame = Buffer.from(buf); // copy
    return zlib.deflateRawSync(data, { level: 6 }).length;
  });
});

// Print results table
console.log('\n' + '='.repeat(110));
console.log(
  'Method'.padEnd(45),
  'Avg/frame'.padStart(10),
  'vs F32'.padStart(8),
  'vs Uint8'.padStart(8),
  'µs/frame'.padStart(10),
  '30fps CPU'.padStart(10),
);
console.log('-'.repeat(110));

for (const r of results) {
  if (r.avgPerFrame === 0) continue; // skip placeholder
  console.log(
    r.name.padEnd(45),
    `${Math.round(r.avgPerFrame)} B`.padStart(10),
    `${r.ratioVsFloat32.toFixed(1)}:1`.padStart(8),
    `${r.ratioVsUint8.toFixed(1)}:1`.padStart(8),
    `${Math.round(r.avgEncodeUs)}`.padStart(10),
    `${(r.avgEncodeUs * 30 / 1000).toFixed(1)} ms`.padStart(10),
  );
}

console.log('='.repeat(110));
console.log(`\nNote: "vs F32" = compression ratio vs raw Float32 (${rawFloat32Size} B/frame)`);
console.log(`      "vs Uint8" = compression ratio vs raw Uint8 (${binCount} B/frame)`);
console.log(`      "30fps CPU" = total encode time per second at 30 fps`);
