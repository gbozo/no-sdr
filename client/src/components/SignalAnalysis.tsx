// ============================================================
// node-sdr — Signal analysis workspace
// ============================================================
// Expert view for the currently tuned station: zoomed spectrum + waterfall,
// instantaneous levels, master peak/low across the full FFT span, local
// peaks/lows and a peak/floor history strip. Fed by the same FFT frames the
// waterfall uses; no extra server traffic.

import { Component, For, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { store } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';

type SpanMode = 'bw' | '2x' | '5x' | '10x' | 'full';

const SPAN_MODES: { id: SpanMode; label: string; title: string }[] = [
  { id: 'bw', label: 'BW', title: 'Exactly the current filter bandwidth (1)' },
  { id: '2x', label: '2×', title: 'Twice the filter bandwidth (2)' },
  { id: '5x', label: '5×', title: 'Five times the filter bandwidth (3)' },
  { id: '10x', label: '10×', title: 'Ten times the filter bandwidth (4)' },
  { id: 'full', label: 'FULL', title: 'Full sampled bandwidth (5)' },
];

const TRACE_MODES: { id: TraceMode; label: string; title: string }[] = [
  { id: 'live', label: 'LIVE', title: 'Live trace' },
  { id: 'avg', label: 'AVG', title: 'Exponential average trace' },
  { id: 'min', label: 'MIN', title: 'Minimum hold trace' },
  { id: 'max', label: 'MAX', title: 'Peak hold trace' },
];

const MAX_WATERFALL_FRAMES = 140;
const MAX_LEVEL_FRAMES = 180;

interface Marker {
  hz: number;
  offsetHz: number;
  db: number;
}

interface AnalysisStats {
  winLowHz: number;
  winHighHz: number;
  spanHz: number;
  hzPerBin: number;
  start: number;
  end: number;
  bins: Float32Array;
  peakDb: number;
  peakHz: number;
  minDb: number;
  minHz: number;
  noiseFloorDb: number;
  meanDb: number;
  snrDb: number;
  crestDb: number;
  bw3DbHz: number;
  peaks: Marker[];
  lows: Marker[];
  fullPeakDb: number;
  fullPeakHz: number;
  fullLowDb: number;
  fullLowHz: number;
  measureBwHz: number;
  chanPowerDb: number;
  chanNoiseDb: number;
  chanSnrDb: number;
  occupiedBwHz: number;
  carrierDb: number;
  carrierHz: number;
  carrierOffsetHz: number;
  carrierToNoiseDb: number;
  usbPowerDb: number;
  lsbPowerDb: number;
  sbBalancePct: number;
  amDepthPct: number;
}

interface AnalysisConfig {
  sampleRate: number;
  centerHz: number;
  tuneHz: number;
  bandwidth: number;
  measureBwHz: number;
}

interface LevelPoint {
  peak: number;
  floor: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 10);
}

function linearToDb(power: number): number {
  return 10 * Math.log10(Math.max(power, 1e-30));
}

function sumLinearPower(frame: Float32Array, start: number, end: number): number {
  let power = 0;
  for (let i = Math.max(0, start); i < Math.min(frame.length, end); i++) {
    if (Number.isFinite(frame[i])) power += dbToLinear(frame[i]);
  }
  return power;
}

function spanForMode(mode: SpanMode, bandwidth: number, sampleRate: number): number {
  const base = Math.max(500, bandwidth || 1000);
  const wanted = mode === 'bw' ? base
    : mode === '2x' ? base * 2
    : mode === '5x' ? base * 5
    : mode === '10x' ? base * 10
    : sampleRate;
  return Math.max(1, Math.min(sampleRate || wanted, wanted));
}

