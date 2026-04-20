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
  MSG_IQ,
  MSG_AUDIO,
  MSG_META,
  MSG_DECODER,
  MSG_SIGNAL_LEVEL,
  DEMOD_MODES,
  type ServerMeta,
  type ClientCommand,
  type DemodMode,
} from '@node-sdr/shared';
import { WaterfallRenderer } from './waterfall.js';
import { SpectrumRenderer } from './spectrum.js';
import { AudioEngine } from './audio.js';
import { getDemodulator, resetDemodulator, type Demodulator, type StereoAudio } from './demodulators.js';
import { store } from '../store/index.js';

export class SdrEngine {
  private ws: WebSocket | null = null;
  private waterfall: WaterfallRenderer | null = null;
  private spectrum: SpectrumRenderer | null = null;
  private audio: AudioEngine;
  private demodulator: Demodulator;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private destroyed = false;

  // Auto-range tracking
  private autoRangeMin = -60;
  private autoRangeMax = -10;

  // Audio diagnostics
  private iqInCount = 0;
  private audioOutCount = 0;
  private lastAudioLog = performance.now();
  private autoRangeFrameCount = 0;

  // Squelch grace period: after tuning/mode change, bypass squelch briefly
  // so the jitter buffer can fill and signal level can stabilize.
  private squelchBypassUntil = 0;

  // Bandwidth / throughput tracking (updated every second)
  private bwFftFrames = 0;
  private bwIqSamples = 0;
  private bwTotalBytes = 0;
  private bwLastUpdate = performance.now();
  private bwHistoryMax = 30; // keep 30 seconds of history

  // Callbacks for decoder data and meta messages
  onDecoderData?: (type: string, data: unknown) => void;
  onMetaMessage?: (meta: ServerMeta) => void;

  constructor() {
    this.audio = new AudioEngine();
    this.demodulator = getDemodulator(store.mode());
  }

  /**
   * Attach canvas elements for rendering
   */
  attachCanvases(waterfallCanvas: HTMLCanvasElement, spectrumCanvas: HTMLCanvasElement): void {
    this.waterfall = new WaterfallRenderer(
      waterfallCanvas,
      store.waterfallTheme(),
      store.waterfallMin(),
      store.waterfallMax(),
    );
    this.spectrum = new SpectrumRenderer(
      spectrumCanvas,
      store.waterfallMin(),
      store.waterfallMax(),
    );
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      store.setConnected(true);
      this.reconnectAttempts = 0;
      console.log('[SDR] WebSocket connected');

      // Auto-subscribe to first dongle if available
      this.fetchDongles();
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
      return;
    }

    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

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
      case MSG_FFT: {
        this.bwFftFrames++;
        const fftData = new Float32Array(payload);

        // Auto-range: adapt waterfall min/max to actual data
        if (store.waterfallAutoRange()) {
          this.updateAutoRange(fftData);
        }

        // Compute signal level at tuned frequency for S-meter
        this.updateSignalLevel(fftData);

        this.waterfall?.drawRow(fftData);
        this.spectrum?.draw(fftData);
        // Draw tuning indicator on spectrum
        this.spectrum?.drawTuningIndicator(
          store.tuneOffset(),
          store.bandwidth(),
          store.sampleRate(),
        );
        break;
      }

      case MSG_FFT_COMPRESSED: {
        this.bwFftFrames++;
        // Decompress uint8 to float32 dB values.
        // Header: 4 bytes [Int16 minDb, Int16 maxDb] (little-endian)
        const headerView = new DataView(payload);
        const compMinDb = headerView.getInt16(0, true);
        const compMaxDb = headerView.getInt16(2, true);
        const compRange = compMaxDb - compMinDb;
        const compressed = new Uint8Array(payload, 4);
        const fftData = new Float32Array(compressed.length);
        for (let i = 0; i < compressed.length; i++) {
          fftData[i] = compMinDb + (compressed[i] / 255) * compRange;
        }

        // Auto-range: adapt waterfall min/max to actual data
        if (store.waterfallAutoRange()) {
          this.updateAutoRange(fftData);
        }

        // Compute signal level at tuned frequency for S-meter
        this.updateSignalLevel(fftData);

        this.waterfall?.drawRow(fftData);
        this.spectrum?.draw(fftData);
        this.spectrum?.drawTuningIndicator(
          store.tuneOffset(),
          store.bandwidth(),
          store.sampleRate(),
        );
        break;
      }

      case MSG_AUDIO: {
        const audioData = new Int16Array(payload);
        this.audio.pushAudio(audioData);
        break;
      }

