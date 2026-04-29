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
  FFT_HISTORY_CODEC_NONE,
  FFT_HISTORY_CODEC_DEFLATE,
  FFT_HISTORY_CODEC_ADPCM,
  type ServerMeta,
  type ClientCommand,
  type CodecType,
  type DemodMode,
} from '@node-sdr/shared';
import { inflateSync } from 'fflate';
import { OpusDecoder } from 'opus-decoder';
import { SpectrumRenderer } from './spectrum.js';
import type { FftDecodeRequest, FftDecodeResult } from './fft-decode.worker.js';
import type { FftAnalysisFrame, FftAnalysisResult } from './fft-analysis.worker.js';
import { AudioEngine } from './audio.js';
import { FftFrameBuffer } from './fft-frame-buffer.js';
import { getDemodulator, resetDemodulator, type Demodulator, type StereoAudio } from './demodulators.js';
import type { RdsData } from './demodulators.js';
import { NoiseReductionEngine } from './noise-reduction.js';
import { LmsAnr } from './lms-anr.js';
import { HangAgc, AGC_PRESETS } from './agc.js';
import { RumbleFilter, AutoNotch, HiBlendFilter } from './audio-filters.js';
import { store } from '../store/index.js';
import type { Bookmark } from '../store/index.js';

export class SdrEngine {
  private ws: WebSocket | null = null;
  // Waterfall is now rendered by a dedicated Worker via OffscreenCanvas.
  // The main thread keeps a reference to the canvas element only.
  private waterfallWorker: Worker | null = null;
  private waterfallCanvas: HTMLCanvasElement | null = null;
  private spectrum: SpectrumRenderer | null = null;
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
  private opusDecoder: OpusDecoder | null = null;
  private opusDecoderReady = false;
  private opusDecoderChannels = 1;

  // Noise reduction engine (spectral NR + noise blanker — legacy)
  private nr = new NoiseReductionEngine();

  // LMS Adaptive NR (replaces spectral NR for CW/SSB/AM)
  private anr = new LmsAnr();

  // Audio filters (rumble HPF + auto-notch + hi-blend for FM stereo)
  private rumbleFilter = new RumbleFilter(48000);
  private autoNotch = new AutoNotch(48000);
  private hiBlend = new HiBlendFilter(48000);

  // Hang-timer AGC (post-demod, pre-audio)
  private agc = new HangAgc(48000);

  // Resampler state for sub-48kHz modes (SSB 24kHz, CW 12kHz → 48kHz)
  private resampleRatio = 1; // inputRate / 48000 (1 = no resampling needed)
  private resamplePhase = 0; // fractional sample position for interpolation


