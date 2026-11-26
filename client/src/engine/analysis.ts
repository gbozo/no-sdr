// ============================================================
// node-sdr — shared spectrum analysis + modulation quality
// ============================================================
// Pure math extracted from the Signal Analysis workspace so the main
// waterfall/control panel can compute the same modulation-quality reading
// without mounting the analysis view.

export interface Marker {
  hz: number;
  offsetHz: number;
  db: number;
}

export interface AnalysisStats {
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
  /** Strongest bin within ±100 Hz of the dial — the suppressed carrier for SSB. */
  tuneCarrierDb: number;
  usbPowerDb: number;
  lsbPowerDb: number;
  sbBalancePct: number;
  amDepthPct: number;
}

export interface AnalysisConfig {
  sampleRate: number;
  centerHz: number;
  tuneHz: number;
  bandwidth: number;
  measureBwHz: number;
}

/** Absolute-Hz coverage of a secondary-FFT frame. */
export interface FrameCoverage {
  lowHz: number;
  spanHz: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 10);
}

export function linearToDb(power: number): number {
  return 10 * Math.log10(Math.max(power, 1e-30));
}

function sumLinearPower(frame: Float32Array, start: number, end: number): number {
  let power = 0;
  for (let i = Math.max(0, start); i < Math.min(frame.length, end); i++) {
    if (Number.isFinite(frame[i])) power += dbToLinear(frame[i]);
  }
  return power;
}

export function analyse(
  frame: Float32Array,
  cfg: AnalysisConfig,
  spanHz: number,
  coverage?: FrameCoverage | null,
): AnalysisStats | null {
  const frameLen = frame.length;
  if (frameLen === 0) return null;
  if (!coverage && cfg.sampleRate <= 0) return null;

  const hzPerBin = coverage && coverage.spanHz > 0
    ? coverage.spanHz / frameLen
    : cfg.sampleRate / frameLen;
  const frameLow = coverage
    ? coverage.lowHz
    : cfg.centerHz - cfg.sampleRate / 2;
  // A secondary frame defines the exact demodulator passband (one-sided for
  // USB/LSB). Without one, fall back to a symmetric window around the tune.
  const wantedLow = coverage ? coverage.lowHz : cfg.tuneHz - spanHz / 2;
  const wantedHigh = coverage
    ? coverage.lowHz + coverage.spanHz
    : cfg.tuneHz + spanHz / 2;
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

  // Power at the dial itself (within ±100 Hz). For SSB this is the suppressed
  // carrier; for AM it is the carrier. Used by the modulation-quality meter.
  const tuneBin = clamp(Math.round((cfg.tuneHz - frameLow) / hzPerBin), 0, frameLen - 1);
  const tuneHalf = Math.max(1, Math.round(100 / hzPerBin));
  let tuneCarrierDb = -Infinity;
  for (let i = Math.max(0, tuneBin - tuneHalf); i <= Math.min(frameLen - 1, tuneBin + tuneHalf); i++) {
    if (Number.isFinite(frame[i]) && frame[i] > tuneCarrierDb) tuneCarrierDb = frame[i];
  }

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
    tuneCarrierDb,
    usbPowerDb,
    lsbPowerDb,
    sbBalancePct,
    amDepthPct,
  };
}

// ---------------------------------------------------------------------------
// Modulation-quality meter
//
// A single number hams can compare, derived entirely from the received
// spectrum. It is deliberately conservative: it scores things a receiver can
// actually see (depth, splatter, carrier/sideband purity, SNR), not claims
// about the transmitter's audio that a one-way SDR cannot verify.
// ---------------------------------------------------------------------------

export interface ModQuality {
  score: number;
  grade: string;
  kind: 'am' | 'ssb';
  snrDb: number;
  splatterDb: number;
  splatterScore: number;
  // AM
  depthPct?: number;
  depthScore?: number;
  symmetryPct?: number;
  symmetryScore?: number;
  // SSB
  oppSbDb?: number;
  oppSbScore?: number;
  carrierSuppDb?: number;
  carrierSuppScore?: number;
  bwHz?: number;
  bwScore?: number;
  // Common (AM carrier C/N, SSB suppressed-carrier)
  carrierScore: number;
}

