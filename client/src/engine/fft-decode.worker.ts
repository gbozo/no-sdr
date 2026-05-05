// ============================================================
// node-sdr — FFT Decode Worker
// ============================================================
// Runs FFT decompression entirely off the main thread.
// Receives raw ArrayBuffer payloads from the WebSocket handler,
// decodes them (inflate / ADPCM / uint8-expand), and posts back
// a transferable Float32Array so the main thread does zero decode work.
//
// Message in:
//   { id: number, type: FftMsgType, payload: ArrayBuffer }  (payload transferred)
//
// Message out:
//   { id: number, fftData: Float32Array, wireBytes: number, rawBytes: number }
//   (fftData transferred)
// ============================================================

import { inflateSync } from 'fflate';
import { decodeFftAdpcm } from '~/shared';

// Keep numeric constants local — avoids importing the full shared bundle
const MSG_FFT           = 0x01;
const MSG_FFT_COMPRESSED = 0x04;
const MSG_FFT_ADPCM     = 0x08;
const MSG_FFT_DEFLATE   = 0x0B;

export type FftMsgType =
  | typeof MSG_FFT
  | typeof MSG_FFT_COMPRESSED
  | typeof MSG_FFT_ADPCM
  | typeof MSG_FFT_DEFLATE;

export interface FftDecodeRequest {
  id: number;
  type: FftMsgType;
  payload: ArrayBuffer;
}

export interface FftDecodeResult {
  id: number;
  fftData: Float32Array;
  wireBytes: number;
  rawBytes: number;
}

self.onmessage = (e: MessageEvent<FftDecodeRequest>) => {
  const { id, type, payload } = e.data;
  const wireBytes = payload.byteLength;

  try {
    let fftData: Float32Array;

    switch (type) {
      case MSG_FFT: {
        // Raw Float32 — no decode needed, just wrap
        fftData = new Float32Array(payload);
        break;
      }

      case MSG_FFT_COMPRESSED: {
        // 4-byte header [Int16 minDb LE, Int16 maxDb LE] + Uint8 bins
        const hv = new DataView(payload);
        const minDb = hv.getInt16(0, true);
        const maxDb = hv.getInt16(2, true);
        const range = maxDb - minDb;
        const compressed = new Uint8Array(payload, 4);
        fftData = new Float32Array(compressed.length);
        for (let i = 0; i < compressed.length; i++) {
          fftData[i] = minDb + (compressed[i] / 255) * range;
        }
        break;
      }

      case MSG_FFT_ADPCM: {
        fftData = decodeFftAdpcm(payload);
        break;
      }

      case MSG_FFT_DEFLATE: {
        // 8-byte header [Int16 minDb LE, Int16 maxDb LE, Uint32 binCount LE] + deflate
        const hv = new DataView(payload);
        const minDb = hv.getInt16(0, true);
        const maxDb = hv.getInt16(2, true);
        const binCount = hv.getUint32(4, true);
        const deflPayload = new Uint8Array(payload, 8);

        const delta = inflateSync(deflPayload);

        // Undo delta encoding
        const uint8Bins = new Uint8Array(binCount);
        uint8Bins[0] = delta[0];
        for (let i = 1; i < binCount; i++) {
          uint8Bins[i] = (uint8Bins[i - 1] + delta[i]) & 0xFF;
        }

        const range = maxDb - minDb;
        fftData = new Float32Array(binCount);
        for (let i = 0; i < binCount; i++) {
          fftData[i] = minDb + (uint8Bins[i] / 255) * range;
        }
        break;
      }

      default:
        return; // unknown type — drop silently
    }

    const rawBytes = fftData.length * 4;
    const result: FftDecodeResult = { id, fftData, wireBytes, rawBytes };
    self.postMessage(result, { transfer: [fftData.buffer] });

  } catch (err) {
    // Post a zero-length result so callers don't hang waiting
    const fftData = new Float32Array(0);
    self.postMessage({ id, fftData, wireBytes, rawBytes: 0 } satisfies FftDecodeResult, { transfer: [fftData.buffer] });
  }
};
