#!/usr/bin/env npx tsx
/**
 * Benchmark IQ compression approaches using captured real WFM IQ data.
 *
 * Tests lossless + lossy strategies across zlib, FLAC and WavPack with various
 * IQ pre-processing stages (interleaved vs de-interleaved, delta, mid-side, etc.)
 *
 * Loads:
 *   scripts/iq-capture-raw.bin          — raw Int16 IQ chunks (capture-iq.ts pass 1)
 *   scripts/iq-capture-adpcm-sizes.bin  — real ADPCM wire sizes (capture-iq.ts pass 2)
 *
 * Usage: npx tsx scripts/benchmark-iq-compression.ts
 * External requirements: flac, wavpack CLIs (brew install flac wavpack)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { ImaAdpcmEncoder } from '@node-sdr/shared';

const rawFile       = path.join(import.meta.dirname, 'iq-capture-raw.bin');
const adpcmSizesFile = path.join(import.meta.dirname, 'iq-capture-adpcm-sizes.bin');

for (const f of [rawFile, adpcmSizesFile]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing: ${f}\nRun capture-iq.ts first.`);
    process.exit(1);
  }
}

// ---- Load captures ----------------------------------------------------------

const rawBuf         = fs.readFileSync(rawFile);
const chunkCount     = rawBuf.readUInt32LE(0);
const samplesPerChunk = rawBuf.readUInt32LE(4); // Int16 elements (I+Q interleaved)
const iqSampleRate   = rawBuf.readUInt32LE(8);
const bytesPerChunk  = samplesPerChunk * 2;
const iqPairs        = samplesPerChunk / 2;      // 4800 IQ pairs per chunk at WFM 240kHz

console.log(`Loaded ${chunkCount} raw IQ chunks`);
console.log(`  samplesPerChunk : ${samplesPerChunk} Int16 (${iqPairs} IQ pairs)`);
console.log(`  bytesPerChunk   : ${bytesPerChunk} B (${(bytesPerChunk / 1024).toFixed(1)} KB)`);
console.log(`  iqSampleRate    : ${iqSampleRate} Hz`);

const int16Chunks: Int16Array[] = [];
const uint8Chunks:  Uint8Array[]  = [];
for (let i = 0; i < chunkCount; i++) {
  const off   = 12 + i * bytesPerChunk;
  const bytes = new Uint8Array(rawBuf.buffer, rawBuf.byteOffset + off, bytesPerChunk);
  int16Chunks.push(new Int16Array(bytes.buffer, bytes.byteOffset, samplesPerChunk));
  uint8Chunks.push(bytes);
}

const adpcmBuf   = fs.readFileSync(adpcmSizesFile);
const adpcmCount = adpcmBuf.readUInt32LE(0);
const adpcmSizes: number[] = [];
for (let i = 0; i < adpcmCount; i++) adpcmSizes.push(adpcmBuf.readUInt32LE(4 + i * 4));
const adpcmAvgWire = adpcmSizes.reduce((s, v) => s + v, 0) / adpcmSizes.length;

console.log(`Loaded ${adpcmCount} ADPCM wire sizes (avg ${Math.round(adpcmAvgWire)} B/chunk)`);
console.log('');

// ---- CLI availability -------------------------------------------------------

function cliAvailable(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { stdio: 'pipe' });
  return r.status === 0;
}
const hasFlac    = cliAvailable('flac');
const hasWavpack = cliAvailable('wavpack');
console.log(`flac CLI    : ${hasFlac    ? 'available' : 'NOT FOUND (brew install flac)'}`);
console.log(`wavpack CLI : ${hasWavpack ? 'available' : 'NOT FOUND (brew install wavpack)'}`);
console.log('');

// ---- IQ pre-processing helpers ----------------------------------------------

/**
 * De-interleave: [I0 Q0 I1 Q1 ...] → [I0 I1 ... Q0 Q1 ...]
 * This is non-interleaved (channel-first) ordering required by FLAC/WavPack.
 */
function deinterleave(chunk: Int16Array): Int16Array {
  const out = new Int16Array(chunk.length);
  const half = iqPairs; // samples per channel
  for (let i = 0; i < half; i++) {
    out[i]        = chunk[i * 2];     // I channel
    out[half + i] = chunk[i * 2 + 1]; // Q channel
  }
  return out;
}

