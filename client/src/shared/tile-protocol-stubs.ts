// ============================================================
// node-sdr — Tiled Waterfall Protocol (CLIENT STUBS)
// ============================================================
// TODO(merge): replace with client/src/shared/protocol.ts exports.
//
// The segmented multi-tier waterfall protocol (packWaterfallView, the tiled
// FFT/history decoders, and the `waterfallProtocol` / `waterfallTileBins` meta
// fields) is being added on a sibling branch that owns protocol.ts. To avoid a
// merge collision this worktree does NOT edit protocol.ts; instead it imports
// these minimal, wire-compatible stubs. When the branches merge, repoint the
// imports in sdr-engine.ts / store / SignalAnalysis.tsx at `~/shared` (the
// protocol branch) and delete this file.
//
// Wire layouts mirrored here so the stubs decode real server frames even before
// the merge (keeps the client runnable against a tiled server):
//
//   Tiled FFT frame (type byte 0x01/0x04/0x08/0x0B, already stripped):
//     [u8 tier][u8 tileIndex][u8 tileCount][u8 reserved] + legacy FFT payload
//   Tiled history (0x0D, already stripped):
//     [u8 tier][u8 tileIndex][u8 tileCount][u8 reserved] + legacy history payload
//
// If the real protocol layout differs, the merge replaces these.
// ============================================================

import { inflateSync } from 'fflate';
import { decodeFftAdpcm } from './adpcm';

const MSG_FFT            = 0x01;
const MSG_FFT_COMPRESSED = 0x04;
const MSG_FFT_ADPCM      = 0x08;
const MSG_FFT_DEFLATE    = 0x0b;

const HIST_CODEC_NONE    = 0;
const HIST_CODEC_DEFLATE = 1;
const HIST_CODEC_ADPCM   = 2;

/** 4-byte tile tag prepended to every tiled frame. */
const TILE_HEADER_BYTES = 4;

/** Decoded tiled FFT frame — bins already dequantized/inflated. */
export interface TiledFftFrame {
  tier: number;
  tileIndex: number;
  tileCount: number;
  minDb: number;
  maxDb: number;
  binCount: number;
  bins: Float32Array;
}

/** Decoded tiled history burst — frames oldest-first, bins dequantized. */
export interface TiledFftHistory {
  tier: number;
  tileIndex: number;
  tileCount: number;
  frameCount: number;
  binCount: number;
  minDb: number;
  maxDb: number;
  frames: Float32Array[];
}

/**
 * Decode a tiled FFT frame (type 0x01/0x04/0x08/0x0B). The message-type byte
 * must already have been stripped (as `unpackBinaryMessage` does). Returns null
 * if the payload is too small or malformed.
 */
export function decodeTiledFftFrame(type: number, payload: ArrayBuffer): TiledFftFrame | null {
  if (payload.byteLength < TILE_HEADER_BYTES) return null;
  const hv = new DataView(payload);
  const tier = hv.getUint8(0);
  const tileIndex = hv.getUint8(1);
  const tileCount = hv.getUint8(2);
  const body = payload.slice(TILE_HEADER_BYTES);

  let bins: Float32Array;
  let minDb = 0;
  let maxDb = 0;

  switch (type) {
    case MSG_FFT: {
      bins = new Float32Array(body);
      break;
    }
    case MSG_FFT_COMPRESSED: {
      const bv = new DataView(body);
      minDb = bv.getInt16(0, true);
      maxDb = bv.getInt16(2, true);
      const range = maxDb - minDb;
      const comp = new Uint8Array(body, 4);
      bins = new Float32Array(comp.length);
      for (let i = 0; i < comp.length; i++) bins[i] = minDb + (comp[i] / 255) * range;
      break;
    }
    case MSG_FFT_ADPCM: {
      bins = decodeFftAdpcm(body);
      break;
    }
    case MSG_FFT_DEFLATE: {
      const bv = new DataView(body);
      minDb = bv.getInt16(0, true);
      maxDb = bv.getInt16(2, true);
      const binCount = bv.getUint32(4, true);
      const defl = new Uint8Array(body, 8);
      const delta = inflateSync(defl);
      const u8 = new Uint8Array(binCount);
      u8[0] = delta[0];
      for (let i = 1; i < binCount; i++) u8[i] = (u8[i - 1] + delta[i]) & 0xff;
      const range = maxDb - minDb;
      bins = new Float32Array(binCount);
      for (let i = 0; i < binCount; i++) bins[i] = minDb + (u8[i] / 255) * range;
      break;
    }
    default:
      return null;
  }

  return { tier, tileIndex, tileCount, minDb, maxDb, binCount: bins.length, bins };
}

