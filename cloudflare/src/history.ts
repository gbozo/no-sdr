// DO-side waterfall history.
//
// The origin sends range-coded (0x10) frames by default; deflate-smooth (0x0B)
// is supported as a fallback. We decode the frame, max-hold decimate to a small
// bin count, and keep a fixed ring. New viewers receive the ring as one 0x0D
// codec-0 message. The DO never re-encodes history per viewer and never uses
// KV/R2.

import { inflateSync } from "fflate";
import { MAX_BINS } from "./protocol";

/**
 * Decode the compressed body of a deflate-smooth frame.
 *
 * serverrs delta-encodes the u8 bins backwards before deflating, so decoding
 * is a forward cumulative sum. `body` is the raw DEFLATE stream.
 */
export function decodeDeflateSmooth(body: Uint8Array, bins: number): Uint8Array {
  if (bins < 1 || bins > MAX_BINS) throw new Error(`invalid bin count ${bins}`);
  const delta = inflateSync(body);
  if (delta.length !== bins) {
    throw new Error(`inflated size ${delta.length} != ${bins}`);
  }

  const out = new Uint8Array(bins);
  let prev = 0;
  for (let i = 0; i < bins; i++) {
    prev = (prev + delta[i]) & 0xff;
    out[i] = prev;
  }
  return out;
}

/**
 * Max-hold decimate `src` to `outBins`. The values are linear in dB, so max
 * preserves narrow carriers and peaks better than averaging.
 */
export function decimateMaxHold(src: Uint8Array, outBins: number): Uint8Array {
  if (outBins < 1 || outBins > src.length) {
    throw new Error(`invalid output bin count ${outBins} for ${src.length} bins`);
  }

  const out = new Uint8Array(outBins);
  const ratio = src.length / outBins;

  for (let j = 0; j < outBins; j++) {
    const start = Math.floor(j * ratio);
    const end = Math.max(start + 1, Math.floor((j + 1) * ratio));
    let max = 0;
    for (let i = start; i < end && i < src.length; i++) {
      if (src[i] > max) max = src[i];
    }
    out[j] = max;
  }

  return out;
}

/** Fixed-capacity ring of decimated u8 frames. */
export class HistoryRing {
  readonly bins: number;
  readonly capacity: number;

  private frames: Array<Uint8Array | undefined>;
  private head = 0;
  private count = 0;

  constructor(bins: number, capacity: number) {
    if (bins < 1 || bins > MAX_BINS) throw new Error(`invalid ring bins ${bins}`);
    if (capacity < 1) throw new Error(`invalid ring capacity ${capacity}`);
    this.bins = bins;
    this.capacity = capacity;
    this.frames = new Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(frame: Uint8Array): void {
    if (frame.length !== this.bins) {
      throw new Error(`ring frame length ${frame.length} != ${this.bins}`);
    }
    this.frames[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Oldest-first snapshot, capped at `limit`. */
  snapshot(limit = this.capacity): Uint8Array[] {
    const n = Math.min(this.count, Math.max(0, limit));
    const out: Uint8Array[] = [];
    const start = (this.head - this.count + this.capacity * 2) % this.capacity;

    for (let i = this.count - n; i < this.count; i++) {
      const frame = this.frames[(start + i) % this.capacity];
      if (frame) out.push(frame);
    }
    return out;
  }

  clear(): void {
    this.frames = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}

/** Fixed-capacity ring of already range-encoded history payloads. */
export class PayloadRing {
  readonly capacity: number;
  private frames: Array<Uint8Array | undefined>;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error(`invalid ring capacity ${capacity}`);
    this.capacity = capacity;
    this.frames = new Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(payload: Uint8Array): void {
    this.frames[this.head] = payload;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Oldest-first snapshot, capped at `limit`. */
  snapshot(limit = this.capacity): Uint8Array[] {
    const n = Math.min(this.count, Math.max(0, limit));
    const out: Uint8Array[] = [];
    const start = (this.head - this.count + this.capacity * 2) % this.capacity;

    for (let i = this.count - n; i < this.count; i++) {
      const frame = this.frames[(start + i) % this.capacity];
      if (frame) out.push(frame);
    }
    return out;
  }

  clear(): void {
    this.frames = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
