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
  ocean: [
    { pos: 0.00, rgb: [0, 0, 80] },
    { pos: 0.15, rgb: [0, 50, 160] },
    { pos: 0.30, rgb: [0, 120, 200] },
    { pos: 0.50, rgb: [0, 180, 210] },
    { pos: 0.70, rgb: [100, 220, 230] },
    { pos: 0.85, rgb: [180, 240, 250] },
    { pos: 1.00, rgb: [240, 250, 255] },
  ],
  inferno: [
    { pos: 0.00, rgb: [0, 0, 4] },
    { pos: 0.15, rgb: [69, 24, 87] },
    { pos: 0.30, rgb: [133, 54, 120] },
    { pos: 0.45, rgb: [188, 55, 76] },
    { pos: 0.60, rgb: [227, 117, 48] },
    { pos: 0.75, rgb: [249, 193, 60] },
    { pos: 0.90, rgb: [252, 254, 164] },
    { pos: 1.00, rgb: [255, 255, 200] },
  ],
  magma: [
    { pos: 0.00, rgb: [0, 0, 4] },
    { pos: 0.15, rgb: [64, 37, 90] },
    { pos: 0.30, rgb: [140, 58, 115] },
    { pos: 0.45, rgb: [186, 73, 103] },
    { pos: 0.60, rgb: [224, 109, 67] },
    { pos: 0.75, rgb: [252, 164, 56] },
    { pos: 0.90, rgb: [252, 223, 148] },
    { pos: 1.00, rgb: [255, 255, 255] },
  ],
  plasma: [
    { pos: 0.00, rgb: [4, 6, 68] },
    { pos: 0.15, rgb: [68, 36, 131] },
    { pos: 0.30, rgb: [120, 42, 164] },
    { pos: 0.45, rgb: [162, 63, 144] },
    { pos: 0.60, rgb: [195, 99, 107] },
    { pos: 0.75, rgb: [222, 148, 73] },
    { pos: 0.90, rgb: [247, 211, 66] },
    { pos: 1.00, rgb: [252, 253, 85] },
  ],
  fire: [
    { pos: 0.00, rgb: [0, 0, 0] },
    { pos: 0.20, rgb: [64, 0, 0] },
    { pos: 0.40, rgb: [180, 0, 0] },
    { pos: 0.55, rgb: [255, 80, 0] },
    { pos: 0.70, rgb: [255, 160, 0] },
    { pos: 0.85, rgb: [255, 240, 80] },
    { pos: 1.00, rgb: [255, 255, 255] },
  ],
  radio: [
    { pos: 0.00, rgb: [8, 24, 32] },
    { pos: 0.20, rgb: [24, 80, 120] },
    { pos: 0.40, rgb: [32, 140, 140] },
    { pos: 0.60, rgb: [80, 200, 120] },
    { pos: 0.80, rgb: [200, 220, 80] },
    { pos: 0.95, rgb: [255, 220, 100] },
    { pos: 1.00, rgb: [255, 255, 200] },
  ],
  // Custom SDR palette: black → blue → cyan → yellow → red (smooth gradient)
  sdr: [
    { pos: 0.00, rgb: [0, 0, 8] },
    { pos: 0.10, rgb: [0, 0, 64] },
    { pos: 0.20, rgb: [0, 48, 128] },
    { pos: 0.30, rgb: [0, 96, 192] },
    { pos: 0.40, rgb: [0, 160, 220] },
    { pos: 0.50, rgb: [0, 200, 180] },
    { pos: 0.60, rgb: [80, 220, 120] },
    { pos: 0.70, rgb: [180, 220, 40] },
    { pos: 0.80, rgb: [255, 200, 0] },
    { pos: 0.90, rgb: [255, 120, 0] },
    { pos: 0.95, rgb: [255, 60, 0] },
    { pos: 1.00, rgb: [255, 0, 0] },
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
 * Get all available palette theme names (ordered)
 */
export function getPaletteNames(): WaterfallColorTheme[] {
  return ['classic', 'sdr', 'turbo', 'viridis', 'hot', 'fire', 'ocean', 'grayscale', 'inferno', 'magma', 'plasma', 'radio'];
}