/**
 * Mid-side transform: mid=(I+Q)>>1, side=I-Q, then non-interleaved [mid... side...]
 * Potentially useful when I and Q are correlated (FM suppressed-carrier regions).
 */
function midSide(chunk: Int16Array): Int16Array {
  const out = new Int16Array(chunk.length);
  const half = iqPairs;
  for (let i = 0; i < half; i++) {
    const iVal = chunk[i * 2];
    const qVal = chunk[i * 2 + 1];
    out[i]        = (iVal + qVal) >> 1; // mid
    out[half + i] = iVal - qVal;         // side
  }
  return out;
}

/**
 * Sample-delta on each channel independently, de-interleaved layout.
 * Encode the difference between successive samples rather than absolute values.
 */
function deltaDeinterleaved(chunk: Int16Array): Int16Array {
  const out = new Int16Array(chunk.length);
  const half = iqPairs;
  // I channel
  out[0] = chunk[0];
  for (let i = 1; i < half; i++) out[i] = chunk[i * 2] - chunk[(i - 1) * 2];
  // Q channel
  out[half] = chunk[1];
  for (let i = 1; i < half; i++) out[half + i] = chunk[i * 2 + 1] - chunk[(i - 1) * 2 + 1];
  return out;
}

/**
 * Extract just the I channel as mono Int16Array.
 */
function iChannelOnly(chunk: Int16Array): Int16Array {
  const out = new Int16Array(iqPairs);
  for (let i = 0; i < iqPairs; i++) out[i] = chunk[i * 2];
  return out;
}

/**
 * Extract just the Q channel as mono Int16Array.
 */
function qChannelOnly(chunk: Int16Array): Int16Array {
  const out = new Int16Array(iqPairs);
  for (let i = 0; i < iqPairs; i++) out[i] = chunk[i * 2 + 1];
  return out;
}

/**
 * Byte-level delta on the raw uint8 view of the chunk.
 */
function byteDelta(bytes: Uint8Array): Buffer {
  const delta = Buffer.allocUnsafe(bytes.length);
  delta[0] = bytes[0];
  for (let i = 1; i < bytes.length; i++) delta[i] = (bytes[i] - bytes[i - 1]) & 0xFF;
  return delta;
}

/**
 * Byte-reorder: separate low and high bytes of Int16 values.
 * [L0 H0 L1 H1 ...] → [L0 L1 ... H0 H1 ...]
 */
function byteReorder(bytes: Uint8Array): Buffer {
  const half = bytes.length / 2; // number of Int16 values
  const out = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < half; i++) {
    out[i]        = bytes[i * 2];     // low bytes
    out[half + i] = bytes[i * 2 + 1]; // high bytes
  }
  return out;
}

// ---- FLAC via CLI -----------------------------------------------------------

