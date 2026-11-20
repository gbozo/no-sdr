// ============================================================
// node-sdr — Range-coded FFT decoder (Cloudflare edge copy)
// ============================================================
// Mirrors serverrs/src/codec/range.rs and client/src/shared/range-decoder.ts.
// Keep the three in sync; cloudflare/test/range.test.ts pins a Rust fixture.
//
// Wire body (header already stripped):
//   range-coded bytes -> u8 codes -> dB
// ============================================================

const PROB_BITS = 11;
const PROB_INIT = 1 << (PROB_BITS - 1); // 1024
const MOVE_BITS = 5;
const TREE_SIZE = 0x300;
const BYTE_CTX_BITS = 1;
const ZERO_CONTEXTS = 32;

// Reused across frames: the decode worker is single-threaded and processes
// one message at a time, so no allocation per frame is needed.
const zeroProbs = new Uint16Array(ZERO_CONTEXTS);
const byteProbs = new Uint16Array((1 << BYTE_CTX_BITS) * TREE_SIZE);
function resetProbs(): void {
  zeroProbs.fill(PROB_INIT);
  byteProbs.fill(PROB_INIT);
}

class RangeDecoder {
  private code = 0;
  private range = 0xffffffff;
  private pos = 0;

  constructor(private readonly data: Uint8Array) {
    for (let i = 0; i < 5; i++) {
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }

  private byte(): number {
    return this.pos < this.data.length ? this.data[this.pos++] : 0;
  }

  bit(probs: Uint16Array, idx: number): number {
    const p = probs[idx];
    const bound = (Math.imul(this.range >>> PROB_BITS, p) >>> 0);
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[idx] = (p + ((1 << PROB_BITS) - p >>> MOVE_BITS)) & 0xffff;
      bit = 0;
    } else {
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      probs[idx] = p - (p >>> MOVE_BITS);
      bit = 1;
    }
    while (this.range < (1 << 24)) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
    return bit;
  }
}

function decodeByte(dec: RangeDecoder, probs: Uint16Array, ctx: number): number {
  const base = ctx * TREE_SIZE;
  let state = 1;
  for (let i = 0; i < 8; i++) {
    const bit = dec.bit(probs, base + state);
    state = (state << 1) | bit;
  }
  return state - 0x100;
}

/**
 * Decode a range-coded FFT-history burst into flat u8 codes.
 * Delta resets at each frame; the probability model spans the whole burst.
 */
export function decodeRangeHistory(
  payload: Uint8Array,
  frameCount: number,
  frameBins: number,
): Uint8Array {
  resetProbs();
  const dec = new RangeDecoder(payload);
  const out = new Uint8Array(frameCount * frameBins);
  let prevRes = 0;
  let run = 0;
  let magClass = 0;

  for (let f = 0; f < frameCount; f++) {
    let prevCode = 0;
    for (let i = 0; i < frameBins; i++) {
      const zctx = Math.min(run, 15) | (magClass << 4);
      const isZero = dec.bit(zeroProbs, zctx) === 1;
      let b: number;
      if (isZero) {
        b = 0;
        run++;
      } else {
        b = decodeByte(dec, byteProbs, prevRes >> (8 - BYTE_CTX_BITS));
        const circ = Math.min(b, 256 - b);
        magClass = circ >= 4 ? 1 : 0;
        prevRes = b;
        run = 0;
      }
      prevCode = (prevCode + b) & 0xff;
      out[f * frameBins + i] = prevCode;
    }
  }
  return out;
}

/**
 * Decode a range-coded FFT body into dB magnitudes.
 *
 * @param payload range-coded bytes (after the 8-byte header)
 * @param binCount number of bins (from the header)
 * @param minDb header minimum dB
 * @param maxDb header maximum dB
 */
