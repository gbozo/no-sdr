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
  private _peakDb: Float32Array | null = null;
  private readonly peakDecayDbPerFrame = 0.4; // dB dropped per frame at 30fps
  private peakDirty = false; // tracks whether peaks need redraw

  // Signal fill (column fill mode)
  private signalFillEnabled = false;

  // Pause / freeze
  private paused = false;
  private frozenData: Float32Array | null = null;

  // Client-side display smoothing (independent of server-side FFT averaging)
  // 0 = off (raw), 0.4 = medium, 0.7 = slow
  private smoothingAlpha = 0;
  private smoothedDb: Float32Array | null = null;

  // Last computed per-pixel dB values — read by tooltip for dB readout
  private _lastPixelDb: Float32Array | null = null;
  // Pre-allocated per-pixel dB buffer — reused every frame to avoid 30Hz allocation
  private _pixelDbBuf: Float32Array | null = null;

  /** Per-pixel dB values from the most recent draw — used by tooltip. */
  get lastPixelDb(): Float32Array | null { return this._lastPixelDb; }

  /** Peak dB values per pixel — used for tooltip peak display (and spectrum peak hold when enabled). */
  get peakDbValues(): Float32Array | null { return this._peakDb; }

  // Tooltip peak: tracks max dB over last N frames for variation display
  private tooltipPeakFrames: Float32Array[] | null = null;
  private tooltipPeakPos = 0;
  private readonly TOOLTIP_PEAK_FRAMES = 30; // ~1 sec at 30fps
  private _tooltipPeak: Float32Array | null = null;

  /** Max dB over last ~1 second — used for tooltip peak display. */
  get tooltipPeakDb(): Float32Array | null { return this._tooltipPeak; }

  // Noise floor estimation using a rolling minimum window per bin.
  // Tracks the true minimum dB seen in the last ~5 seconds (150 frames at 30fps).
  // Because we take the minimum, signal peaks never raise the floor estimate —
  // the floor only reflects the quietest moments at each frequency.
  // Memory budget: capped at ~4 MB to prevent excessive RAM on high bin counts.
  private noiseFloorEnabled = false;
  private noiseFloorWindow: Float32Array[] | null = null; // circular buffer of frames
  private noiseFloorWindowPos = 0;
  private noiseFloorBins: Float32Array | null = null;     // current per-bin minimum
  private readonly NOISE_FLOOR_MAX_FRAMES = 150;          // ideal frames (~5s at 30fps)
  private readonly NOISE_FLOOR_MAX_BYTES = 4 * 1024 * 1024; // 4 MB memory budget
  private noiseFloorWindowSize = 150;                     // actual window (may be reduced)

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
    this.accentColor = '#4aa3ff';
    this.fillColor = 'rgba(74,163,255,0.12)';
    this.signalFillColor = 'rgba(74,163,255,0.25)';
    this.gridColor = 'rgba(38, 50, 70, 0.5)';
    this.resize();
    // Apply the actual current theme color (may differ from default if page loaded with a saved theme)
    const themeColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--sdr-freq-color').trim();
    if (themeColor) this.setAccentColor(themeColor);
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

    const pixelDb = (!this._pixelDbBuf || this._pixelDbBuf.length !== w)
      ? (this._pixelDbBuf = new Float32Array(w))
      : this._pixelDbBuf;
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

    // Track tooltip peak: max dB over last ~1 second (30 frames)
    if (!this.tooltipPeakFrames || this.tooltipPeakFrames[0].length !== w) {
      this.tooltipPeakFrames = Array.from(
        { length: this.TOOLTIP_PEAK_FRAMES },
        () => new Float32Array(w).fill(this.minDb),
      );
      this._tooltipPeak = new Float32Array(w).fill(this.minDb);
      this.tooltipPeakPos = 0;
    }
    // Store current frame in circular buffer
    this.tooltipPeakFrames[this.tooltipPeakPos].set(pixelDb);
    this.tooltipPeakPos = (this.tooltipPeakPos + 1) % this.TOOLTIP_PEAK_FRAMES;
    // Compute max across all buffered frames
    for (let x = 0; x < w; x++) {
      let maxDb = this.minDb;
      for (let f = 0; f < this.TOOLTIP_PEAK_FRAMES; f++) {
        const val = this.tooltipPeakFrames[f][x];
        if (val > maxDb) maxDb = val;
      }
      this._tooltipPeak![x] = maxDb;
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

    // Peak hold — always track peaks, only draw when enabled
    // Classic peak hold: captures new highs, decays slowly when signal drops
    if (!this._peakDb || this._peakDb.length !== w) {
      this._peakDb = new Float32Array(w).fill(this.minDb);
      this.peakDirty = true;
    }
    // Update peaks: capture new highs, apply slow decay
    for (let x = 0; x < w; x++) {
      if (pixelDb[x] > this._peakDb[x]) {
        this._peakDb[x] = pixelDb[x];
      } else {
        // Slow decay: 0.4 dB per frame (~13 dB/sec at 30fps, ~27 frames to drop 10dB)
        this._peakDb[x] -= this.peakDecayDbPerFrame;
        if (this._peakDb[x] < this.minDb) this._peakDb[x] = this.minDb;
      }
    }
    this.peakDirty = true;

    // Draw peak line only when enabled
    if (this.peakHoldEnabled && this.peakDirty) {
      // Draw peak line — same accent colour, slightly dimmer
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const normalized = (this._peakDb[x] - this.minDb) / range;
        const y = h - Math.max(0, Math.min(1, normalized)) * h;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.accentColor;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
      this.peakDirty = false;
    }

    // Noise floor — rolling minimum over last ~5s, drawn as a dim dashed line.
    // Uses a circular buffer of frames; the floor per bin is the minimum across
    // all frames in the window. Signal peaks never push the floor up — they
    // simply become the minimum only if the bin is genuinely quiet at that level.
    if (this.noiseFloorEnabled) {
      // Init or resize window buffer when bin count changes
      if (!this.noiseFloorWindow || this.noiseFloorWindow[0].length !== bins) {
        // Compute window size within memory budget: bins * 4 bytes * windowSize <= budget
        this.noiseFloorWindowSize = Math.max(10, Math.min(
          this.NOISE_FLOOR_MAX_FRAMES,
          Math.floor(this.NOISE_FLOOR_MAX_BYTES / (bins * 4)),
        ));
        this.noiseFloorWindow = Array.from(
          { length: this.noiseFloorWindowSize },
          () => new Float32Array(bins).fill(0),
        );
        this.noiseFloorWindowPos = 0;
        this.noiseFloorBins = new Float32Array(bins).fill(0);
        // Seed all slots with current data so the floor is meaningful immediately
        for (const slot of this.noiseFloorWindow) slot.set(data);
      }

      // Write current frame into the circular buffer
      this.noiseFloorWindow[this.noiseFloorWindowPos].set(data);
      this.noiseFloorWindowPos = (this.noiseFloorWindowPos + 1) % this.noiseFloorWindowSize;

      // Recompute per-bin minimum across the whole window.
      // Only recompute every 3 frames to keep CPU cost low (~10fps update rate).
      if (this.noiseFloorWindowPos % 3 === 0) {
        const floor = this.noiseFloorBins!;
        const win = this.noiseFloorWindow;
        const wLen = win.length;
        for (let b = 0; b < bins; b++) {
          let mn = win[0][b];
          for (let f = 1; f < wLen; f++) {
            if (win[f][b] < mn) mn = win[f][b];
          }
          floor[b] = mn;
        }
      }

      // Map per-bin floor to per-pixel using same zoom-aware mapping as pixelDb
      const floor = this.noiseFloorBins!;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const binF = viewStart + (x / (w - 1)) * (viewBins - 1);
        const binsPerPx = viewBins / w;
        let floorDb: number;
        if (binsPerPx <= 1) {
          const lo = Math.floor(binF);
          const hi = Math.min(lo + 1, bins - 1);
          floorDb = floor[lo] + (binF - lo) * (floor[hi] - floor[lo]);
        } else {
          const bs = Math.max(0, Math.floor(binF));
          const be = Math.min(bins, Math.floor(binF + binsPerPx));
          floorDb = floor[bs];
          for (let b = bs + 1; b < be; b++) {
            if (floor[b] < floorDb) floorDb = floor[b];
          }
        }
        const normalized = (floorDb - this.minDb) / range;
        const y = h - Math.max(0, Math.min(1, normalized)) * h;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#a855f7';
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
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
    if (!enabled) this._peakDb = null;
  }

  setSignalFill(enabled: boolean): void {
    this.signalFillEnabled = enabled;
  }

  setNoiseFloor(enabled: boolean): void {
    this.noiseFloorEnabled = enabled;
    if (!enabled) {
      this.noiseFloorWindow = null;
      this.noiseFloorBins = null;
      this.noiseFloorWindowPos = 0;
    }
  }

  /**
   * Set the zoom viewport as fractions of the full bandwidth [0, 1].
   * e.g. setZoom(0.25, 0.75) zooms to the centre half of the spectrum.
   */
  setZoom(start: number, end: number): void {
    this.zoomStart = Math.max(0, Math.min(start, end - 0.01));
    this.zoomEnd   = Math.min(1, Math.max(end, start + 0.01));
    // Clear peak buffer — pixel-indexed and now stale after zoom change.
    // Noise floor is bin-indexed so it survives zoom changes without reset.
    this._peakDb = null;
  }

  resetZoom(): void {
    this.zoomStart = 0;
    this.zoomEnd   = 1;
    this._peakDb = null;
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
    // Parse hex (#rrggbb or #rgb) or rgb(...) into r,g,b components
    // so we can build correct rgba fill strings regardless of format.
    let r = 74, g = 163, b = 255; // fallback cyan
    const hex6 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    const hex3 = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    const rgbM = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (hex6) {
      r = parseInt(hex6[1], 16); g = parseInt(hex6[2], 16); b = parseInt(hex6[3], 16);
    } else if (hex3) {
      r = parseInt(hex3[1] + hex3[1], 16); g = parseInt(hex3[2] + hex3[2], 16); b = parseInt(hex3[3] + hex3[3], 16);
    } else if (rgbM) {
      r = parseInt(rgbM[1]); g = parseInt(rgbM[2]); b = parseInt(rgbM[3]);
    }
    this.fillColor       = `rgba(${r},${g},${b},0.12)`;
    this.signalFillColor = `rgba(${r},${g},${b},0.25)`;
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