function flacEncode(pcm: Buffer | Int16Array, channels: number, level: number): number {
  if (!hasFlac) return -1;
  const buf = pcm instanceof Int16Array
    ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    : pcm;
  const r = spawnSync('flac', [
    '--silent', '--force', '--stdout', '--no-md5-sum',
    '--force-raw-format', '--sign=signed', '--endian=little',
    `--channels=${channels}`,
    `--bps=16`,
    `--sample-rate=${iqSampleRate}`,
    `-${level}`,
    '-',
  ], { input: buf, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return -1;
  return r.stdout?.length ?? -1;
}

// ---- WavPack via CLI --------------------------------------------------------

function wavpackEncode(pcm: Buffer | Int16Array, channels: number): number {
  if (!hasWavpack) return -1;
  const buf = pcm instanceof Int16Array
    ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    : pcm;
  const r = spawnSync('wavpack', [
    `--raw-pcm=${iqSampleRate},16s,${channels},le`,
    '-q', '-y', '-o', '-', '-',
  ], { input: buf, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== null && r.stdout?.length === 0) return -1;
  return r.stdout?.length ?? -1;
}

// ---- Benchmark harness ------------------------------------------------------

interface Result {
  name: string;
  avgBytes: number;
  minBytes: number;
  maxBytes: number;
  ratioVsRaw: number;
  ratioVsAdpcm: number;
  avgEncodeUs: number;
  lossless: boolean;
  note?: string;
}

const results: Result[] = [];

function bench(
  name: string,
  lossless: boolean,
  encode: () => number[],
  note?: string,
): void {
  const t0 = performance.now();
  let sizes = encode();
  const elapsed = performance.now() - t0;

  // Filter out failed CLI calls (-1)
  sizes = sizes.filter(s => s > 0);
  if (sizes.length === 0) {
    console.warn(`  [SKIP] ${name} — CLI unavailable or all chunks failed`);
    return;
  }

  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  results.push({
    name,
    avgBytes: avg,
    minBytes: Math.min(...sizes),
    maxBytes: Math.max(...sizes),
    ratioVsRaw: bytesPerChunk / avg,
    ratioVsAdpcm: adpcmAvgWire / avg,
    avgEncodeUs: (elapsed / sizes.length) * 1000,
    lossless,
    note,
  });
}

// Only process first N chunks for FLAC/WavPack (CLI overhead — still statistically valid)
const CLI_SAMPLE = Math.min(chunkCount, 100);
const ALL = chunkCount;

console.log(`Running benchmarks (zlib: all ${ALL} chunks, CLI codecs: first ${CLI_SAMPLE} chunks)...\n`);

// ==== SECTION 1: zlib / deflate (all chunks) =================================

bench('1.  Raw Int16 (none codec)', false,
  () => int16Chunks.slice(0, ALL).map(() => bytesPerChunk));

// ADPCM reference from server capture
results.push({
  name: '2.  ADPCM (server wire, adpcm codec)',
  avgBytes: adpcmAvgWire,
  minBytes: Math.min(...adpcmSizes),
  maxBytes: Math.max(...adpcmSizes),
  ratioVsRaw: bytesPerChunk / adpcmAvgWire,
  ratioVsAdpcm: 1.0,
  avgEncodeUs: NaN,
  lossless: false,
  note: 'server wire',
});

bench('3.  ADPCM computed (verify)', false, () => {
  const enc = new ImaAdpcmEncoder();
  return int16Chunks.slice(0, ALL).map(c => { enc.reset(); return 5 + enc.encode(c).length; });
});

bench('4.  Deflate L6 raw bytes', true, () =>
  uint8Chunks.slice(0, ALL).map(f =>
    zlib.deflateRawSync(Buffer.from(f), { level: 6 }).length));

bench('5.  Byte-delta + Deflate L6', true, () =>
  uint8Chunks.slice(0, ALL).map(f =>
    zlib.deflateRawSync(byteDelta(f), { level: 6 }).length));

bench('6.  Byte-reorder + Deflate L6', true, () =>
  uint8Chunks.slice(0, ALL).map(f =>
    zlib.deflateRawSync(byteReorder(f), { level: 6 }).length));

bench('7.  Sample-delta + Deflate L6', true, () =>
  int16Chunks.slice(0, ALL).map(c => {
    const d = new Int16Array(c.length);
    d[0] = c[0];
    for (let i = 1; i < c.length; i++) d[i] = c[i] - c[i - 1];
    return zlib.deflateRawSync(Buffer.from(d.buffer, d.byteOffset, d.byteLength), { level: 6 }).length;
  }));

bench('8.  DeInterleave + Sample-delta + Deflate L6', true, () =>
  int16Chunks.slice(0, ALL).map(c => {
    const di = deltaDeinterleaved(c);
    return zlib.deflateRawSync(Buffer.from(di.buffer, di.byteOffset, di.byteLength), { level: 6 }).length;
  }));

bench('9.  DeInterleave + Byte-reorder + Deflate L6', true, () =>
  int16Chunks.slice(0, ALL).map(c => {
    const di = deinterleave(c);
    const bytes = new Uint8Array(di.buffer, di.byteOffset, di.byteLength);
    return zlib.deflateRawSync(byteReorder(bytes), { level: 6 }).length;
  }));

bench('10. Mid-Side + Deflate L6', true, () =>
  int16Chunks.slice(0, ALL).map(c => {
    const ms = midSide(c);
    return zlib.deflateRawSync(Buffer.from(ms.buffer, ms.byteOffset, ms.byteLength), { level: 6 }).length;
  }));

bench('11. Temporal-delta + Deflate L6', true, () => {
  let prev: Uint8Array | null = null;
  return uint8Chunks.slice(0, ALL).map(f => {
    const buf = Buffer.allocUnsafe(f.length);
    if (prev) { for (let i = 0; i < f.length; i++) buf[i] = (f[i] - prev[i]) & 0xFF; }
    else       { buf.set(f); }
    prev = f;
    return zlib.deflateRawSync(buf, { level: 6 }).length;
  });
});

// ==== SECTION 2: FLAC via CLI (CLI_SAMPLE chunks) ============================

if (hasFlac) {
  // 2a: Mono interleaved (naive — what NOT to do)
  for (const lvl of [1, 5, 8] as const) {
    bench(`12. FLAC L${lvl} — interleaved as mono (naive)`, true, () =>
      int16Chunks.slice(0, CLI_SAMPLE).map(c => flacEncode(c, 1, lvl)));
  }

  // 2b: De-interleaved 2-ch (correct approach)
  for (const lvl of [1, 3, 5, 8] as const) {
    bench(`13. FLAC L${lvl} — de-interleaved 2-ch`, true, () =>
      int16Chunks.slice(0, CLI_SAMPLE).map(c => flacEncode(deinterleave(c), 2, lvl)));
  }

  // 2c: I channel only (mono, to see per-channel compressibility)
  bench('14. FLAC L5 — I channel only (mono)', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => {
      const iCh = iChannelOnly(c);
      const sz = flacEncode(iCh, 1, 5);
      return sz * 2; // ×2 to represent both channels (estimate full cost)
    }), '×2 est.');

  bench('15. FLAC L5 — Q channel only (mono)', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => {
      const qCh = qChannelOnly(c);
      const sz = flacEncode(qCh, 1, 5);
      return sz * 2;
    }), '×2 est.');

  // 2d: Delta-encoded de-interleaved (feed LPC predictor residuals)
  bench('16. FLAC L5 — delta de-interleaved 2-ch', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => flacEncode(deltaDeinterleaved(c), 2, 5)));

  // 2e: Mid-side de-interleaved
  bench('17. FLAC L5 — mid-side 2-ch', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => flacEncode(midSide(c), 2, 5)));
}

