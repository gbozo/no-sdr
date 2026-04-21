#!/usr/bin/env npx tsx
/**
 * Capture raw FFT frames from a running node-sdr server for compression testing.
 * Connects via WebSocket, subscribes to the first dongle, and saves Float32 FFT frames.
 *
 * Usage: npx tsx scripts/capture-fft.ts [frames] [url]
 *   frames: number of FFT frames to capture (default: 100)
 *   url:    WebSocket URL (default: ws://localhost:3000/ws)
 *
 * Output: scripts/fft-capture.bin (binary: [uint32 frameCount][uint32 binCount][Float32[] frame0][Float32[] frame1]...)
 */

import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  unpackBinaryMessage,
  MSG_FFT_COMPRESSED,
  MSG_META,
} from '@node-sdr/shared';

const maxFrames = parseInt(process.argv[2] || '100', 10);
const wsUrl = process.argv[3] || 'ws://localhost:3000/ws';
const outFile = path.join(import.meta.dirname, 'fft-capture.bin');

console.log(`Capturing ${maxFrames} FFT frames from ${wsUrl}...`);
console.log(`Output: ${outFile}`);

// We request 'none' codec to get MSG_FFT_COMPRESSED (Uint8 quantized) 
// but also capture the raw dB range from the header so we can reconstruct Float32.
// Actually, let's request no codec — we get MSG_FFT_COMPRESSED with min/max header.

const ws = new WebSocket(wsUrl);
const frames: Buffer[] = [];
let binCount = 0;
let subscribed = false;

ws.on('open', () => {
  console.log('Connected. Requesting codec=none for Uint8 FFT...');
  // Fetch dongle list and subscribe to first one
  fetch(wsUrl.replace('ws://', 'http://').replace('/ws', '/api/dongles'))
    .then(r => r.json())
    .then((dongles: any[]) => {
      const dongleId = dongles[0]?.id;
      if (!dongleId) { console.error('No dongles found!'); ws.close(); return; }
      console.log(`Subscribing to ${dongleId}...`);
      ws.send(JSON.stringify({ cmd: 'subscribe', dongleId }));
      ws.send(JSON.stringify({ cmd: 'codec', fftCodec: 'none' }));
    })
    .catch(e => { console.error('Failed to fetch dongles:', e); ws.close(); });
});

ws.on('message', (data: Buffer | ArrayBuffer) => {
  if (frames.length >= maxFrames) return;

  // Handle both Buffer and ArrayBuffer from ws library
  let buf: Buffer;
  if (data instanceof ArrayBuffer) {
    buf = Buffer.from(data);
  } else if (data instanceof Buffer) {
    buf = data;
  } else {
    buf = Buffer.from(data as any);
  }
  
  const type = buf[0];
  const payload = buf.subarray(1);

  if (type === 0x03) {
    // META message — check for subscription confirmation
    try {
      const text = new TextDecoder().decode(payload);
      const meta = JSON.parse(text);
      if (meta.type === 'subscribed') {
        subscribed = true;
        console.log(`Subscribed to ${meta.dongleId}, fftSize=${meta.fftSize}, sampleRate=${meta.sampleRate}`);
      } else if (meta.type === 'error') {
        console.log(`Server error: ${meta.message}`);
      } else {
        console.log(`Meta: ${meta.type}`);
      }
    } catch { /* ignore */ }
    return;
  }

  if (!subscribed) {
    console.log(`Got msg type 0x${type.toString(16).padStart(2, '0')} before subscription`);
    return;
  }

  if (type === 0x04) {
    // MSG_FFT_COMPRESSED: [Int16 minDb LE] [Int16 maxDb LE] [Uint8 data...]
    const minDb = payload.readInt16LE(0);
    const maxDb = payload.readInt16LE(2);
    const uint8Data = payload.subarray(4);
    
    binCount = uint8Data.length;
    
    // Save both Uint8 and reconstructed Float32
    frames.push(Buffer.from(uint8Data)); // raw Uint8 frame
    
    if (frames.length % 10 === 0) {
      process.stdout.write(`\r  Captured ${frames.length}/${maxFrames} frames (${binCount} bins, range ${minDb} to ${maxDb} dB)`);
    }
    
    if (frames.length >= maxFrames) {
      console.log(`\nCapture complete! ${frames.length} frames of ${binCount} bins each.`);
      
      // Save Uint8 frames (what the server quantizes to)
      const uint8OutFile = path.join(import.meta.dirname, 'fft-capture-uint8.bin');
      const uint8Header = Buffer.alloc(12);
      uint8Header.writeUInt32LE(frames.length, 0);
      uint8Header.writeUInt32LE(binCount, 4);
      uint8Header.writeInt16LE(minDb, 8);
      uint8Header.writeInt16LE(maxDb, 10);
      fs.writeFileSync(uint8OutFile, Buffer.concat([uint8Header, ...frames]));
      console.log(`Written ${frames.length} Uint8 frames (${binCount} bins) to ${uint8OutFile}`);

      // Also save Float32 reconstruction
      const f32OutFile = path.join(import.meta.dirname, 'fft-capture-f32.bin');
      const range = maxDb - minDb;
      const f32Header = Buffer.alloc(8);
      f32Header.writeUInt32LE(frames.length, 0);
      f32Header.writeUInt32LE(binCount, 4);
      const f32Frames: Buffer[] = [f32Header];
      for (const frame of frames) {
        const f32 = new Float32Array(frame.length);
        for (let i = 0; i < frame.length; i++) {
          f32[i] = minDb + (frame[i] / 255) * range;
        }
        f32Frames.push(Buffer.from(f32.buffer));
      }
      fs.writeFileSync(f32OutFile, Buffer.concat(f32Frames));
      console.log(`Written Float32 version to ${f32OutFile}`);
      
      ws.close();
    }
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('Disconnected.');
  process.exit(0);
});

// Timeout after 30s
setTimeout(() => {
  if (frames.length < maxFrames) {
    console.log(`\nTimeout! Only captured ${frames.length}/${maxFrames} frames.`);
    ws.close();
  }
}, 30000);
