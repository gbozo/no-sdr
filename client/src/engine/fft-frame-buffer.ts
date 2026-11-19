// ============================================================
// node-sdr — Client-Side FFT Frame Buffer
// ============================================================
// Circular buffer of recent decoded Float32 FFT frames.
// Stored as Float32 (no re-quantization) for accurate replay.
// Used for waterfall prefill on zoom/reset without a server round-trip.
// ============================================================

export class FftFrameBuffer {
  private slots: Float32Array[];
  private head = 0;
  private _count = 0;
  binCount: number;
  private readonly maxSlots: number;
  private readonly maxBytes: number;

  constructor(capacity: number, binCount: number, maxBytes = 64 * 1024 * 1024) {
    this.maxSlots = Math.max(1, capacity);
    this.maxBytes = Math.max(4, maxBytes);
    this.binCount = binCount;
    this.slots = this.allocate(binCount);
  }

  get count(): number { return this._count; }
  get capacity(): number { return this.slots.length; }

  push(frame: Float32Array): void {
    if (frame.length !== this.binCount) {
      // Bin count changed (profile switch) — resize
      this.resize(frame.length);
    }
    this.slots[this.head].set(frame);
    this.head = (this.head + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
  }

  /** Return frames in chronological order (oldest first). Views into internal slots. */
  getFrames(): Float32Array[] {
    if (this._count === 0) return [];
    const out: Float32Array[] = new Array(this._count);
    const start = (this.head - this._count + this.capacity) % this.capacity;
    for (let i = 0; i < this._count; i++) {
      out[i] = this.slots[(start + i) % this.capacity];
    }
    return out;
  }

  reset(): void {
    this.head = 0;
    this._count = 0;
  }

  resize(newBinCount: number): void {
    this.binCount = newBinCount;
    this.slots = this.allocate(newBinCount);
    this.head = 0;
    this._count = 0;
  }

  /**
   * Allocate the ring, capping the slot count so a wide FFT (e.g. 131072
   * bins) does not reserve hundreds of megabytes. The byte budget keeps the
   * prefill buffer at a few seconds of history regardless of bin count.
   */
  private allocate(binCount: number): Float32Array[] {
    let slots = this.maxSlots;
    if (binCount > 0) {
      slots = Math.min(slots, Math.max(1, Math.floor(this.maxBytes / (binCount * 4))));
    }
    return Array.from({ length: slots }, () => new Float32Array(binCount));
  }
}
