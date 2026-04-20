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
  type ServerMeta,
  type ClientCommand,
} from '@node-sdr/shared';
import { WaterfallRenderer } from './waterfall.js';
import { SpectrumRenderer } from './spectrum.js';
import { AudioEngine } from './audio.js';
import { getDemodulator, resetDemodulator, type Demodulator } from './demodulators.js';
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

    switch (type) {
      case MSG_FFT: {
        const fftData = new Float32Array(payload);
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
        // Decompress uint8 to float32 dB values
        const compressed = new Uint8Array(payload);
        const fftData = new Float32Array(compressed.length);
        const minDb = store.waterfallMin();
        const range = store.waterfallMax() - minDb;
        for (let i = 0; i < compressed.length; i++) {
          fftData[i] = minDb + (compressed[i] / 255) * range;
        }
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
        const audioSamples = this.demodulator.process(iqData);
        if (audioSamples.length > 0) {
          this.audio.pushDemodulatedAudio(audioSamples);
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
        break;

      case 'profile_changed':
        store.setCenterFrequency(meta.centerFreq);
        store.setSampleRate(meta.sampleRate);
        store.setFftSize(meta.fftSize);
        // Reset waterfall
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
    this.send({ cmd: 'tune', offset: offsetHz });
  }

  setMode(mode: string): void {
    store.setMode(mode as any);
    // Switch to the appropriate demodulator
    this.demodulator = getDemodulator(mode as any);
    this.demodulator.setBandwidth(store.bandwidth());
    this.send({ cmd: 'mode', mode });
  }

  setBandwidth(hz: number): void {
    store.setBandwidth(hz);
    this.demodulator.setBandwidth(hz);
    this.send({ cmd: 'bandwidth', hz });
  }

  setSquelch(db: number | null): void {
    store.setSquelch(db);
    this.send({ cmd: 'squelch', db });
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

  // ---- Display Settings ----

  setWaterfallTheme(theme: string): void {
    store.setWaterfallTheme(theme as any);
    this.waterfall?.setTheme(theme as any);
  }

  setWaterfallRange(minDb: number, maxDb: number): void {
    store.setWaterfallMin(minDb);
    store.setWaterfallMax(maxDb);
    this.waterfall?.setRange(minDb, maxDb);
    this.spectrum?.setRange(minDb, maxDb);
  }

  // ---- Audio ----

  async initAudio(): Promise<void> {
    await this.audio.init();
    this.audio.setVolume(store.volume());
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
