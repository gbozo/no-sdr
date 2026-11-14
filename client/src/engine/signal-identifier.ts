// ============================================================
// node-sdr — client-side signal identification
// ============================================================
// Heuristic classifier for the currently tuned signal. It uses the live
// full-span FFT frames plus a short raw-IQ capture, then ranks the decoder
// modes that could plausibly receive the signal. This is deliberately
// client-side: no extra decoder workers or server load.
//
// ADS-B, VDL2 and AIS are excluded (wideband/high-rate streams that need
// domain-specific demodulation). Packet/AX.25 is included as a bursty
// narrowband candidate.

import {
  DECODER_INFO,
  DECODER_MODE_IDS,
  DIGITAL_MODES,
  type DemodMode,
  type DigitalMode,
} from '~/shared';

export interface IdentifierConfig {
  sampleRate: number;
  centerHz: number;
  tuneHz: number;
  mode: string;
  iqRate: number;
}

export interface IdentifierFeatures {
  presentProbability: number;
  snrDb: number;
  peakDb: number;
  noiseDb: number;
  occupiedBwHz: number;
  activity: number;
  burstiness: number;
  symmetry: number;
  flatness: number;
  peakHz: number;
  analyzerSpanHz: number;
  frames: number;
  iqDuty: number;
  iqBurstiness: number;
}

export interface IdentifierCandidate {
  id: DigitalMode;
  name: string;
  shortName: string;
  score: number;
  reasons: string[];
}

export interface IdentifierResult {
  features: IdentifierFeatures;
  candidates: IdentifierCandidate[];
  excluded: string[];
}

