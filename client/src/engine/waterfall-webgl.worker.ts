// ============================================================
// node-sdr — Waterfall Worker (OffscreenCanvas + WebGL2)
// ============================================================
// WebGL2 ring-buffer waterfall renderer.
//
// Architecture:
//   - GPU texture (w × h, RGBA8) acts as a circular ring buffer.
//   - Per frame: ONE row is uploaded via texSubImage2D (~7 KB vs ~9 MB
//     for Canvas 2D getImageData/putImageData). Zero CPU readback.
//   - Fragment shader shifts the view with fract(uv.y + offset) — no
//     pixel data ever moves on the GPU.
//   - This eliminates ALL Canvas 2D waterfall performance issues:
//       • getImageData GPU→CPU stall (removed entirely)
//       • putImageData full-canvas upload (removed entirely)
//       • Blank frames during scroll (removed entirely)
//       • ResizeObserver clearing content (resize just updates viewport)
//
// Message protocol: identical to waterfall.worker.ts (Canvas 2D fallback).
//
//   { type: 'init', canvas: OffscreenCanvas,
//     width: number, height: number, dpr: number,
//     theme: WaterfallColorTheme, minDb: number, maxDb: number, gamma: number }
//
//   { type: 'frame', fftData: Float32Array }   (fftData transferred)
//   { type: 'prefill', frames: Float32Array[] }
//   { type: 'prefill-history', frames: Uint8Array[], binCount: number,
//     serverMinDb: number, serverMaxDb: number }
//   { type: 'set-range', minDb: number, maxDb: number }
//   { type: 'set-theme', theme: WaterfallColorTheme }
//   { type: 'set-gamma', gamma: number }
//   { type: 'set-zoom', start: number, end: number }
//   { type: 'reset-zoom' }
//   { type: 'resize', width: number, height: number, dpr: number }
//   { type: 'clear' }
//   { type: 'seek-offset', offset: number }
//   { type: 'begin-pan' }
//   { type: 'draw-pan' }
//   { type: 'end-pan' }
// ============================================================

import type { WaterfallColorTheme } from '~/shared';

// ---- Inline palette (identical to Canvas 2D worker) ----

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

// ---- GLSL shaders (inlined as template literals) ----

const VERT_SRC = `#version 300 es
// Fullscreen quad — no VBO needed.
// gl_VertexID: 0=(−1,−1)  1=(1,−1)  2=(−1,1)  3=(1,1)
out vec2 v_uv;
void main() {
  vec2 pos = vec2(
    float((gl_VertexID & 1) * 2) - 1.0,
    float((gl_VertexID >> 1) * 2) - 1.0
  );
  gl_Position = vec4(pos, 0.0, 1.0);
  // UV: (0,0) = bottom-left in GL, but we want (0,0) = top-left (newest row).
  // Flip Y so row 0 of the ring texture appears at the top of the canvas.
  v_uv = pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;

// Ring-buffer texture: RGBA8, w × h.
// Each row stores one FFT frame as RGBA pixels (palette already applied).
uniform sampler2D u_data;

// Write cursor: normalised row index of the NEXT row to be written.
// The newest visible row is at (writeRow - 1 / h), wrapped.
uniform float u_writeRow;

// Zoom: which fraction of the spectrum to display [0, 1].
uniform float u_zoomStart;
uniform float u_zoomEnd;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  // Map horizontal UV through zoom window
  float x = mix(u_zoomStart, u_zoomEnd, v_uv.x);
  // Shift vertical UV by write cursor — newest row at top (v_uv.y = 0)
  float y = fract(v_uv.y + u_writeRow);
  fragColor = texture(u_data, vec2(x, y));
}`;

// ---- Worker state ----

let gl: WebGL2RenderingContext | null = null;
let program: WebGLProgram | null = null;
let dataTex: WebGLTexture | null = null;

// Uniform locations
let uWriteRow = -1 as WebGLUniformLocation | -1;
let uZoomStart = -1 as WebGLUniformLocation | -1;
let uZoomEnd = -1 as WebGLUniformLocation | -1;

// Ring buffer state
let w = 0;         // physical pixel width
let h = 0;         // physical pixel height
let writeRow = 0;  // next row index (0 .. h-1)

// dB range + display parameters
let minDb = -60;
let maxDb = -10;
let gamma = 1.0;
let palette: Palette = getPalette('turbo');
let zoomStart = 0;
let zoomEnd = 1;
let seekOffset = 0;