export function modGrade(score: number): string {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

/** Linear power and bin count in an absolute-Hz band of a windowed frame. */
function bandPower(s: AnalysisStats, lowHz: number, highHz: number): { power: number; bins: number } {
  const n = s.bins.length;
  const i0 = clamp(Math.floor((lowHz - s.winLowHz) / s.hzPerBin), 0, n);
  const i1 = clamp(Math.ceil((highHz - s.winLowHz) / s.hzPerBin), i0, n);
  return { power: sumLinearPower(s.bins, i0, i1), bins: Math.max(0, i1 - i0) };
}

/**
 * Excess power outside an in-band region, above the measured noise floor.
 * Only power inside the supplied outer guard band is counted, so adjacent
 * stations (e.g. the next MW channel 10 kHz away) do not masquerade as
 * splatter. This is the "splatter" estimate: a clean signal leaves the
 * out-of-band window at the noise floor (0 dB excess).
 */
function outOfBandExcessDb(
  s: AnalysisStats,
  inLowHz: number,
  inHighHz: number,
  outerLowHz: number,
  outerHighHz: number,
  noiseFloorDb: number,
): number {
  const n = s.bins.length;
  const o0 = clamp(Math.floor((outerLowHz - s.winLowHz) / s.hzPerBin), 0, n);
  const o1 = clamp(Math.ceil((outerHighHz - s.winLowHz) / s.hzPerBin), o0, n);
  const i0 = clamp(Math.floor((inLowHz - s.winLowHz) / s.hzPerBin), o0, o1);
  const i1 = clamp(Math.ceil((inHighHz - s.winLowHz) / s.hzPerBin), i0, o1);
  const outer = sumLinearPower(s.bins, o0, o1);
  const inBand = sumLinearPower(s.bins, i0, i1);
  const oob = Math.max(0, outer - inBand);
  const oobBins = Math.max(0, (o1 - o0) - (i1 - i0));
  if (oobBins === 0) return 0;
  const noise = dbToLinear(noiseFloorDb) * oobBins;
  return Math.max(0, linearToDb(oob) - linearToDb(noise));
}

export function computeModQuality(
  scoped: AnalysisStats,
  wide: AnalysisStats,
  wideAvailable: boolean,
  mode: string,
  tuneHz: number,
  filterBw: number,
): ModQuality | null {
  const isAm = mode === 'am' || mode === 'sam' || mode === 'am-stereo';
  const isSsb = mode === 'usb' || mode === 'lsb';
  if (!isAm && !isSsb) return null;
  // The analysis scope is one-sided for SSB and clipped to the demod filter,
  // so the opposite sideband is not in it. Without a wide (main-FFT) frame
  // those numbers would be fabricated; report nothing instead.
  if (isSsb && !wideAvailable) return null;

  const snrDb = scoped.chanSnrDb;
  if (!Number.isFinite(snrDb) || snrDb < 3) return null;

  const snrScore = clamp(((snrDb - 6) / 30) * 100, 0, 100);
  // Reference bandwidth for splatter. Cap it so widening the demod filter
  // actually reveals out-of-channel products instead of moving the goalposts.
  const expectedBw = isAm
    ? Math.min(Math.max(3000, filterBw), 6000)
    : Math.min(Math.max(1800, filterBw), 3000);

  const carrierRefHz = isAm ? wide.carrierHz : tuneHz;
  const inHalf = isAm ? expectedBw / 2 : expectedBw * 1.5;
  const guardHz = 3000;
  const splatterDb = outOfBandExcessDb(
    wide,
    carrierRefHz - inHalf,
    carrierRefHz + inHalf,
    carrierRefHz - inHalf - guardHz,
    carrierRefHz + inHalf + guardHz,
    scoped.noiseFloorDb,
  );
  const splatterScore = clamp(100 - Math.max(0, splatterDb - 3) * 6, 0, 100);

  if (isAm) {
    // Measure depth/symmetry around the *detected carrier*, not the dial: an
    // off-tune carrier otherwise drags one sideband region over the carrier
    // and produces nonsense (e.g. >100% depth on a clean signal).
    const carrierHz = wide.carrierHz;
    const audioBw = Math.min(expectedBw / 2, 4500);
    const upperBand = bandPower(wide, carrierHz + 300, carrierHz + audioBw);
    const lowerBand = bandPower(wide, carrierHz - audioBw, carrierHz - 300);
    // Subtract the noise floor from each measurement. Without this, a weak
    // carrier plus hundreds of sideband noise bins integrates to a fake
    // "200% depth" even when the station is clean.
    const noisePerBin = dbToLinear(scoped.noiseFloorDb);
    const upper = Math.max(0, upperBand.power - noisePerBin * upperBand.bins);
    const lower = Math.max(0, lowerBand.power - noisePerBin * lowerBand.bins);
    const carrierPower = Number.isFinite(wide.carrierDb)
      ? Math.max(0, dbToLinear(wide.carrierDb) - noisePerBin)
      : 0;
    const depthPct = carrierPower > 0
      ? clamp(Math.sqrt(Math.max(0, (2 * (upper + lower)) / carrierPower)) * 100, 0, 200)
      : 0;
    const depthScore = depthPct <= 0
      ? 0
      : depthPct < 80
        ? (depthPct / 80) * 100
        : depthPct <= 105
          ? 100
          : clamp(100 - (depthPct - 105) * 2.5, 0, 100);
    const symmetryPct = Math.max(upper, lower) > 0
      ? clamp((Math.min(upper, lower) / Math.max(upper, lower)) * 100, 0, 100)
      : 0;
    const symmetryScore = symmetryPct;
    const carrierScore = clamp(((wide.carrierToNoiseDb - 10) / 30) * 100, 0, 100);

    const score =
      depthScore * 0.35 +
      splatterScore * 0.25 +
      carrierScore * 0.15 +
      snrScore * 0.15 +
      symmetryScore * 0.10;

    return {
      score: clamp(score, 0, 100),
      grade: modGrade(score),
      kind: 'am',
      snrDb,
      splatterDb,
      splatterScore,
      depthPct,
      depthScore,
      symmetryPct,
      symmetryScore,
      carrierScore,
    };
  }

  // SSB: wanted sideband vs suppressed carrier and opposite sideband.
  const wantedRange = mode === 'usb'
    ? { low: tuneHz + 300, high: tuneHz + expectedBw }
    : { low: tuneHz - expectedBw, high: tuneHz - 300 };
  const unwantedRange = mode === 'usb'
    ? { low: tuneHz - expectedBw, high: tuneHz - 300 }
    : { low: tuneHz + 300, high: tuneHz + expectedBw };
  const noisePerBin = dbToLinear(scoped.noiseFloorDb);
  const wantedBand = bandPower(wide, wantedRange.low, wantedRange.high);
  const unwantedBand = bandPower(wide, unwantedRange.low, unwantedRange.high);
  const wantedPower = Math.max(0, wantedBand.power - noisePerBin * wantedBand.bins);
  const unwantedPower = Math.max(0, unwantedBand.power - noisePerBin * unwantedBand.bins);
  const oppSbDb = wantedPower > 0
    ? (unwantedPower > 0 ? clamp(linearToDb(wantedPower) - linearToDb(unwantedPower), 0, 80) : 80)
    : 0;
  const oppSbScore = clamp(((oppSbDb - 10) / 30) * 100, 0, 100);
  const carrierBand = bandPower(wide, tuneHz - 100, tuneHz + 100);
  const carrierNet = carrierBand.power > 0
    ? Math.max(0, carrierBand.power - noisePerBin * carrierBand.bins)
    : 0;
  const carrierSuppDb = wantedPower > 0
    ? (carrierNet > 0 ? clamp(linearToDb(wantedPower) - linearToDb(carrierNet), 0, 80) : 80)
    : 0;
  const carrierScore = clamp(((carrierSuppDb - 10) / 30) * 100, 0, 100);

  const bwHz = scoped.occupiedBwHz;
  const bwScore = bwHz < 1800
    ? clamp((bwHz / 1800) * 100, 0, 100)
    : bwHz <= 3200
      ? 100
      : clamp(100 - ((bwHz - 3200) / 500) * 20, 0, 100);

  const score =
    oppSbScore * 0.25 +
    carrierScore * 0.20 +
    splatterScore * 0.20 +
    bwScore * 0.15 +
    snrScore * 0.20;

  return {
    score: clamp(score, 0, 100),
    grade: modGrade(score),
    kind: 'ssb',
    snrDb,
    splatterDb,
    splatterScore,
    oppSbDb,
    oppSbScore,
    carrierSuppDb,
    carrierSuppScore: carrierScore,
    carrierScore,
    bwHz,
    bwScore,
  };
}
