// ============================================================
// node-sdr — Waterfall Worker (OffscreenCanvas)
// ============================================================
// Owns the WaterfallRenderer entirely inside a Worker.
// The main thread transfers OffscreenCanvas control once at init;
// after that all draw calls happen here, freeing the main thread
// from getImageData/putImageData/palette-lookup work.
//
// Message protocol (main → worker):
//
//   { type: 'init', canvas: OffscreenCanvas,
//     width: number, height: number,
//     theme: WaterfallColorTheme, minDb: number, maxDb: number, gamma: number }
//     (canvas is transferred)
//
//   { type: 'frame', fftData: Float32Array }   (fftData transferred)
//
//   { type: 'prefill', frames: Float32Array[] }
//
//   { type: 'prefill-history',
//     frames: Uint8Array[], binCount: number,
//     serverMinDb: number, serverMaxDb: number }
//
//   { type: 'set-range', minDb: number, maxDb: number }
//   { type: 'set-theme', theme: WaterfallColorTheme }
//   { type: 'set-gamma', gamma: number }
//   { type: 'set-zoom',  start: number, end: number }
//   { type: 'reset-zoom' }
//   { type: 'resize', width: number, height: number }
//   { type: 'clear' }
//   { type: 'seek-offset', offset: number }     — freeze/unfreeze live updates
// ============================================================

import type { WaterfallColorTheme } from '@node-sdr/shared';

// ---- Inline palette (no DOM import needed) ----

type PaletteEntry = [number, number, number];
type Palette = PaletteEntry[];

interface ColorStop { pos: number; rgb: [number, number, number] }

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
  // Custom SDR palette: black → blue → cyan → yellow → red
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

function buildPalette(stops: ColorStop[]): Palette {
  const palette: Palette = new Array(256);
  for (let i = 0; i < 256; i++) {
    const pos = i / 255;
    let lower = stops[0];
    let upper = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (pos >= stops[s].pos && pos <= stops[s + 1].pos) {
        lower = stops[s];
        upper = stops[s + 1];
        break;
      }
    }
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

const paletteCache = new Map<WaterfallColorTheme, Palette>();
function getPalette(theme: WaterfallColorTheme): Palette {
  let p = paletteCache.get(theme);
  if (!p) { p = buildPalette(THEME_STOPS[theme]); paletteCache.set(theme, p); }
  return p;
}

// ---- Worker state ----

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let w = 0;
let h = 0;
let minDb = -60;
let maxDb = -10;
let gamma = 1.0;
let palette: Palette = getPalette('turbo');
let zoomStart = 0;
let zoomEnd = 1;
let seekOffset = 0;
let rowImageData: ImageData | null = null;

// Pan snapshot — preserves full-view waterfall during pan for stale display
let panSnapshot: OffscreenCanvas | null = null;

// Throttle: ~30fps
let lastDrawTime = 0;
const MIN_FRAME_INTERVAL = 33;

// Buffer history until we have real canvas dimensions (w > 0, h > 0).
// Happens when prefill-history arrives before the first resize message.
let pendingHistory: {
  frames: Uint8Array[];
  binCount: number;
  serverMinDb: number;
  serverMaxDb: number;
} | null = null;

// ---- Draw helpers ----

function drawRow(fftData: Float32Array): void {
  if (!ctx || fftData.length === 0 || w < 1 || h < 2) return;

  const now = performance.now();
  if (now - lastDrawTime < MIN_FRAME_INTERVAL) return;
  lastDrawTime = now;

  const range = maxDb - minDb;
  if (range === 0) return;

  // Scroll existing content down by 1px
  const existing = ctx.getImageData(0, 0, w, h - 1);
  ctx.putImageData(existing, 0, 1);

  // Build new top row
  if (!rowImageData || rowImageData.width !== w) {
    rowImageData = ctx.createImageData(w, 1);
  }

  const pixels = rowImageData.data;
  const bins = fftData.length;
  const viewStart = zoomStart * bins;
  const viewEnd   = zoomEnd   * bins;
  const viewBins  = viewEnd - viewStart;
  const binsPerPx = viewBins / w;

  for (let x = 0; x < w; x++) {
    const binF = viewStart + (x / (w - 1)) * (viewBins - 1);
    let db: number;
    if (binsPerPx <= 1) {
      const lo = Math.floor(binF);
      const hi = Math.min(lo + 1, bins - 1);
      db = fftData[lo] + (binF - lo) * (fftData[hi] - fftData[lo]);
    } else {
      const bs = Math.max(0, Math.floor(binF));
      const be = Math.min(bins, Math.floor(binF + binsPerPx));
      db = fftData[bs];
      for (let b = bs + 1; b < be; b++) if (fftData[b] > db) db = fftData[b];
    }

    const normalized = (db - minDb) / range;
    const palIdx = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), gamma) * 255)));
    const color  = palette[palIdx];
    const offset = x * 4;
    pixels[offset]     = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = 255;
  }

  ctx.putImageData(rowImageData, 0, 0);
}