// Throttle to ~30fps (matches server-side FFT push rate)
let lastDrawTime = 0;
const MIN_FRAME_INTERVAL = 33;

// Buffer history if prefill-history arrives before we have canvas dimensions
let pendingHistory: {
  frames: Uint8Array[];
  binCount: number;
  serverMinDb: number;
  serverMaxDb: number;
} | null = null;

// Row pixel buffer — reused every frame (w × 1 RGBA8)
let rowPixels: Uint8Array | null = null;

// ---- WebGL helpers ----

function compileShader(type: number, src: string): WebGLShader {
  const s = gl!.createShader(type)!;
  gl!.shaderSource(s, src);
  gl!.compileShader(s);
  if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
    const err = gl!.getShaderInfoLog(s);
    gl!.deleteShader(s);
    throw new Error(`Shader compile error: ${err}`);
  }
  return s;
}

function buildProgram(): WebGLProgram {
  const vert = compileShader(gl!.VERTEX_SHADER, VERT_SRC);
  const frag = compileShader(gl!.FRAGMENT_SHADER, FRAG_SRC);
  const prog = gl!.createProgram()!;
  gl!.attachShader(prog, vert);
  gl!.attachShader(prog, frag);
  gl!.linkProgram(prog);
  if (!gl!.getProgramParameter(prog, gl!.LINK_STATUS)) {
    const err = gl!.getProgramInfoLog(prog);
    throw new Error(`Program link error: ${err}`);
  }
  gl!.deleteShader(vert);
  gl!.deleteShader(frag);
  return prog;
}

function createDataTexture(texW: number, texH: number): WebGLTexture {
  const tex = gl!.createTexture()!;
  gl!.bindTexture(gl!.TEXTURE_2D, tex);
  // NEAREST filtering — each row is a discrete FFT frame, no interpolation wanted
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
  // CLAMP_TO_EDGE on both axes (the ring-buffer wrap is done in the shader)
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  // Allocate zeroed texture
  gl!.texImage2D(
    gl!.TEXTURE_2D, 0, gl!.RGBA,
    texW, texH, 0,
    gl!.RGBA, gl!.UNSIGNED_BYTE, null,
  );
  return tex;
}

/**
 * Upload one RGB-palette row at the current writeRow position.
 * This is the ONLY GPU operation per FFT frame — ~7 KB vs ~9 MB for Canvas 2D.
 */
function uploadRow(pixels: Uint8Array): void {
  if (!gl || !dataTex) return;
  gl.bindTexture(gl.TEXTURE_2D, dataTex);
  gl.texSubImage2D(
    gl.TEXTURE_2D, 0,
    0, writeRow,       // xoffset, yoffset
    w, 1,              // width, height (1 row)
    gl.RGBA, gl.UNSIGNED_BYTE,
    pixels,
  );
}

function draw(): void {
  if (!gl || !program) return;
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateUniforms(): void {
  if (!gl || !program) return;
  gl.uniform1f(uWriteRow as WebGLUniformLocation, writeRow / Math.max(1, h));
  gl.uniform1f(uZoomStart as WebGLUniformLocation, zoomStart);
  gl.uniform1f(uZoomEnd as WebGLUniformLocation, zoomEnd);
}

// ---- DSP helpers (identical logic to Canvas 2D worker) ----

/**
 * Map one FFT frame to a w×1 RGBA pixel row using the current palette.
 */
function fftToRow(fftData: Float32Array): Uint8Array {
  if (!rowPixels || rowPixels.length !== w * 4) {
    rowPixels = new Uint8Array(w * 4);
  }
  const range    = maxDb - minDb;
  const bins     = fftData.length;
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
    const normalized = range === 0 ? 0 : (db - minDb) / range;
    const palIdx = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), gamma) * 255)));
    const color  = palette[palIdx];
    const off    = x * 4;
    rowPixels[off]     = color[0];
    rowPixels[off + 1] = color[1];
    rowPixels[off + 2] = color[2];
    rowPixels[off + 3] = 255;
  }
  return rowPixels;
}

/**
 * Map a Uint8 history frame (server-compressed dB → 0-255) to a row.
 */
