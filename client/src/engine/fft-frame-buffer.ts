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

  constructor(readonly capacity: number, binCount: number) {
    this.binCount = binCount;
    this.slots = Array.from({ length: capacity }, () => new Float32Array(binCount));
  }

  get count(): number { return this._count; }

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
    this.slots = Array.from({ length: this.capacity }, () => new Float32Array(newBinCount));
    this.head = 0;
    this._count = 0;
  }
}