function fmtFreq(hz: number): string {
  const abs = Math.abs(hz);
  if (abs >= 1e6) return `${(hz / 1e6).toFixed(6)} MHz`;
  if (abs >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function fmtFreqCompact(hz: number): string {
  const abs = Math.abs(hz);
  if (abs >= 1e6) return `${(hz / 1e6).toFixed(4)}M`;
  if (abs >= 1e3) return `${(hz / 1e3).toFixed(2)}k`;
  return `${hz.toFixed(0)}`;
}

function fmtOffset(hz: number): string {
  const abs = Math.abs(hz);
  const sign = hz >= 0 ? '+' : '−';
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}k`;
  return `${sign}${abs.toFixed(0)}`;
}

function fmtSpan(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function niceStep(range: number): number {
  const raw = Math.max(1e-6, range / 5);
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / power;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * power;
}

function setupCanvas(canvas: HTMLCanvasElement) {
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function accentColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--sdr-accent').trim() || '#4aa3ff';
}

function analyse(frame: Float32Array, cfg: AnalysisConfig, spanHz: number): AnalysisStats | null {
  const frameLen = frame.length;
  if (frameLen === 0 || cfg.sampleRate <= 0) return null;

  const hzPerBin = cfg.sampleRate / frameLen;
  const frameLow = cfg.centerHz - cfg.sampleRate / 2;
  const wantedLow = cfg.tuneHz - spanHz / 2;
  const wantedHigh = cfg.tuneHz + spanHz / 2;
  const start = clamp(Math.floor((wantedLow - frameLow) / hzPerBin), 0, frameLen - 1);
  const end = clamp(Math.ceil((wantedHigh - frameLow) / hzPerBin), start + 1, frameLen);
  const lowHz = frameLow + start * hzPerBin;
  const highHz = frameLow + end * hzPerBin;
  const bins = frame.slice(start, end);
  const n = bins.length;
  if (n === 0) return null;

  let peakDb = -Infinity;
  let peakIdx = 0;
  let lowDb = Infinity;
  let lowIdx = 0;
  let sum = 0;
  let finite = 0;
  for (let i = 0; i < n; i++) {
    const v = bins[i];
    if (!Number.isFinite(v)) continue;
    sum += v;
    finite++;
    if (v > peakDb) { peakDb = v; peakIdx = i; }
    if (v < lowDb) { lowDb = v; lowIdx = i; }
  }
  if (finite === 0) return null;

  // Noise reference from the whole sampled span. Using the analysis window
  // alone biases the noise floor upward when the signal fills the window.
  const noiseSamples: number[] = [];
  const noiseStride = Math.max(1, Math.floor(frameLen / 2048));
  for (let i = 0; i < frameLen; i += noiseStride) {
    if (Number.isFinite(frame[i])) noiseSamples.push(frame[i]);
  }
  noiseSamples.sort((a, b) => a - b);
  const noiseFloorDb = noiseSamples.length
    ? noiseSamples[Math.floor(noiseSamples.length / 2)]
    : -120;
  const meanDb = sum / finite;

  const binHz = (index: number) => lowHz + (index + 0.5) * hzPerBin;
  const marker = (index: number, db: number): Marker => {
    const hz = binHz(index);
    return { hz, offsetHz: hz - cfg.tuneHz, db };
  };

  const peaks: Marker[] = [];
  const lows: Marker[] = [];
  const peakThreshold = noiseFloorDb + 6;
  const lowThreshold = noiseFloorDb - 6;
  for (let i = 1; i < n - 1; i++) {
    const v = bins[i];
    if (!Number.isFinite(v)) continue;
    if (v >= bins[i - 1] && v > bins[i + 1] && v >= peakThreshold) {
      peaks.push(marker(i, v));
    }
    if (v <= bins[i - 1] && v < bins[i + 1] && v <= lowThreshold) {
      lows.push(marker(i, v));
    }
  }
  peaks.sort((a, b) => b.db - a.db);
  lows.sort((a, b) => a.db - b.db);
  peaks.splice(4);
  lows.splice(4);
  if (peaks.length === 0) peaks.push(marker(peakIdx, peakDb));
  if (lows.length === 0) lows.push(marker(lowIdx, lowDb));

  // −3 dB bandwidth around the strongest bin, clamped to the noise floor.
  const edge = Math.max(noiseFloorDb + 1, peakDb - 3);
  let left = peakIdx;
  let right = peakIdx;
  while (left > 0 && Number.isFinite(bins[left - 1]) && bins[left - 1] >= edge) left--;
  while (right < n - 1 && Number.isFinite(bins[right + 1]) && bins[right + 1] >= edge) right++;
  const bw3DbHz = Math.max(hzPerBin, (right - left + 1) * hzPerBin);

  // Master peak/low over the full sampled span (edge bins skipped).
  const skip = Math.max(1, Math.floor(frameLen * 0.01));
  let fullPeakDb = -Infinity;
  let fullPeakIdx = 0;
  let fullLowDb = Infinity;
  let fullLowIdx = 0;
  for (let i = skip; i < frameLen - skip; i++) {
    const v = frame[i];
    if (!Number.isFinite(v)) continue;
    if (v > fullPeakDb) { fullPeakDb = v; fullPeakIdx = i; }
    if (v < fullLowDb) { fullLowDb = v; fullLowIdx = i; }
  }
  const fullBinHz = (index: number) => frameLow + (index + 0.5) * hzPerBin;

  // Measurement window (independent of the analysis zoom).
  const measHalfBins = Math.max(1, Math.round(cfg.measureBwHz / 2 / hzPerBin));
  const tuneIdx = Math.round((cfg.tuneHz - frameLow) / hzPerBin);
  const measStart = clamp(tuneIdx - measHalfBins, 0, frameLen - 1);
  const measEnd = clamp(tuneIdx + measHalfBins + 1, measStart + 1, frameLen);
  const chanPower = sumLinearPower(frame, measStart, measEnd);
  const chanPowerDb = linearToDb(chanPower);
  const chanNoiseDb = linearToDb(dbToLinear(noiseFloorDb) * (measEnd - measStart));
  const chanSnrDb = chanPowerDb - chanNoiseDb;

  // 99 % occupied bandwidth inside the analysis window.
  let totalPower = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(bins[i])) totalPower += dbToLinear(bins[i]);
  }
  let accum = 0;
  let occLow = 0;
  let occHigh = n - 1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(bins[i])) continue;
    accum += dbToLinear(bins[i]);
    if (accum >= totalPower * 0.005) { occLow = i; break; }
  }
  accum = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(bins[i])) continue;
    accum += dbToLinear(bins[i]);
    if (accum >= totalPower * 0.995) { occHigh = i; break; }
  }
  const occupiedBwHz = Math.max(hzPerBin, (occHigh - occLow + 1) * hzPerBin);

  // AM/AMS carrier search around the tuned frequency.
  const carrierSearchHz = Math.max(500, Math.min(5000, cfg.bandwidth / 2 || 2000));
  const carrierStart = clamp(
    Math.floor((cfg.tuneHz - carrierSearchHz - frameLow) / hzPerBin),
    0,
    frameLen - 1,
  );
  const carrierEnd = clamp(
    Math.ceil((cfg.tuneHz + carrierSearchHz - frameLow) / hzPerBin),
    carrierStart + 1,
    frameLen,
  );
  let carrierDb = -Infinity;
  let carrierIdx = carrierStart;
  for (let i = carrierStart; i < carrierEnd; i++) {
    if (Number.isFinite(frame[i]) && frame[i] > carrierDb) {
      carrierDb = frame[i];
      carrierIdx = i;
    }
  }
  const carrierHz = frameLow + (carrierIdx + 0.5) * hzPerBin;
  const carrierPower = Number.isFinite(carrierDb) ? dbToLinear(carrierDb) : 0;

  // Upper/lower sideband power inside the demod bandwidth, excluding the
  // carrier region. Used for AM depth and sideband balance estimates.
  const sbInnerHz = Math.max(300, hzPerBin * 3);
  const sbOuterHz = Math.max(sbInnerHz + hzPerBin, cfg.bandwidth / 2 || 3000);
  const upperPower = sumLinearPower(
    frame,
    Math.floor((cfg.tuneHz + sbInnerHz - frameLow) / hzPerBin),
    Math.ceil((cfg.tuneHz + sbOuterHz - frameLow) / hzPerBin),
  );
  const lowerPower = sumLinearPower(
    frame,
    Math.floor((cfg.tuneHz - sbOuterHz - frameLow) / hzPerBin),
    Math.ceil((cfg.tuneHz - sbInnerHz - frameLow) / hzPerBin),
  );
  const usbPowerDb = linearToDb(upperPower);
  const lsbPowerDb = linearToDb(lowerPower);
  const sbMax = Math.max(upperPower, lowerPower);
  const sbBalancePct = sbMax > 0 ? (Math.min(upperPower, lowerPower) / sbMax) * 100 : 0;
  const amDepthPct = carrierPower > 0
    ? clamp(Math.sqrt(Math.max(0, (2 * (upperPower + lowerPower)) / carrierPower)) * 100, 0, 200)
    : 0;

  return {
    winLowHz: lowHz,
    winHighHz: highHz,
    spanHz: highHz - lowHz,
    hzPerBin,
    start,
    end,
    bins,
    peakDb,
    peakHz: binHz(peakIdx),
    minDb: lowDb,
    minHz: binHz(lowIdx),
    noiseFloorDb,
    meanDb,
    snrDb: peakDb - noiseFloorDb,
    crestDb: peakDb - meanDb,
    bw3DbHz,
    peaks,
    lows,
    fullPeakDb,
    fullPeakHz: fullBinHz(fullPeakIdx),
    fullLowDb,
    fullLowHz: fullBinHz(fullLowIdx),
    measureBwHz: (measEnd - measStart) * hzPerBin,
    chanPowerDb,
    chanNoiseDb,
    chanSnrDb,
    occupiedBwHz,
    carrierDb,
    carrierHz,
    carrierOffsetHz: carrierHz - cfg.tuneHz,
    carrierToNoiseDb: carrierDb - noiseFloorDb,
    usbPowerDb,
    lsbPowerDb,
    sbBalancePct,
    amDepthPct,
  };
}

type TraceMode = 'live' | 'avg' | 'min' | 'max';

interface EventEntry {
  at: number;
  text: string;
  kind: 'up' | 'down' | 'info';
}

const MEASURE_BW_OPTIONS = [0, 1_000, 3_000, 6_000, 12_500, 25_000, 50_000, 100_000, 200_000];

function loadDbmOffset(): number {
  try {
    const raw = localStorage.getItem('node-sdr:analysis.dbmOffset');
    const v = raw === null ? 0 : Number(raw);
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

const SignalAnalysis: Component = () => {
  let spectrumRef: HTMLCanvasElement | undefined;
  let waterfallRef: HTMLCanvasElement | undefined;
  let levelRef: HTMLCanvasElement | undefined;
  let driftRef: HTMLCanvasElement | undefined;

  const [spanMode, setSpanMode] = createSignal<SpanMode>('bw');
  const [traceMode, setTraceMode] = createSignal<TraceMode>('max');
  const [frozen, setFrozen] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [stats, setStats] = createSignal<AnalysisStats | null>(null);
  const [cursor, setCursor] = createSignal<{ hz: number; db: number } | null>(null);
  const [measureBw, setMeasureBw] = createSignal(0);
  const [markerA, setMarkerA] = createSignal(-100_000);
  const [markerB, setMarkerB] = createSignal(100_000);
  const [snapMarkers, setSnapMarkers] = createSignal(true);
  const [historyOffset, setHistoryOffset] = createSignal(0);
  const [dbmOffset, setDbmOffset] = createSignal(loadDbmOffset());
  const [showLog, setShowLog] = createSignal(false);
  const [activityPct, setActivityPct] = createSignal(0);
  const [driftHz, setDriftHz] = createSignal(0);
  const [events, setEvents] = createSignal<EventEntry[]>([]);
  const [historyCount, setHistoryCount] = createSignal(0);
  const [syncLock, setSyncLock] = createSignal(-1);
  const [stereoBlend, setStereoBlend] = createSignal(-1);

  let history: Float32Array[] = [];
  let levelHistory: LevelPoint[] = [];
  let traceData: Float32Array | null = null;
  let lastFrame: Float32Array | null = null;
  let lastKey = '';
  let viewMin = store.waterfallMin();
  let viewMax = store.waterfallMax();
  let wfMin = store.waterfallMin();
  let wfMax = store.waterfallMax();
  let driftHistory: number[] = [];
  let driftReference: number | null = null;
  let presenceHistory: boolean[] = [];
  let lastPresence = false;
  let dragging: 'a' | 'b' | null = null;
  let loadedSpanKey = '';

  const config = (): AnalysisConfig => ({
    sampleRate: store.sampleRate(),
    centerHz: store.centerFrequency(),
    tuneHz: store.tunedFrequency(),
    bandwidth: store.bandwidth(),
    measureBwHz: measureBw() > 0 ? measureBw() : Math.max(1, store.bandwidth()),
  });

  const fmtLevel = (db: number): string =>
    `${(db + dbmOffset()).toFixed(1)} ${dbmOffset() === 0 ? 'dB' : 'dBm'}`;

  const markerReadout = () => {
    const s = stats();
    if (!s) return null;
    const dbAt = (offsetHz: number): number => {
      const idx = clamp(
        Math.round((store.tunedFrequency() + offsetHz - s.winLowHz) / s.hzPerBin),
        0,
        s.bins.length - 1,
      );
      return s.bins[idx];
    };
    const aDb = dbAt(markerA());
    const bDb = dbAt(markerB());
    return { aDb, bDb, deltaHz: markerB() - markerA(), deltaDb: bDb - aDb };
  };

  const spanHz = (): number => {
    const cfg = config();
    return spanForMode(spanMode(), cfg.bandwidth, cfg.sampleRate);
  };

  const resetAnalysis = () => {
    history = [];
    levelHistory = [];
    traceData = null;
    lastFrame = null;
    lastKey = '';
    driftHistory = [];
    driftReference = null;
    presenceHistory = [];
    lastPresence = false;
    viewMin = store.waterfallMin();
    viewMax = store.waterfallMax();
    wfMin = store.waterfallMin();
    wfMax = store.waterfallMax();
    setStats(null);
    setCursor(null);
    setActivityPct(0);
    setDriftHz(0);
    setEvents([]);
    setHistoryOffset(0);
    setHistoryCount(0);
    setFrozen(false);
  };

  const updateViewRange = (s: AnalysisStats) => {
    const targetMin = Math.min(store.waterfallMin(), s.noiseFloorDb - 5);
    const targetMax = Math.max(store.waterfallMax(), s.peakDb + 3);
    viewMin += (targetMin - viewMin) * 0.2;
    viewMax += (targetMax - viewMax) * 0.2;
    if (viewMax - viewMin < 10) viewMax = viewMin + 10;
  };

  const updateWaterfallRange = (s: AnalysisStats) => {
    let targetMin = s.noiseFloorDb - 4;
    let targetMax = s.peakDb + 3;
    if (targetMax - targetMin < 12) {
      const mid = (targetMax + targetMin) / 2;
      targetMin = mid - 6;
      targetMax = mid + 6;
    }
    wfMin += (targetMin - wfMin) * 0.25;
    wfMax += (targetMax - wfMax) * 0.25;
  };

  const updateTrace = (frame: Float32Array) => {
    const mode = traceMode();
    if (mode === 'live') {
      traceData = null;
      return;
    }
    if (!traceData || traceData.length !== frame.length) {
      traceData = new Float32Array(frame);
      return;
    }
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      if (!Number.isFinite(v)) continue;
      if (mode === 'avg') traceData[i] = traceData[i] * 0.8 + v * 0.2;
      else if (mode === 'min') traceData[i] = Math.min(traceData[i], v);
      else traceData[i] = Math.max(traceData[i], v);
    }
  };

  const pushEvent = (text: string, kind: EventEntry['kind']) => {
    setEvents((prev) => [{ at: Date.now(), text, kind }, ...prev].slice(0, 60));
  };

  const trackActivity = (s: AnalysisStats) => {
    const active = s.peakDb > s.noiseFloorDb + 6;
    presenceHistory.push(active);
    if (presenceHistory.length > 200) presenceHistory.shift();
    if (active !== lastPresence) {
      pushEvent(active ? 'Signal detected' : 'Signal lost', active ? 'up' : 'down');
      lastPresence = active;
    }
    const count = presenceHistory.reduce((n, v) => n + (v ? 1 : 0), 0);
    setActivityPct((count / Math.max(1, presenceHistory.length)) * 100);
  };

  const trackDrift = (s: AnalysisStats) => {
    if (driftReference === null) driftReference = s.peakHz;
    const drift = s.peakHz - driftReference;
    driftHistory.push(drift);
    if (driftHistory.length > 200) driftHistory.shift();
    setDriftHz(drift);
  };

  const drawSpectrum = (s: AnalysisStats, cfg: AnalysisConfig) => {
    const canvas = spectrumRef;
    if (!canvas) return;
    const setup = setupCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    const left = 34;
    const right = 8;
    const top = 6;
    const bottom = 15;
    const plotW = Math.max(1, w - left - right);
    const plotH = Math.max(1, h - top - bottom);
    const accent = accentColor();

    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, w, h);

    const dbSpan = Math.max(1, viewMax - viewMin);
    const xForHz = (hz: number) => left + ((hz - s.winLowHz) / Math.max(1, s.spanHz)) * plotW;
    const yForDb = (db: number) => top + (1 - (db - viewMin) / dbSpan) * plotH;

    // Grid + dB labels.
    ctx.font = '7px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const step = niceStep(dbSpan);
    const first = Math.ceil(viewMin / step) * step;
    for (let db = first; db <= viewMax; db += step) {
      const y = yForDb(db);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(150,165,185,0.55)';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(db)}`, left - 3, y);
    }

    // Frequency grid + labels.
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const x = left + frac * plotW;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(150,165,185,0.55)';
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(fmtFreqCompact(s.winLowHz + frac * s.spanHz), x, top + plotH + 2);
    }

    // Noise floor.
    const noiseY = yForDb(s.noiseFloorDb);
    ctx.strokeStyle = 'rgba(255,190,90,0.4)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(left, noiseY);
    ctx.lineTo(left + plotW, noiseY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,190,90,0.7)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`NOISE ${s.noiseFloorDb.toFixed(1)} dB`, left + 2, noiseY - 1);

    // Filter edges.
    const bw = store.bandwidth();
    const tuneHz = store.tunedFrequency();
    if (bw > 0) {
      for (const edgeHz of [tuneHz - bw / 2, tuneHz + bw / 2]) {
        if (edgeHz <= s.winLowHz || edgeHz >= s.winHighHz) continue;
        const x = xForHz(edgeHz);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.setLineDash([2, 5]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Signal markers from the waterfall.
    for (const markerHz of store.signalMarkers()) {
      if (markerHz <= s.winLowHz || markerHz >= s.winHighHz) continue;
      const x = xForHz(markerHz);
      ctx.strokeStyle = 'rgba(255,160,60,0.35)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Spectrum trace + fill.
    const points: { x: number; y: number }[] = [];
    for (let x = 0; x < plotW; x++) {
      const i0 = Math.floor((x / plotW) * s.bins.length);
      const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / plotW) * s.bins.length));
      let db = -Infinity;
      for (let i = i0; i < i1 && i < s.bins.length; i++) {
        if (s.bins[i] > db) db = s.bins[i];
      }
      if (!Number.isFinite(db)) db = viewMin;
      points.push({ x: left + x, y: yForDb(db) });
    }
    const grad = ctx.createLinearGradient(0, top, 0, top + plotH);
    grad.addColorStop(0, 'rgba(74,163,255,0.30)');
    grad.addColorStop(1, 'rgba(74,163,255,0.02)');
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.lineTo(left + plotW, top + plotH);
    ctx.lineTo(left, top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Held trace: average, min or max depending on the selected mode.
    if (traceMode() !== 'live' && traceData && traceData.length >= s.end) {
      const tone = traceMode() === 'avg' ? 'rgba(90,220,255,0.65)'
        : traceMode() === 'min' ? 'rgba(110,220,140,0.65)'
        : 'rgba(255,180,70,0.55)';
      ctx.beginPath();
      for (let x = 0; x < plotW; x++) {
        const i0 = s.start + Math.floor((x / plotW) * s.bins.length);
        const i1 = s.start + Math.max(1, Math.floor(((x + 1) / plotW) * s.bins.length));
        let db = -Infinity;
        for (let i = i0; i < i1 && i < traceData.length; i++) {
          if (traceMode() === 'min' ? traceData[i] < db : traceData[i] > db) db = traceData[i];
        }
        if (!Number.isFinite(db)) db = viewMin;
        const px = left + x;
        const py = yForDb(db);
        if (x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = tone;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Draggable measurement markers A/B.
    const drawMarker = (offsetHz: number, label: string, color: string) => {
      const hz = tuneHz + offsetHz;
      if (hz < s.winLowHz || hz > s.winHighHz) return;
      const x = xForHz(hz);
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '7px ui-monospace, monospace';
      ctx.textAlign = x > left + plotW * 0.85 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x + (x > left + plotW * 0.85 ? -3 : 3), top + 2);
    };
    drawMarker(markerA(), `A ${fmtOffset(markerA())}`, 'rgba(80,220,255,0.9)');
    drawMarker(markerB(), `B ${fmtOffset(markerB())}`, 'rgba(255,190,80,0.9)');
    {
      const aHz = tuneHz + markerA();
      const bHz = tuneHz + markerB();
      const aX = xForHz(aHz);
      const bX = xForHz(bHz);
      if (aX >= left && bX <= left + plotW && bX > aX) {
        ctx.fillStyle = 'rgba(120,200,255,0.06)';
        ctx.fillRect(aX, top, bX - aX, plotH);
      }
    }

    // Tuned centre line.
    if (tuneHz > s.winLowHz && tuneHz < s.winHighHz) {
      const x = xForHz(tuneHz);
      ctx.strokeStyle = 'rgba(255,252,98,0.65)';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
    }

    // Strongest peak marker.
    if (Number.isFinite(s.peakDb) && s.peakHz > s.winLowHz && s.peakHz < s.winHighHz) {
      const x = xForHz(s.peakHz);
      const y = yForDb(s.peakDb);
      ctx.fillStyle = 'rgba(255,252,98,0.95)';
      ctx.beginPath();
      ctx.arc(x, clamp(y, top + 2, top + plotH - 2), 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '7px ui-monospace, monospace';
      ctx.textAlign = x > left + plotW * 0.72 ? 'right' : 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(255,252,98,0.9)';
      ctx.fillText(`PEAK ${s.peakDb.toFixed(1)} dB`, x + (x > left + plotW * 0.72 ? -4 : 4), clamp(y - 5, top + 8, top + plotH));
    }

    // Hover cursor.
    const c = cursor();
    if (c && c.hz > s.winLowHz && c.hz < s.winHighHz) {
      const x = xForHz(c.hz);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.lineWidth = 1;
  };

  const drawWaterfall = (s: AnalysisStats) => {
    const canvas = waterfallRef;
    if (!canvas) return;
    const setup = setupCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, w, h);
    if (history.length === 0 || s.bins.length === 0) return;

    const bins = s.bins.length;
    const frames = history.length;
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const range = Math.max(1, wfMax - wfMin);
    for (let y = 0; y < h; y++) {
      // Stretch the available history over the full pane so the first few
      // seconds already look like a waterfall instead of a thin top strip.
      const frameIndex = frames - 1 - Math.min(frames - 1, Math.floor((y / h) * frames));
      const frame = history[frameIndex];
      if (frame.length <= s.end) continue;
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const idx = s.start + Math.min(bins - 1, Math.floor((x / w) * bins));
        const db = frame[idx];
        const t = clamp((db - wfMin) / range, 0, 1);
        const v = Math.round(255 * Math.pow(t, 0.8));
        const p = row + x * 4;
        data[p] = Math.round(v * 0.06);
        data[p + 1] = Math.round(45 + v * 0.60);
        data[p + 2] = Math.round(85 + v * 0.65);
        data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Centre + filter edges over the zoomed waterfall.
    const xForHz = (hz: number) => ((hz - s.winLowHz) / Math.max(1, s.spanHz)) * w;
    const tuneHz = store.tunedFrequency();
    if (tuneHz > s.winLowHz && tuneHz < s.winHighHz) {
      ctx.strokeStyle = 'rgba(255,252,98,0.55)';
      ctx.beginPath();
      ctx.moveTo(xForHz(tuneHz), 0);
      ctx.lineTo(xForHz(tuneHz), h);
      ctx.stroke();
    }
    const bw = store.bandwidth();
    if (bw > 0) {
      for (const edgeHz of [tuneHz - bw / 2, tuneHz + bw / 2]) {
        if (edgeHz <= s.winLowHz || edgeHz >= s.winHighHz) continue;
        const x = xForHz(edgeHz);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  };

  const drawLevelHistory = () => {
    const canvas = levelRef;
    if (!canvas) return;
    const setup = setupCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, w, h);
    if (levelHistory.length < 2) return;

    let min = Infinity;
    let max = -Infinity;
    for (const p of levelHistory) {
      min = Math.min(min, p.floor, p.peak);
      max = Math.max(max, p.floor, p.peak);
    }
    if (max - min < 8) {
      const mid = (max + min) / 2;
      min = mid - 4;
      max = mid + 4;
    }
    const range = Math.max(1, max - min);
    const xFor = (i: number) => (i / (levelHistory.length - 1)) * w;
    const yFor = (db: number) => h - ((db - min) / range) * h;

    ctx.beginPath();
    levelHistory.forEach((p, i) => {
      const x = xFor(i);
      const y = yFor(p.peak);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74,163,255,0.10)';
    ctx.fill();

    ctx.beginPath();
    levelHistory.forEach((p, i) => {
      const x = xFor(i);
      const y = yFor(p.peak);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    levelHistory.forEach((p, i) => {
      const x = xFor(i);
      const y = yFor(p.floor);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(255,190,90,0.55)';
    ctx.stroke();
  };

  const drawDriftHistory = () => {
    const canvas = driftRef;
    if (!canvas) return;
    const setup = setupCanvas(canvas);
    if (!setup) return;
    const { ctx, w, h } = setup;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, w, h);
    if (driftHistory.length < 2) return;
    let min = Infinity;
    let max = -Infinity;
    for (const v of driftHistory) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    if (max - min < 2) {
      const mid = (max + min) / 2;
      min = mid - 1;
      max = mid + 1;
    }
    const range = Math.max(0.1, max - min);
    const xFor = (i: number) => (i / (driftHistory.length - 1)) * w;
    const yFor = (v: number) => h - ((v - min) / range) * h;
    const zeroY = yFor(clamp(0, min, max));
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    driftHistory.forEach((v, i) => {
      const x = xFor(i);
      const y = yFor(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(255,180,70,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  const renderFrame = (frame: Float32Array, pushHistory: boolean) => {
    if (history.length && history[0].length !== frame.length) {
      history = [];
      levelHistory = [];
      traceData = null;
      driftHistory = [];
      driftReference = null;
    }
    if (pushHistory) {
      history.push(new Float32Array(frame));
      if (history.length > MAX_WATERFALL_FRAMES) history.shift();
      setHistoryCount(history.length);
    }

    const cfg = config();
    const s = analyse(frame, cfg, spanHz());
    if (!s) return;
    setStats(s);
    setSyncLock(engine.getSyncLock());
    setStereoBlend(engine.getStereoBlend());
    if (pushHistory) {
      levelHistory.push({ peak: s.peakDb, floor: s.noiseFloorDb });
      if (levelHistory.length > MAX_LEVEL_FRAMES) levelHistory.shift();
      trackActivity(s);
      trackDrift(s);
    }
    updateViewRange(s);
    updateWaterfallRange(s);
    if (pushHistory) updateTrace(frame);
    drawSpectrum(s, cfg);
    drawWaterfall(s);
    drawLevelHistory();
    drawDriftHistory();
  };

  const spectrumGeometry = (event: MouseEvent) => {
    const canvas = spectrumRef;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const left = 34;
    const right = 8;
    const top = 6;
    const bottom = 15;
    const plotW = Math.max(1, rect.width - left - right);
    const plotH = Math.max(1, rect.height - top - bottom);
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      left,
      top,
      plotW,
      plotH,
    };
  };

  const offsetAtX = (s: AnalysisStats, x: number, left: number, plotW: number): number => {
    const hz = s.winLowHz + ((x - left) / plotW) * s.spanHz;
    if (!snapMarkers()) return hz - store.tunedFrequency();
    const idx = clamp(Math.round((hz - s.winLowHz) / s.hzPerBin), 0, s.bins.length - 1);
    const radius = Math.max(2, Math.round(5 * (s.bins.length / plotW)));
    let best = idx;
    let bestDb = s.bins[idx];
    for (let i = Math.max(0, idx - radius); i <= Math.min(s.bins.length - 1, idx + radius); i++) {
      if (s.bins[i] > bestDb) {
        bestDb = s.bins[i];
        best = i;
      }
    }
    return s.winLowHz + (best + 0.5) * s.hzPerBin - store.tunedFrequency();
  };

  const onSpectrumDown = (event: MouseEvent) => {
    const s = stats();
    const geo = spectrumGeometry(event);
    if (!s || !geo) return;
    const tune = store.tunedFrequency();
    const ax = geo.left + ((tune + markerA() - s.winLowHz) / Math.max(1, s.spanHz)) * geo.plotW;
    const bx = geo.left + ((tune + markerB() - s.winLowHz) / Math.max(1, s.spanHz)) * geo.plotW;
    if (Math.abs(geo.x - ax) <= 6) dragging = 'a';
    else if (Math.abs(geo.x - bx) <= 6) dragging = 'b';
    else return;
    event.preventDefault();
  };

  const onSpectrumMove = (event: MouseEvent) => {
    const canvas = spectrumRef;
    const s = stats();
    const geo = spectrumGeometry(event);
    if (!canvas || !s || !geo) return;
    if (geo.x < geo.left || geo.x > geo.left + geo.plotW || geo.y < geo.top || geo.y > geo.top + geo.plotH) {
      if (cursor()) {
        setCursor(null);
        drawSpectrum(s, config());
      }
      return;
    }
    if (dragging) {
      const offset = offsetAtX(s, geo.x, geo.left, geo.plotW);
      if (dragging === 'a') setMarkerA(offset);
      else setMarkerB(offset);
      drawSpectrum(s, config());
      return;
    }
    const idx = clamp(Math.floor(((geo.x - geo.left) / geo.plotW) * s.bins.length), 0, s.bins.length - 1);
    setCursor({ hz: s.winLowHz + (idx + 0.5) * s.hzPerBin, db: s.bins[idx] });
    drawSpectrum(s, config());
  };

  const onSpectrumUp = () => { dragging = null; };

  const onSpectrumLeave = () => {
    dragging = null;
    setCursor(null);
    const s = stats();
    if (s) drawSpectrum(s, config());
  };

  const copyReport = () => {
    const s = stats();
    const lines = [
      `Signal Analysis — ${new Date().toISOString()}`,
      `Mode: ${store.mode().toUpperCase()}  Bandwidth: ${fmtSpan(store.bandwidth())}`,
      `Tune: ${fmtFreq(store.tunedFrequency())}  Center: ${fmtFreq(store.centerFrequency())}  Sample rate: ${fmtSpan(store.sampleRate())}`,
    ];
    if (s) {
      lines.push(
        `Window: ${fmtSpan(s.spanHz)} (${fmtFreq(s.winLowHz)} … ${fmtFreq(s.winHighHz)})`,
        `Level: ${store.signalLevel().toFixed(1)} dB  Peak: ${s.peakDb.toFixed(1)} dB @ ${fmtFreq(s.peakHz)}`,
        `Noise floor: ${s.noiseFloorDb.toFixed(1)} dB  SNR: ${s.snrDb.toFixed(1)} dB  Crest: ${s.crestDb.toFixed(1)} dB`,
        `−3 dB bandwidth: ${fmtSpan(s.bw3DbHz)}`,
        `Occupied bandwidth (99%): ${fmtSpan(s.occupiedBwHz)}`,
        `Measurement window: ${fmtSpan(s.measureBwHz)}  Channel power: ${fmtLevel(s.chanPowerDb)}  C/N: ${s.chanSnrDb.toFixed(1)} dB`,
        `Markers: A ${fmtOffset(markerA())} / ${fmtLevel(markerReadout()?.aDb ?? s.peakDb)}  B ${fmtOffset(markerB())} / ${fmtLevel(markerReadout()?.bDb ?? s.peakDb)}  Δf ${fmtOffset(markerB() - markerA())}  ΔdB ${(markerReadout()?.deltaDb ?? 0).toFixed(1)} dB`,
        `Carrier: ${fmtLevel(s.carrierDb)} @ ${fmtFreq(s.carrierHz)} (Δ ${fmtOffset(s.carrierOffsetHz)})  C/N ${s.carrierToNoiseDb.toFixed(1)} dB`,
        `AM depth (est.): ${s.amDepthPct.toFixed(1)}%  Sideband balance: ${s.sbBalancePct.toFixed(1)}%  USB ${s.usbPowerDb.toFixed(1)} dB  LSB ${s.lsbPowerDb.toFixed(1)} dB`,
        `Activity: ${activityPct().toFixed(1)}%  Peak drift: ${fmtOffset(driftHz())}`,
        `Master peak: ${s.fullPeakDb.toFixed(1)} dB @ ${fmtFreq(s.fullPeakHz)}`,
        `Master low: ${s.fullLowDb.toFixed(1)} dB @ ${fmtFreq(s.fullLowHz)}`,
        'Peaks:',
        ...s.peaks.map((p) => `  ${fmtFreq(p.hz)}  ${fmtOffset(p.offsetHz)}  ${p.db.toFixed(1)} dB`),
        'Lows:',
        ...s.lows.map((p) => `  ${fmtFreq(p.hz)}  ${fmtOffset(p.offsetHz)}  ${p.db.toFixed(1)} dB`),
      );
    }
    const write = navigator.clipboard?.writeText(lines.join('\n'));
    if (write) {
      write.then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  };

  const download = (name: string, href: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const exportCsv = () => {
    const s = stats();
    const rows: string[][] = [
      ['section', 'name', 'frequency_hz', 'offset_hz', 'level_db', 'extra'],
      ['meta', 'mode', '', '', '', store.mode().toUpperCase()],
      ['meta', 'tune_hz', String(Math.round(store.tunedFrequency())), '', '', ''],
      ['meta', 'span_hz', String(Math.round(spanHz())), '', '', ''],
    ];
    if (s) {
      rows.push(
        ['measurement', 'level', '', '', store.signalLevel().toFixed(2), ''],
        ['measurement', 'peak', String(Math.round(s.peakHz)), '', s.peakDb.toFixed(2), ''],
        ['measurement', 'noise_floor', '', '', s.noiseFloorDb.toFixed(2), ''],
        ['measurement', 'snr', '', '', s.snrDb.toFixed(2), ''],
        ['measurement', 'crest', '', '', s.crestDb.toFixed(2), ''],
        ['measurement', 'bw_3db_hz', '', '', '', s.bw3DbHz.toFixed(0)],
        ['measurement', 'occupied_bw_hz', '', '', '', s.occupiedBwHz.toFixed(0)],
        ['measurement', 'measure_bw_hz', '', '', '', s.measureBwHz.toFixed(0)],
        ['measurement', 'channel_power_db', '', '', s.chanPowerDb.toFixed(2), ''],
        ['measurement', 'channel_snr_db', '', '', s.chanSnrDb.toFixed(2), ''],
        ['measurement', 'carrier', String(Math.round(s.carrierHz)), s.carrierOffsetHz.toFixed(0), s.carrierDb.toFixed(2), ''],
        ['measurement', 'carrier_snr_db', '', '', s.carrierToNoiseDb.toFixed(2), ''],
        ['measurement', 'am_depth_pct', '', '', '', s.amDepthPct.toFixed(1)],
        ['measurement', 'sideband_balance_pct', '', '', '', s.sbBalancePct.toFixed(1)],
        ['measurement', 'activity_pct', '', '', '', activityPct().toFixed(1)],
        ['measurement', 'peak_drift_hz', '', driftHz().toFixed(1), '', ''],
        ['marker', 'A', String(Math.round(store.tunedFrequency() + markerA())), markerA().toFixed(0), (markerReadout()?.aDb ?? 0).toFixed(2), ''],
        ['marker', 'B', String(Math.round(store.tunedFrequency() + markerB())), markerB().toFixed(0), (markerReadout()?.bDb ?? 0).toFixed(2), ''],
      );
      for (const p of [...s.peaks, ...s.lows]) {
        rows.push(['peak', p.db > s.noiseFloorDb ? 'peak' : 'low', String(Math.round(p.hz)), p.offsetHz.toFixed(0), p.db.toFixed(2), '']);
      }
    }
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    download(`signal-analysis-${Date.now()}.csv`, url);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportPng = () => {
    const spectrum = spectrumRef;
    const waterfall = waterfallRef;
    if (!spectrum) return;
    const contentW = 1560;
    const sw = Math.max(1, spectrum.width);
    const sh = Math.max(1, spectrum.height);
    const ww = waterfall ? Math.max(1, waterfall.width) : 1;
    const wh = waterfall ? Math.max(1, waterfall.height) : 1;
    const specH = contentW * (sh / sw);
    const wfW = waterfall ? Math.round(contentW * 0.38) : 0;
    const wfH = waterfall ? Math.min(420, wfW * (wh / ww)) : 0;
    const headerH = 58;
    const outH = Math.round(headerH + specH + 20 + wfH + 20);
    const out = document.createElement('canvas');
    out.width = contentW + 40;
    out.height = outH;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.fillStyle = '#d7e3f4';
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillText(`Signal Analysis — ${fmtFreq(store.tunedFrequency())} — ${store.mode().toUpperCase()} — ${new Date().toISOString()}`, 20, 24);
    ctx.fillStyle = '#8a9ab0';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText(`Span ${fmtSpan(spanHz())} · BW ${fmtSpan(store.bandwidth())} · ${stats() ? `Peak ${fmtLevel(stats()!.peakDb)} · Noise ${fmtLevel(stats()!.noiseFloorDb)} · SNR ${stats()!.snrDb.toFixed(1)} dB` : ''}`, 20, 42);
    ctx.drawImage(spectrum, 20, headerH, contentW, specH);
    if (waterfall) {
      ctx.drawImage(waterfall, 20, headerH + specH + 20, wfW, wfH);
    }
    download(`signal-analysis-${Date.now()}.png`, out.toDataURL('image/png'));
  };

  const selectSpan = (mode: SpanMode) => {
    setSpanMode(mode);
    try {
      localStorage.setItem(`node-sdr:analysis.span.${store.activeProfileId() || store.mode()}`, mode);
    } catch { /* ignore */ }
  };

  const cycleTrace = () => {
    const modes: TraceMode[] = ['live', 'avg', 'min', 'max'];
    const next = modes[(modes.indexOf(traceMode()) + 1) % modes.length];
    setTraceMode(next);
    if (next === 'live') traceData = null;
  };

  const saveDbmOffset = (value: number) => {
    const v = clamp(value, -200, 200);
    setDbmOffset(v);
    try { localStorage.setItem('node-sdr:analysis.dbmOffset', String(v)); } catch { /* ignore */ }
  };

  const renderHistory = () => {
    if (!frozen()) return;
    if (history.length === 0) return;
    const offset = clamp(historyOffset(), 0, history.length - 1);
    const frame = history[history.length - 1 - offset];
    if (frame) renderFrame(frame, false);
  };

  onMount(() => {
    setMarkerA(-store.bandwidth() / 2);
    setMarkerB(store.bandwidth() / 2);

    const timer = window.setInterval(() => {
      if (frozen()) return;
      const frame = engine.getLatestFftFrame();
      if (!frame || frame === lastFrame) return;
      lastFrame = frame;
      const key = `${store.tunedFrequency()}|${store.centerFrequency()}|${store.sampleRate()}|${frame.length}`;
      if (lastKey && key !== lastKey) {
        history = [];
        levelHistory = [];
        traceData = null;
        driftHistory = [];
        driftReference = null;
        presenceHistory = [];
        lastPresence = false;
      }
      lastKey = key;
      renderFrame(frame, true);
    }, 100);

    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const key = event.key.toLowerCase();
      const byKey: Record<string, SpanMode> = { '1': 'bw', '2': '2x', '3': '5x', '4': '10x', '5': 'full' };
      if (byKey[key]) { selectSpan(byKey[key]); event.preventDefault(); return; }
      if (key === 'f') { setFrozen((v) => !v); event.preventDefault(); }
      else if (key === 'r') { resetAnalysis(); event.preventDefault(); }
      else if (key === 'c') { copyReport(); event.preventDefault(); }
      else if (key === 't') { cycleTrace(); event.preventDefault(); }
      else if (key === 'm') { setSnapMarkers((v) => !v); event.preventDefault(); }
    };
    const onMouseUp = () => { dragging = null; };

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('mouseup', onMouseUp);
    onCleanup(() => {
      clearInterval(timer);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mouseup', onMouseUp);
    });
  });

  // Restore the analysis span for the current mode/profile.
  createEffect(() => {
    const key = `${store.activeProfileId() || store.mode()}`;
    if (loadedSpanKey === key) return;
    loadedSpanKey = key;
    let saved: string | null = null;
    try { saved = localStorage.getItem(`node-sdr:analysis.span.${key}`); } catch { /* ignore */ }
    setSpanMode(saved && SPAN_MODES.some((m) => m.id === saved) ? (saved as SpanMode) : 'bw');
  });

  // Re-render the last frame when the operator changes the zoom, markers,
  // measurement window or display range without waiting for the next FFT.
  createEffect(() => {
    spanMode();
    traceMode();
    markerA();
    markerB();
    measureBw();
    dbmOffset();
    const isFrozen = frozen();
    historyOffset();
    store.tunedFrequency();
    store.centerFrequency();
    store.sampleRate();
    store.bandwidth();
    store.waterfallMin();
    store.waterfallMax();
    if (isFrozen && history.length > 0) renderHistory();
    else if (lastFrame) renderFrame(lastFrame, false);
  });

  return (
    <div class="relative flex flex-col h-full min-h-0 bg-sdr-surface/30 text-[9px] font-mono overflow-hidden">
      {/* Toolbar */}
      <div class="flex flex-col gap-1 px-2 py-1 border-b border-border/40 shrink-0">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-[8px] uppercase tracking-wider text-text-dim">Signal Analysis</span>
          <span class="text-[7px] text-text-muted uppercase ml-2">Span</span>
          <div class="flex items-center gap-1">
            <For each={SPAN_MODES}>
              {(mode) => (
                <button
                  onClick={() => selectSpan(mode.id)}
                  title={mode.title}
                  class={`mil-btn text-[8px] px-1.5 py-0.5 ${spanMode() === mode.id ? 'active border-cyan text-cyan' : ''}`}
                >
                  {mode.label}
                </button>
              )}
            </For>
          </div>
          <span class="text-[7px] text-text-muted uppercase ml-2">Trace</span>
          <div class="flex items-center gap-1">
            <For each={TRACE_MODES}>
              {(mode) => (
                <button
                  onClick={() => { setTraceMode(mode.id); if (mode.id === 'live') traceData = null; }}
                  title={mode.title}
                  class={`mil-btn text-[8px] px-1.5 py-0.5 ${traceMode() === mode.id ? 'active border-amber text-amber' : ''}`}
                >
                  {mode.label}
                </button>
              )}
            </For>
          </div>
          <div class="ml-auto flex items-center gap-1">
            <button
              onClick={() => setFrozen(v => !v)}
              class={`mil-btn text-[8px] px-1.5 py-0.5 ${frozen() ? 'active border-amber text-amber' : ''}`}
              title="Freeze the analysis workspace (F)"
            >
              {frozen() ? 'Frozen' : 'Freeze'}
            </button>
            <button onClick={resetAnalysis} class="mil-btn text-[8px] px-1.5 py-0.5" title="Clear history and held traces (R)">
              Reset
            </button>
            <button onClick={copyReport} class="mil-btn text-[8px] px-1.5 py-0.5" title="Copy a plain-text measurement report (C)">
              {copied() ? 'Copied' : 'Copy'}
            </button>
            <button onClick={exportCsv} class="mil-btn text-[8px] px-1.5 py-0.5" title="Export measurements and peaks as CSV">
              CSV
            </button>
            <button onClick={exportPng} class="mil-btn text-[8px] px-1.5 py-0.5" title="Export spectrum and waterfall as PNG">
              PNG
            </button>
            <button onClick={() => setShowLog(v => !v)} class={`mil-btn text-[8px] px-1.5 py-0.5 ${showLog() ? 'active' : ''}`} title="Show signal event log">
              Log
            </button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-1.5">
          <label class="flex items-center gap-1 text-[7px] uppercase text-text-muted">
            Meas
            <select
              value={String(measureBw())}
              onChange={(e) => setMeasureBw(Number(e.currentTarget.value))}
              class="bg-sdr-base border border-border/50 rounded-sm text-[8px] font-mono text-text-secondary px-1 py-0.5"
              title="Measurement bandwidth independent of the demod filter"
            >
              <option value="0">Filter</option>
              <For each={MEASURE_BW_OPTIONS.filter(v => v > 0)}>
                {(bw) => <option value={String(bw)}>{fmtSpan(bw)}</option>}
              </For>
            </select>
          </label>
          <Show when={markerReadout()}>
            <span class="text-[8px] text-text-dim tabular-nums">
              A <span class="text-cyan">{fmtOffset(markerA())}</span> / {fmtLevel(markerReadout()!.aDb)}
              <span class="mx-1">·</span>
              B <span class="text-amber">{fmtOffset(markerB())}</span> / {fmtLevel(markerReadout()!.bDb)}
              <span class="mx-1">·</span>
              Δf <span class="text-text-secondary">{fmtSpan(Math.abs(markerReadout()!.deltaHz))}</span>
              <span class="mx-1">·</span>
              ΔdB <span class="text-text-secondary">{markerReadout()!.deltaDb.toFixed(1)} dB</span>
            </span>
          </Show>
          <button
            onClick={() => setSnapMarkers(v => !v)}
            class={`mil-btn text-[8px] px-1.5 py-0.5 ${snapMarkers() ? 'active border-cyan text-cyan' : ''}`}
            title="Snap marker drags to nearby peaks (M)"
          >
            Snap
          </button>
          <label class="flex items-center gap-1 text-[7px] uppercase text-text-muted ml-auto">
            dBm cal
            <input
              type="number"
              step="1"
              value={dbmOffset()}
              onInput={(e) => saveDbmOffset(Number(e.currentTarget.value) || 0)}
              class="w-14 bg-sdr-base border border-border/50 rounded-sm text-[8px] font-mono text-text-secondary px-1 py-0.5"
              title="Calibration offset in dB: 0 displays dB, non-zero displays dBm"
            />
          </label>
          <label class="flex items-center gap-1 text-[7px] uppercase text-text-muted">
            Hist
            <input
              type="range"
              min="0"
              max={Math.max(0, historyCount() - 1)}
              step="1"
              value={historyOffset()}
              disabled={!frozen()}
              onInput={(e) => setHistoryOffset(Number(e.currentTarget.value))}
              class="w-24 sdr-range disabled:opacity-40"
              title="Scrub back through recent FFT history while frozen"
            />
            <span class="text-[7px] text-text-dim tabular-nums w-8">
              {frozen() ? `${historyOffset()}f` : 'live'}
            </span>
          </label>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        {/* Spectrum + measurements */}
        <div class="flex-1 min-w-0 min-h-0 flex flex-col">
          <div class="relative flex-1 min-h-[90px]">
            <canvas
              ref={spectrumRef}
              class="absolute inset-0 w-full h-full cursor-crosshair"
              onMouseDown={onSpectrumDown}
              onMouseMove={onSpectrumMove}
              onMouseUp={onSpectrumUp}
              onMouseLeave={onSpectrumLeave}
            />
            <Show when={cursor()}>
              <div class="absolute top-1 right-1 px-1.5 py-0.5 rounded-sm bg-black/70 border border-border/50 text-[8px] text-text-secondary pointer-events-none">
                {fmtFreq(cursor()!.hz)} · {cursor()!.db.toFixed(1)} dB
              </div>
            </Show>
            <Show when={frozen()}>
              <div class="absolute top-1 left-1 px-1.5 py-0.5 rounded-sm bg-amber/15 border border-amber/40 text-[8px] text-amber uppercase tracking-wider pointer-events-none">
                Frozen
              </div>
            </Show>
          </div>

          {/* Instantaneous measurements */}
          <div class="grid grid-cols-4 xl:grid-cols-6 gap-px bg-border/40 border-t border-border/40 shrink-0">
            <Stat label="Level" value={fmtLevel(store.signalLevel())} title="S-meter level in the current passband" />
            <Stat label="Peak" value={stats() ? fmtLevel(stats()!.peakDb) : '—'} title="Strongest bin in the analysis window" />
            <Stat label="Noise" value={stats() ? fmtLevel(stats()!.noiseFloorDb) : '—'} title="Median bin level in the analysis window" />
            <Stat label="SNR" value={stats() ? `${stats()!.snrDb.toFixed(1)} dB` : '—'} title="Peak minus noise floor" tone="text-cyan" />
            <Stat label="Crest" value={stats() ? `${stats()!.crestDb.toFixed(1)} dB` : '—'} title="Peak minus mean level" />
            <Stat label="−3 dB BW" value={stats() ? fmtSpan(stats()!.bw3DbHz) : '—'} title="Bandwidth around the strongest peak at 3 dB down" />
            <Stat label="Occ BW 99%" value={stats() ? fmtSpan(stats()!.occupiedBwHz) : '—'} title="Bandwidth containing 99% of the power in the analysis window" />
            <Stat label="Activity" value={`${activityPct().toFixed(0)}%`} sub="last 200 frames" title="Percentage of recent frames above noise floor + 6 dB" tone="text-cyan" />
            <Stat
              label="Ch Pwr"
              value={stats() ? fmtLevel(stats()!.chanPowerDb) : '—'}
              sub={stats() ? fmtSpan(stats()!.measureBwHz) : undefined}
              title="Total power in the measurement window"
            />
            <Stat label="C/N" value={stats() ? `${stats()!.chanSnrDb.toFixed(1)} dB` : '—'} title="Channel power minus noise power in the measurement window" tone="text-cyan" />
            <Stat
              label="Master Peak"
              value={stats() ? fmtFreqCompact(stats()!.fullPeakHz) : '—'}
              sub={stats() ? `${fmtLevel(stats()!.fullPeakDb)} · ${fmtOffset(stats()!.fullPeakHz - store.tunedFrequency())}` : undefined}
              title="Strongest bin across the full sampled bandwidth"
              tone="text-amber"
            />
            <Stat
              label="Master Low"
              value={stats() ? fmtFreqCompact(stats()!.fullLowHz) : '—'}
              sub={stats() ? `${fmtLevel(stats()!.fullLowDb)} · ${fmtOffset(stats()!.fullLowHz - store.tunedFrequency())}` : undefined}
              title="Weakest bin across the full sampled bandwidth (edge bins skipped)"
              tone="text-amber"
            />
          </div>

          {/* Mode-specific analysis */}
          <Show when={store.mode() === 'am' || store.mode() === 'sam' || store.mode() === 'am-stereo'}>
            <div class="grid grid-cols-5 gap-px bg-border/40 border-t border-border/40 shrink-0">
              <Stat label="Carrier" value={stats() ? fmtFreqCompact(stats()!.carrierHz) : '—'} sub={stats() ? fmtLevel(stats()!.carrierDb) : undefined} title="Strongest carrier near the tuned frequency" tone="text-amber" />
              <Stat label="Carrier Δ" value={stats() ? fmtOffset(stats()!.carrierOffsetHz) : '—'} title="Carrier offset from the tuned frequency" />
              <Stat label="AM Depth" value={stats() ? `${stats()!.amDepthPct.toFixed(0)}%` : '—'} title="Estimated AM modulation depth from sideband/carrier power" tone="text-cyan" />
              <Stat label="SB Balance" value={stats() ? `${stats()!.sbBalancePct.toFixed(0)}%` : '—'} title="Upper/lower sideband balance (100% = symmetric)" />
              <Stat
                label={store.mode() === 'sam' ? 'Sync Lock' : 'Mode'}
                value={store.mode() === 'sam'
                  ? (syncLock() >= 0 ? `${(syncLock() * 100).toFixed(0)}%` : 'n/a')
                  : store.mode().toUpperCase()}
                title="Synchronous AM PLL lock confidence"
                tone={store.mode() === 'sam' && syncLock() >= 0.6 ? 'text-cyan' : undefined}
              />
            </div>
          </Show>

          <Show when={store.mode() === 'wfm' || store.mode() === 'am-stereo'}>
            <div class="grid grid-cols-4 gap-px bg-border/40 border-t border-border/40 shrink-0">
              <Stat label="Stereo Blend" value={stereoBlend() >= 0 ? `${(stereoBlend() * 100).toFixed(0)}%` : 'n/a'} title="Pilot-derived stereo blend" tone="text-cyan" />
              <Stat label="Carrier" value={stats() ? fmtFreqCompact(stats()!.carrierHz) : '—'} sub={stats() ? fmtLevel(stats()!.carrierDb) : undefined} title="Strongest carrier near the tuned frequency" />
              <Stat label="Activity" value={`${activityPct().toFixed(0)}%`} sub="last 200 frames" title="Percentage of recent frames above noise floor + 6 dB" />
              <Stat label="Occ BW 99%" value={stats() ? fmtSpan(stats()!.occupiedBwHz) : '—'} title="Occupied bandwidth estimate" />
            </div>
          </Show>

          <Show when={store.mode() === 'usb' || store.mode() === 'lsb' || store.mode() === 'cw'}>
            <div class="grid grid-cols-4 gap-px bg-border/40 border-t border-border/40 shrink-0">
              <Stat
                label="Opp SB"
                value={stats()
                  ? `${(store.mode() === 'lsb'
                    ? stats()!.lsbPowerDb - stats()!.usbPowerDb
                    : stats()!.usbPowerDb - stats()!.lsbPowerDb).toFixed(1)} dB`
                  : '—'}
                title="Wanted minus opposite sideband power (spectral estimate)"
                tone="text-cyan"
              />
              <Stat label="USB" value={stats() ? fmtLevel(stats()!.usbPowerDb) : '—'} title="Upper sideband power in the filter" />
              <Stat label="LSB" value={stats() ? fmtLevel(stats()!.lsbPowerDb) : '—'} title="Lower sideband power in the filter" />
              <Stat label="Occ BW 99%" value={stats() ? fmtSpan(stats()!.occupiedBwHz) : '—'} title="Occupied bandwidth estimate" />
            </div>
          </Show>

          {/* Local peaks and lows */}
          <div class="grid grid-cols-2 gap-px bg-border/40 border-t border-border/40 shrink-0 h-[78px] overflow-hidden">
            <MarkerList
              title="Peaks in window"
              items={stats()?.peaks ?? []}
              tone="text-cyan"
              onTune={(hz) => engine.tune(hz - store.centerFrequency())}
              onBookmark={(hz) => {
                engine.tune(hz - store.centerFrequency());
                engine.addBookmark(`${fmtFreqCompact(hz)} peak`);
              }}
            />
            <MarkerList
              title="Lows in window"
              items={stats()?.lows ?? []}
              tone="text-amber"
              onTune={(hz) => engine.tune(hz - store.centerFrequency())}
              onBookmark={(hz) => {
                engine.tune(hz - store.centerFrequency());
                engine.addBookmark(`${fmtFreqCompact(hz)} notch`);
              }}
            />
          </div>
        </div>

        {/* Zoomed mini waterfall + level history */}
        <div class="w-full lg:w-[34%] lg:max-w-[320px] min-w-[190px] flex flex-col min-h-0 border-t lg:border-t-0 lg:border-l border-border/40">
          <div class="flex items-center justify-between px-2 py-0.5 border-b border-border/30 shrink-0">
            <span class="text-[7px] uppercase tracking-wider text-text-dim">Zoomed Waterfall</span>
            <span class="text-[7px] text-text-dim">{stats() ? fmtSpan(stats()!.spanHz) : '—'}</span>
          </div>
          <canvas ref={waterfallRef} class="flex-1 min-h-[80px] w-full" />
          <div class="flex items-center justify-between px-2 py-0.5 border-y border-border/30 shrink-0">
            <span class="text-[7px] uppercase tracking-wider text-text-dim">Level History</span>
            <span class="text-[7px] text-cyan">PEAK</span>
            <span class="text-[7px] text-amber">FLOOR</span>
          </div>
          <canvas ref={levelRef} class="h-10 w-full shrink-0" />
          <div class="flex items-center justify-between px-2 py-0.5 border-y border-border/30 shrink-0">
            <span class="text-[7px] uppercase tracking-wider text-text-dim">Peak Drift</span>
            <span class={`text-[7px] tabular-nums ${Math.abs(driftHz()) > 0.5 ? 'text-amber' : 'text-text-dim'}`}>
              {fmtOffset(driftHz())}
            </span>
          </div>
          <canvas ref={driftRef} class="h-8 w-full shrink-0" />
        </div>
      </div>

      {/* Event log overlay */}
      <Show when={showLog()}>
        <div class="absolute right-1 top-12 bottom-1 w-[340px] max-w-[90%] z-20 flex flex-col rounded-sm border border-border bg-sdr-surface/95 shadow-xl">
          <div class="flex items-center justify-between px-2 py-1 border-b border-border/50">
            <span class="text-[8px] uppercase tracking-wider text-text-dim">Signal Events</span>
            <button onClick={() => setShowLog(false)} class="text-[9px] text-text-dim hover:text-amber px-1">✕</button>
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto">
            <For each={events()} fallback={<div class="px-2 py-2 text-[8px] text-text-dim">No events yet</div>}>
              {(event) => (
                <div class="flex items-center gap-2 px-2 py-[2px] text-[8px] border-b border-border/10">
                  <span class="text-text-muted tabular-nums">
                    {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span class={event.kind === 'up' ? 'text-cyan' : event.kind === 'down' ? 'text-amber' : 'text-text-secondary'}>
                    {event.text}
                  </span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
};

const Stat: Component<{ label: string; value: string; sub?: string; title?: string; tone?: string }> = (props) => (
  <div class="bg-sdr-surface/70 px-1.5 py-0.5 min-w-0" title={props.title}>
    <div class="text-[7px] uppercase tracking-wider text-text-dim truncate">{props.label}</div>
    <div class={`text-[9px] leading-tight whitespace-nowrap ${props.tone ?? 'text-text-primary'}`}>{props.value}</div>
    <Show when={props.sub}>
      <div class="text-[7px] leading-tight text-text-dim truncate">{props.sub}</div>
    </Show>
  </div>
);

const MarkerList: Component<{
  title: string;
  items: Marker[];
  tone: string;
  onTune?: (hz: number) => void;
  onBookmark?: (hz: number) => void;
}> = (props) => (
  <div class="bg-sdr-surface/60 min-w-0 h-full overflow-y-auto">
    <div class="px-2 py-0.5 text-[7px] uppercase tracking-wider text-text-dim border-b border-border/20">{props.title}</div>
    <For each={props.items} fallback={<div class="px-2 py-1 text-[8px] text-text-dim">No markers</div>}>
      {(item) => (
        <div class="flex items-center gap-1 px-2 py-[1px] text-[8px] border-b border-border/10 last:border-0">
          <button
            onClick={() => props.onTune?.(item.hz)}
            class="flex-1 min-w-0 flex items-center justify-between gap-2 hover:text-cyan text-left"
            title="Tune to this frequency"
          >
            <span class="text-text-secondary tabular-nums">{fmtFreqCompact(item.hz)}</span>
            <span class="text-text-dim tabular-nums">{fmtOffset(item.offsetHz)}</span>
          </button>
          <span class={`tabular-nums ${props.tone}`}>{item.db.toFixed(1)} dB</span>
          <button
            onClick={() => props.onBookmark?.(item.hz)}
            class="text-text-dim hover:text-amber px-0.5"
            title="Add this frequency as a bookmark"
          >
            +
          </button>
        </div>
      )}
    </For>
  </div>
);

export default SignalAnalysis;
