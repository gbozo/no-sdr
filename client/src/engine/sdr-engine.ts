// ============================================================
// node-sdr — SDR Engine
// ============================================================
// Main orchestrator: connects WebSocket to renderers and audio.
// Entirely imperative — no framework reactivity for hot paths.
// ============================================================

import {
  unpackBinaryMessage,
  MSG_FFT,
  MSG_FFT_COMPRESSED,
  MSG_FFT_ADPCM,
  MSG_FFT_DEFLATE,
  MSG_FFT_HISTORY,
  MSG_IQ,
  MSG_IQ_ADPCM,
  MSG_AUDIO,
  MSG_AUDIO_OPUS,
  MSG_META,
  MSG_DECODER,
  MSG_DECODER_SCOPE,
  MSG_SIGNAL_LEVEL,
  MSG_RDS,
  unpackDecoderScope,
  type DecoderScopeFrame,
  DEMOD_MODES,
  ImaAdpcmDecoder,
  decodeFftAdpcm,
  FFT_HISTORY_CODEC_DEFLATE,
  FFT_HISTORY_CODEC_ADPCM,
  decodeFftFrame,
  decodeFftHistoryFrame,
  packWaterfallView,
  type FftFrameInfo,
  type FftHistoryInfo,
  type ServerMeta,
  type ClientCommand,
  type CodecType,
  type FftCodecType,
  type IqCodecType,
  type DemodMode,
} from '~/shared';
import { inflateSync } from 'fflate';
import { OpusDecoder } from 'opus-decoder';
import type { FftDecodeRequest, FftDecodeResult } from './fft-decode.worker.js';
import type { FftAnalysisFrame, FftAnalysisResult } from './fft-analysis.worker.js';
import { AudioEngine } from './audio.js';
import { FftFrameBuffer } from './fft-frame-buffer.js';
import { getDemodulator, resetDemodulator, type Demodulator, type StereoAudio } from './demodulators.js';
import type { RdsData } from './demodulators.js';
import { LmsAnr } from './lms-anr.js';
import { HangAgc, AGC_PRESETS } from './agc.js';
import { RumbleFilter, AutoNotch, HiBlendFilter } from './audio-filters.js';
import { store } from '../store/index.js';
import type { Bookmark } from '../store/index.js';
import { ALL_FFT_CODECS, ALL_IQ_CODECS } from '../store/index.js';

/**
 * One decoded tiled FFT frame: the protocol header (tier/tile tag + bin count)
 * plus the dequantized dB bins. Built at the WS handler from `decodeFftFrame`
 * (header only) + the shared per-codec dequant below.
 */
interface DecodedTiledFrame {
  tier: number;
  tileIndex: number;
  tileCount: number;
  binCount: number;
  bins: Float32Array;
}

/** One decoded tiled history burst: header fields + oldest-first dB frames. */
interface DecodedTiledHistory {
  tier: number;
  tileIndex: number;
  tileCount: number;
  binCount: number;
  frames: Float32Array[];
}

/**
 * Dequantize a tiled FFT frame body to dB bins. The tile header has already
 * been parsed by `decodeFftFrame`; `info.payloadOffset` points at the first
 * codec byte within `data`. The per-codec expansion is identical to the legacy
 * `fft-decode.worker` path (raw f32 / u8 expand / ADPCM / delta+deflate), only
 * the starting offset moves from the legacy fixed position to `payloadOffset`.
 */
function dequantTiledFftFrame(data: ArrayBuffer, info: FftFrameInfo): Float32Array {
  const off = info.payloadOffset;
  switch (info.type) {
    case MSG_FFT:
      // Raw Float32 bins from payloadOffset to end.
      return new Float32Array(data.slice(off));
    case MSG_FFT_COMPRESSED: {
      const minDb = info.minDb ?? 0;
      const maxDb = info.maxDb ?? 0;
      const range = maxDb - minDb;
      const comp = new Uint8Array(data, off);
      const bins = new Float32Array(comp.length);
      for (let i = 0; i < comp.length; i++) bins[i] = minDb + (comp[i] / 255) * range;
      return bins;
    }
    case MSG_FFT_ADPCM:
      // ADPCM payload carries its own inner [i16 min][i16 max] header.
      return decodeFftAdpcm(data.slice(off));
    case MSG_FFT_DEFLATE: {
      const minDb = info.minDb ?? 0;
      const maxDb = info.maxDb ?? 0;
      const binCount = info.binCount ?? 0;
      const delta = inflateSync(new Uint8Array(data, off));
      const u8 = new Uint8Array(binCount);
      u8[0] = delta[0];
      for (let i = 1; i < binCount; i++) u8[i] = (u8[i - 1] + delta[i]) & 0xff;
      const range = maxDb - minDb;
      const bins = new Float32Array(binCount);
      for (let i = 0; i < binCount; i++) bins[i] = minDb + (u8[i] / 255) * range;
      return bins;
    }
    default:
      return new Float32Array(0);
  }
}

/**
 * Dequantize a tiled history burst to oldest-first dB frames. Mirrors the
 * legacy 0x0D history handler's per-codec expansion (delta+deflate / ADPCM /
 * raw u8), reading from `info.payloadOffset` instead of the legacy fixed 11.
 */
function dequantTiledFftHistory(data: ArrayBuffer, info: FftHistoryInfo): Float32Array[] {
  const { frameCount, binCount, minDb, maxDb, codec, payloadOffset } = info;
  if (frameCount === 0 || binCount === 0) return [];
  const total = frameCount * binCount;
  const range = maxDb - minDb;
  let flat: Float32Array;

  if (codec === FFT_HISTORY_CODEC_DEFLATE) {
    const delta = inflateSync(new Uint8Array(data, payloadOffset));
    const u8 = new Uint8Array(total);
    u8[0] = delta[0];
    for (let i = 1; i < total; i++) u8[i] = (u8[i - 1] + delta[i]) & 0xff;
    flat = new Float32Array(total);
    for (let i = 0; i < total; i++) flat[i] = minDb + (u8[i] / 255) * range;
  } else if (codec === FFT_HISTORY_CODEC_ADPCM) {
    flat = decodeFftAdpcm(data.slice(payloadOffset));
  } else {
    // FFT_HISTORY_CODEC_NONE — raw Uint8 frames.
    const u8 = new Uint8Array(data, payloadOffset, total);
    flat = new Float32Array(total);
    for (let i = 0; i < total; i++) flat[i] = minDb + (u8[i] / 255) * range;
  }

  const frames: Float32Array[] = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    frames[f] = flat.slice(f * binCount, (f + 1) * binCount);
  }
  return frames;
}

/**
 * Sanity-check a decoded V1 tier/tile tag before accepting a frame as tiled.
 *
 * The 0x11 verFlags probe cannot distinguish a genuine tile header from a
 * legacy frame whose first body byte happens to be 0x11/0x31/... (1 in 32 for
 * inbound legacy frames during the transition). Rejecting implausible tags
 * keeps those frames on the legacy path instead of rendering garbage, and
 * bounds the strip allocation derived from `tileCount`.
 */
function isPlausibleTileTag(
  tier: number | undefined,
  tileIndex: number | undefined,
  tileCount: number | undefined,
): boolean {
  if (tier === undefined || tileIndex === undefined || tileCount === undefined) return false;
  if (!Number.isInteger(tier) || tier < 0 || tier > maxTierIndex()) return false;
  if (!Number.isInteger(tileCount) || tileCount < 1 || tileCount > 4096) return false;
  if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= tileCount) return false;
  const fftSize = store.fftSize();
  const tileBins = store.effectiveTileBins();
  if (fftSize > 0 && tileBins > 0) {
    // Ladder is octave-spaced (factor 1 << tier), so tierN/fftSize >> tier.
    const expected = Math.max(1, Math.floor(Math.max(1, fftSize >> tier) / tileBins));
    if (tileCount !== expected) return false;
  }
  return true;
}

/**
 * Coarsest valid tier index. The server advertises its ladder length in the
 * subscribed/profile meta; without it (older server) derive the same octave
 * ladder from the FFT and tile geometry: one tier per octave until the
 * coarsest tier is a single whole tile.
 */
function maxTierIndex(): number {
  const advertised = store.waterfallTierCount();
  if (advertised > 0) return advertised - 1;
  const fftSize = store.fftSize();
  const tileBins = store.effectiveTileBins();
  if (fftSize > 0 && tileBins > 0) {
    const octaves = Math.floor(Math.log2(Math.max(1, fftSize / tileBins)));
    return Math.max(0, Math.min(7, octaves));
  }
  return 4; // matches the server's historical default ladder
}

/**
 * Map the 0-1 noise-blanker slider to the server's threshold multiplier.
 * Higher level = lower threshold = more aggressive (20x .. 2x the running mean).
 * Used both for live slider moves and for restoring state after a reconnect —
 * sending the raw 0-1 level makes the server blank every sample.
 */
function nbThresholdForLevel(level: number): number {
  const l = Math.max(0, Math.min(1, level));
  return Math.round(20 - l * 18);
}

/**
 * Polyphase windowed-sinc upsampler for integer ratios (2x, 4x).
 *
 * Every phase is a fractional-delay FIR normalised to unity DC gain, so a
 * constant input stays constant and imaging is suppressed by the sinc's
 * stopband instead of the ~-29 dB of 2-tap linear interpolation.
 */
class SincUpsampler {
  readonly ratio: number;
  private readonly tapsPerPhase: number;
  private readonly hist: Float32Array;
  private readonly mask: number;
  private readonly phases: Float32Array[];
  private pos = 0;

  constructor(ratio: number, halfTaps = 16) {
    this.ratio = ratio;
    const n = 2 * halfTaps * ratio;
    // Every phase spans the whole kernel (2 * halfTaps taps), i.e. the filter
    // looks `2 * halfTaps - 1` inputs back. Using only half of the kernel per
    // phase would throw away the negative-frequency side of the interpolator
    // and leave the images completely unfiltered.
    this.tapsPerPhase = 2 * halfTaps;

    let size = 1;
    while (size < 2 * halfTaps + 1) size <<= 1;
    this.hist = new Float32Array(size);
    this.mask = size - 1;

    // Windowed-sinc prototype (Blackman-Harris), centred in the tap window.
    const proto = new Float32Array(n);
    const c = (n - 1) / 2;
    const den = n - 1;
    for (let i = 0; i < n; i++) {
      const x = (i - c) / ratio;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w =
        0.35875 -
        0.48829 * Math.cos((2 * Math.PI * i) / den) +
        0.14128 * Math.cos((4 * Math.PI * i) / den) -
        0.01168 * Math.cos((6 * Math.PI * i) / den);
      proto[i] = sinc * w;
    }

    this.phases = [];
    for (let p = 0; p < ratio; p++) {
      const ph = new Float32Array(this.tapsPerPhase);
      let sum = 0;
      for (let j = 0; j < this.tapsPerPhase; j++) {
        const idx = p + j * ratio;
        ph[j] = idx < n ? proto[idx] : 0;
        sum += ph[j];
      }
      if (Math.abs(sum) > 1e-12) {
        for (let j = 0; j < this.tapsPerPhase; j++) ph[j] /= sum;
      }
      this.phases.push(ph);
    }
  }

  reset(): void {
    this.hist.fill(0);
    this.pos = 0;
  }

  /** Writes `input.length * ratio` samples into `out`; returns the count. */
  process(input: Float32Array, out: Float32Array): number {
    const L = this.ratio;
    const hist = this.hist;
    const mask = this.mask;
    const taps = this.tapsPerPhase;
    let pos = this.pos;
    let written = 0;

    for (let i = 0; i < input.length; i++) {
      hist[pos] = input[i];
      for (let p = 0; p < L; p++) {
        const ph = this.phases[p];
        let acc = 0;
        let idx = pos;
        for (let j = 0; j < taps; j++) {
          acc += ph[j] * hist[idx];
          idx = (idx - 1) & mask;
        }
        out[written++] = acc;
      }
      pos = (pos + 1) & mask;
    }

    this.pos = pos;
    return written;
  }
}

export class SdrEngine {
  private ws: WebSocket | null = null;
  // Waterfall is now rendered by a dedicated Worker via OffscreenCanvas.
  // The main thread keeps a reference to the canvas element only.
  private waterfallWorker: Worker | null = null;
  private waterfallCanvas: HTMLCanvasElement | null = null;
  private spectrumWorker: Worker | null = null;
  private spectrumCanvas: HTMLCanvasElement | null = null;
  private audio: AudioEngine;
  private demodulator: Demodulator;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private destroyed = false;

  // FFT decode worker — offloads inflate/ADPCM/uint8 decode from the WS handler
  private fftDecodeWorker: Worker;
  private fftDecodeCallbacks = new Map<number, (result: FftDecodeResult) => void>();
  private fftDecodeSeq = 0;

  // Pending history: if MSG_FFT_HISTORY arrives before the waterfall worker is
  // ready (worker is created in attachCanvases which fires after App onMount),
  // buffer the decoded frames here and flush them once the worker initialises.
  private pendingHistory: {
    allFrames: Uint8Array;
    frameCount: number;
    binCount: number;
    serverMinDb: number;
    serverMaxDb: number;
  } | null = null;

  // FFT analysis worker — offloads signal level EMA and auto-range math
  private fftAnalysisWorker: Worker;
  private fftAnalysisFrameCount = 0;

  // Client-side FFT frame buffer — keeps last 1024 decoded Float32 frames.
  // Used for waterfall prefill on zoom/reset and future seek-back feature.
  private fftBuffer = new FftFrameBuffer(1024, 0);

  // ---- Segmented multi-tier (tiled) waterfall ----
  // All tiled state is inert until the server advertises waterfallProtocol===1
  // AND the client has sent its first waterfall_view. Until then the legacy
  // full-span path below is used unchanged.
  //
  // tiledRequested: a waterfall_view has been sent, so incoming frames may begin
  //   arriving tiled — we attempt a V1 decode and rely on the version-nibble
  //   guard to treat still-in-flight legacy frames as non-tiled.
  // tiledActive: the first genuinely-tiled frame has been received; only then do
  //   stitch/crop engage and legacy rendering stops.
  private tiledRequested = false;              // a waterfall_view has been sent
  private tiledActive = false;                 // a real tiled frame has arrived
  private tiledTier = 0;                        // tier of the active view (from frame tags)
  private tiledTileCount = 0;                   // tiles spanning the active view
  private tiledBaseTileIndex = 0;               // lowest tileIndex in the active view
  private tiledViewStartFrac = 0;               // exact view fractions to crop to
  private tiledViewEndFrac = 1;
  // Latest decoded tile per tileIndex for the active tier, for live stitching.
  // Pruned to the tiles currently covered by the view so a long pan session
  // cannot grow the stitched strip (and the per-frame allocation) forever.
  private tiledLatest = new Map<number, Float32Array>();
  // Tier each tiledLatest entry belongs to — lets a tier switch preserve tiles
  // just prefilled for the NEW tier (seeded by handleTiledHistory) while still
  // evicting stale entries from the previous tier.
  private tiledLatestTier = new Map<number, number>();
  // User zoom to restore when the Signal Analysis pane stops overriding the
  // view with its measurement window (null = no override active).
  private analysisPrevZoom: [number, number] | null = null;

  /** Viewport width in device-independent px (waterfall canvas), ≥1. */
  private get viewportPx(): number {
    if (this.waterfallCanvas) {
      const w = Math.round(this.waterfallCanvas.getBoundingClientRect().width);
      if (w > 0) return w;
      if (this.waterfallCanvas.clientWidth > 0) return this.waterfallCanvas.clientWidth;
    }
    return 1024;
  }

  /** Mirror of the server's tier selection, for local buffer sizing only. */
  private expectedTier(startFrac: number, endFrac: number, viewportPx: number): number {
    const span = Math.max(1e-9, endFrac - startFrac);
    const binsInView = span * store.fftSize();
    const t = Math.round(Math.log2(Math.max(1, binsInView / Math.max(1, viewportPx))));
    return Math.max(0, Math.min(maxTierIndex(), t));
  }