const EXCLUDED = new Set(['adsb', 'vdl2', 'ais']);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function fmtFreq(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(4)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function fmtSpan(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(2)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function fmtOffset(hz: number): string {
  const a = Math.abs(hz);
  const sign = hz >= 0 ? '+' : '−';
  return a >= 1e3 ? `${sign}${(a / 1e3).toFixed(2)} kHz` : `${sign}${a.toFixed(0)} Hz`;
}

interface FrameStats {
  peakDb: number;
  noiseDb: number;
  meanDb: number;
  occupiedBwHz: number;
  symmetry: number;
  flatness: number;
  peakHz: number;
  active: boolean;
  peakCount: number;
}

function frameStats(
  frame: Float32Array,
  sampleRate: number,
  centerHz: number,
  tuneHz: number,
  spanHz: number,
): FrameStats | null {
  const frameLen = frame.length;
  if (frameLen === 0 || sampleRate <= 0) return null;
  const hzPerBin = sampleRate / frameLen;
  const frameLow = centerHz - sampleRate / 2;
  const wantedLow = tuneHz - spanHz / 2;
  const wantedHigh = tuneHz + spanHz / 2;
  const start = clamp(Math.floor((wantedLow - frameLow) / hzPerBin), 0, frameLen - 1);
  const end = clamp(Math.ceil((wantedHigh - frameLow) / hzPerBin), start + 1, frameLen);
  const n = end - start;
  if (n < 2) return null;

  let peakDb = -Infinity;
  let peakIdx = 0;
  let sum = 0;
  let finite = 0;
  for (let i = 0; i < n; i++) {
    const v = frame[start + i];
    if (!Number.isFinite(v)) continue;
    sum += v;
    finite++;
    if (v > peakDb) { peakDb = v; peakIdx = i; }
  }
  if (finite === 0) return null;

  const noiseSamples: number[] = [];
  const stride = Math.max(1, Math.floor(n / 512));
  for (let i = 0; i < n; i += stride) {
    const v = frame[start + i];
    if (Number.isFinite(v)) noiseSamples.push(v);
  }
  const noiseDb = median(noiseSamples);
  const meanDb = sum / finite;

  // 99 % occupied bandwidth and spectral flatness in the analysis window.
  let total = 0;
  let logPower = 0;
  for (let i = 0; i < n; i++) {
    const v = frame[start + i];
    if (!Number.isFinite(v)) continue;
    const p = Math.pow(10, v / 10);
    total += p;
    logPower += Math.log(p + 1e-30);
  }
  let accum = 0;
  let occLow = 0;
  let occHigh = n - 1;
  for (let i = 0; i < n; i++) {
    const v = frame[start + i];
    if (!Number.isFinite(v)) continue;
    accum += Math.pow(10, v / 10);
    if (accum >= total * 0.005) { occLow = i; break; }
  }
  accum = 0;
  for (let i = 0; i < n; i++) {
    const v = frame[start + i];
    if (!Number.isFinite(v)) continue;
    accum += Math.pow(10, v / 10);
    if (accum >= total * 0.995) { occHigh = i; break; }
  }
  const occupiedBwHz = Math.max(hzPerBin, (occHigh - occLow + 1) * hzPerBin);
  const arith = total / Math.max(1, finite);
  const geo = Math.exp(logPower / Math.max(1, finite));
  const flatness = clamp(geo / (arith + 1e-30), 0, 1);

  // Symmetry about the tuned frequency.
  const tuneIdx = clamp(Math.round((tuneHz - frameLow) / hzPerBin) - start, 0, n - 1);
  let upper = 0;
  let lower = 0;
  const pairs = Math.min(tuneIdx, n - 1 - tuneIdx, 256);
  for (let i = 1; i <= pairs; i++) {
    upper += Math.pow(10, frame[start + tuneIdx + i] / 10);
    lower += Math.pow(10, frame[start + tuneIdx - i] / 10);
  }
  const symmetry = upper + lower > 0 ? 1 - Math.abs(upper - lower) / (upper + lower) : 0;

  let peakCount = 0;
  for (let i = 1; i < n - 1; i++) {
    const v = frame[start + i];
    if (v > noiseDb + 6 && v >= frame[start + i - 1] && v > frame[start + i + 1]) peakCount++;
  }

  return {
    peakDb,
    noiseDb,
    meanDb,
    occupiedBwHz,
    symmetry,
    flatness,
    peakHz: frameLow + (start + peakIdx + 0.5) * hzPerBin,
    active: peakDb > noiseDb + 6,
    peakCount,
  };
}

function iqStats(chunks: Int16Array[]): { duty: number; burstiness: number } {
  const levels: number[] = [];
  for (const chunk of chunks) {
    if (chunk.length < 2) continue;
    let sum = 0;
    const n = chunk.length >> 1;
    for (let i = 0; i < n; i++) {
      const i0 = chunk[i * 2] / 32768;
      const q0 = chunk[i * 2 + 1] / 32768;
      sum += i0 * i0 + q0 * q0;
    }
    levels.push(Math.sqrt(sum / Math.max(1, n)));
  }
  if (levels.length === 0) return { duty: 0, burstiness: 0 };
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const variance = levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length;
  const std = Math.sqrt(variance);
  const duty = levels.filter((v) => v > mean * 1.25).length / levels.length;
  return { duty, burstiness: clamp(std / (mean + 1e-9), 0, 3) };
}

function shapeScore(preview: string, f: IdentifierFeatures, decoderBw: number): number {
  const narrow = f.occupiedBwHz <= Math.max(4_000, decoderBw * 2);
  const veryNarrow = f.occupiedBwHz <= Math.max(2_000, decoderBw * 1.5);
  const activity = clamp(f.activity, 0, 1);
  switch (preview) {
    case 'mfsk':
      return 0.65 * (narrow ? 1 : 0.2) + 0.35 * clamp(activity * 1.4, 0, 1);
    case 'narrow':
      return 0.75 * (veryNarrow ? 1 : 0.2) + 0.25 * activity;
    case 'rtty':
      return 0.7 * (narrow ? 1 : 0.2) + 0.3 * activity;
    case 'burst':
      return 0.65 * (1 - activity) + 0.35 * (narrow ? 1 : 0.3);
    case 'wide':
      return 0.55 * activity + 0.45 * (f.occupiedBwHz > 1_000 && f.occupiedBwHz < 8_000 ? 1 : 0.3);
    case 'pulse':
      return 0.75 * (1 - activity) + 0.25 * (narrow ? 1 : 0.3);
    case 'time':
      return 0.8 * (veryNarrow ? 1 : 0.2) + 0.2 * (1 - activity);
    case 'fax':
      return 0.6 * activity + 0.4 * (f.occupiedBwHz > 1_000 && f.occupiedBwHz < 5_000 ? 1 : 0.3);
    default:
      return 0.5;
  }
}

export function identifySignal(
  frames: Float32Array[],
  iqChunks: Int16Array[],
  cfg: IdentifierConfig,
): IdentifierResult {
  const spanHz = Math.min(cfg.sampleRate || 300_000, 300_000);
  const stats: FrameStats[] = [];
  for (const frame of frames) {
    const s = frameStats(frame, cfg.sampleRate, cfg.centerHz, cfg.tuneHz, spanHz);
    if (s) stats.push(s);
  }

  if (stats.length === 0) {
    return {
      features: {
        presentProbability: 0, snrDb: 0, peakDb: -120, noiseDb: -120,
        occupiedBwHz: 0, activity: 0, burstiness: 0, symmetry: 0, flatness: 0,
        peakHz: cfg.tuneHz, analyzerSpanHz: spanHz, frames: 0, iqDuty: 0, iqBurstiness: 0,
      },
      candidates: [],
      excluded: [...EXCLUDED],
    };
  }

  const peaks = stats.map((s) => s.peakDb);
  const peakDb = median(peaks);
  const noiseDb = median(stats.map((s) => s.noiseDb));
  const occupiedBwHz = median(stats.map((s) => s.occupiedBwHz));
  const symmetry = median(stats.map((s) => s.symmetry));
  const flatness = median(stats.map((s) => s.flatness));
  const active = stats.filter((s) => s.active).length / stats.length;
  const meanPeak = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  const peakStd = Math.sqrt(peaks.reduce((a, b) => a + (b - meanPeak) ** 2, 0) / peaks.length);
  const iq = iqStats(iqChunks);
  const snrDb = peakDb - noiseDb;
  const presentProbability = clamp((snrDb - 4) / 20, 0, 1);
  const peakHz = median(stats.map((s) => s.peakHz));

  const features: IdentifierFeatures = {
    presentProbability,
    snrDb,
    peakDb,
    noiseDb,
    occupiedBwHz,
    activity: active,
    burstiness: clamp(Math.max(peakStd / (Math.abs(meanPeak) + 1e-9), iq.burstiness), 0, 3),
    symmetry,
    flatness,
    peakHz,
    analyzerSpanHz: spanHz,
    frames: stats.length,
    iqDuty: iq.duty,
    iqBurstiness: iq.burstiness,
  };

  const candidates: IdentifierCandidate[] = [];
  for (const id of DECODER_MODE_IDS) {
    if (EXCLUDED.has(id)) continue;
    const base = DIGITAL_MODES[id];
    const extra = DECODER_INFO[id];
    if (!base || !extra) continue;

    let nearest = extra.frequencies[0];
    let nearestDist = Infinity;
    for (const f of extra.frequencies) {
      const d = Math.abs(f.hz - cfg.tuneHz);
      if (d < nearestDist) { nearestDist = d; nearest = f; }
    }

    const tolerance = Math.max(2_500, base.bandwidth * 3);
    const freqScore = Math.exp(-0.5 * (nearestDist / tolerance) ** 2);
    const bwRatio = occupiedBwHz / Math.max(200, base.bandwidth);
    const bwScore = Math.exp(-0.5 * (Math.log2(Math.max(1e-3, bwRatio)) / 0.9) ** 2);
    const shape = shapeScore(extra.preview, features, base.bandwidth);
    let score = presentProbability * (0.47 * freqScore + 0.31 * bwScore + 0.22 * shape);

    // A mode that fits the current demodulator is a little more likely.
    if (base.baseDemod && base.baseDemod === (cfg.mode as DemodMode)) score += 0.03;
    if (id === 'packet' && (cfg.mode === 'nfm' || cfg.mode === 'raw')) score += 0.02;
    score = clamp(score, 0, 1);
    if (score < 0.035) continue;

    const reasons: string[] = [];
    reasons.push(
      nearestDist < tolerance * 2
        ? `near ${nearest.label} ${fmtFreq(nearest.hz)} (${fmtOffset(nearestDist)})`
        : `off published channels (${fmtFreq(nearest.hz)})`,
    );
    reasons.push(`spectrum ${fmtSpan(occupiedBwHz)} vs ${fmtSpan(base.bandwidth)}`);
    if (extra.preview === 'burst' || extra.preview === 'pulse') {
      reasons.push(active < 0.7 ? 'bursty / intermittent' : 'continuous activity');
    } else if (extra.preview === 'narrow' || extra.preview === 'rtty') {
      reasons.push(active > 0.3 ? 'narrow continuous carrier' : 'sparse narrow carrier');
    } else {
      reasons.push(active > 0.5 ? 'continuous / slotted data' : 'intermittent data');
    }

    candidates.push({
      id,
      name: base.name,
      shortName: base.shortName,
      score,
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  candidates.splice(6);

  return { features, candidates, excluded: [...EXCLUDED] };
}
