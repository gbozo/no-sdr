#!/usr/bin/env npx tsx
/**
 * Capture raw IQ chunks from a running node-sdr server for compression benchmarking.
 * Connects via WebSocket, subscribes to the first dongle, and saves two captures:
 *
 *   1. Raw IQ (iqCodec: 'none') → iq-capture-raw.bin
 *      Format: [Uint32 chunkCount][Uint32 samplesPerChunk][Uint32 iqSampleRate]
 *              [chunk0: Int16Array bytes][chunk1: Int16Array bytes]...
 *
 *   2. ADPCM wire sizes (iqCodec: 'adpcm') → iq-capture-adpcm-sizes.bin
 *      Format: [Uint32 chunkCount][Uint32 wireSize0][Uint32 wireSize1]...
 *
 * Usage: npx tsx scripts/capture-iq.ts [chunks] [url]
 *   chunks: number of IQ chunks to capture per pass (default: 500)
 *   url:    WebSocket URL (default: ws://localhost:3000/ws)
 *
 * Requires a running dev server with at least one dongle streaming IQ data.
 * The server must be in WFM mode (240kHz IQ rate) for meaningful results.
 */

import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';

const maxChunks = parseInt(process.argv[2] || '500', 10);
const wsUrl = process.argv[3] || 'ws://localhost:3000/ws';
const httpBase = wsUrl.replace('ws://', 'http://').replace('/ws', '');

const rawOutFile = path.join(import.meta.dirname, 'iq-capture-raw.bin');
const adpcmSizesFile = path.join(import.meta.dirname, 'iq-capture-adpcm-sizes.bin');

const MSG_META = 0x03;
const MSG_IQ = 0x02;
const MSG_IQ_ADPCM = 0x09;

// ---- helpers ----------------------------------------------------------------

function getDongles(): Promise<any[]> {
  return fetch(`${httpBase}/api/dongles`)
    .then(r => r.json()) as Promise<any[]>;
}

function capturePass(
  dongleId: string,
  iqCodec: 'none' | 'adpcm',
  mode: string,
  onChunk: (wireBytes: number, payload: Buffer) => void,
): Promise<{ iqSampleRate: number; samplesPerChunk: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let subscribed = false;
    let iqSampleRate = 0;
    let samplesPerChunk = 0;
    let chunkCount = 0;
    let settled = false;

    const label = iqCodec === 'none' ? 'Raw IQ' : 'ADPCM';
    console.log(`\n[${label}] Connecting to ${wsUrl}...`);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.log(`\n[${label}] Timeout after ${chunkCount} chunks.`);
        ws.close();
        reject(new Error(`Timeout — only got ${chunkCount}/${maxChunks} chunks`));
      }
    }, 60_000);

    ws.on('open', () => {
      console.log(`[${label}] Connected. Subscribing to ${dongleId}...`);
      ws.send(JSON.stringify({ cmd: 'subscribe', dongleId }));
    });

    ws.on('message', (data: Buffer | ArrayBuffer) => {
      const buf: Buffer = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
      const type = buf[0];
      const payload = buf.subarray(1);

      if (type === MSG_META) {
        try {
          const meta = JSON.parse(new TextDecoder().decode(payload));
          if (meta.type === 'subscribed') {
            subscribed = true;
            iqSampleRate = meta.iqSampleRate ?? 240_000;
            samplesPerChunk = Math.round(iqSampleRate * 0.020) * 2; // 20ms → IQ pairs × 2
            console.log(`[${label}] Subscribed: mode=${meta.mode}, iqSampleRate=${iqSampleRate}, samplesPerChunk=${samplesPerChunk}`);
            // Enable IQ flow
            ws.send(JSON.stringify({ cmd: 'audio_enabled', enabled: true }));
            ws.send(JSON.stringify({ cmd: 'codec', iqCodec }));
            console.log(`[${label}] Audio enabled, codec=${iqCodec}. Waiting for chunks...`);
          } else if (meta.type === 'error') {
            console.error(`[${label}] Server error: ${meta.message}`);
          }
        } catch { /* ignore */ }
        return;
      }

      if (!subscribed) return;

      const isTarget = (iqCodec === 'none' && type === MSG_IQ) ||
                       (iqCodec === 'adpcm' && type === MSG_IQ_ADPCM);
      if (!isTarget) return;

      chunkCount++;
      onChunk(buf.length, payload);

      if (chunkCount % 50 === 0 || chunkCount === maxChunks) {
        process.stdout.write(`\r  [${label}] ${chunkCount}/${maxChunks} chunks`);
      }

      if (chunkCount >= maxChunks) {
        if (!settled) {
          settled = true;
          console.log(`\n[${label}] Capture complete.`);
          clearTimeout(timeout);
          ws.close();
          resolve({ iqSampleRate, samplesPerChunk });
        }
      }
    });

    ws.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(err); }
    });

    ws.on('close', () => {
      if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('WS closed unexpectedly')); }
    });
  });
}