      case MSG_IQ: {
        // Per-user IQ sub-band data → client-side demodulation → audio
        const iqData = new Int16Array(payload);
        this.bwIqSamples += iqData.length / 2;

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
            this.audioOutCount += stereoResult.left.length;
            if (stereoResult.left.length > 0 && squelchOpen) {
              this.audio.pushStereoAudio(stereoResult.left, stereoResult.right);
            }
            // Update stereo detection state
            if (!store.stereoDetected()) {
              store.setStereoDetected(true);
            }
          } else {
            this.audioOutCount += stereoResult.left.length;
            if (stereoResult.left.length > 0 && squelchOpen) {
              this.audio.pushDemodulatedAudio(stereoResult.left);
            }
            if (store.stereoDetected()) {
              store.setStereoDetected(false);
            }
          }
        } else {
          const audioSamples = this.demodulator.process(iqData);
          this.iqInCount += iqData.length / 2;
          this.audioOutCount += audioSamples.length;
          if (audioSamples.length > 0 && squelchOpen) {
            this.audio.pushDemodulatedAudio(audioSamples);
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
        break;
      }

      case MSG_META: {
        const decoder = new TextDecoder();
        const json = decoder.decode(payload);
        const meta: ServerMeta = JSON.parse(json);
        this.handleMetaMessage(meta);
        break;
      }

      case MSG_DECODER: {
        const decoder = new TextDecoder();
        const json = decoder.decode(payload);
        const { decoderType, data: decoderData } = JSON.parse(json);
        this.onDecoderData?.(decoderType, decoderData);
        break;
      }

      case MSG_SIGNAL_LEVEL: {
        const level = new Float32Array(payload)[0];
        store.setSignalLevel(level);
        break;
      }
    }
  }

  /**
   * Auto-range: slowly adapt waterfall min/max dB to actual data.
   * Uses exponential smoothing so the range is stable but responsive.
   */
  private updateAutoRange(fftData: Float32Array): void {
    this.autoRangeFrameCount++;
    // Only update every 16 frames (~0.5s at 30fps) to avoid jitter
    if (this.autoRangeFrameCount % 16 !== 0) return;

    // Compute data statistics (skip DC bin ±2 and edges)
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

    if (count === 0) return;
    const avg = sum / count;

    // Target: noise floor ~20% from bottom, strong signals visible at top
    // Use median-like approach: min = avg - 15dB, max = avg + 35dB
    const targetMin = avg - 15;
    const targetMax = Math.max(avg + 35, max + 5);

    // Smooth towards target (slow adaptation)
    const alpha = 0.15;
    this.autoRangeMin = this.autoRangeMin * (1 - alpha) + targetMin * alpha;
    this.autoRangeMax = this.autoRangeMax * (1 - alpha) + targetMax * alpha;

    // Round and apply
    const newMin = Math.round(this.autoRangeMin);
    const newMax = Math.round(this.autoRangeMax);

    if (newMin !== store.waterfallMin() || newMax !== store.waterfallMax()) {
      store.setWaterfallMin(newMin);
      store.setWaterfallMax(newMax);
      this.waterfall?.setRange(newMin, newMax);
      this.spectrum?.setRange(newMin, newMax);
    }
  }

  /**
   * Compute signal level at the tuned frequency from FFT data.
   * Averages the dB values in the bins covering the current bandwidth.
   */
  private signalLevelFrameCount = 0;
  private updateSignalLevel(fftData: Float32Array): void {
    this.signalLevelFrameCount++;
    // Update every 2 frames (~15 times/sec at 30fps)
    if (this.signalLevelFrameCount % 2 !== 0) return;

    const sampleRate = store.sampleRate();
    if (sampleRate <= 0 || fftData.length === 0) return;

    const tuneOffset = store.tuneOffset();
    const bandwidth = store.bandwidth();
    const bins = fftData.length;

    // Map tuneOffset to bin index (0 = left edge, bins-1 = right edge)
    // tuneOffset is relative to center: -sampleRate/2 to +sampleRate/2
    const centerBin = Math.round(((tuneOffset / sampleRate) + 0.5) * (bins - 1));
    const halfBwBins = Math.round((bandwidth / sampleRate) * bins / 2);

    const startBin = Math.max(0, centerBin - halfBwBins);
    const endBin = Math.min(bins - 1, centerBin + halfBwBins);

    if (startBin >= endBin) return;

    // Find peak signal level in the bandwidth (peak is more useful than average for S-meter)
    let peak = -Infinity;
    for (let i = startBin; i <= endBin; i++) {
      const v = fftData[i];
      if (isFinite(v) && v > peak) peak = v;
    }

    if (isFinite(peak)) {
      store.setSignalLevel(peak);
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

    // Rolling history (keep last N seconds)
    const history = store.wsBytesHistory().slice(-(this.bwHistoryMax - 1));
    history.push(bytesPerSec);
    store.setWsBytesHistory(history);

    this.bwFftFrames = 0;
    this.bwIqSamples = 0;
    this.bwTotalBytes = 0;
    this.bwLastUpdate = now;
  }

  /**
   * Handle JSON metadata messages
   */
  private handleMetaMessage(meta: ServerMeta): void {
    this.onMetaMessage?.(meta);

    switch (meta.type) {
      case 'welcome':
        store.setClientId(meta.clientId);
        break;

      case 'subscribed':
        store.setActiveDongleId(meta.dongleId);
        store.setCenterFrequency(meta.centerFreq);
        store.setSampleRate(meta.sampleRate);
        store.setFftSize(meta.fftSize);
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
          this.demodulator = getDemodulator(m);
          this.demodulator.reset();
          this.demodulator.setBandwidth(store.bandwidth());
          if (meta.iqSampleRate) {
            this.demodulator.setInputSampleRate(meta.iqSampleRate);
          }
        }
        // Flush audio on new subscription
        this.audio.resetBuffer();
        break;

      case 'profile_changed':
        store.setCenterFrequency(meta.centerFreq);
        store.setSampleRate(meta.sampleRate);
        store.setFftSize(meta.fftSize);
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
          this.demodulator = getDemodulator(m);
          this.demodulator.reset();
          this.demodulator.setBandwidth(store.bandwidth());
          if (meta.iqSampleRate) {
            this.demodulator.setInputSampleRate(meta.iqSampleRate);
          }
        }
        // Flush audio and reset waterfall
        this.audio.resetBuffer();
        this.waterfall?.clear();
        break;

      case 'admin_auth_ok':
        store.setIsAdmin(true);
        break;

      case 'error':
        console.error(`[SDR] Server error: ${meta.message} (${meta.code ?? ''})`);
        break;
    }
  }

  /**
   * Fetch available dongles via REST API
   */
  async fetchDongles(): Promise<void> {
    try {
      const res = await fetch('/api/dongles');
      const dongles = await res.json();
      store.setDongles(dongles);

      // Auto-subscribe to first running dongle
      const running = dongles.find((d: any) => d.running);
      if (running) {
        this.subscribe(running.id);
      }
    } catch (err) {
      console.error('[SDR] Failed to fetch dongles:', err);
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
    this.send({ cmd: 'subscribe', dongleId, profileId });
  }

  unsubscribe(): void {
    this.send({ cmd: 'unsubscribe' });
  }

  tune(offsetHz: number): void {
    store.setTuneOffset(offsetHz);
    // Reset demodulator and audio buffer to avoid stale filter state
    this.demodulator.reset();
    this.audio.resetBuffer();
    // Bypass squelch for 500ms so jitter buffer fills before squelch gates audio
    this.squelchBypassUntil = performance.now() + 500;
    this.send({ cmd: 'tune', offset: offsetHz });
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
    this.demodulator = getDemodulator(m);
    this.demodulator.reset();
    this.demodulator.setBandwidth(store.bandwidth());
    // Flush stale audio data
    this.audio.resetBuffer();
    // Bypass squelch for 500ms so jitter buffer fills before squelch gates audio
    this.squelchBypassUntil = performance.now() + 500;
    this.send({ cmd: 'mode', mode });
  }

  setBandwidth(hz: number): void {
    store.setBandwidth(hz);
    this.demodulator.setBandwidth(hz);
    this.send({ cmd: 'bandwidth', hz });
  }

  setSquelch(db: number | null): void {
    store.setSquelch(db);
    // Squelch is enforced client-side in the MSG_IQ handler —
    // no server command needed since audio demodulation is local.
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
    // Also inform the FM demodulator so it can skip stereo processing entirely
    if (this.demodulator.stereoCapable && 'setStereoEnabled' in this.demodulator) {
      (this.demodulator as any).setStereoEnabled(enabled);
    }
    if (!enabled && store.stereoDetected()) {
      store.setStereoDetected(false);
    }
    // Reset demodulator state and flush audio buffer to avoid stale filter
    // data from the previous mono/stereo path causing silence or artifacts
    this.demodulator.reset();
    this.audio.resetBuffer();
  }

  setStereoThreshold(dB: number): void {
    store.setStereoThreshold(dB);
    // If current signal is below new threshold, clear stereo detection
    if (store.signalLevel() < dB && store.stereoDetected()) {
      store.setStereoDetected(false);
    }
  }

  // ---- Display Settings ----

  setWaterfallTheme(theme: string): void {
    store.setWaterfallTheme(theme as any);
    this.waterfall?.setTheme(theme as any);
  }

  setWaterfallRange(minDb: number, maxDb: number): void {
    // Manual range adjustment disables auto-range
    store.setWaterfallAutoRange(false);
    store.setWaterfallMin(minDb);
    store.setWaterfallMax(maxDb);
    this.waterfall?.setRange(minDb, maxDb);
    this.spectrum?.setRange(minDb, maxDb);
  }

  // ---- Audio ----

  async initAudio(): Promise<void> {
    await this.audio.init();
    this.audio.setVolume(store.volume());
    this.audio.setBalance(store.balance());
    this.audio.setEqLow(store.eqLow());
    this.audio.setEqLowMid(store.eqLowMid());
    this.audio.setEqMid(store.eqMid());
    this.audio.setEqHighMid(store.eqHighMid());
    this.audio.setEqHigh(store.eqHigh());
    this.audio.setLoudness(store.loudness());
  }

  // ---- Resize Handling ----

  handleResize(): void {
    this.waterfall?.resize();
    this.spectrum?.resize();
  }

  // ---- Admin ----

  adminAuth(password: string): void {
    this.send({ cmd: 'admin_auth', password });
  }

  adminSetProfile(dongleId: string, profileId: string): void {
    this.send({ cmd: 'admin_set_profile', dongleId, profileId });
  }

  // ---- Cleanup ----

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.audio.destroy();
  }
}

// Singleton engine instance
export const engine = new SdrEngine();
