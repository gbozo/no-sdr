// ============================================================
// node-sdr — Waterfall Renderer (Canvas 2D)
// ============================================================
// Imperative canvas rendering — no framework reactivity involved.
// ============================================================

import { getPalette, type Palette, type PaletteEntry } from './palettes.js';
import type { WaterfallColorTheme } from '@node-sdr/shared';

export class WaterfallRenderer {
  private ctx: CanvasRenderingContext2D;
  private palette: Palette;
  private minDb: number;
  private maxDb: number;
  /** Power-curve gamma applied to the 0–1 normalized bin value before palette lookup.
   *  gamma > 1 → pushes midtones darker, makes strong signals pop.
   *  gamma < 1 → brightens midtones, lifts weak signals.
   *  gamma = 1 → linear (default). */
  private gamma = 1.0;
  private w = 0;
  private h = 0;

  // Zoom viewport — fractions of full bandwidth [0, 1]
  private zoomStart = 0;
  private zoomEnd   = 1;

  // Pan snapshot — preserves full-view waterfall during pan for stale display
  private panSnapshot: HTMLCanvasElement | null = null;

  // Reusable ImageData for one row to avoid GC pressure
  private rowImageData: ImageData | null = null;

  // Frame rate limiting — waterfall doesn't need >30fps
  private lastDrawTime = 0;
  private readonly minFrameInterval = 33; // ~30fps

  constructor(
    private canvas: HTMLCanvasElement,
    theme: WaterfallColorTheme = 'turbo',
    minDb: number = -60,
    maxDb: number = -10,
  ) {
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.palette = getPalette(theme);
    this.minDb = minDb;
    this.maxDb = maxDb;

    // Initial resize
    this.resize();
  }