// ==== SECTION 3: WavPack via CLI =============================================

if (hasWavpack) {
  // 3a: Interleaved as mono (naive baseline)
  bench('18. WavPack — interleaved as mono (naive)', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => wavpackEncode(c, 1)));

  // 3b: De-interleaved 2-ch (correct approach)
  bench('19. WavPack — de-interleaved 2-ch', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => wavpackEncode(deinterleave(c), 2)));

  // 3c: Mid-side
  bench('20. WavPack — mid-side 2-ch', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => wavpackEncode(midSide(c), 2)));

  // 3d: Delta de-interleaved
  bench('21. WavPack — delta de-interleaved 2-ch', true, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => wavpackEncode(deltaDeinterleaved(c), 2)));
}

// ==== SECTION 4: Hybrid — quantize then FLAC =================================

if (hasFlac) {
  // 4a: 8-bit requantization (top 8 bits of each Int16) then FLAC — lossy
  bench('22. FLAC L5 — 8-bit requant + de-interleaved (lossy)', false, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => {
      const q8 = new Int8Array(c.length);
      for (let i = 0; i < c.length; i++) q8[i] = c[i] >> 8; // keep top 8 bits
      // Re-pack as Int16 for FLAC (FLAC needs 16-bit input here, but with 8-bit range)
      const as16 = new Int16Array(c.length);
      for (let i = 0; i < c.length; i++) as16[i] = q8[i] * 256;
      return flacEncode(deinterleave(as16), 2, 5);
    }), 'lossy 8b');

  // 4b: 12-bit requantization then FLAC — lossy
  bench('23. FLAC L5 — 12-bit requant + de-interleaved (lossy)', false, () =>
    int16Chunks.slice(0, CLI_SAMPLE).map(c => {
      const as16 = new Int16Array(c.length);
      for (let i = 0; i < c.length; i++) as16[i] = (c[i] >> 4) << 4; // zero low 4 bits
      return flacEncode(deinterleave(as16), 2, 5);
    }), 'lossy 12b');
}

// ---- Print results ----------------------------------------------------------

const chunksPerSec = 1000 / 20; // 50 chunks/sec for WFM 20ms
const W = 52;
const HR = '─'.repeat(100);