  // Audio diagnostics
  private iqInCount = 0;
  private audioOutCount = 0;
  private lastAudioLog = performance.now();

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
      const { signalLevel, newMin, newMax } = e.data;
      store.setSignalLevel(signalLevel);
      if (newMin !== undefined && newMax !== undefined) {
        if (newMin !== store.waterfallMin() || newMax !== store.waterfallMax()) {
          store.setWaterfallMin(newMin);
          store.setWaterfallMax(newMax);
          this.waterfallWorker?.postMessage({ type: 'set-range', minDb: newMin, maxDb: newMax });
          this.spectrum?.setRange(newMin, newMax);
        }
      }
    };
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
  /**
   * Attach canvas elements for rendering.
   * The waterfall canvas is transferred to the WaterfallWorker via OffscreenCanvas.
   * The spectrum canvas stays on the main thread (needs synchronous tooltip reads).
   */
  attachCanvases(waterfallCanvas: HTMLCanvasElement, spectrumCanvas: HTMLCanvasElement): void {
    this.waterfallCanvas = waterfallCanvas;

    // Spin up the waterfall worker and transfer canvas control
    this.waterfallWorker = new Worker(
      new URL('./waterfall.worker.ts', import.meta.url),
      { type: 'module' },
    );

    const offscreen = waterfallCanvas.transferControlToOffscreen();
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

    this.spectrum = new SpectrumRenderer(
      spectrumCanvas,
      store.waterfallMin(),
      store.waterfallMax(),
    );

    // Flush any history that arrived before the worker was ready.
    // Do NOT flush here — the canvas has no dimensions yet at onMount time.
    // flushPendingHistory() is called by WaterfallDisplay after the first resize rAF.
  }

  /**
   * Send buffered waterfall history to the worker.
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
      case MSG_FFT:
      case MSG_FFT_COMPRESSED:
      case MSG_FFT_ADPCM:
      case MSG_FFT_DEFLATE: {
        this.bwFftFrames++;
        this.bwFftWireBytes += payload.byteLength;

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

            // Populate client FFT buffer (zoom/seek uses this).
            // Upsample from history binCount → live fftSize using linear interpolation
            // so seek-back renders at full live resolution.
            const liveBinCount = store.fftSize();
            this.fftBuffer.reset();
            for (let i = 0; i < frameCount; i++) {
              const off = i * binCount;
              if (liveBinCount === binCount) {
                // 1:1 — no interpolation needed
                const f32 = new Float32Array(binCount);
                for (let b = 0; b < binCount; b++) {
                  f32[b] = minDb + (allFrames[off + b] / 255) * serverRange;
                }
                this.fftBuffer.push(f32);
              } else {
                // Upsample via linear interpolation
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

      default: {
        console.warn(`[SDR] unhandled binary message type: 0x${type.toString(16).padStart(2, '0')}, payload ${payload.byteLength} bytes`);
      }
    }
  }

  /**
   * Render one decoded FFT frame: push to client buffer, draw waterfall row,
   * draw spectrum, draw tuning indicator. Single call site for all four codecs.
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

    // Spectrum stays on main thread — needs synchronous lastPixelDb for tooltip
    this.spectrum?.draw(fftData);
    this.spectrum?.drawTuningIndicator(
      store.tuneOffset(),
      store.bandwidth(),
      store.sampleRate(),
    );
  }

  /**
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
        // Apply LMS adaptive NR
        this.anr.process(filtered.left);
        this.anr.process(filtered.right);
        // Resample to 48kHz if demod output is at a lower rate (SSB/CW)
        const resampled = this.resampleStereoTo48k(filtered.left, filtered.right);
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
          this.audio.pushStereoAudio(resampled.left, resampled.right);
        }
        if (!store.stereoDetected()) {
          store.setStereoDetected(true);
        }
      } else {
        // Apply noise reduction to mono audio
        const filtered = this.nr.processMono(stereoResult.left);
        // Apply LMS adaptive NR
        this.anr.process(filtered);
        // Resample to 48kHz if demod output is at a lower rate (SSB/CW)
        const resampled = this.resampleTo48k(filtered);
        // Apply audio filters
        this.rumbleFilter.process(resampled);
        this.autoNotch.process(resampled);
        // Apply AGC
        if (store.agcEnabled()) {
          this.agc.process(resampled);
        }
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
      // Apply LMS adaptive NR
      this.anr.process(filtered);
      // Resample to 48kHz if demod output is at a lower rate (SSB/CW)
      const resampled = this.resampleTo48k(filtered);
      // Apply audio filters
      this.rumbleFilter.process(resampled);
      this.autoNotch.process(resampled);
      // Apply AGC
      if (store.agcEnabled()) {
        this.agc.process(resampled);
      }
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
        store.setActiveProfileId(meta.profileId ?? '');
        store.setCenterFrequency(meta.centerFreq);
        store.setSampleRate(meta.sampleRate);
        store.setFftSize(meta.fftSize);
        store.setTuningStep(meta.tuningStep ?? 0);
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
        // Re-send codec preferences so the server applies them to this subscription.
        // Always send — persisted values from localStorage may differ from server defaults.
        this.send({ cmd: 'codec', fftCodec: store.fftCodec(), iqCodec: store.iqCodec() });
        // Always sync stereo preference for Opus path immediately after codec is set.
        // The server creates a fresh OpusAudioPipeline with stereo enabled by default,
        // so we must send stereo_enabled even when the value is false — otherwise the
        // server encodes stereo while the client expects mono, causing a channel-count
        // mismatch that triggers async Opus decoder re-init and drops audio until resolved.
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
          // Pre-init the Opus decoder with the correct channel count so no
          // async re-init is triggered when the first packet arrives.
          // On the Opus path the server honours stereo_enabled before sending
          // audio, but we prime the decoder here to eliminate any race window.
          if (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq') {
            const expectedChannels = store.stereoEnabled() ? 2 : 1;
            if (!this.opusDecoderReady || this.opusDecoderChannels !== expectedChannels) {
              this.initOpusDecoder(expectedChannels);
            }
          }
          this.send({ cmd: 'audio_enabled', enabled: true });
        }

        // Request waterfall history to prefill the display immediately
        this.send({ cmd: 'request_history' });
        break;
      }

      case 'profile_changed':
        store.setActiveProfileId(meta.profileId ?? '');
        store.setCenterFrequency(meta.centerFreq);
        store.setSampleRate(meta.sampleRate);
        store.setFftSize(meta.fftSize);
        store.setTuningStep(meta.tuningStep ?? 0);
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
        this.waterfallWorker?.postMessage({ type: 'clear' });
        // Update resampler for new mode's output rate
        this.updateResampleRatio();
        break;

      case 'admin_auth_ok':
        store.setIsAdmin(true);
        break;

      case 'error':
        console.error(`[SDR] Server error: ${meta.message} (${meta.code ?? ''})`);
        break;

      case 'server_stats':
        store.setServerCpu(meta.cpuPercent);
        store.setServerMem(meta.memMb);
        store.setServerClients(meta.clients);
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
    // Reset demodulator to clear stale filter state at the new frequency
    this.demodulator.reset();
    // Reset ADPCM decoder — predictor state is invalid after frequency change
    this.iqAdpcmDecoder.reset();
    // On the IQ codec path the client holds demodulated samples that go stale
    // when the server shifts the extracted sub-band — flush the ring buffer.
    // On the Opus path the server re-tunes seamlessly; flushing causes a
    // needless 150ms silence while the jitter buffer re-fills.
    if (store.iqCodec() === 'none' || store.iqCodec() === 'adpcm') {
      this.audio.resetBuffer();
    }
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
    // Reset ADPCM decoder — mode/rate change invalidates predictor
    this.iqAdpcmDecoder.reset();
    // Reset noise reduction state for new mode
    this.nr.reset();
    this.anr.reset();
    this.anr.setPreset(this.getAnrPresetForMode(m));
    // Update AGC preset for new mode
    this.agc.setPreset(this.getAgcPresetForMode(m));
    this.agc.reset();
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
    // Map 0-1 strength to ANR gain.
    // At 0: gain = 0 (true passthrough, no adaptation)
    // At 1: gain = 5e-4 (aggressive adaptation)
    if (strength <= 0) {
      this.anr.setOptions({ gain: 0 });
    } else {
      const gain = strength * 5e-4;
      this.anr.setOptions({ gain });
    }
  }

  setNbEnabled(enabled: boolean): void {
    store.setNbEnabled(enabled);
    // NB is now server-side — send command to server
    this.send({ cmd: 'set_pre_filter_nb', enabled });
  }

  setNbLevel(level: number): void {
    store.setNbLevel(level);
    // Map 0-1 to threshold 20-2 (inverted: higher level = lower threshold = more aggressive)
    // 2 = very aggressive (audible on any signal — blanks anything 2× above average)
    // 20 = gentle (only blanks strong impulses 20× above average)
    const threshold = Math.round(20 - level * 18);
    this.send({ cmd: 'set_pre_filter_nb_threshold', threshold });
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
      case 'am-stereo': return 'am';
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
      case 'am-stereo': return 'am';
      default: return 'ssb'; // default works for FM too (NR usually off for FM)
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
    this.waterfallWorker?.postMessage({ type: 'set-theme', theme });
  }

  setWaterfallRange(minDb: number, maxDb: number): void {
    // Manual range adjustment disables auto-range
    store.setWaterfallAutoRange(false);
    store.setWaterfallMin(minDb);
    store.setWaterfallMax(maxDb);
    this.waterfallWorker?.postMessage({ type: 'set-range', minDb, maxDb });
    this.spectrum?.setRange(minDb, maxDb);
  }

  setWaterfallGamma(gamma: number): void {
    store.setWaterfallGamma(gamma);
    this.waterfallWorker?.postMessage({ type: 'set-gamma', gamma });
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

  /** Get the peak dB value at a canvas X pixel on the spectrum — used by tooltip. */
  getSpectrumPeakDbAtPixel(canvasX: number): number | null {
    const pd = this.spectrum?.peakDbValues;
    if (!pd) return null;
    const idx = Math.max(0, Math.min(pd.length - 1, Math.round(canvasX)));
    return pd[idx];
  }

  /** Get the max dB over last ~1 second at a canvas X pixel — used by tooltip. */
  getSpectrumTooltipPeakDbAtPixel(canvasX: number): number | null {
    const pd = this.spectrum?.tooltipPeakDb;
    if (!pd) return null;
    const idx = Math.max(0, Math.min(pd.length - 1, Math.round(canvasX)));
    return pd[idx];
  }

  setSpectrumNoiseFloor(enabled: boolean): void {
    store.setSpectrumNoiseFloor(enabled);
    this.spectrum?.setNoiseFloor(enabled);
  }

  /**
   * Update spectrum accent color after a UI theme change.
   * Call immediately after setting data-theme on the root element so the
   * renderer picks up the new CSS variable value.
   */
  setSpectrumAccentColor(): void {
    const color = getComputedStyle(document.documentElement)
      .getPropertyValue('--sdr-freq-color').trim();
    if (color) this.spectrum?.setAccentColor(color);
  }

  /**
   * Set zoom viewport from two X fractions [0,1] of the full bandwidth.
   * Both spectrum and waterfall renderers are updated.
   */
  setSpectrumZoom(start: number, end: number): void {
    store.setSpectrumZoom([start, end]);
    this.spectrum?.setZoom(start, end);
    this.waterfallWorker?.postMessage({ type: 'set-zoom', start, end });
    // Defer waterfall prefill to next rAF — multiple wheel events within one
    // frame collapse into a single redraw instead of blocking on every tick.
    this.scheduleWaterfallPrefill();
  }

  resetSpectrumZoom(): void {
    store.setSpectrumZoom([0, 1]);
    this.spectrum?.resetZoom();
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

  /** Whether audio has been initialised (user has clicked to enable). */
  get isAudioInitialized(): boolean { return this.audio.isInitialized; }

  /** AnalyserNode for the audio spectrum display. Null until audio is initialised. */
  getAudioAnalyser(): AnalyserNode | null { return this.audio.getAnalyser(); }

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
    // Apply all persisted audio settings to the Web Audio graph
    this.audio.setVolume(store.volume());
    this.audio.setBalance(store.balance());
    this.audio.setEqLow(store.eqLow());
    this.audio.setEqLowMid(store.eqLowMid());
    this.audio.setEqMid(store.eqMid());
    this.audio.setEqHighMid(store.eqHighMid());
    this.audio.setEqHigh(store.eqHigh());
    this.audio.setLoudness(store.loudness());
    this.nr.setNrEnabled(false);  // Legacy spectral NR disabled — replaced by LMS ANR
    this.nr.setNrStrength(0);
    this.nr.setNbEnabled(false);  // Legacy client NB disabled — replaced by server pre-filter NB
    this.nr.setNbLevel(0);
    // Restore LMS ANR state
    this.anr.setPreset(this.getAnrPresetForMode(store.mode()));
    this.anr.setEnabled(store.nrEnabled());
    if (store.nrStrength()) {
      const gain = 5e-5 + store.nrStrength() * 4.5e-4;
      this.anr.setOptions({ gain });
    }
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

    // For Opus codec path: initialise the WASM decoder with the correct
    // channel count before sending audio_enabled. On a fresh page load
    // setIqCodec() is never called (codec comes from persisted store), so
    // the decoder is null. We must await it here so the first packets are
    // not silently dropped while the decoder is still initialising.
    if (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq') {
      const expectedChannels = store.stereoEnabled() ? 2 : 1;
      if (!this.opusDecoderReady || this.opusDecoderChannels !== expectedChannels) {
        await this.initOpusDecoder(expectedChannels);
      }
    }

    // Tell server to start sending IQ data now that audio is enabled
    this.send({ cmd: 'audio_enabled', enabled: true });
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
    this.fftDecodeWorker.terminate();
    this.fftAnalysisWorker.terminate();
    this.waterfallWorker?.terminate();
  }
}

// Singleton engine instance
export const engine = new SdrEngine();
