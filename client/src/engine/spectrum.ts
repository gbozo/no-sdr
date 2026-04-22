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
  private signalFillColor: string;
  private gridColor: string;
  private ready = false;

  // Throttle rendering to ~30fps (same as waterfall)
  private lastDrawTime = 0;
  private readonly minFrameInterval = 33; // ms (~30fps)

  // Peak hold
  private peakHoldEnabled = false;
  private peakDb: Float32Array | null = null;
  private readonly peakDecayDbPerFrame = 0.4; // dB dropped per frame at 30fps

  // Pause / freeze
  private paused = false;
  private frozenData: Float32Array | null = null;

  // Client-side display smoothing (independent of server-side FFT averaging)
  // 0 = off (raw), 0.4 = medium, 0.7 = slow
  private smoothingAlpha = 0;
  private smoothedDb: Float32Array | null = null;

  // Last computed per-pixel dB values — read by tooltip for dB readout
  private _lastPixelDb: Float32Array | null = null;

  /** Per-pixel dB values from the most recent draw — used by tooltip. */
  get lastPixelDb(): Float32Array | null { return this._lastPixelDb; }

  // Noise floor estimation — per-pixel running minimum with slow rise
  private noiseFloorEnabled = false;
  private noiseFloorDb: Float32Array | null = null;
  // Per-pixel floor tracks toward new minimum quickly, rises very slowly
  private readonly noiseFloorFall = 0.15;   // alpha toward lower value (fast snap down)
  private readonly noiseFloorRise = 0.002;  // alpha toward higher value (very slow rise)

  // Zoom viewport — fractions of full bandwidth [0, 1]
  private zoomStart = 0;
  private zoomEnd   = 1;

  get isZoomed(): boolean { return this.zoomStart > 0 || this.zoomEnd < 1; }
  getZoom(): [number, number] { return [this.zoomStart, this.zoomEnd]; }

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
    this.signalFillColor = 'rgba(74, 163, 255, 0.25)';
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

    // Pause: freeze on the last frame, stop updating
    if (this.paused) {
      if (!this.frozenData) this.frozenData = new Float32Array(fftData);
      return; // already drawn frozen frame; nothing to update
    }
    this.frozenData = null;

    // Client-side display smoothing
    let data = fftData;
    if (this.smoothingAlpha > 0) {
      if (!this.smoothedDb || this.smoothedDb.length !== fftData.length) {
        this.smoothedDb = new Float32Array(fftData);
      } else {
        const a = this.smoothingAlpha;
        const b = 1 - a;
        for (let i = 0; i < fftData.length; i++) {
          this.smoothedDb[i] = a * this.smoothedDb[i] + b * fftData[i];
        }
        data = this.smoothedDb;
      }
    } else {
      this.smoothedDb = null;
    }

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    const bins = data.length;
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

    // Precompute per-pixel dB values — zoom-aware bin mapping
    const viewStart = this.zoomStart * bins;
    const viewEnd   = this.zoomEnd   * bins;
    const viewBins  = viewEnd - viewStart;

    const pixelDb = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let db: number;
      // Map canvas pixel to bin within the zoom viewport
      const binF = viewStart + (x / (w - 1)) * (viewBins - 1);
      const binsPerPx = viewBins / w;
      if (binsPerPx <= 1) {
        const lo = Math.floor(binF);
        const hi = Math.min(lo + 1, bins - 1);
        const frac = binF - lo;
        db = data[lo] + frac * (data[hi] - data[lo]);
      } else {
        const binStart = Math.max(0, Math.floor(binF));
        const binEnd   = Math.min(bins, Math.floor(binF + binsPerPx));
        db = data[binStart];
        for (let b = binStart + 1; b < binEnd; b++) {
          if (data[b] > db) db = data[b];
        }
      }
      pixelDb[x] = db;
    }

    // Store for tooltip dB readout
    this._lastPixelDb = pixelDb;

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

    if (this.signalFillEnabled) {
      // Column fill: each pixel column filled from bottom to its peak y
      // Uses a brighter accent fill so signals "glow" upward
      ctx.save();
      ctx.fillStyle = this.fillColor;
      ctx.fill(); // keep the dim base fill for the curve shape
      ctx.restore();

      ctx.save();
      ctx.fillStyle = this.signalFillColor;
      for (let x = 0; x < w; x++) {
        const normalized = (pixelDb[x] - this.minDb) / range;
        const y = h - Math.max(0, Math.min(1, normalized)) * h;
        ctx.fillRect(x, y, 1, h - y);
      }
      ctx.restore();
    } else {
      // Default: dim fill under the curve path
      ctx.fillStyle = this.fillColor;
      ctx.fill();
    }

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

    // Peak hold — draw a thin line at peak dB per pixel
    if (this.peakHoldEnabled) {
      // Init or resize peak buffer
      if (!this.peakDb || this.peakDb.length !== w) {
        this.peakDb = new Float32Array(w).fill(this.minDb);
      }
      // Update peaks and apply decay
      for (let x = 0; x < w; x++) {
        if (pixelDb[x] > this.peakDb[x]) {
          this.peakDb[x] = pixelDb[x];
        } else {
          this.peakDb[x] -= this.peakDecayDbPerFrame;
          if (this.peakDb[x] < this.minDb) this.peakDb[x] = this.minDb;
        }
      }
      // Draw peak line — same accent colour, slightly dimmer
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const normalized = (this.peakDb[x] - this.minDb) / range;
        const y = h - Math.max(0, Math.min(1, normalized)) * h;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.accentColor;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Noise floor — per-pixel running minimum drawn as a dim dashed line
    if (this.noiseFloorEnabled) {
      if (!this.noiseFloorDb || this.noiseFloorDb.length !== w) {
        this.noiseFloorDb = new Float32Array(pixelDb); // init to current data
      } else {
        for (let x = 0; x < w; x++) {
          const cur = pixelDb[x];
          const floor = this.noiseFloorDb[x];
          if (cur < floor) {
            // Snap down quickly
            this.noiseFloorDb[x] = floor + this.noiseFloorFall * (cur - floor);
          } else {
            // Rise very slowly — noise floor should only creep up
            this.noiseFloorDb[x] = floor + this.noiseFloorRise * (cur - floor);
          }
        }
      }
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const normalized = (this.noiseFloorDb[x] - this.minDb) / range;
        const y = h - Math.max(0, Math.min(1, normalized)) * h;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#a855f7';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Draw a tuning indicator at the given frequency offset
   */
  drawTuningIndicator(offset: number, bandwidth: number, sampleRate: number): void {
    if (!this.ready || this.paused) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    // Convert frequency offset to canvas pixel — zoom-aware
    // Normalise offset to [0,1] across full bandwidth, then remap into zoom viewport
    const normFull   = (offset / sampleRate) + 0.5;
    const normZoomed = (normFull - this.zoomStart) / (this.zoomEnd - this.zoomStart);
    const centerX    = normZoomed * w;
    const halfBwNorm = (bandwidth / sampleRate / 2) / (this.zoomEnd - this.zoomStart);
    const halfBw     = halfBwNorm * w;

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
   * Enable or disable peak hold. Clears the peak buffer when disabled.
   */
  setPause(enabled: boolean): void {
    this.paused = enabled;
    if (!enabled) this.frozenData = null;
  }

  setSmoothing(alpha: number): void {
    this.smoothingAlpha = Math.max(0, Math.min(0.95, alpha));
    this.smoothedDb = null; // reset on change
  }

  setPeakHold(enabled: boolean): void {
    this.peakHoldEnabled = enabled;
    if (!enabled) this.peakDb = null;
  }

  setSignalFill(enabled: boolean): void {
    this.signalFillEnabled = enabled;
  }

  setNoiseFloor(enabled: boolean): void {
    this.noiseFloorEnabled = enabled;
    if (!enabled) this.noiseFloorDb = null;
  }

  /**
   * Set the zoom viewport as fractions of the full bandwidth [0, 1].
   * e.g. setZoom(0.25, 0.75) zooms to the centre half of the spectrum.
   */
  setZoom(start: number, end: number): void {
    this.zoomStart = Math.max(0, Math.min(start, end - 0.01));
    this.zoomEnd   = Math.min(1, Math.max(end, start + 0.01));
    // Clear noise floor and peak buffers — they are pixel-indexed and now stale
    this.noiseFloorDb = null;
    this.peakDb = null;
  }

  resetZoom(): void {
    this.zoomStart = 0;
    this.zoomEnd   = 1;
    this.noiseFloorDb = null;
    this.peakDb = null;
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
    this.signalFillColor = color.replace(')', ', 0.25)').replace('rgb', 'rgba');
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