  /**
   * Compute the current zoom window as fractions of the full dongle span and,
   * when the tiled protocol is live, send a waterfall_view. Returns true when a
   * view was sent (so callers can keep the legacy path otherwise).
   */
  private sendWaterfallView(fps?: number): boolean {
    if (store.waterfallProtocol() !== 1) return false;
    const [zs, ze] = store.spectrumZoom();
    const startFrac = Math.max(0, Math.min(1, zs));
    const endFrac = Math.max(startFrac + 1e-4, Math.min(1, ze));
    const px = this.viewportPx;
    // Local-only tier estimate for buffer sizing; the server tags the truth.
    store.setSelectedTier(this.expectedTier(startFrac, endFrac, px));
    this.tiledViewStartFrac = startFrac;
    this.tiledViewEndFrac = endFrac;
    // Mark that a view was requested so the receive path begins attempting V1
    // decode; tiledActive flips only once a real tiled frame arrives.
    this.tiledRequested = true;
    this.send(packWaterfallView(px, startFrac, endFrac, fps));
    // Every strip from here on is cropped to a new window, so buffered frames
    // from the previous crop no longer align: drop them instead of replaying
    // mis-registered seek-back frames.
    this.fftBuffer.reset();
    // The incoming strip is already cropped to the view, so the renderers must
    // draw it edge-to-edge — their internal zoom is reset to the full strip.
    this.spectrumWorker?.postMessage({ type: 'reset-zoom' });
    this.waterfallWorker?.postMessage({ type: 'reset-zoom' });
    return true;
  }

  /**
   * Reset all tiled state back to the legacy full-span path (profile change,
   * disconnect, or a non-tiled server).
   */
  private resetTiledState(): void {
    this.tiledRequested = false;
    this.tiledActive = false;
    this.tiledTier = 0;
    this.tiledTileCount = 0;
    this.tiledBaseTileIndex = 0;
    this.tiledViewStartFrac = 0;
    this.tiledViewEndFrac = 1;
    this.tiledLatest.clear();
    this.tiledLatestTier.clear();
    this.analysisPrevZoom = null;
    store.setSelectedTier(0);
    store.setActiveTiles([]);
  }

  /** Route one decoded tiled FFT frame into the stitch map and restitch the strip. */
  private handleTiledFrame(frame: DecodedTiledFrame): void {
    const { tier, tileIndex, tileCount } = frame;

    // Tier switch (server authoritative) — drop tiles belonging to any other
    // tier, but keep entries already seeded for the NEW tier (prefill via
    // handleTiledHistory) so the prefilled line renders immediately.
    if (tier !== this.tiledTier || tileCount !== this.tiledTileCount) {
      this.tiledTier = tier;
      this.tiledTileCount = tileCount;
      for (const [idx, seededTier] of [...this.tiledLatestTier.entries()]) {
        if (seededTier !== tier) {
          this.tiledLatest.delete(idx);
          this.tiledLatestTier.delete(idx);
        }
      }
      this.fftBuffer.reset();
    }

    this.tiledLatest.set(tileIndex, frame.bins);
    this.tiledLatestTier.set(tileIndex, tier);
    this.pruneTilesOutsideView();

    const stitched = this.stitchActiveTiles();
    if (stitched) {
      // Feed the analysis worker (auto-range + signal-level EMA) with a clone,
      // mirroring the legacy FFT path.
      const fftForAnalysis = stitched.slice();
      this.fftAnalysisFrameCount++;
      const analysisMsg: FftAnalysisFrame = {
        type: 'frame',
        fftData: fftForAnalysis,
        tuneOffset:  store.tuneOffset(),
        bandwidth:   store.bandwidth(),
        sampleRate:  store.sampleRate(),
        autoRange:   store.waterfallAutoRange(),
        frameCount:  this.fftAnalysisFrameCount,
      };
      this.fftAnalysisWorker.postMessage(analysisMsg, [fftForAnalysis.buffer]);
      this.renderFftFrame(stitched);
    }
  }

  /**
   * Stitch the live tiles of the active tier into a contiguous ascending-Hz
   * strip and crop to the exact [startFrac, endFrac] view. Returns null until
   * at least one tile of the active tier is present.
   */
  private stitchActiveTiles(): Float32Array | null {
    const tileCount = this.tiledTileCount;
    if (tileCount <= 0) return null;

    // tilesPerTier[t] = tierBins[t] / effectiveTileBins. The full tier spans the
    // whole dongle; a tile = tileBins columns. Determine base tile + per-tile
    // bin width from the first live tile.
    const indices = [...this.tiledLatest.keys()].sort((a, b) => a - b);
    if (indices.length === 0) return null;

    // Prefer the real decoded tile width (whole tiles are uniform) and fall
    // back to the meta-advertised effectiveTileBins.
    const firstTile = this.tiledLatest.get(indices[0])!;
    const tileBins = firstTile.length > 0 ? firstTile.length : store.effectiveTileBins();

    // Stitch only the tile range the view actually overlaps, not the whole
    // tier: a deeply zoomed view at the finest tier touches 1 tile out of up
    // to 64, and allocating the full tier width every frame would waste
    // hundreds of KB per frame for columns that are immediately cropped away.
    const range = this.visibleTileRange();
    const first = range ? range[0] : indices[0];
    const last = range ? range[1] : indices[indices.length - 1];
    const windowTiles = last - first + 1;
    this.tiledBaseTileIndex = first;
    store.setActiveTiles(indices.filter((idx) => idx >= first && idx <= last));

    const stripBins = windowTiles * tileBins;
    const strip = new Float32Array(stripBins);
    // Fill from each tile; missing tiles stay at 0 (floor) until they arrive.
    for (const idx of indices) {
      const col = (idx - first) * tileBins;
      if (col < 0 || col >= stripBins) continue;
      const tile = this.tiledLatest.get(idx)!;
      const n = Math.min(tileBins, tile.length, stripBins - col);
      strip.set(tile.subarray(0, n), col);
    }

    return this.cropStripToView(strip, windowTiles);
  }

  /**
   * Crop a full-tier-aligned strip to the exact [startFrac, endFrac] view. The
   * strip's lowest bin corresponds to `tiledBaseTileIndex` and covers
   * `windowTiles` tiles of the full tier, whose tile count comes from the frame
   * tag (server-authoritative) rather than local metadata.
   */
  private cropStripToView(strip: Float32Array, windowTiles: number): Float32Array {
    const start = this.tiledViewStartFrac;
    const end = this.tiledViewEndFrac;
    const tilesPerTier = Math.max(1, this.tiledTileCount);
    const tileFrac = 1 / tilesPerTier;
    const stripStartFrac = this.tiledBaseTileIndex * tileFrac;
    const stripSpanFrac = windowTiles * tileFrac;
    if (stripSpanFrac <= 0) return strip;

    // Map the view [start,end] into strip-bin coordinates.
    const lo = ((start - stripStartFrac) / stripSpanFrac) * strip.length;
    const hi = ((end - stripStartFrac) / stripSpanFrac) * strip.length;
    const a = Math.max(0, Math.min(strip.length, Math.floor(lo)));
    const b = Math.max(a + 1, Math.min(strip.length, Math.ceil(hi)));
    if (a === 0 && b === strip.length) return strip;
    return strip.slice(a, b);
  }

  /**
   * Tile index range the current view overlaps, using the same arithmetic as
   * the server (`floor(start*count)..=ceil(end*count)-1`). Null when no tiled
   * view is active.
   */
  private visibleTileRange(): [number, number] | null {
    const count = this.tiledTileCount;
    if (count <= 0) return null;
    const first = Math.max(0, Math.min(count - 1, Math.floor(this.tiledViewStartFrac * count)));
    const last = Math.max(first, Math.min(count - 1, Math.ceil(this.tiledViewEndFrac * count) - 1));
    return [first, last];
  }

  /** Keep only tiles covered by the current view. */
  private pruneTilesOutsideView(): void {
    if (this.tiledLatest.size === 0) return;
    const range = this.visibleTileRange();
    if (!range) return;
    const [first, last] = range;
    for (const idx of [...this.tiledLatest.keys()]) {
      if (idx < first || idx > last) {
        this.tiledLatest.delete(idx);
        this.tiledLatestTier.delete(idx);
      }
    }
  }

  /** Route a decoded tiled history burst: seed the stitch map for prefill. */
  private handleTiledHistory(hist: DecodedTiledHistory): void {
    // Seed the live map so the next stitch shows prefilled data immediately.
    // Tag it with this tier so the tier-switch clear in handleTiledFrame does
    // not discard the seed before the first live frame of the new tier lands.
    if (hist.frames.length > 0) {
      this.tiledLatest.set(hist.tileIndex, hist.frames[hist.frames.length - 1]);
      this.tiledLatestTier.set(hist.tileIndex, hist.tier);
    }
  }

  // Zoomed spectra for the foreground decoder pane. Each frame is ~537 B,
  // so 240 frames is ~130 KB; the pane only ever draws the newest ~160.
  private decoderScopeFrames: DecoderScopeFrame[] = [];

  // Pending waterfall prefill: rAF handle for deferred zoom/pan redraws.
  // Multiple zoom wheel events within one frame collapse into a single redraw.
  private pendingWaterfallPrefill: number | null = null;

  private scheduleWaterfallPrefill(): void {
    if (this.pendingWaterfallPrefill !== null) return;
    this.pendingWaterfallPrefill = requestAnimationFrame(() => {
      this.pendingWaterfallPrefill = null;
      if (this.waterfallWorker && this.fftBuffer.count > 0) {
        // Frames are plain Float32Arrays — safe to transfer
        const frames = this.fftBuffer.getFrames().map(f => f.slice()); // clone — buffer owns originals
        this.waterfallWorker.postMessage({ type: 'prefill', frames });
      }
    });
  }

  // Seek-back: when > 0, waterfall is frozen N frames in the past
  private seekOffset = 0;



  // ADPCM decoder for IQ sub-band (stateful, streaming)
  private iqAdpcmDecoder = new ImaAdpcmDecoder();

  // Opus decoder for server-side demodulated audio (WASM, async init)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private opusDecoder: OpusDecoder<any> | null = null;
  private opusDecoderReady = false;
  private opusDecoderChannels = 1;

  // LMS adaptive NR (time-domain, no musical-noise artifacts)
  private anr = new LmsAnr();

  // Audio filters (rumble HPF + auto-notch + hi-blend for FM stereo)
  private rumbleFilter = new RumbleFilter(48000);
  private autoNotch = new AutoNotch(48000);
  private hiBlend = new HiBlendFilter(48000);

  // Soft mute: smoothed gain factor (0-1) based on signal level
  private softMuteGain = 1.0;

  // Hang-timer AGC (post-demod, pre-audio)
  private agc = new HangAgc(48000);

  // Resampler state for sub-48kHz modes (SSB 24kHz, CW 12kHz → 48kHz)
  private resampleRatio = 1; // inputRate / 48000 (1 = no resampling needed)
  private resamplePhase = 0; // fractional sample position for interpolation
  private resampleBuf = new Float32Array(8192);
  private resampleBufL = new Float32Array(8192);
  private resampleBufR = new Float32Array(8192);
  private upsampler: SincUpsampler | null = null;
  private upsamplerL: SincUpsampler | null = null;
  private upsamplerR: SincUpsampler | null = null;


  // Audio diagnostics
  private iqInCount = 0;
  private audioOutCount = 0;
  private lastAudioLog = performance.now();

  // Squelch grace period: after tuning/mode change, bypass squelch briefly
  // so the jitter buffer can fill and signal level can stabilize.
  private squelchBypassUntil = 0;

  // Tracks whether we have ever successfully subscribed in this session.
  // Unlike activeDongleId (cleared on disconnect), this stays true across
  // reconnects so the 'subscribed' handler can restore tuning state.
  private hadPriorSubscription = false;
  /** True while re-establishing a dropped connection (restores tuning state). */
  private reconnecting = false;

  // Bandwidth / throughput tracking (updated every second)
  private bwFftFrames = 0;
  private bwIqSamples = 0;
  private bwTotalBytes = 0;
  // Codec performance tracking (wire = actual bytes received, raw = uncompressed equivalent)
  private bwFftWireBytes = 0;
  private bwFftRawBytes = 0;
  private bwIqWireBytes = 0;
  private bwIqRawBytes = 0;
  private bwLastUpdate = performance.now();
  private bwHistoryMax = 30; // keep 30 seconds of history

  // Short raw-IQ capture for the client-side signal identifier.
  private iqCaptureChunks: Int16Array[] = [];
  private iqCaptureActive = false;
  private iqCaptureUntil = 0;

  // Callbacks for decoder data and meta messages
  onDecoderData?: (type: string, data: unknown) => void;
  onMetaMessage?: (meta: ServerMeta) => void;

