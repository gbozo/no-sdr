// Wire constants shared with serverrs and client/src/shared/protocol.ts.
//
// Browser <-> DO messages are the existing no-sdr binary frames. The DO never
// invents a public message type; history is the existing 0x0D burst with
// codec 4 (per-frame range) for history bursts. 0x10 is FFT_RANGE.

import { encodeRangeHistory } from "./range";

export const MSG_FFT_DEFLATE = 0x0b;
export const MSG_FFT_HISTORY = 0x0d;
export const MSG_FFT_RANGE = 0x10;

export const HISTORY_CODEC_NONE = 0;
export const HISTORY_CODEC_RANGE = 3;
export const HISTORY_CODEC_RANGE_FRAME = 4;

export const MIN_DB = -130;
export const MAX_DB = 0;

export const MIN_BINS = 256;
export const MAX_BINS = 131_072;
export const MAX_INGEST_BYTES = 1 << 20;

export interface DeflateFrame {
  minDb: number;
  maxDb: number;
  bins: number;
  /** Raw DEFLATE bytes (delta-encoded u8 bins). */
  deflate: Uint8Array;
}

export interface RangeFrame {
  minDb: number;
  maxDb: number;
  bins: number;
  /** Range-coded bytes (spatial-delta residual stream). */
  payload: Uint8Array;
}

interface ParsedHeader {
  minDb: number;
  maxDb: number;
  bins: number;
  payload: Uint8Array;
}

function parseHeader(frame: ArrayBuffer, expectedType: number): ParsedHeader {
  if (frame.byteLength < 9) throw new Error("fft frame too short");
  const view = new DataView(frame);
  if (view.getUint8(0) !== expectedType) {
    throw new Error(`unexpected fft type ${view.getUint8(0).toString(16)}`);
  }

  const minDb = view.getInt16(1, true);
  const maxDb = view.getInt16(3, true);
  const bins = view.getUint32(5, true);

  if (bins < MIN_BINS || bins > MAX_BINS) {
    throw new Error(`fft bin count out of range: ${bins}`);
  }
  if (frame.byteLength > MAX_INGEST_BYTES) {
    throw new Error(`fft frame too large: ${frame.byteLength}`);
  }
  if (maxDb <= minDb) throw new Error("invalid fft db range");

  return { minDb, maxDb, bins, payload: new Uint8Array(frame, 9) };
}

/**
 * Parse a full 0x0B wire frame:
 *   [u8 type][i16 minDb][i16 maxDb][u32 binCount][deflate bytes]
 */
export function parseFftDeflate(frame: ArrayBuffer): DeflateFrame {
  const { minDb, maxDb, bins, payload } = parseHeader(frame, MSG_FFT_DEFLATE);
  return { minDb, maxDb, bins, deflate: payload };
}

/**
 * Parse a full 0x10 wire frame:
 *   [u8 type][i16 minDb][i16 maxDb][u32 binCount][range-coded bytes]
 */
export function parseFftRange(frame: ArrayBuffer): RangeFrame {
  const { minDb, maxDb, bins, payload } = parseHeader(frame, MSG_FFT_RANGE);
  return { minDb, maxDb, bins, payload };
}

/** Body of 0x0D, matching client/src/shared/protocol.ts. */
export function packHistory(
  frames: Uint8Array[],
  bins: number,
  minDb: number,
  maxDb: number,
): ArrayBuffer {
  if (frames.length === 0) throw new Error("history requires at least one frame");
  if (frames.length > 0xffff) throw new Error("too many history frames");
  if (bins < 1 || bins > MAX_BINS) throw new Error(`history bin count out of range: ${bins}`);

  const size = 12 + frames.length * bins;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);

  out[0] = MSG_FFT_HISTORY;
  view.setUint16(1, frames.length, true);
  view.setUint32(3, bins, true);
  view.setInt16(7, Math.round(minDb), true);
  view.setInt16(9, Math.round(maxDb), true);
  out[11] = HISTORY_CODEC_NONE;

  let offset = 12;
  for (const frame of frames) {
    if (frame.length !== bins) throw new Error("history frame length mismatch");
    out.set(frame, offset);
    offset += bins;
  }

  return out.buffer;
}

/**
 * Pack a per-frame range history burst (0x0D codec 4). Each frame is
 * independently encoded (fresh probability model) and length-prefixed, so the
 * DO can encode incrementally as frames arrive.
 */
export function packRangeFrameHistory(
  frames: Uint8Array[],
  bins: number,
  minDb: number,
  maxDb: number,
): ArrayBuffer {
  if (frames.length === 0) throw new Error("history requires at least one frame");
  if (frames.length > 0xffff) throw new Error("too many history frames");
  if (bins < 1 || bins > MAX_BINS) throw new Error(`history bin count out of range: ${bins}`);

  let payloadLength = 0;
  for (const frame of frames) payloadLength += 4 + frame.length;

  const out = new Uint8Array(12 + payloadLength);
  const view = new DataView(out.buffer);

  out[0] = MSG_FFT_HISTORY;
  view.setUint16(1, frames.length, true);
  view.setUint32(3, bins, true);
  view.setInt16(7, Math.round(minDb), true);
  view.setInt16(9, Math.round(maxDb), true);
  out[11] = HISTORY_CODEC_RANGE_FRAME;

  let offset = 12;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    offset += 4;
    out.set(frame, offset);
    offset += frame.length;
  }

  return out.buffer;
}

export function isFftType(type: number): boolean {
  return type === MSG_FFT_DEFLATE || type === MSG_FFT_RANGE;
}

/**
 * Pack a history burst using the range codec (0x0D codec 3). The model spans
 * the whole burst; the client decodes it with `decodeRangeHistory`.
 */
export function packRangeHistory(
  frames: Uint8Array[],
  bins: number,
  minDb: number,
  maxDb: number,
): ArrayBuffer {
  if (frames.length === 0) throw new Error("history requires at least one frame");
  if (frames.length > 0xffff) throw new Error("too many history frames");
  if (bins < 1 || bins > MAX_BINS) throw new Error(`history bin count out of range: ${bins}`);

  const payload = encodeRangeHistory(frames, bins);
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);

  out[0] = MSG_FFT_HISTORY;
  view.setUint16(1, frames.length, true);
  view.setUint32(3, bins, true);
  view.setInt16(7, Math.round(minDb), true);
  view.setInt16(9, Math.round(maxDb), true);
  out[11] = HISTORY_CODEC_RANGE;
  out.set(payload, 12);

  return out.buffer;
}