export function decodeRangeFft(
  payload: Uint8Array,
  binCount: number,
  minDb: number,
  maxDb: number,
): Float32Array {
  resetProbs();
  const dec = new RangeDecoder(payload);

  const span = maxDb - minDb;
  const out = new Float32Array(binCount);
  let prevCode = 0;
  let prevRes = 0;
  let run = 0;
  let magClass = 0;

  for (let i = 0; i < binCount; i++) {
    const zctx = Math.min(run, 15) | (magClass << 4);
    const isZero = dec.bit(zeroProbs, zctx) === 1;
    let b: number;
    if (isZero) {
      b = 0;
      run++;
    } else {
      b = decodeByte(dec, byteProbs, prevRes >> (8 - BYTE_CTX_BITS));
      const circ = Math.min(b, 256 - b);
      magClass = circ >= 4 ? 1 : 0;
      prevRes = b;
      run = 0;
    }
    prevCode = (prevCode + b) & 0xff;
    out[i] = minDb + (prevCode / 255) * span;
  }
  return out;
}

/** Decode one live range-coded FFT frame into u8 codes (history ring path). */
export function decodeRangeFrame(payload: Uint8Array, bins: number): Uint8Array {
  return decodeRangeHistory(payload, 1, bins);
}

// ---------------------------------------------------------------------------
// Encoder (history bursts)
// ---------------------------------------------------------------------------

class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private out: number[] = [];

  private shiftLow(): void {
    const low32 = this.low >>> 0;
    if (low32 < 0xff000000 || this.low >= 0x100000000) {
      const carry = Math.floor(this.low / 0x100000000) & 0xff;
      let temp = this.cache;
      for (;;) {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
        this.cacheSize--;
        if (this.cacheSize === 0) break;
      }
      this.cache = (low32 >>> 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (low32 << 8) >>> 0;
  }

  bit(probs: Uint16Array, idx: number, bit: number): void {
    const p = probs[idx];
    const bound = Math.floor(this.range / (1 << PROB_BITS)) * p;
    if (bit === 0) {
      this.range = bound;
      probs[idx] = (p + (((1 << PROB_BITS) - p) >>> MOVE_BITS)) & 0xffff;
    } else {
      this.low += bound;
      this.range = (this.range - bound) >>> 0;
      probs[idx] = p - (p >>> MOVE_BITS);
    }
    while (this.range < (1 << 24)) {
      this.range = (this.range << 8) >>> 0;
      this.shiftLow();
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return Uint8Array.from(this.out);
  }
}

function encodeByte(
  enc: RangeEncoder,
  probs: Uint16Array,
  ctx: number,
  byte: number,
): void {
  const base = ctx * TREE_SIZE;
  let state = 1;
  for (let i = 7; i >= 0; i--) {
    const bit = (byte >>> i) & 1;
    enc.bit(probs, base + state, bit);
    state = (state << 1) | bit;
  }
}

/**
 * Encode a history burst: per-frame delta (reset at each frame), with the
 * probability model persisting across the whole burst. This is the exact
 * counterpart of `decodeRangeHistory` and `range.rs::encode_history`.
 */
export function encodeRangeHistory(frames: Uint8Array[], bins: number): Uint8Array {
  const zeroProbs = new Uint16Array(ZERO_CONTEXTS).fill(PROB_INIT);
  const byteProbs = new Uint16Array((1 << BYTE_CTX_BITS) * TREE_SIZE).fill(PROB_INIT);
  const enc = new RangeEncoder();

  let prevRes = 0;
  let run = 0;
  let magClass = 0;

  for (const frame of frames) {
    if (frame.length !== bins) throw new Error("history frame length mismatch");
    let prevCode = 0;
    for (let i = 0; i < bins; i++) {
      const code = frame[i];
      const b = (code - prevCode) & 0xff;
      prevCode = code;
      const zctx = Math.min(run, 15) | (magClass << 4);
      enc.bit(zeroProbs, zctx, b === 0 ? 1 : 0);
      if (b !== 0) {
        encodeByte(enc, byteProbs, prevRes >> (8 - BYTE_CTX_BITS), b);
        const circ = Math.min(b, 256 - b);
        magClass = circ >= 4 ? 1 : 0;
        prevRes = b;
        run = 0;
      } else {
        run++;
      }
    }
  }

  return enc.finish();
}

/** Encode one decimated history frame with a fresh model (per-frame codec). */
export function encodeRangeFrame(frame: Uint8Array): Uint8Array {
  return encodeRangeHistory([frame], frame.length);
}