function historyFrameToRow(frame: Uint8Array, binCount: number, serverMinDb: number, serverMaxDb: number): Uint8Array {
  if (!rowPixels || rowPixels.length !== w * 4) {
    rowPixels = new Uint8Array(w * 4);
  }
  const serverRange = serverMaxDb - serverMinDb;
  const clientRange = maxDb - minDb;
  const binsPerPx   = binCount / w;

  for (let x = 0; x < w; x++) {
    let u8: number;
    if (binsPerPx <= 1) {
      const binIdx = (x / (w - 1)) * (binCount - 1);
      const lo = Math.floor(binIdx);
      const hi = Math.min(lo + 1, binCount - 1);
      u8 = Math.round(frame[lo] + (binIdx - lo) * (frame[hi] - frame[lo]));
    } else {
      const bs = Math.floor(x * binsPerPx);
      const be = Math.min(Math.floor((x + 1) * binsPerPx), binCount);
      u8 = frame[bs];
      for (let b = bs + 1; b < be; b++) if (frame[b] > u8) u8 = frame[b];
    }
    const db         = serverMinDb + (u8 / 255) * serverRange;
    const normalized = clientRange === 0 ? 0 : (db - minDb) / clientRange;
    const palIdx     = Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, normalized), gamma) * 255)));
    const color      = palette[palIdx];
    const off        = x * 4;
    rowPixels[off]     = color[0];
    rowPixels[off + 1] = color[1];
    rowPixels[off + 2] = color[2];
    rowPixels[off + 3] = 255;
  }
  return rowPixels;
}

// ---- Core operations ----

function drawRow(fftData: Float32Array): void {
  if (!gl || fftData.length === 0 || w < 1 || h < 2) return;

  const now = performance.now();
  if (now - lastDrawTime < MIN_FRAME_INTERVAL) return;
  lastDrawTime = now;

  const pixels = fftToRow(fftData);
  uploadRow(pixels);

  // Advance ring cursor — after upload, so this row appears at the newest position
  writeRow = (writeRow + 1) % h;

  updateUniforms();
  draw();
}

function prefillFromBuffer(frames: Float32Array[]): void {
  if (!gl || frames.length === 0 || w < 1 || h < 1) return;

  const rowCount = Math.min(frames.length, h);
  // Fill ring buffer: oldest frame at writeRow, newest at writeRow-1
  for (let i = 0; i < rowCount; i++) {
    // frames[frames.length - rowCount] = oldest, frames[frames.length - 1] = newest
    // We want oldest at top (largest y offset from writeRow), newest just before writeRow
    const frameIdx  = frames.length - rowCount + i;
    const targetRow = (writeRow + i) % h;
    const pixels    = fftToRow(frames[frameIdx]);
    if (!gl || !dataTex) return;
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, targetRow, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels.slice());
  }
  // Advance write cursor past filled rows
  writeRow = (writeRow + rowCount) % h;

  updateUniforms();
  draw();
  lastDrawTime = performance.now() - MIN_FRAME_INTERVAL;
}

function prefillHistory(
  frames: Uint8Array[],
  binCount: number,
  serverMinDb: number,
  serverMaxDb: number,
): void {
  if (!gl || frames.length === 0 || w < 1 || h < 1) return;

  const rowCount = Math.min(frames.length, h);
  for (let i = 0; i < rowCount; i++) {
    const frameIdx  = frames.length - rowCount + i;
    const targetRow = (writeRow + i) % h;
    const pixels    = historyFrameToRow(frames[frameIdx], binCount, serverMinDb, serverMaxDb);
    if (!gl || !dataTex) return;
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, targetRow, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels.slice());
  }
  writeRow = (writeRow + rowCount) % h;

  updateUniforms();
  draw();
  lastDrawTime = performance.now() - MIN_FRAME_INTERVAL;
}

function clear(): void {
  if (!gl || !dataTex) return;
  // Clear texture to black by uploading zeroed data
  const zeros = new Uint8Array(w * h * 4);
  gl.bindTexture(gl.TEXTURE_2D, dataTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, zeros);
  writeRow = 0;
  updateUniforms();
  draw();
}

function resize(newW: number, newH: number): void {
  if (!gl) return;

  // Guard: skip if dimensions haven't changed
  if (newW === w && newH === h) return;

  w = newW;
  h = newH;
  writeRow   = 0;
  rowPixels  = null;

  // Update GL viewport
  gl.viewport(0, 0, w, h);

  // Recreate ring-buffer texture at new size (old content is lost — acceptable,
  // prefill will redraw from fftBuffer if needed)
  if (dataTex) gl.deleteTexture(dataTex);
  dataTex = createDataTexture(w, h);

  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, dataTex);

  updateUniforms();
  draw();
}

// ---- Initialisation ----

