// ============================================================
// node-sdr — Range-coded FFT decoder
// ============================================================
// Mirrors serverrs/src/codec/range.rs: LZMA-style binary range coder with a
// run-length zero model over the spatial-delta residual stream.
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
