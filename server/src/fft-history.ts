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

  /** Storage bin count (may differ from live fftSize) */
  readonly binCount: number;

  /** Live FFT size currently being pushed — used for downsampling ratio */
  private liveBinCount: number;

  constructor(
    readonly capacity: number,
    historyBinCount: number,
    liveBinCount: number,
  ) {
    this.binCount = historyBinCount;
    this.liveBinCount = liveBinCount;
    this.buffer = Array.from({ length: capacity }, () => new Uint8Array(historyBinCount));
  }

  get count(): number { return this._count; }

  /**
   * Push a live Float32 FFT frame (dB values, liveBinCount bins).
   * Downsamples to historyBinCount using max-hold if needed, then
   * quantizes to Uint8 and stores.
   */
  push(fftData: Float32Array): void {
    if (fftData.length !== this.liveBinCount) return;

    const slot = this.buffer[this.head];
    const range = FFT_HISTORY_MAX_DB - FFT_HISTORY_MIN_DB;

    if (this.liveBinCount === this.binCount) {
      // 1:1 — no resampling needed
      for (let i = 0; i < this.binCount; i++) {
        const n = (fftData[i] - FFT_HISTORY_MIN_DB) / range;
        slot[i] = n < 0 ? 0 : n > 1 ? 255 : Math.round(n * 255);
      }
    } else {
      // Downsample: each history bin covers (liveBinCount / binCount) live bins.
      // Use max-hold so signal peaks are never lost.
      const ratio = this.liveBinCount / this.binCount;
      for (let h = 0; h < this.binCount; h++) {
        const srcStart = h * ratio;
        const srcEnd   = srcStart + ratio;
        const lo = Math.floor(srcStart);
        const hi = Math.min(Math.ceil(srcEnd), this.liveBinCount);
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

  /**
   * Return all stored frames in chronological order (oldest first).
   * Returns views into the internal buffer — do not mutate.
   */
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

  /**
   * Update live bin count on profile change (different fftSize).
   * Resets the buffer since stored frames are no longer valid.
   */
  setLiveBinCount(newLiveBinCount: number): void {
    this.liveBinCount = newLiveBinCount;
    this.head = 0;
    this._count = 0;
  }
}
