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
  private readonly maxCapacity: number;
  /** Hard memory ceiling for the ring. At 16384+ bins, allocating the full
   *  1024-frame capacity would reserve 64 MB+ in one go and can crash a
   *  remote/in-app browser tab. Keep the history at a bounded byte size and
   *  retain fewer frames when the FFT is large. */
  private static readonly MAX_BYTES = 16 * 1024 * 1024;
  private capacity: number;
  binCount: number;

  constructor(capacity: number, binCount: number) {
    this.maxCapacity = capacity;
    this.capacity = capacity;
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
    const maxFrames = newBinCount > 0
      ? Math.floor(FftFrameBuffer.MAX_BYTES / (newBinCount * 4))
      : this.maxCapacity;
    this.capacity = Math.max(1, Math.min(this.maxCapacity, maxFrames));
    this.slots = Array.from({ length: this.capacity }, () => new Float32Array(newBinCount));
    this.head = 0;
    this._count = 0;
  }
}
