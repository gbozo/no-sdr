// ============================================================
// node-sdr — FFT History Buffer
// ============================================================
// Circular buffer of recent FFT frames per dongle.
// Stored at a fixed historyBinCount (independent of live fftSize)
// using max-hold downsampling — preserves signal peaks even when
// many live bins map to one history bin.
// ============================================================

export const FFT_HISTORY_MIN_DB = -130;
export const FFT_HISTORY_MAX_DB = 0;

/**
 * Fixed-capacity circular buffer of Uint8-quantized FFT frames.
 * Frames are stored at historyBinCount resolution, downsampled from
 * the live fftSize if needed. Clients interpolate back up on display.
 */
export class FftHistoryBuffer {
  private buffer: Uint8Array[];
  private head = 0;
  private _count = 0;

  readonly binCount: number;
  private liveBinCount: number;

  // Precomputed downsample index ranges — avoids float multiply/floor/ceil per bin per frame.
  // Each entry is [lo, hi] source bin indices for one history bin.
  private srcRanges: Int32Array = new Int32Array(0); // pairs: [lo0, hi0, lo1, hi1, ...]

  constructor(
    readonly capacity: number,
    historyBinCount: number,
    liveBinCount: number,
  ) {
    this.binCount = historyBinCount;
    this.liveBinCount = liveBinCount;
    this.buffer = Array.from({ length: capacity }, () => new Uint8Array(historyBinCount));
    this.computeSrcRanges();
  }

  get count(): number { return this._count; }

  private computeSrcRanges(): void {
    if (this.liveBinCount === this.binCount) {
      this.srcRanges = new Int32Array(0); // 1:1 — not used
      return;
    }
    const ranges = new Int32Array(this.binCount * 2);
    const ratio = this.liveBinCount / this.binCount;
    for (let h = 0; h < this.binCount; h++) {
      const srcStart = h * ratio;
      ranges[h * 2]     = Math.floor(srcStart);
      ranges[h * 2 + 1] = Math.min(Math.ceil(srcStart + ratio), this.liveBinCount);
    }
    this.srcRanges = ranges;
  }

  push(fftData: Float32Array): void {
    if (fftData.length !== this.liveBinCount) return;

    const slot = this.buffer[this.head];
    const range = FFT_HISTORY_MAX_DB - FFT_HISTORY_MIN_DB;

    if (this.liveBinCount === this.binCount) {
      for (let i = 0; i < this.binCount; i++) {
        const n = (fftData[i] - FFT_HISTORY_MIN_DB) / range;
        slot[i] = n < 0 ? 0 : n > 1 ? 255 : Math.round(n * 255);
      }
    } else {
      // Downsample using precomputed index ranges (max-hold)
      const ranges = this.srcRanges;
      for (let h = 0; h < this.binCount; h++) {
        const lo = ranges[h * 2];
        const hi = ranges[h * 2 + 1];
        let maxDb = fftData[lo];
        for (let s = lo + 1; s < hi; s++) {
          if (fftData[s] > maxDb) maxDb = fftData[s];
        }
        const n = (maxDb - FFT_HISTORY_MIN_DB) / range;
        slot[h] = n < 0 ? 0 : n > 1 ? 255 : Math.round(n * 255);
      }
    }

    this.head = (this.head + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
  }

  getFrames(): Uint8Array[] {
    if (this._count === 0) return [];
    const out: Uint8Array[] = new Array(this._count);
    const start = (this.head - this._count + this.capacity) % this.capacity;
    for (let i = 0; i < this._count; i++) {
      out[i] = this.buffer[(start + i) % this.capacity];
    }
    return out;
  }

  reset(): void {
    this.head = 0;
    this._count = 0;
  }

  setLiveBinCount(newLiveBinCount: number): void {
    this.liveBinCount = newLiveBinCount;
    this.computeSrcRanges();
    this.head = 0;
    this._count = 0;
  }
}
