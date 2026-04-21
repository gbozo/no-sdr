// ============================================================
// node-sdr — Spectrum Renderer (Canvas 2D)
// ============================================================
// Draws the FFT spectrum as a line graph above/below the waterfall.
// ============================================================

export class SpectrumRenderer {
  private ctx: CanvasRenderingContext2D;
  private minDb: number;
  private maxDb: number;
  private accentColor: string;
  private fillColor: string;
  private gridColor: string;
  private ready = false;

  // Throttle rendering to ~30fps (same as waterfall)
  private lastDrawTime = 0;
  private readonly minFrameInterval = 33; // ms (~30fps)

  constructor(
    private canvas: HTMLCanvasElement,
    minDb: number = -120,
    maxDb: number = -40,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: true })!;
    this.minDb = minDb;
    this.maxDb = maxDb;
    this.accentColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--sdr-accent').trim() || '#4aa3ff';
    this.fillColor = 'rgba(74, 163, 255, 0.12)';
    this.gridColor = 'rgba(38, 50, 70, 0.5)';
    this.resize();
  }

  /**
   * Draw the spectrum for one FFT frame.
   * Throttled to ~30fps to avoid excessive redraws.
   */
  draw(fftData: Float32Array): void {
    if (fftData.length === 0) return;

    // Throttle to ~30fps
    const now = performance.now();
    if (now - this.lastDrawTime < this.minFrameInterval) return;
    this.lastDrawTime = now;

    if (!this.ready) {
      this.resize();
      if (!this.ready) return;
    }

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    const bins = fftData.length;
    const range = this.maxDb - this.minDb;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Grid lines (every 10 dB)
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 0.5;
    for (let db = Math.ceil(this.minDb / 10) * 10; db <= this.maxDb; db += 10) {
      const y = h - ((db - this.minDb) / range) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // dB labels
    ctx.fillStyle = '#6f7f94';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for (let db = Math.ceil(this.minDb / 20) * 20; db <= this.maxDb; db += 20) {
      const y = h - ((db - this.minDb) / range) * h;
      ctx.fillText(`${db}`, 4, y - 2);
    }

    // Precompute per-pixel dB values with peak-hold binning
    const binsPerPixel = bins / w;
    const pixelDb = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let db: number;
      if (binsPerPixel <= 1) {
        const binIdx = (x / (w - 1)) * (bins - 1);
        const lo = Math.floor(binIdx);
        const hi = Math.min(lo + 1, bins - 1);
        const frac = binIdx - lo;
        db = fftData[lo] + frac * (fftData[hi] - fftData[lo]);
      } else {
        const binStart = Math.floor(x * binsPerPixel);
        const binEnd = Math.min(Math.floor((x + 1) * binsPerPixel), bins);
        db = fftData[binStart];
        for (let b = binStart + 1; b < binEnd; b++) {
          if (fftData[b] > db) db = fftData[b];
        }
      }
      pixelDb[x] = db;
    }

    // Spectrum line + fill
    ctx.beginPath();
    ctx.moveTo(0, h);

    for (let x = 0; x < w; x++) {
      const normalized = (pixelDb[x] - this.minDb) / range;
      const y = h - Math.max(0, Math.min(1, normalized)) * h;
      ctx.lineTo(x, y);
    }

    // Close path for fill
    ctx.lineTo(w, h);
    ctx.closePath();

    // Fill under curve
    ctx.fillStyle = this.fillColor;
    ctx.fill();

    // Draw line on top
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const normalized = (pixelDb[x] - this.minDb) / range;
      const y = h - Math.max(0, Math.min(1, normalized)) * h;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.strokeStyle = this.accentColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /**
   * Draw a tuning indicator at the given frequency offset
   */
  drawTuningIndicator(offset: number, bandwidth: number, sampleRate: number): void {
    if (!this.ready) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    // Convert offset to pixel position
    const centerX = ((offset / sampleRate) + 0.5) * w;
    const halfBw = (bandwidth / sampleRate / 2) * w;

    // Draw bandwidth rectangle
    ctx.fillStyle = 'rgba(74, 163, 255, 0.08)';
    ctx.fillRect(centerX - halfBw, 0, halfBw * 2, h);

    // Draw center line
    ctx.strokeStyle = this.accentColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw bandwidth edges
    ctx.strokeStyle = 'rgba(74, 163, 255, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(centerX - halfBw, 0);
    ctx.lineTo(centerX - halfBw, h);
    ctx.moveTo(centerX + halfBw, 0);
    ctx.lineTo(centerX + halfBw, h);
    ctx.stroke();
  }

  /**
   * Update dB range
   */
  setRange(minDb: number, maxDb: number): void {
    this.minDb = minDb;
    this.maxDb = maxDb;
  }

  /**
   * Update accent color (when UI theme changes)
   */
  setAccentColor(color: string): void {
    this.accentColor = color;
    this.fillColor = color.replace(')', ', 0.12)').replace('rgb', 'rgba');
  }

  /**
   * Resize canvas to match container
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);

    if (w < 1 || h < 1) {
      this.ready = false;
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const newW = Math.round(w * dpr);
    const newH = Math.round(h * dpr);

    if (this.canvas.width !== newW || this.canvas.height !== newH) {
      this.canvas.width = newW;
      this.canvas.height = newH;
    }

    this.ready = true;
  }
}
