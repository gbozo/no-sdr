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
  MSG_SIGNAL_LEVEL,
  MSG_RDS,
  DEMOD_MODES,
  ImaAdpcmDecoder,
  decodeFftAdpcm,
  type ServerMeta,
  type ClientCommand,
  type CodecType,
  type DemodMode,
} from '@node-sdr/shared';
import { inflateSync } from 'fflate';
import { OpusDecoder } from 'opus-decoder';
import { WaterfallRenderer } from './waterfall.js';
import { SpectrumRenderer } from './spectrum.js';
import { AudioEngine } from './audio.js';
import { FftFrameBuffer } from './fft-frame-buffer.js';
import { getDemodulator, resetDemodulator, type Demodulator, type StereoAudio } from './demodulators.js';
import type { RdsData } from './demodulators.js';
import { NoiseReductionEngine } from './noise-reduction.js';
import { store } from '../store/index.js';
import type { Bookmark } from '../store/index.js';

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

  // Client-side FFT frame buffer — keeps last 1024 decoded Float32 frames.
  // Used for waterfall prefill on zoom/reset and future seek-back feature.
  private fftBuffer = new FftFrameBuffer(1024, 0);

  // Seek-back: when > 0, waterfall is frozen N frames in the past
  private seekOffset = 0;

  // ADPCM decoder for IQ sub-band (stateful, streaming)
  private iqAdpcmDecoder = new ImaAdpcmDecoder();

  // Opus decoder for server-side demodulated audio (WASM, async init)
  private opusDecoder: OpusDecoder | null = null;
  private opusDecoderReady = false;
  private opusDecoderChannels = 1;

  // Noise reduction engine (spectral NR + noise blanker)
  private nr = new NoiseReductionEngine();

  // Resampler state for sub-48kHz modes (SSB 24kHz, CW 12kHz → 48kHz)
  private resampleRatio = 1; // inputRate / 48000 (1 = no resampling needed)
  private resamplePhase = 0; // fractional sample position for interpolation


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
  // Codec performance tracking (wire = actual bytes received, raw = uncompressed equivalent)
  private bwFftWireBytes = 0;
  private bwFftRawBytes = 0;
  private bwIqWireBytes = 0;
  private bwIqRawBytes = 0;
  private bwLastUpdate = performance.now();
  private bwHistoryMax = 30; // keep 30 seconds of history

  // Callbacks for decoder data and meta messages
  onDecoderData?: (type: string, data: unknown) => void;
  onMetaMessage?: (meta: ServerMeta) => void;

  constructor() {
    this.audio = new AudioEngine();
    this.demodulator = getDemodulator(store.mode());
    this.attachRdsCallback();
  }

  /** Attach RDS callback to current demodulator if it supports RDS */
  private attachRdsCallback(): void {
    if (this.demodulator.setRdsCallback) {
      this.demodulator.setRdsCallback((data: RdsData) => {
        store.setRdsPs(data.ps);
        store.setRdsRt(data.rt);
        store.setRdsPty(data.ptyName);
        store.setRdsPi(data.pi !== null ? data.pi.toString(16).toUpperCase().padStart(4, '0') : '');
        store.setRdsSynced(data.synced);
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
  }

  /**
   * Resample audio from a lower sample rate to 48kHz using linear interpolation.
   * Returns the input unchanged if resampleRatio is 1.
   */
  private resampleTo48k(samples: Float32Array): Float32Array {
    if (this.resampleRatio <= 1) return samples;

    const ratio = this.resampleRatio;
    const outLen = Math.floor(samples.length * ratio);
    const out = new Float32Array(outLen);
    let phase = this.resamplePhase;
    let outIdx = 0;

    for (let i = 0; outIdx < outLen; ) {
      // Integer and fractional parts of the source position
      const srcPos = phase;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;

      if (srcIdx >= samples.length - 1) break;

      // Linear interpolation between adjacent source samples
      out[outIdx++] = samples[srcIdx] * (1 - frac) + samples[srcIdx + 1] * frac;
      phase += 1 / ratio; // advance by one output sample's worth of input
    }

    // Save fractional phase for next call (maintain continuity)
    this.resamplePhase = phase - Math.floor(phase);

    return out.subarray(0, outIdx);
  }

  /**
   * Resample stereo audio from a lower sample rate to 48kHz.
   */
  private resampleStereoTo48k(left: Float32Array, right: Float32Array): { left: Float32Array; right: Float32Array } {
    if (this.resampleRatio <= 1) return { left, right };
    // Save/restore phase so both channels use the same timing
    const savedPhase = this.resamplePhase;
    const resLeft = this.resampleTo48k(left);
    this.resamplePhase = savedPhase;
    const resRight = this.resampleTo48k(right);
    return { left: resLeft, right: resRight };
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
        // Track codec stats: MSG_FFT is raw Float32, no compression
        this.bwFftWireBytes += payload.byteLength;
        this.bwFftRawBytes += payload.byteLength;

        // Auto-range: adapt waterfall min/max to actual data
        if (store.waterfallAutoRange()) {
          this.updateAutoRange(fftData);
        }

        // Compute signal level at tuned frequency for S-meter
        this.updateSignalLevel(fftData);

        this.renderFftFrame(fftData);
        break;
      }

      case MSG_FFT_COMPRESSED: {
        this.bwFftFrames++;
        // Track codec stats: Uint8 compressed FFT (4-byte header + Uint8 bins)
        this.bwFftWireBytes += payload.byteLength;
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
        this.bwFftRawBytes += fftData.length * 4; // equivalent Float32 size

        // Auto-range: adapt waterfall min/max to actual data
        if (store.waterfallAutoRange()) {
          this.updateAutoRange(fftData);
        }

        // Compute signal level at tuned frequency for S-meter
        this.updateSignalLevel(fftData);

        this.renderFftFrame(fftData);
        break;
      }

      case MSG_FFT_ADPCM: {
        this.bwFftFrames++;
        // Decode ADPCM-compressed FFT: Int16 (dB×100) with warmup padding → Float32 dB
        this.bwFftWireBytes += payload.byteLength;
        const fftData = decodeFftAdpcm(payload);
        this.bwFftRawBytes += fftData.length * 4; // equivalent Float32 size

        if (store.waterfallAutoRange()) {
          this.updateAutoRange(fftData);
        }
        this.updateSignalLevel(fftData);

        this.renderFftFrame(fftData);
        break;
      }

      case MSG_FFT_DEFLATE: {
        this.bwFftFrames++;
        this.bwFftWireBytes += payload.byteLength;
        try {
          // Header: [Int16 minDb LE] [Int16 maxDb LE] [Uint32 binCount LE] [deflate payload]
          const headerView = new DataView(payload);
          const deflMinDb = headerView.getInt16(0, true);
          const deflMaxDb = headerView.getInt16(2, true);
          const binCount = headerView.getUint32(4, true);
          const deflPayload = new Uint8Array(payload, 8);
          // Inflate the raw deflate payload
          const delta = inflateSync(deflPayload);
          // Undo delta encoding → Uint8 dB values
          const uint8Bins = new Uint8Array(binCount);
          uint8Bins[0] = delta[0];
          for (let i = 1; i < binCount; i++) {
            uint8Bins[i] = (uint8Bins[i - 1] + delta[i]) & 0xFF;
          }
          // Convert Uint8 (0-255) → Float32 dB using header min/max
          const deflRange = deflMaxDb - deflMinDb;
          const deflFftData = new Float32Array(binCount);
          for (let i = 0; i < binCount; i++) {
            deflFftData[i] = deflMinDb + (uint8Bins[i] / 255) * deflRange;
          }
          this.bwFftRawBytes += deflFftData.length * 4;

          if (store.waterfallAutoRange()) {
            this.updateAutoRange(deflFftData);
          }
          this.updateSignalLevel(deflFftData);

          this.renderFftFrame(deflFftData);
        } catch (e) {
          console.error('[FFT_DEFLATE] decode error:', e);
        }
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
        this.bwIqWireBytes += payload.byteLength;
        this.bwIqRawBytes += payload.byteLength; // no compression
        this.processIqData(iqData);
        break;
      }

      case MSG_IQ_ADPCM: {
        // ADPCM-compressed IQ sub-band: decode nibbles → Int16 interleaved I/Q
        this.bwIqWireBytes += payload.byteLength;
        const iqHeaderView = new DataView(payload);
        const sampleCount = iqHeaderView.getUint32(0, true);
        const adpcmData = new Uint8Array(payload, 4);
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

          // Recreate decoder if channel count changed (async — drops frames until ready)
          if (channels !== this.opusDecoderChannels) {
            this.opusDecoderReady = false;
            this.initOpusDecoder(channels); // fire-and-forget
          }

          // Squelch gate — same logic as processIqData()
          const squelchLevel = store.squelch();
          const inGracePeriod = performance.now() < this.squelchBypassUntil;
          const squelchOpen = squelchLevel === null || inGracePeriod || store.signalLevel() >= squelchLevel;

          if (this.opusDecoder && this.opusDecoderReady && squelchOpen) {
            const { channelData } = this.opusDecoder.decodeFrame(opusPacket);
            this.bwIqRawBytes += opusSamples * channels * 2;

            if (channels === 2 && channelData.length >= 2) {
              this.audio.pushStereoAudio(channelData[0], channelData[1]);
              if (!store.stereoDetected()) store.setStereoDetected(true);
            } else {
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
        // Waterfall prefill burst from server history buffer.
        // Wire: [Uint16 frameCount][Uint16 binCount][Int16 minDb][Int16 maxDb][Uint8 frames...]
        try {
          const v = new DataView(payload);
          const frameCount = v.getUint16(0, true);
          const binCount   = v.getUint16(2, true);
          const minDb      = v.getInt16(4, true);
          const maxDb      = v.getInt16(6, true);
          if (frameCount > 0 && binCount > 0) {
            const serverRange = maxDb - minDb;
            // Slice Uint8 views and dequantize into Float32 for the client buffer
            const frames: Uint8Array[] = new Array(frameCount);
            for (let i = 0; i < frameCount; i++) {
              frames[i] = new Uint8Array(payload, 8 + i * binCount, binCount);
            }
            // Prefill waterfall display
            if (this.waterfall) {
              this.waterfall.prefillHistory(frames, binCount, minDb, maxDb);
            }
            // Populate client FFT buffer with dequantized Float32 frames
            // so zoom/reset can immediately use local data without a server round-trip
            this.fftBuffer.reset(); // replace any stale frames from before connect
            for (const u8frame of frames) {
              const f32 = new Float32Array(binCount);
              for (let b = 0; b < binCount; b++) {
                f32[b] = minDb + (u8frame[b] / 255) * serverRange;
              }
              this.fftBuffer.push(f32);
            }
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

      case MSG_SIGNAL_LEVEL: {
        const level = new Float32Array(payload)[0];
        store.setSignalLevel(level);
        break;
      }

      case MSG_RDS: {
        // Server-side RDS data from Opus codec path (WFM mode).
        // Bypasses the client-side demodulator — directly update store.
        try {
          const text = new TextDecoder().decode(payload);
          const rds = JSON.parse(text);
          if (rds.ps !== undefined) store.setRdsPs(rds.ps);
          if (rds.rt !== undefined) store.setRdsRt(rds.rt);
          if (rds.ptyName !== undefined) store.setRdsPty(rds.ptyName);
          if (rds.pi !== null && rds.pi !== undefined) {
            store.setRdsPi(rds.pi.toString(16).toUpperCase().padStart(4, '0'));
          } else if (rds.pi === null) {
            store.setRdsPi('');
          }
          if (rds.synced !== undefined) store.setRdsSynced(rds.synced);
        } catch (e) {
          console.error('[RDS] decode error:', e);
        }
        break;
      }
    }
  }

  /**
   * Render one decoded FFT frame: push to client buffer, draw waterfall row,
   * draw spectrum, draw tuning indicator. Single call site for all four codecs.
   */
  private renderFftFrame(fftData: Float32Array): void {
    this.fftBuffer.push(fftData);
    // When seeking, skip waterfall live update — frozen view is managed by seekTo()
    if (this.seekOffset === 0) {
      this.waterfall?.drawRow(fftData);
    }
    this.spectrum?.draw(fftData);
    this.spectrum?.drawTuningIndicator(
      store.tuneOffset(),
      store.bandwidth(),
      store.sampleRate(),
    );
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

    // Target: noise floor ~10% from bottom, strong signals visible at top
    // Use median-like approach: min = avg - 10dB, max = avg + 35dB
    const targetMin = avg - 10;
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
   * Common IQ demodulation pipeline shared by MSG_IQ and MSG_IQ_ADPCM.
   * Handles squelch gating, stereo detection, and audio push.
   */
  private processIqData(iqData: Int16Array): void {
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
        // Apply noise reduction to stereo audio
        const filtered = this.nr.processStereo(stereoResult.left, stereoResult.right);
        // Resample to 48kHz if demod output is at a lower rate (SSB/CW)
        const resampled = this.resampleStereoTo48k(filtered.left, filtered.right);
        this.audioOutCount += resampled.left.length;
        if (resampled.left.length > 0 && squelchOpen) {
          this.audio.pushStereoAudio(resampled.left, resampled.right);
        }
        if (!store.stereoDetected()) {
          store.setStereoDetected(true);
        }
      } else {
        // Apply noise reduction to mono audio
        const filtered = this.nr.processMono(stereoResult.left);
        // Resample to 48kHz if demod output is at a lower rate (SSB/CW)
        const resampled = this.resampleTo48k(filtered);
        this.audioOutCount += resampled.length;
        if (resampled.length > 0 && squelchOpen) {
          this.audio.pushDemodulatedAudio(resampled);
        }
        if (store.stereoDetected()) {
          store.setStereoDetected(false);
        }
      }
    } else {
      const audioSamples = this.demodulator.process(iqData);
      this.iqInCount += iqData.length / 2;
      // Apply noise reduction to mono audio
      const filtered = this.nr.processMono(audioSamples);
      // Resample to 48kHz if demod output is at a lower rate (SSB/CW)
      const resampled = this.resampleTo48k(filtered);
      this.audioOutCount += resampled.length;
      if (resampled.length > 0 && squelchOpen) {
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
        store.setClientId(meta.clientId);
        break;

      case 'subscribed': {
        // Capture client-side state before the server profile defaults overwrite it.
        // Only meaningful on reconnects — guard with wasSubscribed so first-time
        // connections never restore stale store defaults (mode='nfm', offset=0, etc.)
        const wasSubscribed  = !!store.activeDongleId();
        const prevTuneOffset = wasSubscribed ? store.tuneOffset()  : 0;
        const prevMode       = wasSubscribed ? store.mode()        : null;
        const prevBandwidth  = wasSubscribed ? store.bandwidth()   : 0;
        const audioWasActive = this.audio.isInitialized;

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
        // Re-send codec preferences so the server applies them to this subscription
        if (store.fftCodec() !== 'none' || store.iqCodec() !== 'none') {
          this.send({ cmd: 'codec', fftCodec: store.fftCodec(), iqCodec: store.iqCodec() });
        }
        // Re-send stereo preference for Opus path
        if (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq') {
          this.send({ cmd: 'stereo_enabled', enabled: store.stereoEnabled() });
        }

        // Restore client tuning state from before the reconnect.
        // Only re-send if the value differs from the server's profile default so we
        // don't spam the server on a first-time connection where prevMode/offset are
        // already at their zero/default values.
        if (prevMode && prevMode !== meta.mode) {
          store.setMode(prevMode as DemodMode);
          const modeInfo = DEMOD_MODES[prevMode as DemodMode];
          this.demodulator = getDemodulator(prevMode as DemodMode);
          this.demodulator.reset();
          const bw = prevBandwidth || modeInfo?.defaultBandwidth || store.bandwidth();
          store.setBandwidth(bw);
          this.demodulator.setBandwidth(bw);
          this.attachRdsCallback();
          if (meta.iqSampleRate) this.demodulator.setInputSampleRate(meta.iqSampleRate);
          this.send({ cmd: 'mode', mode: prevMode });
          this.send({ cmd: 'bandwidth', hz: bw });
          this.updateResampleRatio();
        } else if (prevBandwidth && prevBandwidth !== store.bandwidth()) {
          store.setBandwidth(prevBandwidth);
          this.demodulator.setBandwidth(prevBandwidth);
          this.send({ cmd: 'bandwidth', hz: prevBandwidth });
        }

        if (prevTuneOffset !== 0) {
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
        break;
      }

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
          this.attachRdsCallback();
          if (meta.iqSampleRate) {
            this.demodulator.setInputSampleRate(meta.iqSampleRate);
          }
        }
        // Flush audio and reset waterfall + client FFT buffer
        this.audio.resetBuffer();
        this.fftBuffer.reset();
        this.waterfall?.clear();
        // Update resampler for new mode's output rate
        this.updateResampleRatio();
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
    this.attachRdsCallback();
    // For Opus codec path, clear RDS when leaving WFM (server won't send MSG_RDS for other modes)
    if ((store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq') && m !== 'wfm') {
      store.setRdsPs('');
      store.setRdsRt('');
      store.setRdsPty('');
      store.setRdsPi('');
      store.setRdsSynced(false);
    }
    // Flush stale audio data
    this.audio.resetBuffer();
    // Reset noise reduction state for new mode
    this.nr.reset();
    // Update resampler for new mode's output rate
    this.updateResampleRatio();
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
    if (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq') {
      this.send({ cmd: 'stereo_enabled', enabled });
    }
    // For IQ path: inform the local FM demodulator
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

  // ---- Noise Reduction ----

  setNrEnabled(enabled: boolean): void {
    store.setNrEnabled(enabled);
    this.nr.setNrEnabled(enabled);
  }

  setNrStrength(strength: number): void {
    store.setNrStrength(strength);
    this.nr.setNrStrength(strength);
  }

  setNbEnabled(enabled: boolean): void {
    store.setNbEnabled(enabled);
    this.nr.setNbEnabled(enabled);
  }

  setNbLevel(level: number): void {
    store.setNbLevel(level);
    this.nr.setNbLevel(level);
  }

  // ---- Codec Settings ----

  setFftCodec(codec: CodecType): void {
    store.setFftCodec(codec);
    this.send({ cmd: 'codec', fftCodec: codec });
  }

  setIqCodec(codec: CodecType): void {
    store.setIqCodec(codec as any);
    // Reset codec decoders when switching codecs
    this.iqAdpcmDecoder.reset();
    // Initialize Opus decoder if switching to opus
    if ((codec === 'opus' || codec === 'opus-hq') && !this.opusDecoderReady) {
      this.initOpusDecoder();
    }
    this.send({ cmd: 'codec', iqCodec: codec });
    // When switching to Opus, sync stereo preference to server
    if (codec === 'opus' || codec === 'opus-hq') {
      this.send({ cmd: 'stereo_enabled', enabled: store.stereoEnabled() });
    }
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
      await this.opusDecoder.ready;
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

  setWaterfallGamma(gamma: number): void {
    store.setWaterfallGamma(gamma);
    this.waterfall?.setGamma(gamma);
  }

  setSpectrumPeakHold(enabled: boolean): void {
    store.setSpectrumPeakHold(enabled);
    this.spectrum?.setPeakHold(enabled);
  }

  setSpectrumSignalFill(enabled: boolean): void {
    store.setSpectrumSignalFill(enabled);
    this.spectrum?.setSignalFill(enabled);
  }

  setSpectrumPaused(enabled: boolean): void {
    store.setSpectrumPaused(enabled);
    this.spectrum?.setPause(enabled);
  }

  setSpectrumAveraging(speed: 'fast' | 'med' | 'slow'): void {
    store.setSpectrumAveraging(speed);
    const alpha = speed === 'slow' ? 0.7 : speed === 'med' ? 0.4 : 0;
    this.spectrum?.setSmoothing(alpha);
  }

  /** Get the dB value at a canvas X pixel on the spectrum — used by tooltip. */
  getSpectrumDbAtPixel(canvasX: number): number | null {
    const pd = this.spectrum?.lastPixelDb;
    if (!pd) return null;
    const idx = Math.max(0, Math.min(pd.length - 1, Math.round(canvasX)));
    return pd[idx];
  }

  setSpectrumNoiseFloor(enabled: boolean): void {
    store.setSpectrumNoiseFloor(enabled);
    this.spectrum?.setNoiseFloor(enabled);
  }

  /**
   * Set zoom viewport from two X fractions [0,1] of the full bandwidth.
   * Both spectrum and waterfall renderers are updated.
   */
  setSpectrumZoom(start: number, end: number): void {
    store.setSpectrumZoom([start, end]);
    this.spectrum?.setZoom(start, end);
    this.waterfall?.setZoom(start, end);
    // Prefill waterfall from client buffer so it doesn't go blank
    if (this.waterfall && this.fftBuffer.count > 0) {
      this.waterfall.prefillFromBuffer(this.fftBuffer.getFrames());
    }
  }

  resetSpectrumZoom(): void {
    store.setSpectrumZoom([0, 1]);
    this.spectrum?.resetZoom();
    this.waterfall?.resetZoom();
    // Prefill waterfall from client buffer on zoom exit
    if (this.waterfall && this.fftBuffer.count > 0) {
      this.waterfall.prefillFromBuffer(this.fftBuffer.getFrames());
    }
  }

  // ---- Seek-back ----

  get fftBufferCount(): number { return this.fftBuffer.count; }

  /** Whether audio has been initialised (user has clicked to enable). */
  get isAudioInitialized(): boolean { return this.audio.isInitialized; }

  /**
   * Seek the waterfall to `offset` frames back from live (0 = live).
   * Redraws the waterfall from the client buffer window.
   */
  seekTo(offset: number): void {
    const count = this.fftBuffer.count;
    this.seekOffset = Math.max(0, Math.min(offset, count));
    if (!this.waterfall) return;
    if (this.seekOffset === 0) {
      // Back to live — refill from full buffer then let live frames take over
      this.waterfall.prefillFromBuffer(this.fftBuffer.getFrames());
      return;
    }
    // Show the window of frames ending `seekOffset` frames ago
    const frames = this.fftBuffer.getFrames();
    const end    = frames.length - this.seekOffset;
    if (end <= 0) return;
    this.waterfall.prefillFromBuffer(frames.slice(0, end));
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
    };
    store.setBookmarks([...store.bookmarks(), bm]);
  }

  /** Recall a bookmark: tune, set mode and bandwidth. */
  recallBookmark(bm: Bookmark): void {
    // Set mode first (may change IQ rate)
    if (bm.mode !== store.mode()) this.setMode(bm.mode);
    if (bm.bandwidth !== store.bandwidth()) this.setBandwidth(bm.bandwidth);
    this.tune(bm.hz - store.centerFrequency());
  }

  deleteBookmark(id: string): void {
    store.setBookmarks(store.bookmarks().filter(b => b.id !== id));
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
    // Tell server to start sending IQ data now that audio is enabled
    this.send({ cmd: 'audio_enabled', enabled: true });
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