  constructor() {
    this.audio = new AudioEngine();
    this.demodulator = this.newDemodulator(store.mode());
    this.attachRdsCallback();

    // Spin up FFT decode worker
    this.fftDecodeWorker = new Worker(
      new URL('./fft-decode.worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.fftDecodeWorker.onmessage = (e: MessageEvent<FftDecodeResult>) => {
      const { id, fftData, wireBytes, rawBytes } = e.data;
      const cb = this.fftDecodeCallbacks.get(id);
      if (cb) {
        this.fftDecodeCallbacks.delete(id);
        cb({ id, fftData, wireBytes, rawBytes });
      }
    };

    // Spin up FFT analysis worker
    this.fftAnalysisWorker = new Worker(
      new URL('./fft-analysis.worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.fftAnalysisWorker.onmessage = (e: MessageEvent<FftAnalysisResult>) => {
      const { signalLevel, snr, newMin, newMax } = e.data;
      store.setSignalLevel(signalLevel);
      store.setSnr(snr);
      if (newMin !== undefined && newMax !== undefined) {
        if (newMin !== store.waterfallMin() || newMax !== store.waterfallMax()) {
          store.setWaterfallMin(newMin);
          store.setWaterfallMax(newMax);
          this.waterfallWorker?.postMessage({ type: 'set-range', minDb: newMin, maxDb: newMax });
          this.spectrumWorker?.postMessage({ type: 'set-range', minDb: newMin, maxDb: newMax });
        }
      }
    };

    // Resume AudioContext when page becomes visible again (e.g. screen unlock).
    // This is the baseline for keeping audio alive on mobile.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.audio.resume();
      }
    });
  }

  /** Update the Media Session API metadata (lock screen / notification shade).
   *  Uses RDS PS/RT when available, falls back to frequency + mode.
   *  Best-effort: keeps audio alive on Android, may help on iOS 17+. */
  private updateMediaSession(): void {
    if (!('mediaSession' in navigator)) return;

    const freqHz  = store.tunedFrequency();
    const freqMhz = (freqHz / 1e6).toFixed(4).replace(/\.?0+$/, '');
    const mode    = store.mode().toUpperCase();

    // RDS PS (station name) as title when decoded, otherwise "100.3 MHz"
    const ps  = store.rdsPs().trim();
    const rt  = store.rdsRt().trim();
    const pty = store.rdsPty().trim();

    const title  = ps  || `${freqMhz} MHz`;
    // Artist: RT if present, else mode or PTY label
    const artist = rt  || (pty ? `${mode} · ${pty}` : mode);
    // Album: always show frequency so it's visible on the lock screen
    const album  = ps  ? `${freqMhz} MHz` : 'no-sdr';

    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album });
    navigator.mediaSession.playbackState = 'playing';
  }

  /** Create a demodulator and apply the persisted FM de-emphasis setting. */
  private newDemodulator(mode: DemodMode): Demodulator {
    const d = getDemodulator(mode);
    d.setDeemphasis?.(store.deemphasisUs());
    return d;
  }

  /** Attach RDS callback to current demodulator if it supports RDS */
  private attachRdsCallback(): void {
    if (this.demodulator.setRdsCallback) {
      this.demodulator.setRdsCallback((data: RdsData) => {        
        if (data.ps) store.setRdsPs(data.ps);
        store.setRdsRt(data.rt);
        store.setRdsPty(data.ptyName);
        store.setRdsPi(data.pi !== null ? data.pi.toString(16).toUpperCase().padStart(4, '0') : '');
        store.setRdsSynced(data.synced);
        // Update lock screen with station name / radio text as RDS data arrives
        this.updateMediaSession();
      });
    } else {
      // Clear RDS data when not in WFM mode
      store.setRdsPs('');
      store.setRdsRt('');
      store.setRdsPty('');
      store.setRdsPi('');
      store.setRdsSynced(false);
    }
  }

  /**
   * Update the resample ratio based on the demodulator's audio output rate.
   * WFM/NFM/AM output at 48kHz (ratio = 1, no resampling needed).
   * SSB outputs at 24kHz (ratio = 2). CW outputs at 12kHz (ratio = 4).
   */
  private updateResampleRatio(): void {
    const iqRate = store.iqSampleRate();
    const mode = store.mode();
    // Demod output rates: WFM decimates 240k→48k internally. Others output at IQ rate.
    let demodOutputRate: number;
    if (mode === 'wfm') {
      demodOutputRate = 48000; // WFM demod has internal 5:1 decimation
    } else {
      demodOutputRate = iqRate; // NFM/AM/SSB/CW output at IQ rate
    }
    this.resampleRatio = demodOutputRate >= 48000 ? 1 : 48000 / demodOutputRate;
    this.resamplePhase = 0;
    this.resampleBuf = new Float32Array(8192);
    this.resampleBufL = new Float32Array(8192);
    this.resampleBufR = new Float32Array(8192);

    const ratio = this.resampleRatio;
    const isInteger = ratio > 1 && Math.abs(ratio - Math.round(ratio)) < 1e-9;
    this.upsampler = null;
    this.upsamplerL = null;
    this.upsamplerR = null;
    if (isInteger) {
      const l = Math.round(ratio);
      this.upsampler = new SincUpsampler(l);
      this.upsamplerL = new SincUpsampler(l);
      this.upsamplerR = new SincUpsampler(l);
    }
  }

  /**
   * Resample audio from a lower sample rate to 48 kHz.
   *
   * Integer ratios (24k→48k, 12k→48k) use a polyphase windowed-sinc
   * interpolator; linear interpolation would leave images only ~29 dB down
   * around 4 kHz. Non-integer ratios fall back to linear.
   * Returns the input unchanged when no conversion is needed.
   */
  private resampleTo48k(samples: Float32Array): Float32Array {
    if (this.resampleRatio <= 1) return samples;
    if (this.upsampler) {
      return this.upsampleWith(this.upsampler, samples, 'mono');
    }
    return this.resampleLinearTo48k(samples);
  }

  private resampleLinearTo48k(samples: Float32Array): Float32Array {
    const ratio = this.resampleRatio;
    const outLen = Math.floor(samples.length * ratio);
    const out = new Float32Array(outLen);
    let phase = this.resamplePhase;
    let outIdx = 0;

    for (let i = 0; outIdx < outLen; ) {
      const srcPos = phase;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;

      if (srcIdx >= samples.length - 1) break;

      out[outIdx++] = samples[srcIdx] * (1 - frac) + samples[srcIdx + 1] * frac;
      phase += 1 / ratio;
    }

    this.resamplePhase = phase - Math.floor(phase);
    return out.subarray(0, outIdx);
  }

  private upsampleWith(
    up: SincUpsampler,
    samples: Float32Array,
    which: 'mono' | 'left' | 'right',
  ): Float32Array {
    const needed = samples.length * up.ratio + 4;
    let buf =
      which === 'mono' ? this.resampleBuf : which === 'left' ? this.resampleBufL : this.resampleBufR;
    if (buf.length < needed) {
      buf = new Float32Array(Math.ceil(needed * 1.5));
      if (which === 'mono') this.resampleBuf = buf;
      else if (which === 'left') this.resampleBufL = buf;
      else this.resampleBufR = buf;
    }
    const n = up.process(samples, buf);
    return buf.subarray(0, n);
  }

  /**
   * Resample stereo audio from a lower sample rate to 48 kHz.
   * Uses one interpolator per channel so both share the same timing without
   * overwriting each other's history.
   */
  private resampleStereoTo48k(left: Float32Array, right: Float32Array): { left: Float32Array; right: Float32Array } {
    if (this.resampleRatio <= 1) return { left, right };
    if (!this.upsamplerL || !this.upsamplerR) {
      const savedPhase = this.resamplePhase;
      const l = this.resampleLinearTo48k(left);
      this.resamplePhase = savedPhase;
      const r = this.resampleLinearTo48k(right);
      return { left: l, right: r };
    }
    const resLeft = this.upsampleWith(this.upsamplerL, left, 'left');
    const resRight = this.upsampleWith(this.upsamplerR, right, 'right');
    return { left: resLeft, right: resRight };
  }

  attachCanvases(waterfallCanvas: HTMLCanvasElement, spectrumCanvas: HTMLCanvasElement): void {
    this.waterfallCanvas = waterfallCanvas;
    this.spectrumCanvas = spectrumCanvas;

    // Terminate existing workers before creating new ones (remount case)
    if (this.waterfallWorker) {
      this.waterfallWorker.terminate();
      this.waterfallWorker = null;
    }
    if (this.spectrumWorker) {
      this.spectrumWorker.terminate();
      this.spectrumWorker = null;
    }

    // ---- Waterfall worker ----
    const themeColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--sdr-freq-color').trim();

    this.waterfallWorker = new Worker(
      new URL('./waterfall.worker.ts', import.meta.url),
      { type: 'module' },
    );

    let offscreen: OffscreenCanvas;
    try {
      offscreen = waterfallCanvas.transferControlToOffscreen();
    } catch (err) {
      console.warn('[sdr] waterfall transferControlToOffscreen() failed:', err);
      this.waterfallWorker?.terminate();
      this.waterfallWorker = null;
      return;
    }
    const rect = waterfallCanvas.getBoundingClientRect();
    this.waterfallWorker.postMessage(
      {
        type: 'init',
        canvas: offscreen,
        width:  Math.round(rect.width)  || waterfallCanvas.clientWidth,
        height: Math.round(rect.height) || waterfallCanvas.clientHeight,
        theme:  store.waterfallTheme(),
        minDb:  store.waterfallMin(),
        maxDb:  store.waterfallMax(),
        gamma:  store.waterfallGamma(),
      },
      [offscreen],
    );

    // ---- Spectrum worker ----
    this.spectrumWorker = new Worker(
      new URL('./spectrum.worker.ts', import.meta.url),
      { type: 'module' },
    );

    let spectrumOffscreen: OffscreenCanvas;
    try {
      spectrumOffscreen = spectrumCanvas.transferControlToOffscreen();
    } catch (err) {
      console.warn('[sdr] spectrum transferControlToOffscreen() failed:', err);
      this.spectrumWorker?.terminate();
      this.spectrumWorker = null;
      return;
    }

    const sRect = spectrumCanvas.getBoundingClientRect();
    const sW = Math.round(sRect.width);
    const sH = Math.round(sRect.height);
    const dpr = window.devicePixelRatio || 1;

    this.spectrumWorker.postMessage(
      {
        type: 'init',
        canvas: spectrumOffscreen,
        width: sW,
        height: sH,
        dpr,
        minDb: store.waterfallMin(),
        maxDb: store.waterfallMax(),
        accentColor: themeColor || undefined,
        peakHold: store.spectrumPeakHold(),
        signalFill: store.spectrumSignalFill(),
        noiseFloor: store.spectrumNoiseFloor(),
        smoothingAlpha: store.spectrumAveraging() === 'slow' ? 0.7
                      : store.spectrumAveraging() === 'med' ? 0.4 : 0,
      },
      [spectrumOffscreen],
    );

    // Flush any history that arrived before the worker was ready.
    // Do NOT flush here — the canvas has no dimensions yet at onMount time.
    // flushPendingHistory() is called by WaterfallDisplay after the first resize rAF.
  }

  /**
   * Must be called after handleResize() has given the worker real canvas dimensions.
   */
  flushPendingHistory(): void {
    if (!this.pendingHistory || !this.waterfallWorker) {
      return;
    }
    const h = this.pendingHistory;
    this.pendingHistory = null;
    this.waterfallWorker.postMessage(
      { type: 'prefill-history', allFrames: h.allFrames, frameCount: h.frameCount, binCount: h.binCount, serverMinDb: h.serverMinDb, serverMaxDb: h.serverMaxDb },
      [h.allFrames.buffer],
    );
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    store.setConnectionState('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const clientId = store.localClientId();
    const wsUrl = `${protocol}//${location.host}/ws${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      store.setConnected(true);
      store.setConnectionState('connected');
      this.reconnectAttempts = 0;
      store.setReconnectAttempt(0);
      // FIX: Resume AudioContext if it was initialized
      if (this.audio?.isInitialized) {
        this.audio.resume();
      }
      console.log('[SDR] WebSocket connected');
      // state_sync from server provides the full dongle list — no REST fallback needed
      // Fetch public bookmarks (admin-configured) for bookmark ribbon display
      this.fetchAdminBookmarks();
    };

    this.ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryMessage(event.data);
      } else if (typeof event.data === 'string') {
        // Shouldn't happen in our protocol, but handle gracefully
        try {
          const meta = JSON.parse(event.data);
          this.handleMetaMessage(meta);
        } catch {
          console.warn('[SDR] Unexpected text message:', event.data);
        }
      }
    };

    this.ws.onclose = () => {
      store.setConnected(false);
      store.setConnectionState('disconnected');
      this.reconnecting = true;
      store.setUserLocations([]);
      // FIX: Clear activeDongleId so state_sync triggers resubscription on reconnect
      store.setActiveDongleId('');
      // Tiled view does not survive a reconnect — the resubscription will stream
      // legacy full-span frames until the user zooms again.
      this.resetTiledState();
      console.log('[SDR] WebSocket disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[SDR] WebSocket error:', err);
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[SDR] Max reconnect attempts reached');
      store.setConnectionState('disconnected');
      return;
    }

    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    store.setReconnectAttempt(this.reconnectAttempts);

    this.reconnectTimer = setTimeout(() => {
      console.log(`[SDR] Reconnecting (attempt ${this.reconnectAttempts})...`);
      this.connect();
    }, delay);
  }

  /**
   * Handle binary messages from server
   */
  private handleBinaryMessage(data: ArrayBuffer): void {
    const [type, payload] = unpackBinaryMessage(data);

    // Track total inbound bytes for bandwidth meter
    this.bwTotalBytes += data.byteLength;
    this.updateBandwidthStats();

    switch (type) {
      case MSG_FFT:
      case MSG_FFT_COMPRESSED:
      case MSG_FFT_ADPCM:
      case MSG_FFT_DEFLATE: {
        this.bwFftFrames++;
        this.bwFftWireBytes += payload.byteLength;

        // Tiled path: once a waterfall_view has been requested the server will
        // switch this client to tagged whole-tile frames (V1 tier header +
        // legacy codec body). We attempt a V1 decode while a view is pending or
        // active; decodeFftFrame's version-nibble guard reports still-in-flight
        // legacy frames as non-tiled, so those fall through to the legacy path.
        // tiledActive flips only on the first genuinely-tiled frame.
        if (store.waterfallProtocol() === 1 && (this.tiledActive || this.tiledRequested)) {
          let handledTiled = false;
          try {
            const info = decodeFftFrame(data, true);
            if (info.tiled && isPlausibleTileTag(info.tier, info.tileIndex, info.tileCount)) {
              this.tiledActive = true;
              const bins = dequantTiledFftFrame(data, info);
              if (bins.length > 0) {
                this.bwFftRawBytes += bins.length * 4;
                this.handleTiledFrame({
                  tier: info.tier!,
                  tileIndex: info.tileIndex!,
                  tileCount: info.tileCount!,
                  binCount: bins.length,
                  bins,
                });
              }
              handledTiled = true;
            }
          } catch (e) {
            // Truncated/corrupt tiled frame — drop it rather than throwing.
            console.error('[FFT] tiled frame decode error:', e);
            handledTiled = true;
          }
          if (handledTiled) break;
          // else: a legacy frame still in flight — fall through to the worker.
        }

        // Dispatch raw payload to the FFT decode worker (zero-copy via transfer).
        // The worker posts back a decoded Float32Array which drives renderFftFrame.
        const id = this.fftDecodeSeq++;
        const req: FftDecodeRequest = { id, type: type as any, payload };
        this.fftDecodeCallbacks.set(id, ({ fftData, rawBytes }) => {
          if (fftData.length === 0) return;
          this.bwFftRawBytes += rawBytes;
          // Send to analysis worker (also zero-copy via transfer — clone for spectrum)
          const fftForAnalysis = fftData.slice();
          this.fftAnalysisFrameCount++;
          const analysisMsg: FftAnalysisFrame = {
            type: 'frame',
            fftData: fftForAnalysis,
            tuneOffset:  store.tuneOffset(),
            bandwidth:   store.bandwidth(),
            sampleRate:  store.sampleRate(),
            autoRange:   store.waterfallAutoRange(),
            frameCount:  this.fftAnalysisFrameCount,
          };
          this.fftAnalysisWorker.postMessage(analysisMsg, [fftForAnalysis.buffer]);
          // Drive spectrum + waterfall worker with the original data
          this.renderFftFrame(fftData);
        });
        // Transfer the payload buffer to the worker — no copy
        this.fftDecodeWorker.postMessage(req, [payload]);
        break;
      }

      case MSG_AUDIO: {
        const audioData = new Int16Array(payload);
        this.audio.pushAudio(audioData);
        break;
      }

      case MSG_IQ: {
        // Per-user IQ sub-band data → client-side demodulation → audio
        // Wire: [Uint32 sampleRate LE][Uint8 channels][Uint8 reserved][Int16 I/Q samples...]
        this.bwIqWireBytes += payload.byteLength;
        if (payload.byteLength < 6) break; // malformed header
        const iqRawHdr = new DataView(payload);
        const iqRawSampleRate = iqRawHdr.getUint32(0, true);
        // Update demodulator input rate only when it changes (wire-driven, avoids per-frame resamplePhase reset)
        if (iqRawSampleRate > 0 && iqRawSampleRate !== store.iqSampleRate()) {
          this.demodulator.setInputSampleRate(iqRawSampleRate);
          store.setIqSampleRate(iqRawSampleRate);
          this.updateResampleRatio();
        }
        const iqRawData = new Int16Array(payload, 6);
        this.bwIqRawBytes += iqRawData.byteLength;
        this.processIqData(iqRawData);
        break;
      }

      case MSG_IQ_ADPCM: {
        // ADPCM-compressed IQ sub-band: decode nibbles → Int16 interleaved I/Q
        // Wire: [Uint32 sampleCount LE][Uint32 sampleRate LE][Uint8 channels][Uint8 reserved][ADPCM bytes...]
        this.bwIqWireBytes += payload.byteLength;
        if (payload.byteLength < 10) break; // malformed header
        const iqAdpcmHdr = new DataView(payload);
        const sampleCount = iqAdpcmHdr.getUint32(0, true);
        const iqAdpcmSampleRate = iqAdpcmHdr.getUint32(4, true);
        // Update demodulator input rate only when it changes
        if (iqAdpcmSampleRate > 0 && iqAdpcmSampleRate !== store.iqSampleRate()) {
          this.demodulator.setInputSampleRate(iqAdpcmSampleRate);
          store.setIqSampleRate(iqAdpcmSampleRate);
          this.updateResampleRatio();
        }
        const adpcmData = new Uint8Array(payload, 10);
        const decoded = this.iqAdpcmDecoder.decode(adpcmData);
        // Trim to exact sample count (ADPCM may produce +1 sample if odd count)
        const iqData = sampleCount < decoded.length ? decoded.subarray(0, sampleCount) : decoded;
        this.bwIqRawBytes += iqData.length * 2; // equivalent Int16 size
        this.processIqData(iqData);
        break;
      }

      case MSG_AUDIO_OPUS: {
        // Server-side demodulated + Opus-encoded audio (mono or stereo)
        // Wire: [Uint16 sampleCount LE] [Uint8 channels] [Opus packet bytes]
        this.bwIqWireBytes += payload.byteLength;
        try {
          const headerView = new DataView(payload);
          const opusSamples = headerView.getUint16(0, true);
          const channels = headerView.getUint8(2);
          const opusPacket = new Uint8Array(payload, 3);

          // Wire-driven decoder lifecycle: rebuild if decoder is absent, not ready,
          // or channel count changed. This is the ONLY place that manages the Opus
          // decoder — client is a dumb terminal driven by wire headers.
          if (!this.opusDecoder || !this.opusDecoderReady || channels !== this.opusDecoderChannels) {
            this.resetOpusDecoderState(channels);
          }

          // Squelch gate — same logic as processIqData()
          const squelchLevel = store.squelch();
          const inGracePeriod = performance.now() < this.squelchBypassUntil;
          const squelchOpen = squelchLevel === null || inGracePeriod || store.signalLevel() >= squelchLevel;

          if (this.opusDecoder && this.opusDecoderReady && squelchOpen) {
            const { channelData } = this.opusDecoder.decodeFrame(opusPacket);
            this.bwIqRawBytes += opusSamples * channels * 2;

            if (channels === 2 && channelData.length >= 2) {
              // Apply Adaptive NR
              if (store.nrEnabled()) {
                this.anr.process(channelData[0]);
                this.anr.process(channelData[1]);
              }
              // Apply audio filters (rumble + auto-notch + hi-blend)
              this.rumbleFilter.processStereo(channelData[0], channelData[1]);
              this.autoNotch.processStereo(channelData[0], channelData[1]);
              this.hiBlend.processStereo(channelData[0], channelData[1]);
              // Apply AGC
              if (store.agcEnabled()) {
                this.agc.processStereo(channelData[0], channelData[1]);
              }
              this.applySoftMuteStereo(channelData[0], channelData[1]);
              this.audio.pushStereoAudio(channelData[0], channelData[1]);
              if (!store.stereoDetected()) store.setStereoDetected(true);
            } else {
              // Apply Adaptive NR
              if (store.nrEnabled()) {
                this.anr.process(channelData[0]);
              }
              // Apply audio filters
              this.rumbleFilter.process(channelData[0]);
              this.autoNotch.process(channelData[0]);
              // Apply AGC
              if (store.agcEnabled()) {
                this.agc.process(channelData[0]);
              }
              this.applySoftMute(channelData[0]);
              this.audio.pushDemodulatedAudio(channelData[0]);
              if (store.stereoDetected()) store.setStereoDetected(false);
            }
          }
        } catch (e) {
          console.error('[OPUS] decode error:', e);
        }
        break;
      }

      case MSG_META: {
        const decoder = new TextDecoder();
        const json = decoder.decode(payload);
        const meta: ServerMeta = JSON.parse(json);
        this.handleMetaMessage(meta);
        break;
      }

      case MSG_FFT_HISTORY: {
        // Tiled path: server sends a tagged 0x0D burst per (tier,tile) when
        // entering a view. Decode the header + dequant frames from the reported
        // payloadOffset, then route each into its per-tile ring for prefill.
        if (store.waterfallProtocol() === 1 && (this.tiledActive || this.tiledRequested)) {
          try {
            const info = decodeFftHistoryFrame(data, true);
            if (info.tiled && isPlausibleTileTag(info.tier, info.tileIndex, info.tileCount)) {
              const frames = dequantTiledFftHistory(data, info);
              if (frames.length > 0) {
                this.handleTiledHistory({
                  tier: info.tier!,
                  tileIndex: info.tileIndex!,
                  tileCount: info.tileCount!,
                  binCount: info.binCount,
                  frames,
                });
              }
              break;
            }
            // Non-tiled burst still in flight — fall through to the legacy path.
          } catch (e) {
            // Truncated/corrupt tiled history — drop it rather than throwing.
            console.error('[FFT_HISTORY] tiled decode error:', e);
            break;
          }
        }
        // Wire (payload, after type byte stripped):
        //   [Uint16 frameCount LE][Uint32 binCount LE][Int16 minDb LE][Int16 maxDb LE]
        //   [Uint8 codec][compressed/raw frame data...]
        try {
          const v = new DataView(payload);
          const frameCount = v.getUint16(0, true);
          const binCount   = v.getUint32(2, true);
          const minDb      = v.getInt16(6, true);
          const maxDb      = v.getInt16(8, true);
          const codec      = v.getUint8(10);           // 0=none, 1=deflate, 2=adpcm

          if (frameCount > 0 && binCount > 0) {
            const serverRange = maxDb - minDb;
            const totalSamples = frameCount * binCount;

            // Decode compressed payload → flat Uint8 array (frameCount × binCount)
            let allFrames: Uint8Array;

            if (codec === FFT_HISTORY_CODEC_DEFLATE) {
              // Delta+deflate: inflate then undo delta
              const deflPayload = new Uint8Array(payload, 11);
              const delta = inflateSync(deflPayload);
              allFrames = new Uint8Array(totalSamples);
              allFrames[0] = delta[0];
              for (let i = 1; i < totalSamples; i++) {
                allFrames[i] = (allFrames[i - 1] + delta[i]) & 0xFF;
              }

            } else if (codec === FFT_HISTORY_CODEC_ADPCM) {
              // ADPCM → Float32 dB → re-quantize to Uint8 for waterfall worker
              const adpcmPayload = payload.slice(11); // copy — decodeFftAdpcm needs ArrayBuffer
              const float32 = decodeFftAdpcm(adpcmPayload);
              allFrames = new Uint8Array(totalSamples);
              for (let i = 0; i < totalSamples; i++) {
                const n = (float32[i] - minDb) / serverRange;
                allFrames[i] = n < 0 ? 0 : n > 1 ? 255 : Math.round(n * 255);
              }

            } else {
              // none — raw Uint8 frames starting at offset 11
              allFrames = new Uint8Array(payload, 11, totalSamples).slice();
            }


            // Send decoded flat buffer to waterfall worker
            if (this.waterfallWorker) {
              const transfer = allFrames.slice(); // ensure own buffer for transfer
              this.waterfallWorker.postMessage(
                { type: 'prefill-history', allFrames: transfer, frameCount, binCount, serverMinDb: minDb, serverMaxDb: maxDb },
                [transfer.buffer],
              );
            } else {
              this.pendingHistory = {
                allFrames: allFrames.slice(),
                frameCount,
                binCount,
                serverMinDb: minDb,
                serverMaxDb: maxDb,
              };
            }

            // Defer FFT buffer population in batches to keep the main thread
            // responsive during connect. Processing hundreds of frames with
            // interpolation can block for 135-180ms; batching at ~20 frames
            // per tick keeps each chunk under ~8ms.
            const BATCH_SIZE = 20;
            const liveBinCount = store.fftSize();
            this.fftBuffer.reset();
            let batchIdx = 0;
            const processBatch = () => {
              const end = Math.min(batchIdx + BATCH_SIZE, frameCount);
              for (; batchIdx < end; batchIdx++) {
                const off = batchIdx * binCount;
                if (liveBinCount === binCount) {
                  const f32 = new Float32Array(binCount);
                  for (let b = 0; b < binCount; b++) {
                    f32[b] = minDb + (allFrames[off + b] / 255) * serverRange;
                  }
                  this.fftBuffer.push(f32);
                } else {
                  const f32 = new Float32Array(liveBinCount);
                  const scale = (binCount - 1) / (liveBinCount - 1);
                  for (let b = 0; b < liveBinCount; b++) {
                    const src = b * scale;
                    const lo  = Math.floor(src);
                    const hi  = Math.min(lo + 1, binCount - 1);
                    const t   = src - lo;
                    const dbLo = minDb + (allFrames[off + lo] / 255) * serverRange;
                    const dbHi = minDb + (allFrames[off + hi] / 255) * serverRange;
                    f32[b] = dbLo + t * (dbHi - dbLo);
                  }
                  this.fftBuffer.push(f32);
                }
              }
              if (batchIdx < frameCount) {
                setTimeout(processBatch, 0);
              }
            };
            processBatch();
          }
        } catch (e) {
          console.error('[FFT_HISTORY] decode error:', e);
        }
        break;
      }

      case MSG_DECODER: {
        const decoder = new TextDecoder();
        const json = decoder.decode(payload);
        const { decoderType, data: decoderData } = JSON.parse(json);
        this.onDecoderData?.(decoderType, decoderData);
        break;
      }

      case MSG_DECODER_SCOPE: {
        const frame = unpackDecoderScope(payload);
        if (!frame) break;
        this.decoderScopeFrames.push(frame);
        if (this.decoderScopeFrames.length > 240) this.decoderScopeFrames.shift();
        store.setDecoderScopeSeq(store.decoderScopeSeq() + 1);
        break;
      }

      case MSG_SIGNAL_LEVEL: {
        const level = new Float32Array(payload)[0];
        store.setSignalLevel(level);
        this.updateAutoHiBlend(level);
        break;
      }

      case MSG_RDS: {
        // Server-side RDS data from Opus codec path (WFM mode).
        // Bypasses the client-side demodulator — directly update store.
        try {
          const text = new TextDecoder().decode(payload);
          const rds = JSON.parse(text);
          if (rds.ps) store.setRdsPs(rds.ps);
          if (rds.rt !== undefined) store.setRdsRt(rds.rt);
          if (rds.ptyName !== undefined) store.setRdsPty(rds.ptyName);
          if (rds.pi !== null && rds.pi !== undefined) {
            store.setRdsPi(rds.pi.toString(16).toUpperCase().padStart(4, '0'));
          } else if (rds.pi === null) {
            store.setRdsPi('');
          }
          if (rds.synced !== undefined) store.setRdsSynced(rds.synced);
          if (rds.clock) {
            const c = rds.clock;
            const pad = (n: number) => String(n).padStart(2, '0');
            const half = Math.abs(c.offsetHalfHours ?? 0);
            const sign = (c.offsetHalfHours ?? 0) >= 0 ? '+' : '-';
            store.setRdsClock(
              `${c.year}-${pad(c.month)}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)} ` +
              `UTC${sign}${pad(Math.floor(half / 2))}:${pad((half % 2) * 30)}`,
            );
          }
          // Update lock screen with RDS station name / radio text
          this.updateMediaSession();
        } catch (e) {
          console.error('[RDS] decode error:', e);
        }
        break;
      }

      default: {
        console.warn(`[SDR] unhandled binary message type: 0x${type.toString(16).padStart(2, '0')}, payload ${payload.byteLength} bytes`);
      }
    }
  }

  /**
   * Render one decoded FFT frame: push to client buffer, draw waterfall row,
   * draw spectrum + tuning indicator. Single call site for all four codecs.
   */
  private renderFftFrame(fftData: Float32Array): void {
    this.fftBuffer.push(fftData);

    // Waterfall: post frame to worker (zero-copy transfer).
    // Worker ignores the frame when seekOffset > 0.
    if (this.waterfallWorker) {
      const frame = fftData.slice(); // clone — fftBuffer owns the original
      this.waterfallWorker.postMessage(
        { type: 'frame', fftData: frame },
        [frame.buffer],
      );
    }

    // Spectrum: post frame to worker (zero-copy transfer).
    // Worker draws the spectrum + tuning indicator immediately.
    if (this.spectrumWorker) {
      const frame = fftData.slice(); // clone — fftBuffer owns the original
      this.spectrumWorker.postMessage(
        {
          type: 'frame',
          fftData: frame,
          tuneOffset: store.tuneOffset(),
          bandwidth: store.bandwidth(),
          sampleRate: store.sampleRate(),
        },
        [frame.buffer],
      );
    }
  }

  /**
  /**
   * Common IQ demodulation pipeline shared by MSG_IQ and MSG_IQ_ADPCM.
   * Handles squelch gating, stereo detection, and audio push.
   */
  private processIqData(iqData: Int16Array): void {
    this.bwIqSamples += iqData.length / 2;

    if (this.iqCaptureActive) {
      if (performance.now() >= this.iqCaptureUntil) {
        this.iqCaptureActive = false;
      } else if (this.iqCaptureChunks.length < 300) {
        this.iqCaptureChunks.push(iqData.slice());
      }
    }

    // Squelch gate: if squelch is set and signal is below threshold, mute audio.
    // During grace period after tune/mode change, bypass squelch so the
    // jitter buffer can fill and the signal level can stabilize.
    const squelchLevel = store.squelch();
    const inGracePeriod = performance.now() < this.squelchBypassUntil;
    const squelchOpen = squelchLevel === null || inGracePeriod || store.signalLevel() >= squelchLevel;
    // Determine if stereo decoding should be attempted:
    // 1. User has stereo enabled (toggle switch)
    // 2. Demodulator supports it
    // 3. Signal level exceeds threshold
    const stereoAllowed = store.stereoEnabled()
      && this.demodulator.stereoCapable
      && this.demodulator.processStereo != null
      && store.signalLevel() >= store.stereoThreshold();

    // Use stereo path when allowed
    if (stereoAllowed) {
      const stereoResult = this.demodulator.processStereo!(iqData);
      this.iqInCount += iqData.length / 2;

      if (stereoResult.stereo) {
        // Resample to 48kHz first so the adaptive filters always run at the
        // rate their presets are tuned for (SSB/CW arrive at 24/12 kHz).
        const resampled = this.resampleStereoTo48k(stereoResult.left, stereoResult.right);
        // LMS adaptive NR
        this.anr.process(resampled.left);
        this.anr.process(resampled.right);
        // Apply audio filters (rumble + auto-notch + hi-blend)
        this.rumbleFilter.processStereo(resampled.left, resampled.right);
        this.autoNotch.processStereo(resampled.left, resampled.right);
        this.hiBlend.processStereo(resampled.left, resampled.right);
        // Apply AGC
        if (store.agcEnabled()) {
          this.agc.processStereo(resampled.left, resampled.right);
        }
        this.audioOutCount += resampled.left.length;
        if (resampled.left.length > 0 && squelchOpen) {
          this.applySoftMuteStereo(resampled.left, resampled.right);
          this.audio.pushStereoAudio(resampled.left, resampled.right);
        }
        if (!store.stereoDetected()) {
          store.setStereoDetected(true);
        }
      } else {
        // Resample to 48kHz first so the adaptive filters run at their design rate.
        const resampled = this.resampleTo48k(stereoResult.left);
        // LMS adaptive NR
        this.anr.process(resampled);
        // Apply audio filters
        this.rumbleFilter.process(resampled);
        this.autoNotch.process(resampled);
        // Apply AGC
        if (store.agcEnabled()) {
          this.agc.process(resampled);
        }
        this.audioOutCount += resampled.length;
        if (resampled.length > 0 && squelchOpen) {
          this.applySoftMute(resampled);
          this.audio.pushDemodulatedAudio(resampled);
        }
        if (store.stereoDetected()) {
          store.setStereoDetected(false);
        }
      }
    } else {
      const audioSamples = this.demodulator.process(iqData);
      this.iqInCount += iqData.length / 2;
      // Resample to 48kHz first so the adaptive filters run at their design rate.
      const resampled = this.resampleTo48k(audioSamples);
      // LMS adaptive NR
      this.anr.process(resampled);
      // Apply audio filters
      this.rumbleFilter.process(resampled);
      this.autoNotch.process(resampled);
      // Apply AGC
      if (store.agcEnabled()) {
        this.agc.process(resampled);
      }
      this.audioOutCount += resampled.length;
      if (resampled.length > 0 && squelchOpen) {
        this.applySoftMute(resampled);
        this.audio.pushDemodulatedAudio(resampled);
      }
      if (store.stereoDetected()) {
        store.setStereoDetected(false);
      }
    }

    const now = performance.now();
    if (now - this.lastAudioLog > 30000) {
      const elapsed = (now - this.lastAudioLog) / 1000;
      console.debug(`[SDR Audio] IQ in: ${Math.round(this.iqInCount / elapsed)}/s, Audio out: ${Math.round(this.audioOutCount / elapsed)}/s, Stereo: ${store.stereoDetected()}`);
      this.iqInCount = 0;
      this.audioOutCount = 0;
      this.lastAudioLog = now;
    }
  }

  /**
   * Update bandwidth/throughput stats every 1 second.
   * Pushes rates into the store and maintains a rolling history for the sparkline.
   */
  private updateBandwidthStats(): void {
    const now = performance.now();
    const elapsed = (now - this.bwLastUpdate) / 1000;
    if (elapsed < 1) return;

    store.setFftRate(Math.round(this.bwFftFrames / elapsed));
    store.setIqRate(Math.round(this.bwIqSamples / elapsed));
    const bytesPerSec = Math.round(this.bwTotalBytes / elapsed);
    store.setWsBytes(bytesPerSec);

    // Codec performance stats
    store.setFftWireBytes(Math.round(this.bwFftWireBytes / elapsed));
    store.setFftRawBytes(Math.round(this.bwFftRawBytes / elapsed));
    store.setIqWireBytes(Math.round(this.bwIqWireBytes / elapsed));
    store.setIqRawBytes(Math.round(this.bwIqRawBytes / elapsed));

    // Rolling history (keep last N seconds)
    const history = store.wsBytesHistory().slice(-(this.bwHistoryMax - 1));
    history.push(bytesPerSec);
    store.setWsBytesHistory(history);

    this.bwFftFrames = 0;
    this.bwIqSamples = 0;
    this.bwTotalBytes = 0;
    this.bwFftWireBytes = 0;
    this.bwFftRawBytes = 0;
    this.bwIqWireBytes = 0;
    this.bwIqRawBytes = 0;
    this.bwLastUpdate = now;
  }

  /**
   * Handle JSON metadata messages
   */
  private handleMetaMessage(meta: ServerMeta): void {
    this.onMetaMessage?.(meta);

    switch (meta.type) {
      case 'welcome':
        store.setServerWsBytes(-1);
        store.setServerWsBytesHistory([]);
        store.setClientId(meta.clientId);
        store.setServerVersion(meta.serverVersion ?? '');
        // Server is the authority on client ID — store whatever it sends
        if (meta.clientId && meta.clientId !== store.localClientId()) {
          store.setLocalClientId(meta.clientId);
        }
        // Store connection index (multi-tab identifier)
        if (meta.connIndex) {
          store.setConnIndex(meta.connIndex);
        }
        // Update available codecs from server capabilities
        store.setAvailableFftCodecs(meta.allowedFftCodecs ?? ALL_FFT_CODECS);
        store.setAvailableIqCodecs(meta.allowedIqCodecs ?? ALL_IQ_CODECS);
        // Segmented multi-tier waterfall capability (absent on legacy servers).
        store.setWaterfallProtocol(meta.waterfallProtocol ?? 0);
        if (meta.waterfallTileBins && meta.waterfallTileBins > 0) {
          store.setEffectiveTileBins(meta.waterfallTileBins);
        }
        store.setWaterfallTierCount(meta.waterfallTierCount ?? 0);
        break;

      case 'subscribed': {
        // Capture client-side state before the server profile defaults overwrite it.
        // hadPriorSubscription persists across reconnects (unlike activeDongleId which
        // is cleared on disconnect), so this correctly identifies a reconnect scenario.
        store.setUserLocations([]);
        const isReconnect    = this.hadPriorSubscription;
        const prevTuneOffset = isReconnect ? store.tuneOffset()  : 0;
        const prevMode       = isReconnect ? store.mode()        : null;
        const prevBandwidth  = isReconnect ? store.bandwidth()   : 0;
        const audioWasActive = this.audio.isInitialized;
        // Mark that we have successfully subscribed at least once.
        this.hadPriorSubscription = true;

        store.setActiveDongleId(meta.dongleId);
        store.setActiveProfileId(meta.profileId ?? '');
        store.setCenterFrequency(meta.centerFreq);
        store.setSampleRate(meta.sampleRate);
        store.setFftSize(meta.fftSize);
        store.setTuningStep(meta.tuningStep ?? 0);
        // Fresh subscription: adopt this profile's tiled geometry and reset
        // the ladder state. The viewport is (re)requested at the end of this
        // handler, so a tiled server streams a screen-sized strip immediately
        // instead of a full-resolution frame. Capture any per-profile tile
        // width override first.
        if (meta.waterfallTileBins && meta.waterfallTileBins > 0) {
          store.setEffectiveTileBins(meta.waterfallTileBins);
        }
        store.setWaterfallTierCount(meta.waterfallTierCount ?? 0);
        this.resetTiledState();
        // Apply the profile's default tune offset so the displayed frequency
        // matches what the server is actually demodulating. On reconnect the
        // client restores its previous offset below.
        store.setTuneOffset(meta.tuneOffset ?? 0);
        // Center frequency changed server-side — arm identify cooldown for ADPCM/none.
        this.armIdentifyCooldown();
        if (meta.iqSampleRate) {
          store.setIqSampleRate(meta.iqSampleRate);
          // Tell demodulator the actual IQ sample rate from server
          this.demodulator.setInputSampleRate(meta.iqSampleRate);
        }
        if (meta.mode) {
          const m = meta.mode as DemodMode;
          store.setMode(m);
          // Set bandwidth to the mode's default so the UI shows the correct value
          const modeInfo = DEMOD_MODES[m];
          if (modeInfo) {
            store.setBandwidth(modeInfo.defaultBandwidth);
          }
          this.demodulator = this.newDemodulator(m as DemodMode);
          this.demodulator.reset();
          this.demodulator.setBandwidth(store.bandwidth());
          this.attachRdsCallback();
          if (meta.iqSampleRate) {
            this.demodulator.setInputSampleRate(meta.iqSampleRate);
          }
        }
        // Flush audio on new subscription and reset codec decoders
        this.audio.resetBuffer();
        this.iqAdpcmDecoder.reset();
        // Update resampler for this mode's output rate
        this.updateResampleRatio();
         // Re-send codec preferences so the server applies them to this subscription.
         // Always send — persisted values from localStorage may differ from server defaults.
         // Send stereo_enabled BEFORE codec: the server stores it at the clientPipeline level
         // so when codec creates the Opus pipeline it already uses the correct stereo preference.
         // This prevents the first packets from being stereo when stereoEnabled=false.
         if (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq' || store.iqCodec() === 'opus-lo') {
           this.send({ cmd: 'stereo_enabled', enabled: store.stereoEnabled() });
         }
         this.send({ cmd: 'codec', fftCodec: store.fftCodec(), iqCodec: store.iqCodec() });
         // De-emphasis is per-client server-side state; a fresh pipeline
         // defaults to 75 µs, so restore the user's choice.
         this.send({ cmd: 'deemphasis', deemphasis: store.deemphasisUs() });

         // Restore client tuning state from before the reconnect.
         // On a reconnect the server always resets to profile defaults, so we must
         // unconditionally re-send mode, bandwidth, and tune offset.
         // On a first-time connection isReconnect=false so prevMode/prevBandwidth/prevTuneOffset
         // are all null/0 and none of the branches fire.
         if (isReconnect && prevMode) {
           store.setMode(prevMode as DemodMode);
           const modeInfo = DEMOD_MODES[prevMode as DemodMode];
           this.demodulator = this.newDemodulator(prevMode as DemodMode);
           this.demodulator.reset();
           const bw = prevBandwidth || modeInfo?.defaultBandwidth || store.bandwidth();
           store.setBandwidth(bw);
           this.demodulator.setBandwidth(bw);
           this.attachRdsCallback();
           if (meta.iqSampleRate) this.demodulator.setInputSampleRate(meta.iqSampleRate);
           this.send({ cmd: 'mode', mode: prevMode, bandwidth: bw });
           this.updateResampleRatio();
         } else if (isReconnect && prevBandwidth) {
           store.setBandwidth(prevBandwidth);
           this.demodulator.setBandwidth(prevBandwidth);
           this.send({ cmd: 'bandwidth', hz: prevBandwidth });
         }

         if (isReconnect && prevTuneOffset !== 0) {
           store.setTuneOffset(prevTuneOffset);
           this.send({ cmd: 'tune', offset: prevTuneOffset });
           this.squelchBypassUntil = performance.now() + 500;
         }

        // Re-enable audio if it was active before disconnect.
         // Also resume the AudioContext — it may be suspended after a page reload
         // or HMR cycle even though the AudioEngine instance was already initialised.
         if (audioWasActive) {
           this.audio.resume();
           this.send({ cmd: 'audio_enabled', enabled: true });
         }

        // Request waterfall history to prefill the display immediately
        this.send({ cmd: 'request_history' });

        // Establish the tiled viewport for this subscription. A tiled-capable
        // server should stream the screen-sized view from the very first frame
        // — including the full span, where the chosen tier is simply the one
        // that matches the canvas width — so the client never has to download a
        // full-resolution frame it cannot show. The legacy path is kept only
        // for servers that do not advertise the protocol.
        {
          const [zs, ze] = store.spectrumZoom();
          if (this.sendWaterfallView(store.waterfallSpeed())) {
            // tiled view requested; nothing else to do
          } else if (zs > 0.0001 || ze < 0.9999) {
            // Legacy server with a restored zoom: re-apply the worker crop.
            this.spectrumWorker?.postMessage({ type: 'set-zoom', start: zs, end: ze });
            this.waterfallWorker?.postMessage({ type: 'set-zoom', start: zs, end: ze });
            this.scheduleWaterfallPrefill();
          }
        }

        // Re-send noise blanker state (persisted in localStorage but not part of subscribe reset)
        if (store.nbEnabled()) {
          this.send({ cmd: 'set_pre_filter_nb', enabled: true });
          this.send({ cmd: 'set_pre_filter_nb_threshold', threshold: nbThresholdForLevel(store.nbLevel()) });
        }
        this.reconnecting = false;
        break;
      }

      case 'waterfall_refresh': {
        // Server-initiated refresh: the tier ladder changed (admin config,
        // dongle restart) or an operator forced one. Adopt the advertised
        // geometry, forget the old tile buffers, and re-request the viewport.
        if (meta.dongleId && store.activeDongleId() && meta.dongleId !== store.activeDongleId()) {
          break;
        }
        if (meta.waterfallProtocol) store.setWaterfallProtocol(meta.waterfallProtocol);
        if (meta.waterfallTileBins && meta.waterfallTileBins > 0) {
          store.setEffectiveTileBins(meta.waterfallTileBins);
        }
        store.setWaterfallTierCount(meta.waterfallTierCount ?? 0);
        // Re-request whenever the client was on the tiled path — including a
        // full-span tiled view, which must not silently degrade to the legacy
        // full-frame stream just because the zoom window is [0,1].
        const wasTiled = this.tiledActive || this.tiledRequested;
        this.resetTiledState();
        if (wasTiled) {
          this.sendWaterfallView(store.waterfallSpeed());
        } else {
          this.spectrumWorker?.postMessage({ type: 'reset-zoom' });
          this.waterfallWorker?.postMessage({ type: 'reset-zoom' });
          this.scheduleWaterfallPrefill();
        }
        break;
      }

      case 'profile_changed':
        store.setActiveProfileId(meta.profileId ?? '');
        store.setCenterFrequency(meta.centerFreq);
        store.setSampleRate(meta.sampleRate);
        store.setFftSize(meta.fftSize);
        store.setTuningStep(meta.tuningStep ?? 0);
        // Reset tune offset — previous offset is invalid for new center frequency
        store.setTuneOffset(meta.tuneOffset ?? 0);
        // Profile/center frequency changed — arm identify cooldown for ADPCM/none.
        this.armIdentifyCooldown();
        if (meta.iqSampleRate) {
          store.setIqSampleRate(meta.iqSampleRate);
        }
        if (meta.mode) {
          const m = meta.mode as DemodMode;
          store.setMode(m);
          const modeInfo = DEMOD_MODES[m];
          if (modeInfo) {
            store.setBandwidth(modeInfo.defaultBandwidth);
          }
          this.demodulator = this.newDemodulator(m as DemodMode);
          this.demodulator.reset();
          this.demodulator.setBandwidth(store.bandwidth());
          this.attachRdsCallback();
          if (meta.iqSampleRate) {
            this.demodulator.setInputSampleRate(meta.iqSampleRate);
          }
        }
        // Flush audio and reset waterfall + client FFT buffer
        this.audio.resetBuffer();
        this.fftBuffer.reset();
        this.waterfallWorker?.postMessage({ type: 'clear' });
        // New profile → back to legacy full-span until the user zooms again.
        if (meta.waterfallTileBins && meta.waterfallTileBins > 0) {
          store.setEffectiveTileBins(meta.waterfallTileBins);
        }
        store.setWaterfallTierCount(meta.waterfallTierCount ?? 0);
        this.resetTiledState();
        // Update resampler for new mode's output rate
        this.updateResampleRatio();
        break;

      case 'admin_auth_ok':
        store.setIsAdmin(true);
        break;

      case 'identify_token':
        // One-time token for music recognition — resolve the pending identify() promise
        if (this.identifyTokenResolve && meta.message) {
          this.identifyTokenResolve(meta.message);
        }
        break;

      case 'toast':
        // Server-pushed notification (rate limit, errors, etc.)
        store.addToast(meta.message, meta.code);
        // If an identify was in progress, reset it
        if (store.identifyState() === 'capturing' || store.identifyState() === 'querying') {
          store.setIdentifyState('error');
          store.setIdentifyResult({ match: false });
          this.identifyTokenResolve = null;
        }
        break;

      case 'error':
        console.error(`[SDR] Server error: ${meta.message} (${meta.code ?? ''})`);
        break;

      case 'server_stats':
        store.setServerCpu(meta.cpuPercent);
        store.setServerMem(meta.memMb);
        store.setServerClients(meta.clients);
        if (typeof meta.wsBytesPerSec === 'number') {
          store.setServerWsBytes(meta.wsBytesPerSec);
          const history = store.serverWsBytesHistory().slice(-29);
          history.push(meta.wsBytesPerSec);
          store.setServerWsBytesHistory(history);
        }
        break;

      // ---- Config push notifications (Phase 13: reactive state from WS) ----

      case 'state_sync': {
        store.setPushDongles(meta.dongles);
        if (meta.server) store.setPushServerConfig(meta.server);
        if (meta.version) store.setConfigVersion(meta.version);

        // Convert push dongles to the legacy DongleInfo format for backward compatibility
        const legacyDongles = meta.dongles.map(d => ({
          id: d.id,
          name: d.name,
          deviceIndex: 0,
          serial: '',
          source: d.sourceType as any,
          activeProfileId: d.activeProfile || null,
          ppmCorrection: 0,
          running: d.state.status === 'running',
          clientCount: d.clientCount ?? 0,
          sampleRate: d.sampleRate,
        }));
        store.setDongles(legacyDongles);

        // If no dongles are configured, set connection state to unconfigured
        if (meta.dongles.length === 0) {
          store.setConnectionState('unconfigured');
        } else {
          store.setConnectionState('connected');
        }

        // Auto-subscribe if we don't have an active subscription yet
        if (!store.activeDongleId()) {
          const running = meta.dongles.find(d => d.state.status === 'running');
          if (running) {
            this.subscribe(running.id);
          }
        }
        break;
      }

      case 'dongle_added': {
        const current = store.pushDongles();
        store.setPushDongles([...current, meta.dongle]);
        // Update legacy signal too
        store.setDongles([...store.dongles(), {
          id: meta.dongle.id,
          name: meta.dongle.name,
          deviceIndex: 0,
          serial: '',
          source: meta.dongle.sourceType as any,
          activeProfileId: meta.dongle.activeProfile || null,
          ppmCorrection: 0,
          running: meta.dongle.state.status === 'running',
          clientCount: meta.dongle.clientCount ?? 0,
          sampleRate: meta.dongle.sampleRate,
        }]);
        if (meta.version) store.setConfigVersion(meta.version);
        // If was unconfigured, now we have at least one dongle
        if (store.connectionState() === 'unconfigured') {
          store.setConnectionState('connected');
        }
        break;
      }

      case 'dongle_updated': {
        store.setPushDongles(
          store.pushDongles().map(d => d.id === meta.dongleId ? meta.dongle : d)
        );
        store.setDongles(
          store.dongles().map(d => d.id === meta.dongleId ? {
            ...d,
            name: meta.dongle.name,
            source: meta.dongle.sourceType as any,
            running: meta.dongle.state.status === 'running',
            sampleRate: meta.dongle.sampleRate,
            activeProfileId: meta.dongle.activeProfile || null,
            clientCount: meta.dongle.clientCount ?? d.clientCount ?? 0,
          } : d)
        );
        if (meta.version) store.setConfigVersion(meta.version);
        break;
      }

      case 'dongle_removed': {
        store.setPushDongles(
          store.pushDongles().filter(d => d.id !== meta.dongleId)
        );
        store.setDongles(
          store.dongles().filter(d => d.id !== meta.dongleId)
        );
        if (meta.version) store.setConfigVersion(meta.version);
        // If we were subscribed to the removed dongle, try another
        if (store.activeDongleId() === meta.dongleId) {
          store.setActiveDongleId('');
          const remaining = store.pushDongles();
          const running = remaining.find(d => d.state.status === 'running');
          if (running) {
            this.subscribe(running.id);
          } else if (remaining.length === 0) {
            store.setConnectionState('unconfigured');
          }
        }
        break;
      }

      case 'dongle_started': {
        store.setPushDongles(
          store.pushDongles().map(d => d.id === meta.dongleId ? { ...d, state: meta.state } : d)
        );
        store.setDongles(
          store.dongles().map(d => d.id === meta.dongleId ? { ...d, running: true } : d)
        );
        if (meta.version) store.setConfigVersion(meta.version);
        // Auto-subscribe if we have no active subscription
        if (!store.activeDongleId()) {
          this.subscribe(meta.dongleId);
        }
        break;
      }

      case 'dongle_stopped': {
        store.setPushDongles(
          store.pushDongles().map(d => d.id === meta.dongleId ? { ...d, state: meta.state } : d)
        );
        store.setDongles(
          store.dongles().map(d => d.id === meta.dongleId ? { ...d, running: false } : d)
        );
        if (meta.version) store.setConfigVersion(meta.version);
        // If we were subscribed to this dongle, try switching
        if (store.activeDongleId() === meta.dongleId) {
          store.setActiveDongleId('');
          const running = store.pushDongles().find(d => d.state.status === 'running' && d.id !== meta.dongleId);
          if (running) {
            this.subscribe(running.id);
          }
        }
        break;
      }

      case 'dongle_status': {
        store.setDongles(
          store.dongles().map(d => d.id === meta.dongleId
            ? { ...d, running: meta.running, clientCount: meta.clientCount }
            : d)
        );
        store.setPushDongles(
          store.pushDongles().map(d => {
            if (d.id !== meta.dongleId) return d;
            const status = meta.running
              ? 'running'
              : (d.state.status === 'running' ? 'stopped' : d.state.status);
            return { ...d, clientCount: meta.clientCount, state: { ...d.state, status } };
          })
        );
        break;
      }

      case 'dongle_error': {
        store.setPushDongles(
          store.pushDongles().map(d => d.id === meta.dongleId ? { ...d, state: meta.state } : d)
        );
        store.setDongles(
          store.dongles().map(d => d.id === meta.dongleId ? { ...d, running: false } : d)
        );
        if (meta.version) store.setConfigVersion(meta.version);
        console.warn(`[SDR] Dongle ${meta.dongleId} error: ${meta.error}`);
        break;
      }

      case 'profile_added': {
        store.setPushDongles(
          store.pushDongles().map(d => {
            if (d.id !== meta.dongleId) return d;
            return { ...d, profiles: [...d.profiles, meta.profile] };
          })
        );
        if (meta.version) store.setConfigVersion(meta.version);
        break;
      }

      case 'profile_updated': {
        store.setPushDongles(
          store.pushDongles().map(d => {
            if (d.id !== meta.dongleId) return d;
            return {
              ...d,
              profiles: d.profiles.map(p => p.id === meta.profileId ? meta.profile : p),
            };
          })
        );
        if (meta.version) store.setConfigVersion(meta.version);
        break;
      }

      case 'profile_removed': {
        store.setPushDongles(
          store.pushDongles().map(d => {
            if (d.id !== meta.dongleId) return d;
            return { ...d, profiles: d.profiles.filter(p => p.id !== meta.profileId) };
          })
        );
        if (meta.version) store.setConfigVersion(meta.version);
        break;
      }

      case 'profiles_reordered': {
        store.setPushDongles(
          store.pushDongles().map(d => {
            if (d.id !== meta.dongleId) return d;
            return { ...d, profiles: meta.profiles };
          })
        );
        if (meta.version) store.setConfigVersion(meta.version);
        break;
      }

      case 'server_config_updated':
        store.setPushServerConfig(meta.server);
        if (meta.version) store.setConfigVersion(meta.version);
        break;

      case 'user_locations':
        store.setUserLocations(meta.users ?? []);
        break;

      case 'config_saved':
        if (meta.version) store.setConfigVersion(meta.version);
        console.log('[SDR] Config saved (version:', meta.version, ')');
        this.fetchAdminBookmarks();
        break;

      case 'dongle_disconnected':
        console.warn(`[SDR] Dongle disconnected: ${meta.dongleId} (${meta.message ?? meta.reason ?? 'disconnected'})`);
        // If we were subscribed to this dongle, clear subscription state
        if (store.activeDongleId() === meta.dongleId) {
          store.setActiveDongleId('');
          // Try to resubscribe to another running dongle
          const running = store.pushDongles().find(d => d.state.status === 'running' && d.id !== meta.dongleId);
          if (running) {
            this.subscribe(running.id);
          }
        }
        break;

      case 'codec_status': {
        if (meta.fftCodec && meta.fftCodec !== store.fftCodec()) {
          store.setFftCodec(meta.fftCodec as FftCodecType);
        }
        if (meta.iqCodec && meta.iqCodec !== store.iqCodec()) {
          store.setIqCodec(meta.iqCodec as IqCodecType);
          this.iqAdpcmDecoder.reset();
        }
        const notice = [meta.fftMsg, meta.iqMsg].filter(Boolean).join(' ');
        if (notice) {
          console.warn(`[SDR] Codec fallback: ${notice}`);
          store.addToast(notice, 'codec');
        }
        break;
      }
    }
  }

  // ---- Client Commands ----

  /**
   * Send a command to the server
   */
  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  subscribe(dongleId: string, profileId?: string): void {
    // A user-initiated subscribe (or automatic dongle switch while connected)
    // must use the new profile's defaults. Only a reconnect restores the
    // previous mode/bandwidth/tune offset.
    if (!this.reconnecting) {
      this.hadPriorSubscription = false;
    }
    this.send({ cmd: 'subscribe', dongleId, profileId });
    if (store.decoderMode()) {
      this.send({ cmd: 'decoder', mode: store.decoderMode() });
      this.send({
        cmd: 'decoder_scope',
        enabled: store.decoderPanelOpen(),
        fps: 10,
      });
    }
  }

  unsubscribe(): void {
    this.send({ cmd: 'unsubscribe' });
  }

  tune(offsetHz: number): void {
    store.setTuneOffset(offsetHz);
    // Reset demodulator to clear stale filter state at the new frequency
    this.demodulator.reset();
    // Reset ADPCM decoder — predictor state is invalid after frequency change
    this.iqAdpcmDecoder.reset();
    // Reset audio filter IIR state — delay-line history from the old frequency
    // causes a transient noise burst on the first frames of the new frequency.
    this.rumbleFilter.reset();
    this.autoNotch.reset();
    this.hiBlend.reset();
    // Reset soft-mute gain so the new frequency starts at full gain
    this.softMuteGain = 1.0;
    // Flush stale audio from the jitter buffer. On the Opus path the old
    // comment said "server re-tunes seamlessly" but the jitter buffer can hold
    // up to 3 seconds of audio — without a flush the user hears the old
    // frequency playing out before the new one starts (the "takes longer" effect).
    this.audio.resetBuffer();
    // Bypass squelch for 500ms so jitter buffer fills before squelch gates audio
    this.squelchBypassUntil = performance.now() + 500;
    this.send({ cmd: 'tune', offset: offsetHz });
    this.updateMediaSession();
    // Arm the identify cooldown for ADPCM/none — the client ring buffer was just
    // flushed and needs 10s to refill before recognition is reliable.
    this.armIdentifyCooldown();
  }

  setMode(mode: string): void {
    const m = mode as DemodMode;
    store.setMode(m);
    // Set bandwidth to the new mode's default
    const modeInfo = DEMOD_MODES[m];
    if (modeInfo) {
      store.setBandwidth(modeInfo.defaultBandwidth);
    }
    // Switch to the appropriate demodulator
    this.demodulator = this.newDemodulator(m as DemodMode);
    this.demodulator.reset();
    this.demodulator.setBandwidth(store.bandwidth());
    this.attachRdsCallback();
    // Clear stereo indicator — the new mode may be mono
    store.setStereoDetected(false);
    // For Opus codec path, clear RDS when leaving WFM (server won't send MSG_RDS for other modes)
    if ((store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq' || store.iqCodec() === 'opus-lo') && m !== 'wfm') {
      store.setRdsPs('');
      store.setRdsRt('');
      store.setRdsPty('');
      store.setRdsPi('');
      store.setRdsSynced(false);
    }
    // Flush stale audio data
    this.audio.resetBuffer();
    // Reset ADPCM decoder — mode/rate change invalidates predictor
    this.iqAdpcmDecoder.reset();
    // Reset audio filter IIR state — stale delay-line history from the previous
    // mode causes transient noise on the first frames of the new mode.
    this.rumbleFilter.reset();
    this.autoNotch.reset();
    this.hiBlend.reset();
    // Reset soft-mute gain — avoid inheriting a suppressed gain value across modes
    this.softMuteGain = 1.0;
    // Reset noise reduction state for new mode
    this.anr.reset();
    this.anr.setPreset(this.getAnrPresetForMode(m));
    this.anr.setStrength(store.nrStrength());
    // Update AGC preset for new mode
    this.agc.setPreset(this.getAgcPresetForMode(m));
    this.agc.reset();
    // Update resampler for new mode's output rate
    this.updateResampleRatio();
    // Bypass squelch for 500ms so jitter buffer fills before squelch gates audio
    this.squelchBypassUntil = performance.now() + 500;
    // Send mode + bandwidth together so server can set RF filter correctly
    this.send({ cmd: 'mode', mode, bandwidth: store.bandwidth() });
    // set_mode rebuilds the server demodulator, so re-apply the de-emphasis.
    this.send({ cmd: 'deemphasis', deemphasis: store.deemphasisUs() });
    this.updateMediaSession();
  }

  /** Select a foreground digital decoder (empty string disables it). */
  setDecoder(mode: string): void {
    const next = mode.trim().toLowerCase();
    // Selecting a decoder from a bookmark or the workspace toolbar should
    // reveal the decoder workspace; the sidebar toggle is what hides it again.
    // Keep Signal Analysis open so both workspaces can be shown together.
    if (next) store.setDecoderPanelOpen(true);
    store.setDecoderMode(next);
    this.clearDecoderScope();
    store.clearDecoderMessages();
    store.clearDecoderState();
    store.clearAdsb();
    store.clearAcars();
    store.clearAis();
    store.clearVdl2();
    store.clearHfdl();
    store.clearAprs();
    store.clearNavtex();
    store.clearPacket();
    store.clearIsm();
    store.clearWefax();
    store.clearSstv();
    store.clearHell();
    store.clearText();
    store.clearMeteor();
    store.clearJs8();
    store.clearTimeSignal();
    this.send({ cmd: 'decoder', mode: next });
    // The scope is opt-in: it costs one extra decimator + FFT per client, so
    // only ask for it while the decoder workspace is actually visible.
    this.send({ cmd: 'decoder_scope', enabled: !!next, fps: 10 });
  }

  /** Turn the zoomed decoder spectrum on or off without changing the decoder. */
  setDecoderScopeEnabled(enabled: boolean): void {
    this.send({ cmd: 'decoder_scope', enabled: enabled && !!store.decoderMode(), fps: 10 });
    if (!enabled) this.clearDecoderScope();
  }

  setBandwidth(hz: number): void {
    store.setBandwidth(hz);
    this.demodulator.setBandwidth(hz);
    this.send({ cmd: 'bandwidth', hz });
  }

  /** FM de-emphasis time constant: 75 µs (Americas) or 50 µs (Europe/Asia).
   *  Applies locally for the IQ path and tells the server for the Opus path. */
  setDeemphasis(us: number): void {
    store.setDeemphasisUs(us);
    this.demodulator.setDeemphasis?.(us);
    this.send({ cmd: 'deemphasis', deemphasis: us });
  }

  setSquelch(db: number | null): void {
    store.setSquelch(db);
    // Squelch is enforced client-side in both the MSG_IQ and MSG_AUDIO_OPUS handlers.
  }

  setVolume(level: number): void {
    store.setVolume(level);
    this.audio.setVolume(level);
    this.send({ cmd: 'volume', level });
  }

  setMuted(muted: boolean): void {
    store.setMuted(muted);
    this.audio.setMuted(muted);
    this.send({ cmd: 'mute', muted });
  }

  setBalance(value: number): void {
    store.setBalance(value);
    this.audio.setBalance(value);
  }

  setEqLow(dB: number): void {
    store.setEqLow(dB);
    this.audio.setEqLow(dB);
  }

  setEqLowMid(dB: number): void {
    store.setEqLowMid(dB);
    this.audio.setEqLowMid(dB);
  }

  setEqMid(dB: number): void {
    store.setEqMid(dB);
    this.audio.setEqMid(dB);
  }

  setEqHighMid(dB: number): void {
    store.setEqHighMid(dB);
    this.audio.setEqHighMid(dB);
  }

  setEqHigh(dB: number): void {
    store.setEqHigh(dB);
    this.audio.setEqHigh(dB);
  }

  setLoudness(enabled: boolean): void {
    store.setLoudness(enabled);
    this.audio.setLoudness(enabled);
  }

  setStereoEnabled(enabled: boolean): void {
    store.setStereoEnabled(enabled);
    // For Opus path: tell server to enable/disable stereo demod
    if (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq' || store.iqCodec() === 'opus-lo') {
      this.send({ cmd: 'stereo_enabled', enabled });
    }
    // For IQ path: inform the local FM demodulator
    if (this.demodulator.stereoCapable && 'setStereoEnabled' in this.demodulator) {
      (this.demodulator as any).setStereoEnabled(enabled);
    }
    if (!enabled && store.stereoDetected()) {
      store.setStereoDetected(false);
    }
    // Reset demodulator state to clear stale filter conditions from the old path.
    // Only flush audio on the IQ path — on Opus the server handles the
    // mono/stereo switch without a buffer discontinuity.
    this.demodulator.reset();
    if (store.iqCodec() === 'none' || store.iqCodec() === 'adpcm') {
      this.audio.resetBuffer();
    }
  }

  setStereoThreshold(dB: number): void {
    store.setStereoThreshold(dB);
    // If current signal is below new threshold, clear stereo detection
    if (store.signalLevel() < dB && store.stereoDetected()) {
      store.setStereoDetected(false);
    }
  }

  // ---- Noise Reduction ----

  setNrEnabled(enabled: boolean): void {
    store.setNrEnabled(enabled);
    this.anr.setEnabled(enabled);
  }

  setNrStrength(strength: number): void {
    store.setNrStrength(strength);
    this.anr.setStrength(strength);
  }

  setNbEnabled(enabled: boolean): void {
    store.setNbEnabled(enabled);
    // NB is now server-side — send command to server
    this.send({ cmd: 'set_pre_filter_nb', enabled });
  }

  setNbLevel(level: number): void {
    store.setNbLevel(level);
    this.send({ cmd: 'set_pre_filter_nb_threshold', threshold: nbThresholdForLevel(level) });
  }

  // ---- AGC ----

  setAgcEnabled(enabled: boolean): void {
    store.setAgcEnabled(enabled);
    if (!enabled) {
      this.agc.reset();
    }
  }

  setAgcDecay(ms: number): void {
    store.setAgcDecayMs(ms);
    this.agc.setDecayMs(ms);
  }

  /** Map demod mode to AGC preset name */
  private getAgcPresetForMode(mode: string): string {
    switch (mode) {
      case 'usb':
      case 'lsb': return 'ssb';
      case 'cw': return 'cw';
      case 'am':
      case 'am-stereo':
      case 'sam': return 'am';
      case 'wfm':
      case 'nfm': return 'fm';
      default: return 'ssb';
    }
  }

  /** Map demod mode to ANR preset name */
  private getAnrPresetForMode(mode: string): string {
    switch (mode) {
      case 'usb':
      case 'lsb': return 'ssb';
      case 'cw': return 'cw';
      case 'am':
      case 'am-stereo':
      case 'sam': return 'am';
      default: return 'ssb';
    }
  }

  // ---- Audio Filters ----

  setRumbleFilterEnabled(enabled: boolean): void {
    store.setRumbleFilterEnabled(enabled);
    this.rumbleFilter.setEnabled(enabled);
  }

  setRumbleFilterCutoff(hz: number): void {
    store.setRumbleFilterCutoff(hz);
    this.rumbleFilter.setCutoff(hz);
  }

  setAutoNotchEnabled(enabled: boolean): void {
    store.setAutoNotchEnabled(enabled);
    this.autoNotch.setEnabled(enabled);
  }

  setHiBlendEnabled(enabled: boolean): void {
    store.setHiBlendEnabled(enabled);
    this.hiBlend.setEnabled(enabled);
  }

  setHiBlendCutoff(hz: number): void {
    store.setHiBlendCutoff(hz);
    this.hiBlend.setCutoff(hz);
  }

  /** Auto hi-blend: stereo width follows the signal level. */
  setHiBlendAuto(enabled: boolean): void {
    store.setHiBlendAuto(enabled);
    if (enabled) {
      this.updateAutoHiBlend(store.signalLevel());
    } else {
      this.hiBlend.setCutoff(store.hiBlendCutoff());
    }
  }

  /**
   * Maps the channel level to a hi-blend cutoff: strong stations keep full
   * stereo separation, weak ones fade the treble to mono.
   */
  private updateAutoHiBlend(levelDb: number): void {
    if (!store.hiBlendEnabled() || !store.hiBlendAuto()) return;
    if (!Number.isFinite(levelDb)) return;
    // -80 dB → 1.2 kHz, -30 dB → 8 kHz, linear in dB.
    const target = 1200 + (levelDb + 80) * 136;
    const cutoff = Math.round(Math.max(800, Math.min(8000, target)));
    // Avoid redesigning the biquad on every level tick. The auto value is a
    // volatile signal: persisting it would hit localStorage several times a
    // second.
    if (Math.abs(cutoff - store.hiBlendAutoCutoff()) >= 100) {
      store.setHiBlendAutoCutoff(cutoff);
      this.hiBlend.setCutoff(cutoff);
    }
  }

  setSoftMuteEnabled(enabled: boolean): void {
    store.setSoftMuteEnabled(enabled);
    if (!enabled) this.softMuteGain = 1.0;
  }

  setSoftMuteThreshold(dB: number): void {
    store.setSoftMuteThreshold(dB);
  }

  /**
   * Apply soft mute gain to audio samples in-place.
   * Gain is smoothed and proportional to signal level above threshold.
   * Below threshold: progressively attenuated. Above: full volume.
   */
  private applySoftMute(samples: Float32Array): void {
    if (!store.softMuteEnabled()) return;

    const signalDb = store.signalLevel();
    const threshold = store.softMuteThreshold();
    // Linear gain: 0 when 10dB below threshold, 1 when at/above threshold
    const targetGain = Math.min(1.0, Math.max(0.0, (signalDb - threshold + 10) / 10));
    // Smooth with 50ms time constant to avoid pumping
    const alpha = 0.02; // ~50ms at typical call rate
    this.softMuteGain += alpha * (targetGain - this.softMuteGain);

    if (this.softMuteGain < 0.999) {
      const g = this.softMuteGain;
      for (let i = 0; i < samples.length; i++) {
        samples[i] *= g;
      }
    }
  }

  private applySoftMuteStereo(left: Float32Array, right: Float32Array): void {
    if (!store.softMuteEnabled()) return;

    const signalDb = store.signalLevel();
    const threshold = store.softMuteThreshold();
    const targetGain = Math.min(1.0, Math.max(0.0, (signalDb - threshold + 10) / 10));
    const alpha = 0.02;
    this.softMuteGain += alpha * (targetGain - this.softMuteGain);

    if (this.softMuteGain < 0.999) {
      const g = this.softMuteGain;
      const len = Math.min(left.length, right.length);
      for (let i = 0; i < len; i++) {
        left[i] *= g;
        right[i] *= g;
      }
    }
  }

  // ---- Codec Settings ----

  setFftCodec(codec: CodecType): void {
    store.setFftCodec(codec as FftCodecType);
    this.send({ cmd: 'codec', fftCodec: codec as FftCodecType });
  }

  setIqCodec(codec: CodecType): void {
    store.setIqCodec(codec as any);
    // Reset codec decoders when switching codecs
    this.iqAdpcmDecoder.reset();
    // Do NOT proactively initialize the Opus decoder here.
    // MSG_AUDIO_OPUS is the sole owner of decoder lifecycle — it initialises
    // (via resetOpusDecoderState) when the first server packet arrives with
    // the actual channel count in the wire header. Proactive init with a
    // hardcoded channel count races with resetOpusDecoderState() and can
    // install a stale mono decoder that feeds the stereo bitstream, causing
    // the "chipmunk + silence" glitch.
    this.send({ cmd: 'codec', iqCodec: codec as IqCodecType });
    // When switching to Opus, sync stereo preference to server
    if (codec === 'opus' || codec === 'opus-hq' || codec === 'opus-lo') {
      this.send({ cmd: 'stereo_enabled', enabled: store.stereoEnabled() });
    }
  }

  /**
   * Reset Opus decoder state without causing a gap in audio decoding.
   *
   * - Same channel count: calls decoder.reset() which is async but keeps the
   *   decoder live and ready — no dropped packets.
   * - Channel count change: builds a new decoder in the background and only
   *   swaps it in once ready, so opusDecoderReady never goes false mid-stream.
   *
   * Use this on mode/tune changes instead of initOpusDecoder() to avoid the
   * "chipmunk + silence" artifact caused by dropping packets while the WASM
   * decoder is reinitialising.
   */
  private resetOpusDecoderState(channels: number): void {
    const isStereo = channels >= 2;
    const targetChannels = isStereo ? 2 : 1;

    if (this.opusDecoder && this.opusDecoderReady && targetChannels === this.opusDecoderChannels) {
      // Same channel config — decoder stays live. Opus packets are independently
      // decodable (with PLC), so no decoder reset is needed on mode/tune change.
      // The jitter buffer flush (already done by caller) is sufficient.
      return;
    }

    // Channel count change (or decoder not yet ready):
    // A mono decoder fed stereo packets (or vice versa) produces chipmunk.
    // Stop decoding immediately, flush the jitter buffer, build a new decoder.
    // The resulting silence window is <50ms (WASM module is cached after first load).
    if (this.opusDecoder) {
      try { this.opusDecoder.free(); } catch { /* ignore */ }
      this.opusDecoder = null;
    }
    this.opusDecoderReady = false;
    this.opusDecoderChannels = targetChannels; // set eagerly — prevents duplicate triggers
    this.audio.resetBuffer();

    const next = new OpusDecoder({
      sampleRate: 48000,
      channels: targetChannels,
      streamCount: 1,
      coupledStreamCount: isStereo ? 1 : 0,
      channelMappingTable: isStereo ? [0, 1] : [0],
    });
    next.ready.then(() => {
      this.opusDecoder = next as unknown as OpusDecoder<any>;
      this.opusDecoderReady = true;
    }).catch((e) => {
      console.error('[SDR] Failed to reinit Opus decoder:', e);
      this.opusDecoderChannels = isStereo ? 1 : 2; // roll back
      try { next.free(); } catch { /* ignore */ }
    });
  }

  /** Initialize Opus WASM decoder (async, one-time) */
  private async initOpusDecoder(channels = 1): Promise<void> {
    // Free existing decoder if channel count changed
    if (this.opusDecoder) {
      try { this.opusDecoder.free(); } catch { /* ignore */ }
      this.opusDecoder = null;
      this.opusDecoderReady = false;
    }
    try {
      const isStereo = channels >= 2;
      this.opusDecoder = new OpusDecoder({
        sampleRate: 48000,
        channels: isStereo ? 2 : 1,
        streamCount: 1,
        coupledStreamCount: isStereo ? 1 : 0,
        channelMappingTable: isStereo ? [0, 1] : [0],
      });
      await this.opusDecoder!.ready;
      this.opusDecoderReady = true;
      this.opusDecoderChannels = isStereo ? 2 : 1;
    } catch (e) {
      console.error('[SDR] Failed to init Opus decoder:', e);
      this.opusDecoder = null;
      this.opusDecoderReady = false;
    }
  }

  // ---- Display Settings ----

  setWaterfallTheme(theme: string): void {
    store.setWaterfallTheme(theme as any);
    this.waterfallWorker?.postMessage({ type: 'set-theme', theme });
  }

  setWaterfallRange(minDb: number, maxDb: number): void {
    // Manual range adjustment disables auto-range
    store.setWaterfallAutoRange(false);
    store.setWaterfallMin(minDb);
    store.setWaterfallMax(maxDb);
    this.waterfallWorker?.postMessage({ type: 'set-range', minDb, maxDb });
    this.spectrumWorker?.postMessage({ type: 'set-range', minDb, maxDb });
  }

  setWaterfallGamma(gamma: number): void {
    store.setWaterfallGamma(gamma);
    this.waterfallWorker?.postMessage({ type: 'set-gamma', gamma });
  }

  setSpectrumPeakHold(enabled: boolean): void {
    store.setSpectrumPeakHold(enabled);
    this.spectrumWorker?.postMessage({ type: 'set-peak-hold', enabled });
  }

  setSpectrumSignalFill(enabled: boolean): void {
    store.setSpectrumSignalFill(enabled);
    this.spectrumWorker?.postMessage({ type: 'set-signal-fill', enabled });
  }

  setSpectrumPaused(enabled: boolean): void {
    store.setSpectrumPaused(enabled);
    this.spectrumWorker?.postMessage({ type: 'set-pause', enabled });
  }

  setSpectrumAveraging(speed: 'fast' | 'med' | 'slow'): void {
    store.setSpectrumAveraging(speed);
    const alpha = speed === 'slow' ? 0.7 : speed === 'med' ? 0.4 : 0;
    this.spectrumWorker?.postMessage({ type: 'set-smoothing', alpha });
  }



  setSpectrumNoiseFloor(enabled: boolean): void {
    store.setSpectrumNoiseFloor(enabled);
    this.spectrumWorker?.postMessage({ type: 'set-noise-floor', enabled });
  }

  /**
   * Update spectrum accent color after a UI theme change.
   * Call immediately after setting data-theme on the root element so the
   * renderer picks up the new CSS variable value.
   */
  setSpectrumAccentColor(): void {
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue('--sdr-freq-color').trim();
    if (color) this.spectrumWorker?.postMessage({ type: 'set-accent-color', color });
  }

  /**
   * Set zoom viewport from two X fractions [0,1] of the full bandwidth.
   * Both spectrum and waterfall renderers are updated.
   */
  setSpectrumZoom(start: number, end: number): void {
    // An explicit zoom means the operator is driving again: drop any pending
    // restore from the Signal Analysis pane.
    this.analysisPrevZoom = null;
    store.setSpectrumZoom([start, end]);
    // Tiled path: whenever the server supports the segmented waterfall, request
    // the tiles for this window instead of letting the renderers remap a coarse
    // full-span frame. sendWaterfallView resets the renderers' internal zoom
    // because the incoming strip is already cropped.
    const isRealZoom = start > 0.0001 || end < 0.9999;
    if (store.waterfallProtocol() === 1 && (this.tiledActive || isRealZoom)) {
      this.sendWaterfallView(store.waterfallSpeed());
      return;
    }
    this.spectrumWorker?.postMessage({ type: 'set-zoom', start, end });
    this.waterfallWorker?.postMessage({ type: 'set-zoom', start, end });
    // Defer waterfall prefill to next rAF — multiple wheel events within one
    // frame collapse into a single redraw instead of blocking on every tick.
    this.scheduleWaterfallPrefill();
  }

  resetSpectrumZoom(): void {
    this.analysisPrevZoom = null;
    store.setSpectrumZoom([0, 1]);
    // Once a tiled view is active or pending, a full-span reset is itself a
    // (coarsest-tier) waterfall_view — re-send so the pending view fractions
    // track the user's intent rather than going stale.
    if (store.waterfallProtocol() === 1 && (this.tiledActive || this.tiledRequested)) {
      this.sendWaterfallView(store.waterfallSpeed());
      return;
    }
    this.spectrumWorker?.postMessage({ type: 'reset-zoom' });
    this.waterfallWorker?.postMessage({ type: 'reset-zoom' });
    this.scheduleWaterfallPrefill();
  }

  beginWaterfallPan(): void {
    this.waterfallWorker?.postMessage({ type: 'begin-pan' });
  }

  drawWaterfallPan(): void {
    this.waterfallWorker?.postMessage({ type: 'draw-pan' });
  }

  endWaterfallPan(): void {
    this.waterfallWorker?.postMessage({ type: 'end-pan' });
  }

  // ---- Seek-back ----

  get fftBufferCount(): number { return this.fftBuffer.count; }

  /** Latest decoded FFT frame, for decoder-specific zoom displays. */
  getLatestFftFrame(): Float32Array | null {
    const frames = this.fftBuffer.getFrames();
    return frames.length ? frames[frames.length - 1] : null;
  }

  /**
   * Frequency span, in absolute Hz, of the frames returned by getLatestFftFrame.
   * Returns null on the legacy full-span path (callers fall back to
   * centerHz ± sampleRate/2). When a tiled view is active the latest frame is a
   * cropped strip covering only [viewStartFrac, viewEndFrac] of the dongle span.
   */
  getLatestFftFrameCoverage(): { lowHz: number; highHz: number } | null {
    if (!(this.tiledActive && store.waterfallProtocol() === 1)) return null;
    const center = store.centerFrequency();
    const sr = store.sampleRate();
    if (sr <= 0) return null;
    const fullLow = center - sr / 2;
    return {
      lowHz: fullLow + this.tiledViewStartFrac * sr,
      highHz: fullLow + this.tiledViewEndFrac * sr,
    };
  }

  /** True when the segmented tiled waterfall is driving the display. */
  get isTiledWaterfall(): boolean {
    return this.tiledActive && store.waterfallProtocol() === 1;
  }

  /**
   * Ask the server for the finest tiles covering an absolute-Hz window, so the
   * Signal Analysis pane reads high-resolution tile data instead of the coarse
   * full-span frame. No-op on legacy servers (caller uses the full-span frame).
   * Skips re-requesting when the active view already covers the window.
   */
  requestAnalysisWindow(lowHz: number, highHz: number): void {
    if (store.waterfallProtocol() !== 1) return;
    const center = store.centerFrequency();
    const sr = store.sampleRate();
    if (sr <= 0) return;
    const fullLow = center - sr / 2;
    let startFrac = (lowHz - fullLow) / sr;
    let endFrac = (highHz - fullLow) / sr;
    startFrac = Math.max(0, Math.min(1, startFrac));
    endFrac = Math.max(startFrac + 1e-4, Math.min(1, endFrac));
    // Reuse the current view when it already covers the requested window.
    if (this.tiledActive &&
        this.tiledViewStartFrac <= startFrac + 1e-6 &&
        this.tiledViewEndFrac >= endFrac - 1e-6) {
      return;
    }
    // Remember the operator's zoom the first time the pane hijacks the view so
    // releaseAnalysisWindow() can put it back.
    if (!this.analysisPrevZoom) {
      this.analysisPrevZoom = store.spectrumZoom();
    }
    store.setSpectrumZoom([startFrac, endFrac]);
    this.sendWaterfallView(store.waterfallSpeed());
  }

  /**
   * Restore the view the operator had before the Signal Analysis pane narrowed
   * it to its measurement window. No-op when no override is active.
   */
  releaseAnalysisWindow(): void {
    const prev = this.analysisPrevZoom;
    if (!prev) return;
    this.analysisPrevZoom = null;
    const [start, end] = prev;
    store.setSpectrumZoom([start, end]);
    if (store.waterfallProtocol() === 1) {
      this.sendWaterfallView(store.waterfallSpeed());
      return;
    }
    this.spectrumWorker?.postMessage({ type: 'set-zoom', start, end });
    this.waterfallWorker?.postMessage({ type: 'set-zoom', start, end });
    this.scheduleWaterfallPrefill();
  }

  /** Zoomed foreground-decoder spectra, oldest first. */
  getDecoderScopeFrames(): DecoderScopeFrame[] {
    return this.decoderScopeFrames;
  }

  clearDecoderScope(): void {
    this.decoderScopeFrames = [];
    store.setDecoderScopeSeq(0);
  }

  /** Begin a short raw-IQ capture for client-side signal identification. */
  startIqCapture(durationMs: number): void {
    this.iqCaptureChunks = [];
    this.iqCaptureActive = true;
    this.iqCaptureUntil = performance.now() + Math.max(500, durationMs);
  }

  /** Drain the IQ captured since startIqCapture (or the last drain). */
  takeIqCapture(): Int16Array[] {
    const chunks = this.iqCaptureChunks;
    this.iqCaptureChunks = [];
    this.iqCaptureActive = false;
    return chunks;
  }

  /** Stop capturing without draining. */
  stopIqCapture(): void {
    this.iqCaptureActive = false;
  }

  /** Whether audio has been initialised (user has clicked to enable). */
  get isAudioInitialized(): boolean { return this.audio.isInitialized; }

  /** AnalyserNode for the audio spectrum display. Null until audio is initialised. */
  getAudioAnalyser(): AnalyserNode | null { return this.audio.getAnalyser(); }

  /** [leftAnalyser, rightAnalyser] for per-channel VU metering. */
  getAudioAnalysersLR(): [AnalyserNode | null, AnalyserNode | null] { return this.audio.getAnalysersLR(); }

  /** DynamicsCompressorNode — exposes .reduction (gain reduction in dB, ≤0). Null until initialised. */
  getAudioCompressor(): DynamicsCompressorNode | null { return this.audio.getCompressor(); }

  /**
   * Stereo blend factor for the active demodulator (0 = mono, 1 = full stereo).
   * Reads PilotPLL.blendFactor for WFM and lockLevel for C-QUAM/SAM.
   * Returns -1 if the current mode is not stereo-capable or the demod doesn't expose blend.
   */
  getStereoBlend(): number {
    const d = this.demodulator as any;
    if (d?.blendFactor !== undefined) return d.blendFactor as number;
    // WFM demod wraps PilotPLL internally; blendFactor exposed via getter
    return -1;
  }

  /** Carrier/PLL lock confidence for synchronous demodulators (SAM). */
  getSyncLock(): number {
    const d = this.demodulator as any;
    if (typeof d?.getLockLevel === 'function') return d.getLockLevel() as number;
    return -1;
  }

  /**
   * Seek the waterfall to `offset` frames back from live (0 = live).
   * Redraws the waterfall from the client buffer window.
   */
  seekTo(offset: number): void {
    const count = this.fftBuffer.count;
    this.seekOffset = Math.max(0, Math.min(offset, count));

    // Tell the worker to freeze/unfreeze live drawing
    this.waterfallWorker?.postMessage({ type: 'seek-offset', offset: this.seekOffset });

    if (!this.waterfallWorker) return;

    if (this.seekOffset === 0) {
      // Back to live — refill from full buffer
      const frames = this.fftBuffer.getFrames().map(f => f.slice());
      this.waterfallWorker.postMessage({ type: 'prefill', frames });
      return;
    }
    // Show the window of frames ending `seekOffset` frames ago
    const frames = this.fftBuffer.getFrames();
    const end = frames.length - this.seekOffset;
    if (end <= 0) return;
    const sliced = frames.slice(0, end).map(f => f.slice());
    this.waterfallWorker.postMessage({ type: 'prefill', frames: sliced });
  }

  /** Add a signal marker at an absolute frequency (Hz). */
  addSignalMarker(hz: number): void {
    const existing = store.signalMarkers();
    if (!existing.includes(hz)) {
      store.setSignalMarkers([...existing, hz]);
    }
  }

  /** Remove a signal marker at an absolute frequency (Hz). */
  removeSignalMarker(hz: number): void {
    store.setSignalMarkers(store.signalMarkers().filter(f => f !== hz));
  }

  clearSignalMarkers(): void {
    store.setSignalMarkers([]);
  }

  // ---- Bookmarks ----

  /** Save the current tune/mode/bandwidth as a named bookmark. */
  addBookmark(label: string): void {
    const bm: Bookmark = {
      id: `bm-${Date.now()}`,
      label: label.trim() || `${(store.tunedFrequency() / 1e6).toFixed(4)} MHz`,
      hz: store.tunedFrequency(),
      mode: store.mode(),
      bandwidth: store.bandwidth(),
      decoder: store.decoderMode() || undefined,
    };
    store.setBookmarks([...store.bookmarks(), bm]);
  }

  /** Fetch admin-configured bookmarks from the public API and populate the store. */
  async fetchAdminBookmarks(): Promise<void> {
    try {
      const res = await fetch('/api/bookmarks');
      if (!res.ok) return;
      const data = await res.json() as { id: string; name: string; frequency: number; mode: string; bandwidth?: number; description?: string }[];
      store.setAdminBookmarks(Array.isArray(data) ? data : []);
    } catch {
      // silently ignore — admin bookmarks are optional
    }
  }

  /** Recall a bookmark: tune, set mode/bandwidth and the foreground decoder. */
  async recallBookmark(bm: Bookmark): Promise<void> {
    const decoder = (bm.decoder ?? '').trim().toLowerCase();
    // Audio worklets are only needed for audio modes; a decoder bookmark can
    // be recalled without an audio gesture.
    if (!decoder && !this.audio.isInitialized) await this.initAudio();
    // Set mode first (may change IQ rate)
    if (bm.mode !== store.mode()) this.setMode(bm.mode);
    if (bm.bandwidth !== store.bandwidth()) this.setBandwidth(bm.bandwidth);
    this.tune(bm.hz - store.centerFrequency());
    // Restore the decoder last: it is built from the just-applied tune offset,
    // and an empty value turns any currently active decoder off.
    if (decoder !== store.decoderMode()) this.setDecoder(decoder);
  }

  deleteBookmark(id: string): void {
    store.setBookmarks(store.bookmarks().filter(b => b.id !== id));
  }

  // ---- Audio ----

  async initAudio(): Promise<void> {
    await this.audio.init();
    store.setAudioRunning(true);
    // Apply all persisted audio settings to the Web Audio graph
    this.audio.setVolume(store.volume());
    this.audio.setBalance(store.balance());
    this.audio.setEqLow(store.eqLow());
    this.audio.setEqLowMid(store.eqLowMid());
    this.audio.setEqMid(store.eqMid());
    this.audio.setEqHighMid(store.eqHighMid());
    this.audio.setEqHigh(store.eqHigh());
    this.audio.setLoudness(store.loudness());
    // Restore LMS ANR state
    this.anr.setPreset(this.getAnrPresetForMode(store.mode()));
    this.anr.setEnabled(store.nrEnabled());
    this.anr.setStrength(store.nrStrength());
    // Restore AGC settings from store
    this.agc.setPreset(this.getAgcPresetForMode(store.mode()));
    if (store.agcDecayMs()) {
      this.agc.setDecayMs(store.agcDecayMs());
    }
    // Restore audio filter settings from store
    this.rumbleFilter.setEnabled(store.rumbleFilterEnabled());
    this.rumbleFilter.setCutoff(store.rumbleFilterCutoff());
    this.autoNotch.setEnabled(store.autoNotchEnabled());
    this.hiBlend.setEnabled(store.hiBlendEnabled());
    this.hiBlend.setCutoff(store.hiBlendCutoff());

    // Client is a dumb terminal: the Opus decoder lifecycle is managed
    // exclusively by MSG_AUDIO_OPUS based on the wire channel header.
    // No pre-init here — just tell the server to start sending.

    // Tell server to start sending IQ data now that audio is enabled
    this.send({ cmd: 'audio_enabled', enabled: true });
    // Announce to the OS lock screen / notification shade
    this.updateMediaSession();
  }

  // ---- Resize Handling ----

  handleResize(): void {
    if (this.waterfallCanvas && this.waterfallWorker) {
      const rect = this.waterfallCanvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w > 0 && h > 0) {
        this.waterfallWorker.postMessage({ type: 'resize', width: w, height: h });
      }
    }
    if (this.spectrumCanvas && this.spectrumWorker) {
      const rect = this.spectrumCanvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const dpr = window.devicePixelRatio || 1;
      if (w > 0 && h > 0) {
        this.spectrumWorker.postMessage({ type: 'resize', width: w, height: h, dpr });
      }
    }
    // Tiled path: viewport width drives tier/tile selection, so a resize must
    // re-request the view at the new pixel width.
    if (store.waterfallProtocol() === 1 && (this.tiledActive || this.tiledRequested)) {
      this.sendWaterfallView(store.waterfallSpeed());
    }
  }

  // ---- Admin ----

  adminAuth(password: string): void {
    this.send({ cmd: 'admin_auth', password });
  }

  adminSetProfile(dongleId: string, profileId: string): void {
    this.send({ cmd: 'admin_set_profile', dongleId, profileId });
  }

  // ---- Music Identification ----

  /**
   * Identify the currently playing music.
   *
   * - Opus codec path: server captures from its internal PCM ring buffer (best quality).
   * Identify the currently playing music.
   *
   * Flow:
   *  1. Sends `identify_start` over WebSocket → server issues a one-time token (20s TTL)
   *  2. Simultaneously starts capturing 10s of audio from the worklet ring buffer
   *  3. When token arrives via `identify_token` META message, POSTs token + WAV to /api/identify
   *     (Opus path: server uses its own PCM buffer; ADPCM/none path: uses the uploaded WAV)
   *  4. Result stored in store.identifyResult
   *
   * Updates store.identifyState and store.identifyResult reactively.
   */
  async identify(): Promise<void> {
    if (store.identifyState() === 'capturing' || store.identifyState() === 'querying') return;

    store.setIdentifyState('capturing');
    store.setIdentifyResult(null);

    try {
      // Request a one-time token from the server via WebSocket
      const tokenPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.identifyTokenResolve = null;
          reject(new Error('token timeout — server did not respond in time'));
        }, 5000);
        this.identifyTokenResolve = (token: string) => {
          clearTimeout(timer);
          this.identifyTokenResolve = null;
          resolve(token);
        };
      });
      this.send({ cmd: 'identify_start' });

      // Capture audio and wait for token in parallel
      const codec = store.iqCodec();
      const isOpus = codec === 'opus' || codec === 'opus-hq' || codec === 'opus-lo';

      // Start audio capture immediately — runs in parallel with token fetch
      const capturePromise = isOpus
        ? Promise.resolve(null)                 // Opus: server has its own PCM buffer
        : this.audio.captureAudio(10);          // ADPCM/none: capture from worklet

      const [token, pcm] = await Promise.all([tokenPromise, capturePromise]);

      store.setIdentifyState('querying');

      // Build multipart form: always include token; include WAV for non-Opus paths
      const form = new FormData();
      form.append('token', token);

      if (!isOpus) {
        if (!pcm || pcm.length === 0) {
          store.setIdentifyState('error');
          store.setIdentifyResult({ match: false, error: 'No audio captured' });
          return;
        }
        const wav = this.pcmToWav(pcm, 48000);
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
      }

      const response = await fetch('/api/identify', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });

      const responseText = await response.text();

      if (!response.ok) {
        let err: { error?: string } = { error: `HTTP ${response.status}` };
        try { err = JSON.parse(responseText); } catch {}
        store.setIdentifyState('error');
        store.setIdentifyResult({ match: false, error: err?.error ?? `HTTP ${response.status}` });
        return;
      }

      let data: any = {};
      try { data = JSON.parse(responseText); } catch {
        console.error('[Identify] failed to parse response JSON');
        store.setIdentifyState('error');
        store.setIdentifyResult({ match: false, error: 'Invalid server response' });
        return;
      }
      store.setIdentifyState('done');
      if (data.match && data.result) {
        store.setIdentifyResult({
          match:   true,
          title:   data.result.title,
          artist:  data.result.artist,
          album:   data.result.album,
          spotify: data.result.spotify,
          youtube: data.result.youtube,
          apple:   data.result.apple,
          service: data.result.service,
        });
      } else {
        store.setIdentifyResult({ match: false });
      }
    } catch (e) {
      console.error('[Identify] error:', e);
      store.setIdentifyState('error');
      store.setIdentifyResult({ match: false, error: e instanceof Error ? e.message : 'Network error' });
    }
  }

  // Resolve callback for pending identify token — set by identify(), called by handleMetaMessage
  private identifyTokenResolve: ((token: string) => void) | null = null;

  /**
   * Arms a 10-second identify cooldown for ADPCM and none codecs.
   * On these paths the client-side ring buffer was just flushed (frequency change)
   * and needs to refill before 10s of clean audio is available for recognition.
   * Opus is exempt — the server-side ring is independent of client tuning.
   */
  private armIdentifyCooldown(): void {
    const codec = store.iqCodec();
    if (codec === 'opus' || codec === 'opus-hq' || codec === 'opus-lo') return;
    store.setIdentifyReadyAt(Date.now() + 5_000);
  }

  /** Encode a Float32 mono 48kHz PCM array to a minimal WAV ArrayBuffer. */
  private pcmToWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
    const numSamples = pcm.length;
    const buf = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buf);
    const write4 = (o: number, s: string) => { for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    const writeU32 = (o: number, v: number) => view.setUint32(o, v, true);
    const writeU16 = (o: number, v: number) => view.setUint16(o, v, true);
    write4(0, 'RIFF');
    writeU32(4, 36 + numSamples * 2);
    write4(8, 'WAVE');
    write4(12, 'fmt ');
    writeU32(16, 16); writeU16(20, 1); writeU16(22, 1);
    writeU32(24, sampleRate); writeU32(28, sampleRate * 2);
    writeU16(32, 2); writeU16(34, 16);
    write4(36, 'data');
    writeU32(40, numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return buf;
  }

  // ---- Cleanup ----

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.audio.destroy();
    this.fftDecodeWorker.terminate();
    this.fftAnalysisWorker.terminate();
    this.waterfallWorker?.terminate();
  }
}

// Singleton engine instance.
// Survives HMR by reusing the existing instance stored on globalThis — this
// preserves WS connection, audio state, and tuning state across hot reloads.
const _global = globalThis as any;
export const engine: SdrEngine = _global.__sdrEngine instanceof SdrEngine
  ? _global.__sdrEngine
  : (_global.__sdrEngine = new SdrEngine());
