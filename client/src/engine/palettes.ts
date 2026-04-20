// ============================================================
// node-sdr — Waterfall Color Palettes
// ============================================================
// 256-entry RGB lookup tables for waterfall rendering.
// Completely separate from UI themes.
// ============================================================

import type { WaterfallColorTheme } from '@node-sdr/shared';

export type PaletteEntry = [r: number, g: number, b: number];
export type Palette = PaletteEntry[];

// ---- Color Stop Definitions ----

interface ColorStop {
  pos: number; // 0.0 - 1.0
  rgb: [number, number, number];
}

const THEME_STOPS: Record<WaterfallColorTheme, ColorStop[]> = {
  turbo: [
    { pos: 0.00, rgb: [48, 18, 59] },
    { pos: 0.10, rgb: [65, 69, 171] },
    { pos: 0.20, rgb: [70, 117, 237] },
    { pos: 0.30, rgb: [57, 162, 252] },
    { pos: 0.40, rgb: [27, 207, 212] },
    { pos: 0.50, rgb: [36, 236, 166] },
    { pos: 0.60, rgb: [97, 252, 108] },
    { pos: 0.70, rgb: [164, 252, 59] },
    { pos: 0.80, rgb: [209, 232, 52] },
    { pos: 0.90, rgb: [243, 198, 58] },
    { pos: 0.95, rgb: [254, 155, 45] },
    { pos: 1.00, rgb: [122, 4, 2] },
  ],
  viridis: [
    { pos: 0.00, rgb: [68, 1, 84] },
    { pos: 0.13, rgb: [72, 40, 120] },
    { pos: 0.25, rgb: [62, 73, 137] },
    { pos: 0.38, rgb: [49, 104, 142] },
    { pos: 0.50, rgb: [38, 130, 142] },
    { pos: 0.63, rgb: [31, 158, 137] },
    { pos: 0.75, rgb: [53, 183, 121] },
    { pos: 0.88, rgb: [110, 206, 88] },
    { pos: 1.00, rgb: [253, 231, 37] },
  ],
  classic: [
    { pos: 0.00, rgb: [0, 0, 0] },
    { pos: 0.15, rgb: [0, 0, 128] },
    { pos: 0.30, rgb: [0, 0, 255] },
    { pos: 0.50, rgb: [0, 255, 255] },
    { pos: 0.70, rgb: [255, 255, 0] },
    { pos: 0.85, rgb: [255, 128, 0] },
    { pos: 0.95, rgb: [255, 0, 0] },
    { pos: 1.00, rgb: [255, 255, 255] },
  ],
  grayscale: [
    { pos: 0.00, rgb: [0, 0, 0] },
    { pos: 1.00, rgb: [255, 255, 255] },
  ],
  hot: [
    { pos: 0.00, rgb: [0, 0, 0] },
    { pos: 0.25, rgb: [128, 0, 0] },
    { pos: 0.50, rgb: [255, 0, 0] },
    { pos: 0.75, rgb: [255, 200, 0] },
    { pos: 1.00, rgb: [255, 255, 255] },
  ],
};

/**
 * Build a 256-entry palette from color stops
 */
function buildPalette(stops: ColorStop[]): Palette {
  const palette: Palette = new Array(256);

  for (let i = 0; i < 256; i++) {
    const pos = i / 255;

    // Find surrounding stops
    let lower = stops[0];
    let upper = stops[stops.length - 1];

    for (let s = 0; s < stops.length - 1; s++) {
      if (pos >= stops[s].pos && pos <= stops[s + 1].pos) {
        lower = stops[s];
        upper = stops[s + 1];
        break;
      }
    }

    // Interpolate
    const range = upper.pos - lower.pos;
    const t = range === 0 ? 0 : (pos - lower.pos) / range;

    palette[i] = [
      Math.round(lower.rgb[0] + t * (upper.rgb[0] - lower.rgb[0])),
      Math.round(lower.rgb[1] + t * (upper.rgb[1] - lower.rgb[1])),
      Math.round(lower.rgb[2] + t * (upper.rgb[2] - lower.rgb[2])),
    ];
  }

  return palette;
}

// ---- Pre-built Palettes ----

const paletteCache = new Map<WaterfallColorTheme, Palette>();

export function getPalette(theme: WaterfallColorTheme): Palette {
  let palette = paletteCache.get(theme);
  if (!palette) {
    palette = buildPalette(THEME_STOPS[theme]);
    paletteCache.set(theme, palette);
  }
  return palette;
}

/**
 * Get all available palette theme names
 */
export function getPaletteNames(): WaterfallColorTheme[] {
  return Object.keys(THEME_STOPS) as WaterfallColorTheme[];
}