function initWebGL(canvas: OffscreenCanvas): void {
  const context = canvas.getContext('webgl2', {
    antialias: false,
    depth:     false,
    stencil:   false,
    alpha:     false,
    // Prefer low-power on mobile (tiled GPU path)
    powerPreference: 'low-power',
  });

  if (!context) {
    throw new Error('WebGL2 not available on this OffscreenCanvas');
  }

  gl = context as WebGL2RenderingContext;

  // Handle context loss/restore
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    gl = null;
    program = null;
    dataTex = null;
  });

  canvas.addEventListener('webglcontextrestored', () => {
    // Re-obtain context and reinit — the main thread will re-send prefill
    const restoredCtx = canvas.getContext('webgl2', {
      antialias: false, depth: false, stencil: false, alpha: false,
      powerPreference: 'low-power',
    });
    if (!restoredCtx) return;
    gl = restoredCtx as WebGL2RenderingContext;
    setupGLState();
    // Signal main thread to send prefill
    self.postMessage({ type: 'context-restored' });
  });

  setupGLState();
}

function setupGLState(): void {
  if (!gl) return;

  program = buildProgram();
  gl.useProgram(program);

  // Bind data texture to unit 0
  uWriteRow  = gl.getUniformLocation(program, 'u_writeRow')!;
  uZoomStart = gl.getUniformLocation(program, 'u_zoomStart')!;
  uZoomEnd   = gl.getUniformLocation(program, 'u_zoomEnd')!;

  const uData = gl.getUniformLocation(program, 'u_data')!;
  gl.uniform1i(uData, 0);

  gl.clearColor(0, 0, 0, 1);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  if (w > 0 && h > 0) {
    gl.viewport(0, 0, w, h);
    dataTex = createDataTexture(w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    updateUniforms();
  }
}

// ---- Message handler ----

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      const canvas = msg.canvas as OffscreenCanvas;
      const dpr    = (msg.dpr as number) || 1;
      w = Math.round((msg.width  as number) * dpr);
      h = Math.round((msg.height as number) * dpr);
      canvas.width  = w;
      canvas.height = h;

      minDb   = msg.minDb  ?? -60;
      maxDb   = msg.maxDb  ?? -10;
      gamma   = msg.gamma  ?? 1.0;
      palette = getPalette(msg.theme ?? 'turbo');

      try {
        initWebGL(canvas);
        // Set initial viewport + create texture after dimensions are known
        if (gl) {
          gl.viewport(0, 0, w, h);
          dataTex = createDataTexture(w, h);
          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, dataTex);
          updateUniforms();
          draw();
        }
      } catch (err) {
        // Notify main thread so it can fall back to Canvas 2D worker
        self.postMessage({ type: 'init-failed', error: String(err) });
      }
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
      const allFrames   = msg.allFrames  as Uint8Array;
      const frameCount  = msg.frameCount as number;
      const binCount    = msg.binCount   as number;
      const serverMinDb = msg.serverMinDb as number;
      const serverMaxDb = msg.serverMaxDb as number;

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
      // Re-render the visible frame with the new palette if possible
      // (ring buffer stores RGBA, not raw dB — so we can't retroactively recolor.
      // Clear to indicate theme change; new frames will use the new palette.)
      // NOTE: If palette texture approach is used in a future iteration, this
      // becomes a single texSubImage2D call instead.
      clear();
      break;
    }

    case 'set-gamma': {
      gamma = Math.max(0.1, msg.gamma as number);
      break;
    }

    case 'set-zoom': {
      zoomStart = Math.max(0, Math.min(msg.start, msg.end - 0.01));
      zoomEnd   = Math.min(1, Math.max(msg.end, msg.start + 0.01));
      updateUniforms();
      draw();
      break;
    }

    case 'reset-zoom': {
      zoomStart = 0;
      zoomEnd   = 1;
      updateUniforms();
      draw();
      break;
    }

    case 'resize': {
      const dpr = (msg.dpr as number) || 1;
      resize(
        Math.round((msg.width  as number) * dpr),
        Math.round((msg.height as number) * dpr),
      );
      // If history arrived before dimensions were set, draw it now
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

    // Pan snapshot — WebGL version: just update the zoom uniforms; no pixel copy needed.
    // The ring buffer texture is stable across pan operations.
    case 'begin-pan':
    case 'draw-pan':
    case 'end-pan':
      // No-op: pan is handled via set-zoom/reset-zoom uniforms in the shader.
      break;
  }
};
