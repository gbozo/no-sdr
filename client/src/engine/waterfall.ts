// ============================================================
// node-sdr — Waterfall Renderer (Canvas 2D)
// ============================================================
// Imperative canvas rendering — no framework reactivity involved.
// Pattern: scroll existing content down 1px, paint new row at top.
// ============================================================

import { getPalette, type Palette, type PaletteEntry } from './palettes.js';
import type { WaterfallColorTheme } from '@node-sdr/shared';

export class WaterfallRenderer {
  private ctx: CanvasRenderingContext2D;
  private palette: Palette;
  private minDb: number;
  private maxDb: number;

  constructor(
    private canvas: HTMLCanvasElement,
    theme: WaterfallColorTheme = 'turbo',
    minDb: number = -120,
    maxDb: number = -40,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.palette = getPalette(theme);
    this.minDb = minDb;
    this.maxDb = maxDb;

    // Set canvas to fill its container
    this.resize();
  }

  /**
   * Draw one FFT row at the top, scrolling existing content down
   */
  drawRow(fftData: Float32Array): void {
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Scroll existing content down by 1 pixel
    this.ctx.drawImage(this.canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);

    // Create new row at top
    const row = this.ctx.createImageData(w, 1);
    const pixels = row.data;
    const bins = fftData.length;
    const range = this.maxDb - this.minDb;

    for (let x = 0; x < w; x++) {
      // Map pixel x to FFT bin index
      const binIdx = Math.floor((x / (w - 1)) * (bins - 1));
      const db = fftData[binIdx];

      // Normalize to 0-255 palette index
      const normalized = (db - this.minDb) / range;
      const palIdx = Math.max(0, Math.min(255, Math.round(normalized * 255)));
      const [r, g, b] = this.palette[palIdx];

      const offset = x * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }

    this.ctx.putImageData(row, 0, 0);
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
   * Resize canvas to match container
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
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
    // Map 0..1 to -sampleRate/2 .. +sampleRate/2
    return (relativeX - 0.5) * sampleRate;
  }
}