function prefillFromBuffer(frames: Float32Array[]): void {
  if (!ctx || frames.length === 0 || w < 1 || h < 1) return;

  const range = maxDb - minDb;
  if (range === 0) return;

  const rowCount = Math.min(frames.length, h);
  const startIdx = frames.length - rowCount;
  const binCount = frames[0].length;
  const viewStart = zoomStart * binCount;
  const viewEnd   = zoomEnd   * binCount;
  const viewBins  = viewEnd - viewStart;
  const binsPerPx = viewBins / w;

  const imgData = ctx.createImageData(w, rowCount);
  const pixels  = imgData.data;

  for (let row = 0; row < rowCount; row++) {
    const frame     = frames[startIdx + (rowCount - 1 - row)];
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

      const normalized = (db - minDb) / range;
      const palIdx = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), gamma) * 255)));
      const color  = palette[palIdx];
      const offset = rowOffset + x * 4;
      pixels[offset]     = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  lastDrawTime = performance.now() - MIN_FRAME_INTERVAL;
}

function prefillHistory(
  frames: Uint8Array[],
  binCount: number,
  serverMinDb: number,
  serverMaxDb: number,
): void {
  if (!ctx || frames.length === 0 || w < 1 || h < 1) return;

  const serverRange = serverMaxDb - serverMinDb;
  const clientRange = maxDb - minDb;
  if (serverRange === 0 || clientRange === 0) return;

  const rowCount = Math.min(frames.length, h);
  const startIdx = frames.length - rowCount;
  const binsPerPixel = binCount / w;

  const imgData = ctx.createImageData(w, rowCount);
  const pixels  = imgData.data;

  for (let row = 0; row < rowCount; row++) {
    const frame     = frames[startIdx + (rowCount - 1 - row)];
    const rowOffset = row * w * 4;

    for (let x = 0; x < w; x++) {
      let u8: number;
      if (binsPerPixel <= 1) {
        const binIdx = (x / (w - 1)) * (binCount - 1);
        const lo = Math.floor(binIdx);
        const hi = Math.min(lo + 1, binCount - 1);
        u8 = Math.round(frame[lo] + (binIdx - lo) * (frame[hi] - frame[lo]));
      } else {
        const bs = Math.floor(x * binsPerPixel);
        const be = Math.min(Math.floor((x + 1) * binsPerPixel), binCount);
        u8 = frame[bs];
        for (let b = bs + 1; b < be; b++) if (frame[b] > u8) u8 = frame[b];
      }

      const db         = serverMinDb + (u8 / 255) * serverRange;
      const normalized = (db - minDb) / clientRange;
      const palIdx     = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), gamma) * 255)));
      const color      = palette[palIdx];
      const offset     = rowOffset + x * 4;
      pixels[offset]     = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  lastDrawTime = performance.now() - MIN_FRAME_INTERVAL;
}

function clear(): void {
  if (!ctx) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
}

