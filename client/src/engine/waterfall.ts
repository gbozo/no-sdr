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
  private w = 0;
  private h = 0;

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

    // Scroll existing content down by 1 pixel using getImageData/putImageData
    // This avoids the drawImage self-reference issue entirely
    const existing = this.ctx.getImageData(0, 0, w, h - 1);
    this.ctx.putImageData(existing, 0, 1);

    // Create new row at top (reuse ImageData object if same width)
    if (!this.rowImageData || this.rowImageData.width !== w) {
      this.rowImageData = this.ctx.createImageData(w, 1);
    }

    const pixels = this.rowImageData.data;
    const bins = fftData.length;
    const range = this.maxDb - this.minDb;

    if (range === 0) return;

    for (let x = 0; x < w; x++) {
      // Map pixel x to FFT bin index
      const binIdx = Math.floor((x / (w - 1)) * (bins - 1));
      const db = fftData[binIdx];

      // Normalize to 0-255 palette index
      const normalized = (db - this.minDb) / range;
      const palIdx = Math.max(0, Math.min(255, Math.round(normalized * 255)));
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

    // Use 1:1 pixel mapping (no DPR scaling) for waterfall — each pixel = 1 row
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
   * Map a click X position to a frequency offset from center
   */
  pixelToFreqOffset(pixelX: number, sampleRate: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const relativeX = pixelX / rect.width;
    return (relativeX - 0.5) * sampleRate;
  }
}
