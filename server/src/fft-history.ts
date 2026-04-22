// ============================================================
// node-sdr — FFT History Buffer
// ============================================================
// Circular buffer of recent FFT frames per dongle.
// Stored as Uint8-quantized frames (same quantization as
// MSG_FFT_COMPRESSED) so replay is zero-cost — no re-encoding.
// ============================================================

export const FFT_HISTORY_MIN_DB = -130;
export const FFT_HISTORY_MAX_DB = 0;

/**
 * Fixed-capacity circular buffer of Uint8-quantized FFT frames.
 * Oldest frame is overwritten when capacity is reached.
 */
export class FftHistoryBuffer {
  private buffer: Uint8Array[];
  private head = 0;        // index of next write slot
  private _count = 0;      // number of valid frames currently stored
  binCount: number;

  constructor(
    readonly capacity: number,
    binCount: number,
  ) {
    this.binCount = binCount;
    // Pre-allocate fixed-size Uint8Array slots to avoid GC churn
    this.buffer = Array.from({ length: capacity }, () => new Uint8Array(binCount));
  }

  /** Number of frames currently stored. */
  get count(): number {
    return this._count;
  }

  /**
   * Push a new Float32 FFT frame (dB values) into the buffer.
   * Quantizes to Uint8 and overwrites the oldest slot when full.
   */
  push(fftData: Float32Array): void {
    if (fftData.length !== this.binCount) return;
    const slot = this.buffer[this.head];
    const range = FFT_HISTORY_MAX_DB - FFT_HISTORY_MIN_DB;
    for (let i = 0; i < this.binCount; i++) {
      const n = (fftData[i] - FFT_HISTORY_MIN_DB) / range;
      slot[i] = n < 0 ? 0 : n > 1 ? 255 : Math.round(n * 255);
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
    // Oldest frame is at (head - count) wrapping around
    const start = (this.head - this._count + this.capacity) % this.capacity;
    for (let i = 0; i < this._count; i++) {
      out[i] = this.buffer[(start + i) % this.capacity];
    }
    return out;
  }

  /**
   * Reset the buffer (call on dongle stop or profile change).
   */
  reset(): void {
    this.head = 0;
    this._count = 0;
  }

  /**
   * Resize for a new FFT bin count (profile change with different fftSize).
   */
  resize(newBinCount: number): void {
    this.binCount = newBinCount;
    this.buffer = Array.from({ length: this.capacity }, () => new Uint8Array(newBinCount));
    this.head = 0;
    this._count = 0;
  }
}