  /**
   * Draw one FFT row at the top, scrolling existing content down
   */
  drawRow(fftData: Float32Array): void {
    if (fftData.length === 0 || this.w < 1 || this.h < 2) return;

    // Throttle to ~30fps
    const now = performance.now();
    if (now - this.lastDrawTime < this.minFrameInterval) return;
    this.lastDrawTime = now;

    const w = this.w;
    const h = this.h;

    // Scroll existing content down by 1 pixel
    const existing = this.ctx.getImageData(0, 0, w, h - 1);
    this.ctx.putImageData(existing, 0, 1);

    // Create new row at top
    if (!this.rowImageData || this.rowImageData.width !== w) {
      this.rowImageData = this.ctx.createImageData(w, 1);
    }

    const pixels = this.rowImageData.data;
    const bins = fftData.length;
    const range = this.maxDb - this.minDb;

    if (range === 0) return;

    // Zoom-aware bin mapping
    const viewStart  = this.zoomStart * bins;
    const viewEnd    = this.zoomEnd   * bins;
    const viewBins   = viewEnd - viewStart;
    const binsPerPx  = viewBins / w;

    for (let x = 0; x < w; x++) {
      let db: number;
      const binF = viewStart + (x / (w - 1)) * (viewBins - 1);
      if (binsPerPx <= 1) {
        const lo = Math.floor(binF);
        const hi = Math.min(lo + 1, bins - 1);
        const frac = binF - lo;
        db = fftData[lo] + frac * (fftData[hi] - fftData[lo]);
      } else {
        const binStart = Math.max(0, Math.floor(binF));
        const binEnd   = Math.min(bins, Math.floor(binF + binsPerPx));
        // Average aggregation for smoother waterfall (vs MAX which is noisier)
        let sum = fftData[binStart];
        for (let b = binStart + 1; b < binEnd; b++) {
          sum += fftData[b];
        }
        db = sum / (binEnd - binStart);
      }

      // Normalize to 0-255 palette index
      const normalized = (db - this.minDb) / range;
      const palIdx = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), this.gamma) * 255)));
      const color = this.palette[palIdx];

      const offset = x * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }

    this.ctx.putImageData(this.rowImageData, 0, 0);
  }

  /**
   * Update the color palette
   */
  setTheme(theme: WaterfallColorTheme): void {
    this.palette = getPalette(theme);
  }

  /**
   * Update dB range
   */
  setRange(minDb: number, maxDb: number): void {
    this.minDb = minDb;
    this.maxDb = maxDb;
  }

  /**
   * Update gamma power curve (0.3–3.0 practical range, 1.0 = linear)
   */
  setGamma(gamma: number): void {
    this.gamma = Math.max(0.1, gamma);
  }

  setZoom(start: number, end: number): void {
    this.zoomStart = Math.max(0, Math.min(start, end - 0.01));
    this.zoomEnd   = Math.min(1, Math.max(end, start + 0.01));
    this.rowImageData = null;
    // Caller is responsible for calling prefillFromBuffer() after setZoom
    // to avoid a blank waterfall — clear as fallback only
    this.clear();
  }

  resetZoom(): void {
    this.zoomStart = 0;
    this.zoomEnd = 1;
    this.rowImageData = null;
    this.clear();
  }

  beginPan(): void {
    if (this.w < 1 || this.h < 1) return;
    this.panSnapshot = document.createElement('canvas');
    this.panSnapshot.width = this.w;
    this.panSnapshot.height = this.h;
    this.panSnapshot.getContext('2d')!.drawImage(this.canvas, 0, 0);
  }

  drawPanSnapshot(): void {
    if (!this.panSnapshot) return;
    this.ctx.drawImage(this.panSnapshot, 0, 0);
  }

  endPan(): void {
    this.panSnapshot = null;
  }

  get isPanning(): boolean { return this.panSnapshot !== null; }

  /**
   * Resize canvas to match container.
   * Must be called when the container size changes (via ResizeObserver).
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cw = Math.round(rect.width);
    const ch = Math.round(rect.height);

    if (cw < 1 || ch < 2) {
      this.w = 0;
      this.h = 0;
      return;
    }

    // Use 1:1 for waterfall - CSS pixelated gives crisp non-blurry pixels
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      // Preserve existing waterfall content across resize by cloning to an offscreen canvas
      const oldW = this.canvas.width;
      const oldH = this.canvas.height;
      let snapshot: HTMLCanvasElement | null = null;

      if (oldW > 0 && oldH > 0) {
        snapshot = document.createElement('canvas');
        snapshot.width = oldW;
        snapshot.height = oldH;
        snapshot.getContext('2d')!.drawImage(this.canvas, 0, 0);
      }

      // Setting width/height clears the canvas
      this.canvas.width = cw;
      this.canvas.height = ch;
      this.rowImageData = null; // force recreate

      // Restore: stretch old content to new dimensions
      if (snapshot) {
        this.ctx.drawImage(snapshot, 0, 0, oldW, oldH, 0, 0, cw, ch);
      }
    }

    this.w = cw;
    this.h = ch;
  }

  /**
   * Clear the waterfall
   */
  clear(): void {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Prefill the waterfall from client-side Float32 frame buffer.
   * frames: Float32Array[], oldest first, each frame is dB magnitudes.
   * Applies current zoom viewport and client min/max dB range.
   * Used on zoom change / reset so the waterfall doesn't go blank.
   */
  prefillFromBuffer(frames: Float32Array[]): void {
    if (frames.length === 0 || this.w < 1 || this.h < 1) return;

    const w = this.w;
    const h = this.h;
    const range = this.maxDb - this.minDb;
    if (range === 0) return;

    const rowCount  = Math.min(frames.length, h);
    const startIdx  = frames.length - rowCount;

    // Zoom-aware bin mapping
    const binCount  = frames[0].length;
    const viewStart = this.zoomStart * binCount;
    const viewEnd   = this.zoomEnd   * binCount;
    const viewBins  = viewEnd - viewStart;
    const binsPerPx = viewBins / w;

    const imgData = this.ctx.createImageData(w, rowCount);
    const pixels  = imgData.data;

    for (let row = 0; row < rowCount; row++) {
      const frame     = frames[startIdx + (rowCount - 1 - row)]; // newest at top
      const rowOffset = row * w * 4;

      for (let x = 0; x < w; x++) {
        const binF = viewStart + (x / (w - 1)) * (viewBins - 1);
        let db: number;
        if (binsPerPx <= 1) {
          const lo = Math.floor(binF);
          const hi = Math.min(lo + 1, binCount - 1);
          db = frame[lo] + (binF - lo) * (frame[hi] - frame[lo]);
        } else {
          const bs = Math.max(0, Math.floor(binF));
          const be = Math.min(binCount, Math.floor(binF + binsPerPx));
          db = frame[bs];
          for (let b = bs + 1; b < be; b++) if (frame[b] > db) db = frame[b];
        }

        const normalized = (db - this.minDb) / range;
        const palIdx = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), this.gamma) * 255)));
        const color  = this.palette[palIdx];
        const offset = rowOffset + x * 4;
        pixels[offset]     = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }

    this.ctx.putImageData(imgData, 0, 0);
    this.lastDrawTime = performance.now() - this.minFrameInterval;
  }

  /**
   * Prefill the waterfall from history frames received from the server.
   * frames: Uint8-quantized rows (0-255), oldest first, each binCount values.
   * minDb/maxDb: the quantization range used server-side (FFT_HISTORY_MIN/MAX_DB).
   *
   * Draws all frames in a single ImageData batch — no scroll, no throttle.
   * The most recent frame ends up at the top (row 0), oldest at the bottom.
   */
  prefillHistory(
    frames: Uint8Array[],
    binCount: number,
    serverMinDb: number,
    serverMaxDb: number,
  ): void {
    if (frames.length === 0 || this.w < 1 || this.h < 1) return;

    const w = this.w;
    const h = this.h;
    const serverRange = serverMaxDb - serverMinDb;
    if (serverRange === 0) return;

    // Client display range (may differ from server quantization range)
    const clientRange = this.maxDb - this.minDb;
    if (clientRange === 0) return;

    // Number of rows to draw — cap at canvas height
    const rowCount = Math.min(frames.length, h);
    // frames is oldest-first; we want newest at top (row 0)
    const startIdx = frames.length - rowCount;

    // Build one ImageData covering all rows at once
    const imgData = this.ctx.createImageData(w, rowCount);
    const pixels = imgData.data;

    const binsPerPixel = binCount / w;

    for (let row = 0; row < rowCount; row++) {
      // Invert so row 0 = most recent frame
      const frameIdx = startIdx + (rowCount - 1 - row);
      const frame = frames[frameIdx];
      const rowOffset = row * w * 4;

      for (let x = 0; x < w; x++) {
        // Map pixel x to bin(s) — same peak-hold logic as drawRow
        let u8: number;
        if (binsPerPixel <= 1) {
          const binIdx = (x / (w - 1)) * (binCount - 1);
          const lo = Math.floor(binIdx);
          const hi = Math.min(lo + 1, binCount - 1);
          const frac = binIdx - lo;
          u8 = Math.round(frame[lo] + frac * (frame[hi] - frame[lo]));
        } else {
          const binStart = Math.floor(x * binsPerPixel);
          const binEnd = Math.min(Math.floor((x + 1) * binsPerPixel), binCount);
          u8 = frame[binStart];
          for (let b = binStart + 1; b < binEnd; b++) {
            if (frame[b] > u8) u8 = frame[b];
          }
        }

        // Dequantize server Uint8 → dB, then renormalize to client display range
        const db = serverMinDb + (u8 / 255) * serverRange;
        const normalized = (db - this.minDb) / clientRange;
        const palIdx = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), this.gamma) * 255)));
        const color = this.palette[palIdx];
        const offset = rowOffset + x * 4;
        pixels[offset]     = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }

    // Draw history block at top; live frames will scroll it down naturally
    this.ctx.putImageData(imgData, 0, 0);
    // Ensure next live frame isn't skipped by the throttle
    this.lastDrawTime = performance.now() - this.minFrameInterval;
  }

  /**
   * Map a click X position to a frequency offset from center
   */
  pixelToFreqOffset(pixelX: number, sampleRate: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const relativeX = pixelX / rect.width;
    return (relativeX - 0.5) * sampleRate;
  }
}