function hdr(title: string) {
  console.log(`\n${title}`);
  console.log(HR);
  console.log(
    'Method'.padEnd(W),
    'Avg/chunk'.padStart(10),
    'vs Raw'.padStart(7),
    'vs ADPCM'.padStart(9),
    'µs/chunk'.padStart(9),
    '50fps ms'.padStart(9),
    'L'.padStart(2),
  );
  console.log(HR);
}

function row(r: Result) {
  const us  = isNaN(r.avgEncodeUs) ? '--' : `${Math.round(r.avgEncodeUs)}`;
  const fps = isNaN(r.avgEncodeUs) ? '--' : `${(r.avgEncodeUs * chunksPerSec / 1000).toFixed(2)}`;
  const lo  = r.lossless ? 'Y' : 'N';
  const note = r.note ? ` (${r.note})` : '';
  console.log(
    (r.name + note).padEnd(W),
    `${Math.round(r.avgBytes)} B`.padStart(10),
    `${r.ratioVsRaw.toFixed(2)}x`.padStart(7),
    `${r.ratioVsAdpcm.toFixed(2)}x`.padStart(9),
    us.padStart(9),
    fps.padStart(9),
    lo.padStart(2),
  );
}

const allTitle = `\n${'═'.repeat(100)}\n IQ Compression Benchmark — WFM ${iqSampleRate/1000}kHz · ${samplesPerChunk} samples/chunk (${bytesPerChunk} B raw) · ${chunkCount} chunks\n ADPCM server wire avg: ${Math.round(adpcmAvgWire)} B/chunk · L = Lossless\n${'═'.repeat(100)}`;
console.log(allTitle);

hdr('SECTION 1 — zlib/deflate variants (all chunks)');
results.filter(r => r.name.match(/^[1-9]\.|^10\.|^11\./)).forEach(row);

hdr('SECTION 2 — FLAC variants (first 100 chunks, CLI)');
results.filter(r => r.name.match(/^1[2-7]\./)).forEach(row);

hdr('SECTION 3 — WavPack variants (first 100 chunks, CLI)');
results.filter(r => r.name.match(/^1[89]\.|^2[01]\./)).forEach(row);

hdr('SECTION 4 — Hybrid: quantize then FLAC (lossy, first 100 chunks)');
results.filter(r => r.name.match(/^2[23]\./)).forEach(row);

// Overall best by ratio
console.log(`\n${'═'.repeat(100)}`);
console.log(' SUMMARY — Best by compression ratio (top 5 per category)');
console.log('═'.repeat(100));

const sorted = [...results].sort((a, b) => a.avgBytes - b.avgBytes);
console.log('\n  Best lossless:');
sorted.filter(r => r.lossless).slice(0, 5).forEach(r => {
  const us = isNaN(r.avgEncodeUs) ? 'CLI' : `${Math.round(r.avgEncodeUs)}µs`;
  console.log(`    ${r.name.padEnd(W)} ${Math.round(r.avgBytes)} B  ${r.ratioVsRaw.toFixed(2)}x vs raw  ${r.ratioVsAdpcm.toFixed(2)}x vs ADPCM  enc=${us}`);
});

console.log('\n  Best lossy:');
sorted.filter(r => !r.lossless).slice(0, 5).forEach(r => {
  const us = isNaN(r.avgEncodeUs) ? 'server' : `${Math.round(r.avgEncodeUs)}µs`;
  console.log(`    ${r.name.padEnd(W)} ${Math.round(r.avgBytes)} B  ${r.ratioVsRaw.toFixed(2)}x vs raw  enc=${us}`);
});

console.log(`\n${'═'.repeat(100)}`);
console.log(`  Notes:`);
console.log(`    - FLAC/WavPack CLI µs/chunk includes process spawn overhead (not representative of library cost)`);
console.log(`    - De-interleaving splits [I0 Q0 I1 Q1...] → [I0 I1... Q0 Q1...] (channel-first)`);
console.log(`    - Mid-side: mid=(I+Q)/2, side=I-Q (spatial decorrelation)`);
console.log(`    - Delta variants encode sample-to-sample differences before codec`);
console.log(`    - Temporal delta uses previous 20ms chunk as reference`);
console.log(`    - 8-bit/12-bit variants drop LSBs before encoding (lossy)`);
