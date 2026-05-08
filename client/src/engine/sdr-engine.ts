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
  type FftCodecType,
  type IqCodecType,
  type DemodMode,
} from '~/shared';
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
import { ALL_FFT_CODECS, ALL_IQ_CODECS } from '../store/index.js';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private opusDecoder: OpusDecoder<any> | null = null;
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

  // Soft mute: smoothed gain factor (0-1) based on signal level
  private softMuteGain = 1.0;

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

  /** Attach RDS callback to current demodulator if it supports RDS */
  private attachRdsCallback(): void {
    if (this.demodulator.setRdsCallback) {
      this.demodulator.setRdsCallback((data: RdsData) => {
        store.setRdsPs(data.ps);
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

    // FIX: Terminate existing worker before creating new one (remount case)
    if (this.waterfallWorker) {
      this.waterfallWorker.terminate();
      this.waterfallWorker = null;
    }

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
      // FIX: Clear activeDongleId so state_sync triggers resubscription on reconnect
      store.setActiveDongleId('');
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
          this.applySoftMuteStereo(resampled.left, resampled.right);
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
        store.setClientId(meta.clientId);
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
         // Send stereo_enabled BEFORE codec: the server stores it at the clientPipeline level
         // so when codec creates the Opus pipeline it already uses the correct stereo preference.
         // This prevents the first packets from being stereo when stereoEnabled=false.
         if (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq' || store.iqCodec() === 'opus-lo') {
           this.send({ cmd: 'stereo_enabled', enabled: store.stereoEnabled() });
         }
         this.send({ cmd: 'codec', fftCodec: store.fftCodec(), iqCodec: store.iqCodec() });

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
          this.send({ cmd: 'mode', mode: prevMode, bandwidth: bw });
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
          // Client is a dumb terminal: the Opus decoder lifecycle is managed
          // exclusively by MSG_AUDIO_OPUS based on the wire channel header.
          // Do NOT pre-init here — just enable audio and let the server drive.
          this.send({ cmd: 'audio_enabled', enabled: true });
        }

        // Request waterfall history to prefill the display immediately
        this.send({ cmd: 'request_history' });

        // Re-send noise blanker state (persisted in localStorage but not part of subscribe reset)
        if (store.nbEnabled()) {
          this.send({ cmd: 'set_pre_filter_nb', enabled: true });
          this.send({ cmd: 'set_pre_filter_nb_threshold', threshold: store.nbLevel() });
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
        store.setTuneOffset(0);
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
          clientCount: 0,
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
          clientCount: 0,
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

      case 'config_saved':
        if (meta.version) store.setConfigVersion(meta.version);
        console.log('[SDR] Config saved (version:', meta.version, ')');
        break;

      case 'dongle_disconnected':
        console.warn(`[SDR] Dongle disconnected: ${meta.dongleId} (${meta.reason})`);
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

      case 'codec_status':
        if (!meta.accepted) {
          console.warn(`[SDR] Codec ${meta.codec} rejected: ${meta.reason}`);
        }
        break;
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
    this.demodulator = getDemodulator(m);
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
    // Send mode + bandwidth together so server can set RF filter correctly
    this.send({ cmd: 'mode', mode, bandwidth: store.bandwidth() });
    this.updateMediaSession();
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
    // Map 0-1 strength to ANR gain.
    // At 0: gain = 0 (true passthrough, no adaptation)
    // At 1: gain = 1e-4 (moderate adaptation — safe for all signal types)
    if (strength <= 0) {
      this.anr.setOptions({ gain: 0 });
    } else {
      const gain = strength * 1e-4;
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
    this.spectrum?.resize();
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

// Singleton engine instance
export const engine = new SdrEngine();