// ---- main -------------------------------------------------------------------

async function main() {
  console.log(`=== IQ Capture ===`);
  console.log(`Target: ${maxChunks} chunks per pass, ${wsUrl}`);

  // Fetch dongle list
  let dongles: any[];
  try {
    dongles = await getDongles();
  } catch (e) {
    console.error(`Failed to fetch dongles from ${httpBase}/api/dongles:`, e);
    process.exit(1);
  }
  if (!dongles.length) { console.error('No dongles found!'); process.exit(1); }
  const dongle = dongles[0];
  const dongleId = dongle.id;
  const mode = dongle.activeProfile?.defaultMode ?? 'wfm';
  console.log(`Using dongle: ${dongleId}, mode: ${mode}`);

  // ---- Pass 1: raw IQ -------------------------------------------------------
  const rawChunks: Buffer[] = [];
  let rawMeta = { iqSampleRate: 240_000, samplesPerChunk: 9_600 };

  rawMeta = await capturePass(dongleId, 'none', mode, (_wireBytes, payload) => {
    // payload is the raw Int16Array bytes (no header for MSG_IQ)
    rawChunks.push(Buffer.from(payload));
  });

  // Write raw capture file
  const { iqSampleRate, samplesPerChunk } = rawMeta;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(rawChunks.length, 0);
  header.writeUInt32LE(samplesPerChunk, 4);
  header.writeUInt32LE(iqSampleRate, 8);
  fs.writeFileSync(rawOutFile, Buffer.concat([header, ...rawChunks]));
  const rawBytes = rawChunks.reduce((s, c) => s + c.length, 0);
  console.log(`\nWrote ${rawChunks.length} raw IQ chunks (${rawBytes.toLocaleString()} bytes total) → ${rawOutFile}`);

  // ---- Pass 2: ADPCM wire sizes ---------------------------------------------
  const adpcmWireSizes: number[] = [];

  await capturePass(dongleId, 'adpcm', mode, (wireBytes) => {
    adpcmWireSizes.push(wireBytes);
  });

  // Write ADPCM sizes file
  const sizeBuf = Buffer.alloc(4 + adpcmWireSizes.length * 4);
  sizeBuf.writeUInt32LE(adpcmWireSizes.length, 0);
  for (let i = 0; i < adpcmWireSizes.length; i++) {
    sizeBuf.writeUInt32LE(adpcmWireSizes[i], 4 + i * 4);
  }
  fs.writeFileSync(adpcmSizesFile, sizeBuf);
  const adpcmAvg = adpcmWireSizes.reduce((s, v) => s + v, 0) / adpcmWireSizes.length;
  console.log(`\nWrote ${adpcmWireSizes.length} ADPCM wire sizes (avg ${Math.round(adpcmAvg)} B/chunk) → ${adpcmSizesFile}`);

  console.log('\n=== Capture done. Run benchmark-iq-compression.ts next. ===');
}

main().catch(e => { console.error(e); process.exit(1); });
