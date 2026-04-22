#!/usr/bin/env npx tsx
/**
 * Multi-mode IQ compression benchmark.
 * Runs the same compression suite across WFM (240kHz), NFM (48kHz), and AM (48kHz)
 * captures and prints a comparative cross-mode table.
 *
 * Requires (all produced by capture-iq.ts):
 *   iq-capture-raw.bin              + iq-capture-adpcm-sizes.bin        (WFM, active capture)
 *   iq-capture-nfm-raw.bin          + iq-capture-nfm-adpcm-sizes.bin    (NFM)
 *   iq-capture-am-raw.bin           + iq-capture-am-adpcm-sizes.bin     (AM)
 *
 * External deps: flac, wavpack CLIs (brew install flac wavpack)
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { ImaAdpcmEncoder } from '@node-sdr/shared';

const D = import.meta.dirname;

// ---- Dataset descriptors ----------------------------------------------------

interface Dataset {
  label: string;
  rawFile: string;
  adpcmFile: string;
}

const DATASETS: Dataset[] = [
  {
    label:    'WFM 240kHz',
    rawFile:  path.join(D, 'iq-capture-raw.bin'),
    adpcmFile: path.join(D, 'iq-capture-adpcm-sizes.bin'),
  },
  {
    label:    'NFM  48kHz',
    rawFile:  path.join(D, 'iq-capture-nfm-raw.bin'),
    adpcmFile: path.join(D, 'iq-capture-nfm-adpcm-sizes.bin'),
  },
  {
    label:    'AM   48kHz',
    rawFile:  path.join(D, 'iq-capture-am-raw.bin'),
    adpcmFile: path.join(D, 'iq-capture-am-adpcm-sizes.bin'),
  },
];

for (const ds of DATASETS) {
  if (!fs.existsSync(ds.rawFile))  { console.error(`Missing: ${ds.rawFile}`);  process.exit(1); }
  if (!fs.existsSync(ds.adpcmFile)){ console.error(`Missing: ${ds.adpcmFile}`); process.exit(1); }
}

// ---- CLI checks -------------------------------------------------------------

function cliOk(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { stdio: 'pipe' }).status === 0;
}
const hasFlac    = cliOk('flac');
const hasWavpack = cliOk('wavpack');
console.log(`flac: ${hasFlac ? 'ok' : 'MISSING'}  wavpack: ${hasWavpack ? 'ok' : 'MISSING'}\n`);

// ---- IQ pre-processing helpers ----------------------------------------------

function deinterleave(c: Int16Array, pairs: number): Int16Array {
  const o = new Int16Array(c.length);
  for (let i = 0; i < pairs; i++) { o[i] = c[i*2]; o[pairs+i] = c[i*2+1]; }
  return o;
}
function midSide(c: Int16Array, pairs: number): Int16Array {
  const o = new Int16Array(c.length);
  for (let i = 0; i < pairs; i++) {
    o[i] = (c[i*2] + c[i*2+1]) >> 1;
    o[pairs+i] = c[i*2] - c[i*2+1];
  }
  return o;
}
function deltaDeinterleave(c: Int16Array, pairs: number): Int16Array {
  const o = new Int16Array(c.length);
  o[0] = c[0];
  for (let i = 1; i < pairs; i++) o[i]       = c[i*2]   - c[(i-1)*2];
  o[pairs] = c[1];
  for (let i = 1; i < pairs; i++) o[pairs+i] = c[i*2+1] - c[(i-1)*2+1];
  return o;
}
function byteReorder(b: Uint8Array): Buffer {
  const n = b.length / 2, o = Buffer.allocUnsafe(b.length);
  for (let i = 0; i < n; i++) { o[i] = b[i*2]; o[n+i] = b[i*2+1]; }
  return o;
}
function byteDelta(b: Uint8Array): Buffer {
  const d = Buffer.allocUnsafe(b.length);
  d[0] = b[0];
  for (let i = 1; i < b.length; i++) d[i] = (b[i] - b[i-1]) & 0xFF;
  return d;
}

// ---- FLAC / WavPack helpers -------------------------------------------------

function flac(pcm: Int16Array | Buffer, channels: number, sr: number, level: number): number {
  if (!hasFlac) return -1;
  const buf = pcm instanceof Int16Array
    ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : pcm;
  const r = spawnSync('flac', [
    '--silent','--force','--stdout','--no-md5-sum',
    '--force-raw-format','--sign=signed','--endian=little',
    `--channels=${channels}`, '--bps=16', `--sample-rate=${sr}`,
    `-${level}`, '-',
  ], { input: buf, maxBuffer: 32*1024*1024 });
  return (r.status === 0 && r.stdout?.length) ? r.stdout.length : -1;
}

function wavpack(pcm: Int16Array | Buffer, channels: number, sr: number): number {
  if (!hasWavpack) return -1;
  const buf = pcm instanceof Int16Array
    ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : pcm;
  const r = spawnSync('wavpack', [
    `--raw-pcm=${sr},16s,${channels},le`, '-q', '-y', '-o', '-', '-',
  ], { input: buf, maxBuffer: 32*1024*1024 });
  return (r.stdout?.length) ? r.stdout.length : -1;
}

// ---- Result types -----------------------------------------------------------

interface MethodResult {
  name: string;
  lossless: boolean;
  avgBytes: number;
  ratioVsRaw: number;
  ratioVsAdpcm: number;
  avgUs: number;        // NaN = CLI / server (not independently timed)
}

// ---- Core benchmark loop ----------------------------------------------------

const CLI_N = 50; // chunks to use for FLAC/WavPack (process spawn overhead)

function runDataset(ds: Dataset): { meta: string; bytesPerChunk: number; adpcmAvg: number; results: MethodResult[] } {

  // Load raw
  const raw      = fs.readFileSync(ds.rawFile);
  const nChunks  = raw.readUInt32LE(0);
  const samples  = raw.readUInt32LE(4); // Int16 elements per chunk
  const sr       = raw.readUInt32LE(8);
  const bpc      = samples * 2;         // bytes per chunk
  const pairs    = samples / 2;         // IQ pairs

  const i16: Int16Array[] = [];
  const u8:  Uint8Array[] = [];
  for (let i = 0; i < nChunks; i++) {
    const off = 12 + i * bpc;
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset + off, bpc);
    i16.push(new Int16Array(bytes.buffer, bytes.byteOffset, samples));
    u8.push(bytes);
  }

  // Load ADPCM sizes
  const ab = fs.readFileSync(ds.adpcmFile);
  const asz: number[] = [];
  for (let i = 0; i < ab.readUInt32LE(0); i++) asz.push(ab.readUInt32LE(4 + i*4));
  const adpcmAvg = asz.reduce((s,v) => s+v, 0) / asz.length;

  const results: MethodResult[] = [];
  const ALL = nChunks;

  function add(name: string, lossless: boolean, encode: () => number[]): void {
    const t0 = performance.now();
    const sizes = encode().filter(s => s > 0);
    const elapsed = performance.now() - t0;
    if (!sizes.length) return;
    const avg = sizes.reduce((a,b) => a+b, 0) / sizes.length;
    results.push({
      name, lossless, avgBytes: avg,
      ratioVsRaw:   bpc / avg,
      ratioVsAdpcm: adpcmAvg / avg,
      avgUs: (elapsed / sizes.length) * 1000,
    });
  }

  // 1. Baselines
  add('Raw Int16 (none)', false, () => i16.slice(0,ALL).map(() => bpc));

  results.push({
    name: 'ADPCM (server wire)', lossless: false,
    avgBytes: adpcmAvg,
    ratioVsRaw: bpc / adpcmAvg,
    ratioVsAdpcm: 1.0,
    avgUs: NaN,
  });

  add('ADPCM computed', false, () => {
    const enc = new ImaAdpcmEncoder();
    return i16.slice(0,ALL).map(c => { enc.reset(); return 5 + enc.encode(c).length; });
  });

  // 2. zlib variants (all chunks)
  add('Deflate L6 (raw bytes)', true, () =>
    u8.slice(0,ALL).map(f => zlib.deflateRawSync(Buffer.from(f), { level:6 }).length));

  add('Byte-delta + Deflate L6', true, () =>
    u8.slice(0,ALL).map(f => zlib.deflateRawSync(byteDelta(f), { level:6 }).length));

  add('Byte-reorder + Deflate L6', true, () =>
    u8.slice(0,ALL).map(f => zlib.deflateRawSync(byteReorder(f), { level:6 }).length));

  add('DeInterleave + Byte-reorder + Deflate L6', true, () =>
    i16.slice(0,ALL).map(c => {
      const di = deinterleave(c, pairs);
      const b  = new Uint8Array(di.buffer, di.byteOffset, di.byteLength);
      return zlib.deflateRawSync(byteReorder(b), { level:6 }).length;
    }));

  add('Sample-delta (per-ch) + Deflate L6', true, () =>
    i16.slice(0,ALL).map(c => {
      const d = deltaDeinterleave(c, pairs);
      return zlib.deflateRawSync(
        Buffer.from(d.buffer, d.byteOffset, d.byteLength), { level:6 }).length;
    }));

  add('Mid-Side + Deflate L6', true, () =>
    i16.slice(0,ALL).map(c => {
      const ms = midSide(c, pairs);
      return zlib.deflateRawSync(
        Buffer.from(ms.buffer, ms.byteOffset, ms.byteLength), { level:6 }).length;
    }));

  add('Temporal-delta + Deflate L6', true, () => {
    let prev: Uint8Array | null = null;
    return u8.slice(0,ALL).map(f => {
      const d = Buffer.allocUnsafe(f.length);
      if (prev) { for (let i=0; i<f.length; i++) d[i] = (f[i]-prev[i]) & 0xFF; }
      else d.set(f);
      prev = f;
      return zlib.deflateRawSync(d, { level:6 }).length;
    });
  });

  // Deflate L1 vs L6 on best lossless variant (for speed tradeoff insight)
  add('DeInterleave + Byte-reorder + Deflate L1', true, () =>
    i16.slice(0,ALL).map(c => {
      const di = deinterleave(c, pairs);
      const b  = new Uint8Array(di.buffer, di.byteOffset, di.byteLength);
      return zlib.deflateRawSync(byteReorder(b), { level:1 }).length;
    }));

  // 3. FLAC (CLI_N chunks)
  if (hasFlac) {
    for (const lvl of [1, 5, 8] as const) {
      add(`FLAC L${lvl} de-interleaved 2-ch`, true, () =>
        i16.slice(0,CLI_N).map(c => flac(deinterleave(c,pairs), 2, sr, lvl)));
    }
    add('FLAC L5 mid-side 2-ch', true, () =>
      i16.slice(0,CLI_N).map(c => flac(midSide(c,pairs), 2, sr, 5)));
    add('FLAC L5 delta de-intlv 2-ch', true, () =>
      i16.slice(0,CLI_N).map(c => flac(deltaDeinterleave(c,pairs), 2, sr, 5)));
  }

  // 4. WavPack (CLI_N chunks)
  if (hasWavpack) {
    add('WavPack de-interleaved 2-ch', true, () =>
      i16.slice(0,CLI_N).map(c => wavpack(deinterleave(c,pairs), 2, sr)));
    add('WavPack mid-side 2-ch', true, () =>
      i16.slice(0,CLI_N).map(c => wavpack(midSide(c,pairs), 2, sr)));
  }

  const chunksPerSec = 1000 / 20; // 50 per sec (20ms chunks)
  const meta = `${ds.label} | ${samples} smp | ${bpc} B raw | ADPCM ${Math.round(adpcmAvg)} B | ${nChunks} chunks | ${(bpc*chunksPerSec/1024).toFixed(0)} KB/s raw`;
  return { meta, bytesPerChunk: bpc, adpcmAvg, results };
}

// ---- Run all datasets -------------------------------------------------------

const allData: ReturnType<typeof runDataset>[] = [];
for (const ds of DATASETS) {
  process.stdout.write(`Benchmarking ${ds.label}...`);
  const d = runDataset(ds);
  allData.push(d);
  console.log(' done');
}

// ---- Print comparative table ------------------------------------------------

// Collect union of method names in order
const methodNames: string[] = [];
for (const d of allData) {
  for (const r of d.results) {
    if (!methodNames.includes(r.name)) methodNames.push(r.name);
  }
}

const W = 42;
const colW = 18;
const HR = '─'.repeat(W + colW * DATASETS.length + 2);

function pad(s: string, w: number) { return s.length >= w ? s.slice(0,w) : s.padEnd(w); }
function rpad(s: string, w: number) { return s.padStart(w); }

console.log(`\n${'═'.repeat(HR.length)}`);
console.log(' IQ COMPRESSION — MULTI-MODE COMPARISON  (ratio vs raw · ratio vs ADPCM · µs/chunk)');
console.log('═'.repeat(HR.length));

// Header rows
console.log(pad('Method', W) + DATASETS.map(d => rpad(d.label, colW)).join(''));
console.log(pad('', W) + DATASETS.map(d => rpad(`raw=${allData[DATASETS.indexOf(d)].bytesPerChunk}B adpcm=${Math.round(allData[DATASETS.indexOf(d)].adpcmAvg)}B`, colW)).join(''));
console.log(HR);

// Separator
function isSep(name: string) {
  return name.startsWith('ADPCM computed') || name.startsWith('Deflate L6') ||
         name.startsWith('Deflate L1') || name.startsWith('FLAC L1') ||
         name.startsWith('WavPack de');
}

for (const name of methodNames) {
  if (isSep(name)) console.log(HR.replace(/─/g, '-'));

  const row = pad(name, W);
  const cells = DATASETS.map((_, di) => {
    const r = allData[di].results.find(x => x.name === name);
    if (!r) return rpad('—', colW);
    const us   = isNaN(r.avgUs) ? '  --' : `${Math.round(r.avgUs)}µs`;
    const cell = `${r.ratioVsRaw.toFixed(2)}x/${r.ratioVsAdpcm.toFixed(2)}x ${us}`;
    return rpad(cell, colW);
  });
  console.log(row + cells.join(''));
}

console.log(HR);
console.log('  ratio format: vsRaw / vsADPCM  µs/chunk (CLI codecs include process spawn overhead)');
console.log('  L = lossless baseline (Y), lossy (N)');

// ---- Per-mode best-of summary -----------------------------------------------

console.log(`\n${'═'.repeat(HR.length)}`);
console.log(' BEST LOSSLESS per mode (top 3 by ratio, excluding CLI spawn cost from ranking)');
console.log('═'.repeat(HR.length));

for (let di = 0; di < DATASETS.length; di++) {
  const ds = DATASETS[di];
  const d  = allData[di];
  const bpc = d.bytesPerChunk;
  const chunksPerSec = 50;

  // Exclude CLI-based (identified by avgUs=NaN for CLI, but CLI has very high us due to spawn)
  // Rank zlib separately from CLI codecs
  const zlibBest = [...d.results]
    .filter(r => r.lossless && !r.name.startsWith('FLAC') && !r.name.startsWith('WavPack'))
    .sort((a,b) => a.avgBytes - b.avgBytes)
    .slice(0,3);

  const cliBest = [...d.results]
    .filter(r => r.lossless && (r.name.startsWith('FLAC') || r.name.startsWith('WavPack')))
    .sort((a,b) => a.avgBytes - b.avgBytes)
    .slice(0,2);

  console.log(`\n  ${ds.label}  (raw=${bpc}B · ADPCM=${Math.round(d.adpcmAvg)}B · ${(bpc*chunksPerSec/1024).toFixed(0)} KB/s raw)`);
  console.log(`  ── zlib/deflate ──`);
  for (const r of zlibBest) {
    const cpu = `${(r.avgUs * chunksPerSec / 1000).toFixed(2)}ms/s`;
    console.log(`    ${pad(r.name,W)} ${Math.round(r.avgBytes)}B  ${r.ratioVsRaw.toFixed(2)}x raw  ${r.ratioVsAdpcm.toFixed(2)}x adpcm  cpu=${cpu}`);
  }
  console.log(`  ── FLAC / WavPack (CLI spawn overhead in µs) ──`);
  for (const r of cliBest) {
    console.log(`    ${pad(r.name,W)} ${Math.round(r.avgBytes)}B  ${r.ratioVsRaw.toFixed(2)}x raw  ${r.ratioVsAdpcm.toFixed(2)}x adpcm  spawn=${Math.round(r.avgUs)}µs`);
  }
}

console.log(`\n${'═'.repeat(HR.length)}`);
console.log('  NOTES:');
console.log('  · WFM 240kHz = 9600 Int16/chunk; NFM/AM 48kHz = 1920 Int16/chunk');
console.log('  · "vsRaw" = compression ratio vs uncompressed Int16');
console.log('  · "vsADPCM" = how it compares to ADPCM (>1 = better than ADPCM)');
console.log('  · FLAC/WavPack µs include process spawn — real library cost is ~5-20x lower');
console.log('  · Pi 4 budget: ~1ms/chunk target at 50 chunks/s = 5% of one core per client');