/**
 * Decode a tiled waterfall-history burst (type 0x0D). The message-type byte
 * must already have been stripped. Returns null on malformed input.
 */
export function decodeTiledFftHistory(payload: ArrayBuffer): TiledFftHistory | null {
  if (payload.byteLength < TILE_HEADER_BYTES + 11) return null;
  const hv = new DataView(payload);
  const tier = hv.getUint8(0);
  const tileIndex = hv.getUint8(1);
  const tileCount = hv.getUint8(2);

  const body = payload.slice(TILE_HEADER_BYTES);
  const v = new DataView(body);
  const frameCount = v.getUint16(0, true);
  const binCount = v.getUint32(2, true);
  const minDb = v.getInt16(6, true);
  const maxDb = v.getInt16(8, true);
  const codec = v.getUint8(10);
  if (frameCount === 0 || binCount === 0) return null;

  const total = frameCount * binCount;
  const range = maxDb - minDb;
  let flat: Float32Array;

  if (codec === HIST_CODEC_DEFLATE) {
    const defl = new Uint8Array(body, 11);
    const delta = inflateSync(defl);
    const u8 = new Uint8Array(total);
    u8[0] = delta[0];
    for (let i = 1; i < total; i++) u8[i] = (u8[i - 1] + delta[i]) & 0xff;
    flat = new Float32Array(total);
    for (let i = 0; i < total; i++) flat[i] = minDb + (u8[i] / 255) * range;
  } else if (codec === HIST_CODEC_ADPCM) {
    flat = decodeFftAdpcm(body.slice(11));
  } else {
    // HIST_CODEC_NONE — raw Uint8 frames.
    const u8 = new Uint8Array(body, 11, total);
    flat = new Float32Array(total);
    for (let i = 0; i < total; i++) flat[i] = minDb + (u8[i] / 255) * range;
  }

  const frames: Float32Array[] = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    frames[f] = flat.subarray(f * binCount, (f + 1) * binCount);
  }

  return { tier, tileIndex, tileCount, frameCount, binCount, minDb, maxDb, frames };
}

/** The `waterfall_view` client command object (JSON-serializable). */
export interface WaterfallViewCommand {
  cmd: 'waterfall_view';
  viewportPx: number;
  startFrac: number;
  endFrac: number;
  fps?: number;
}

/**
 * Build a `waterfall_view` command. The server picks tier + overlapping tiles
 * from viewportPx and the [startFrac, endFrac] fraction of the full dongle span.
 */
export function packWaterfallView(
  viewportPx: number,
  startFrac: number,
  endFrac: number,
  fps?: number,
): WaterfallViewCommand {
  const cmd: WaterfallViewCommand = {
    cmd: 'waterfall_view',
    viewportPx: Math.max(1, Math.round(viewportPx)),
    startFrac: Math.max(0, Math.min(1, startFrac)),
    endFrac: Math.max(0, Math.min(1, endFrac)),
  };
  if (fps != null) cmd.fps = fps;
  return cmd;
}

/**
 * Optional meta fields carried by `welcome` / `subscribed` / `profile_changed`
 * once the protocol branch extends ServerMeta. Until then, read them off the
 * raw meta object via this shape to keep the full-span path untouched.
 * TODO(merge): these become part of ServerMeta in protocol.ts.
 */
export interface WaterfallMetaFields {
  waterfallProtocol?: number;
  waterfallTileBins?: number;
}