function resize(newW: number, newH: number): void {
  if (!ctx) return;

  // Snapshot existing content before resize clears it
  let snapshot: ImageBitmap | null = null;
  if (w > 0 && h > 0) {
    // createImageBitmap is available in workers
    // We do this synchronously via getImageData since createImageBitmap is async
    const oldData = ctx.getImageData(0, 0, w, h);
    // We'll redraw old content after resize
    const canvas = ctx.canvas;
    canvas.width  = newW;
    canvas.height = newH;
    rowImageData = null;
    w = newW;
    h = newH;
    // Stretch old content — create a tmp OffscreenCanvas to hold it
    if (oldData) {
      const tmp = new OffscreenCanvas(oldData.width, oldData.height);
      tmp.getContext('2d')!.putImageData(oldData, 0, 0);
      ctx.drawImage(tmp, 0, 0, oldData.width, oldData.height, 0, 0, newW, newH);
    }
    return;
  }

  ctx.canvas.width  = newW;
  ctx.canvas.height = newH;
  rowImageData = null;
  w = newW;
  h = newH;
  void snapshot; // suppress unused warning
}

// ---- Message handler ----

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      const canvas = msg.canvas as OffscreenCanvas;
      ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      w = msg.width;
      h = msg.height;
      canvas.width  = w;
      canvas.height = h;
      minDb  = msg.minDb  ?? -60;
      maxDb  = msg.maxDb  ?? -10;
      gamma  = msg.gamma  ?? 1.0;
      palette = getPalette(msg.theme ?? 'turbo');
      break;
    }

    case 'frame': {
      if (seekOffset === 0) {
        drawRow(msg.fftData as Float32Array);
      }
      break;
    }

    case 'prefill': {
      prefillFromBuffer(msg.frames as Float32Array[]);
      break;
    }

    case 'prefill-history': {
      const allFrames  = msg.allFrames  as Uint8Array;
      const frameCount = msg.frameCount as number;
      const binCount   = msg.binCount   as number;
      const serverMinDb = msg.serverMinDb as number;
      const serverMaxDb = msg.serverMaxDb as number;

      // Reconstruct Uint8Array[] views from the flat buffer
      const frames: Uint8Array[] = new Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        frames[i] = allFrames.subarray(i * binCount, (i + 1) * binCount);
      }

      if (w < 1 || h < 1) {
        pendingHistory = { frames, binCount, serverMinDb, serverMaxDb };
      } else {
        prefillHistory(frames, binCount, serverMinDb, serverMaxDb);
      }
      break;
    }

    case 'set-range': {
      minDb = msg.minDb;
      maxDb = msg.maxDb;
      break;
    }

    case 'set-theme': {
      palette = getPalette(msg.theme as WaterfallColorTheme);
      break;
    }

    case 'set-gamma': {
      gamma = Math.max(0.1, msg.gamma as number);
      break;
    }

    case 'set-zoom': {
      zoomStart    = Math.max(0, Math.min(msg.start, msg.end - 0.01));
      zoomEnd      = Math.min(1, Math.max(msg.end, msg.start + 0.01));
      rowImageData = null;
      clear();
      break;
    }

    case 'reset-zoom': {
      zoomStart    = 0;
      zoomEnd      = 1;
      rowImageData = null;
      clear();
      break;
    }

    case 'resize': {
      resize(msg.width as number, msg.height as number);
      // If history arrived before we had real dimensions, draw it now
      if (pendingHistory && w > 0 && h > 0) {
        const ph = pendingHistory;
        pendingHistory = null;
        prefillHistory(ph.frames, ph.binCount, ph.serverMinDb, ph.serverMaxDb);
      }
      break;
    }

    case 'clear': {
      clear();
      break;
    }

    case 'seek-offset': {
      seekOffset = msg.offset as number;
      break;
    }

    case 'begin-pan': {
      if (!ctx || w < 1 || h < 1) break;
      panSnapshot = new OffscreenCanvas(w, h);
      panSnapshot.getContext('2d')!.drawImage(ctx.canvas, 0, 0);
      break;
    }

    case 'draw-pan': {
      if (!ctx || !panSnapshot) break;
      ctx.drawImage(panSnapshot, 0, 0);
      break;
    }

    case 'end-pan': {
      panSnapshot = null;
      break;
    }
  }
};
