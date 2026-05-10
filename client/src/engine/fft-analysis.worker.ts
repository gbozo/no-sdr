// ============================================================
// node-sdr — FFT Analysis Worker
// ============================================================
// Runs signal level EMA and auto-range computation off the main thread.
// Receives decoded Float32 FFT frames + tuning params, posts back
// derived values (signalLevel, optional new dB range) for the S-meter
// and waterfall auto-range.
//
// Message in — frame:
//   { type: 'frame', fftData: Float32Array,
//     tuneOffset: number, bandwidth: number, sampleRate: number,
//     autoRange: boolean, frameCount: number }  (fftData transferred)
//
// Message out — result:
//   { type: 'result', signalLevel: number,
//     newMin?: number, newMax?: number }
// ============================================================

export interface FftAnalysisFrame {
  type: 'frame';
  fftData: Float32Array;
  tuneOffset: number;
  bandwidth: number;
  sampleRate: number;
  autoRange: boolean;
  frameCount: number;
}

export interface FftAnalysisResult {
  type: 'result';
  signalLevel: number;
  snr: number;
  newMin?: number;
  newMax?: number;
}

// ---- Signal level EMA state ----
let smoothedSignalLevel = -120;
let lastSignalTime = 0;

function computeSignalLevel(
  fftData: Float32Array,
  tuneOffset: number,
  bandwidth: number,
  sampleRate: number,
  dt: number,
): number {
  if (sampleRate <= 0 || fftData.length === 0) return smoothedSignalLevel;

  const bins = fftData.length;
  const centerBin = Math.round(((tuneOffset / sampleRate) + 0.5) * (bins - 1));
  const halfBwBins = Math.round((bandwidth / sampleRate) * bins / 2);

  const startBin = Math.max(0, centerBin - halfBwBins);
  const endBin   = Math.min(bins - 1, centerBin + halfBwBins);

  if (startBin >= endBin) return smoothedSignalLevel;

  let peak = -Infinity;
  for (let i = startBin; i <= endBin; i++) {
    const v = fftData[i];
    if (isFinite(v) && v > peak) peak = v;
  }

  if (!isFinite(peak)) return smoothedSignalLevel;

  // Time-based EMA: attack τ=60ms, decay τ=120ms
  const tau = peak > smoothedSignalLevel ? 60 : 120;
  const alpha = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
  smoothedSignalLevel += alpha * (peak - smoothedSignalLevel);

  return smoothedSignalLevel;
}

// ---- SNR EMA state ----
let smoothedSnr = 0;

function computeSnr(
  fftData: Float32Array,
  tuneOffset: number,
  bandwidth: number,
  sampleRate: number,
  dt: number,
): number {
  if (sampleRate <= 0 || fftData.length === 0) return smoothedSnr;

  const bins = fftData.length;
  const centerBin = Math.round(((tuneOffset / sampleRate) + 0.5) * (bins - 1));
  // Widen signal window slightly (1.5×) to catch sidebands
  const halfBwBins = Math.round((bandwidth / sampleRate) * bins / 2 * 1.5);

  const sigStart = Math.max(0, centerBin - halfBwBins);
  const sigEnd   = Math.min(bins - 1, centerBin + halfBwBins);

  // Signal: peak dB in passband
  let sigPeak = -Infinity;
  for (let i = sigStart; i <= sigEnd; i++) {
    const v = fftData[i];
    if (isFinite(v) && v > sigPeak) sigPeak = v;
  }
  if (!isFinite(sigPeak)) return smoothedSnr;

  // Noise: average of bins outside the signal window (skip 5% edges)
  const edgeSkip = Math.max(4, Math.floor(bins * 0.05));
  let noiseSum = 0;
  let noiseCount = 0;
  for (let i = edgeSkip; i < bins - edgeSkip; i++) {
    if (i >= sigStart && i <= sigEnd) continue;
    const v = fftData[i];
    if (isFinite(v)) { noiseSum += v; noiseCount++; }
  }
  if (noiseCount === 0) return smoothedSnr;
  const noiseFloor = noiseSum / noiseCount;

  const rawSnr = Math.max(0, sigPeak - noiseFloor);

  // Smooth with τ=200ms
  const tau = 200;
  const alpha = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
  smoothedSnr += alpha * (rawSnr - smoothedSnr);
  return smoothedSnr;
}

// ---- Auto-range state ----
let autoRangeMin = -60;
let autoRangeMax = -10;

function computeAutoRange(
  fftData: Float32Array,
  frameCount: number,
): { newMin: number; newMax: number } | null {
  // Only update every 16 frames (~0.5s at 30fps)
  if (frameCount % 16 !== 0) return null;

  const skip = Math.max(4, Math.floor(fftData.length * 0.02));
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;

  for (let i = skip; i < fftData.length - skip; i++) {
    const v = fftData[i];
    if (!isFinite(v)) continue;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }

  if (count === 0) return null;

  const avg = sum / count;
  const targetMin = avg - 10;
  const targetMax = Math.max(avg + 35, max + 5);

  const alpha = 0.15;
  autoRangeMin = autoRangeMin * (1 - alpha) + targetMin * alpha;
  autoRangeMax = autoRangeMax * (1 - alpha) + targetMax * alpha;

  return {
    newMin: Math.round(autoRangeMin),
    newMax: Math.round(autoRangeMax),
  };
}

self.onmessage = (e: MessageEvent<FftAnalysisFrame>) => {
  const { fftData, tuneOffset, bandwidth, sampleRate, autoRange, frameCount } = e.data;

  // Compute dt once (shared between signalLevel and snr EMAs)
  const now = performance.now();
  const dt = lastSignalTime > 0 ? Math.min(now - lastSignalTime, 200) : 0;
  lastSignalTime = now;

  const signalLevel = computeSignalLevel(fftData, tuneOffset, bandwidth, sampleRate, dt);
  const snr = computeSnr(fftData, tuneOffset, bandwidth, sampleRate, dt);

  const result: FftAnalysisResult = { type: 'result', signalLevel, snr };

  if (autoRange) {
    const range = computeAutoRange(fftData, frameCount);
    if (range) {
      result.newMin = range.newMin;
      result.newMax = range.newMax;
    }
  }

  // fftData was transferred in — we don't transfer it back (it's spent)
  self.postMessage(result);
};
