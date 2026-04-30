// ============================================================
// node-sdr — WebSocket Client Manager
// ============================================================
// Manages WebSocket connections, subscriptions, and message routing.
// Handles the binary protocol defined in @node-sdr/shared/protocol.
// ============================================================

import type { WSContext } from 'hono/ws';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import {
  type ClientCommand,
  type CodecType,
  type ServerMeta,
  type ClientSession,
  type DongleProfile,
  type DemodMode,
  packBinaryMessage,
  packMetaMessage,
  packFftMessage,
  packCompressedFftMessage,
  compressFft,
  packIqMessage,
  packFftAdpcmMessage,
  packFftDeflateMessage,
  packIqAdpcmMessage,
  packAudioOpusMessage,
  packFftHistoryMessage,
  packFftHistoryDeflateMessage,
  packFftHistoryAdpcmMessage,
  packRdsMessage,
  FFT_HISTORY_CODEC_NONE,
  FFT_HISTORY_CODEC_DEFLATE,
  FFT_HISTORY_CODEC_ADPCM,
  MSG_FFT,
  MSG_FFT_COMPRESSED,
  MSG_FFT_ADPCM,
  MSG_FFT_DEFLATE,
  MSG_IQ,
  MSG_IQ_ADPCM,
  MSG_AUDIO_OPUS,
  MSG_DECODER,
  ImaAdpcmEncoder,
  encodeFftAdpcm,
} from '@node-sdr/shared';
import { DongleManager } from './dongle-manager.js';
import { DecoderManager, type DecoderMessage } from './decoder-manager.js';
import { FftProcessor } from './fft-processor.js';
import { FftHistoryBuffer, FFT_HISTORY_MIN_DB, FFT_HISTORY_MAX_DB } from './fft-history.js';
import { IqExtractor, getOutputSampleRate } from './iq-extractor.js';
import { OpusAudioPipeline } from './opus-audio.js';
import { logger } from './logger.js';

/**
 * Target IQ chunk duration in seconds.
 * Server accumulates IQ extractor output into fixed-size chunks before sending.
 * This ensures the client receives evenly-sized pieces regardless of how data
 * arrives from the dongle (variable TCP/pipe chunks). Reduces jitter and
 * improves audio continuity in the client AudioWorklet.
 */
const IQ_CHUNK_DURATION_S = 0.020; // 20ms — matches Opus frame size

interface ConnectedClient {
  id: string;
  ip: string;
  ws: WSContext;
  session: ClientSession;
  isAdmin: boolean;
  iqExtractor: IqExtractor | null;
  /** Per-client codec preferences (default: 'none' = uncompressed) */
  fftCodec: CodecType;
  iqCodec: CodecType;
  /** Per-client ADPCM encoder for IQ stream (stateful, streaming) */
  iqAdpcmEncoder: ImaAdpcmEncoder | null;
  /** Pre-allocated output scratch for IQ ADPCM encode — avoids allocation per chunk */
  iqAdpcmScratch: Uint8Array | null;
  /** Per-client Opus audio pipeline (server-side demod + encode) */
  opusPipeline: OpusAudioPipeline | null;
  /** IQ accumulation buffer for fixed-chunk sending (non-Opus codecs only) */
  iqAccumBuffer: Int16Array | null;
  /** Current write position in iqAccumBuffer (in Int16 elements) */
  iqAccumPos: number;
  /** Target chunk size in Int16 elements (IQ pairs × 2) */
  iqAccumTarget: number;
}

export class WebSocketManager {
  private clients = new Map<string, ConnectedClient>();
  private fftProcessors = new Map<string, FftProcessor>(); // dongleId -> processor
  private fftHistories  = new Map<string, FftHistoryBuffer>(); // dongleId -> history
  /**
   * Per-dongle EMA of the per-frame minimum bin dB value, used by the
   * 'deflate-floor' codec to adaptively clamp the below-noise region.
   * Smoothing factor alpha=0.05 gives a ~20-frame (~0.7s at 30fps) time constant
   * — fast enough to track slow band changes, slow enough to ignore transients.
   * Initialised to FFT_MIN_DB so the first real frame immediately pulls it up.
   */
  private fftNoiseFloorEma = new Map<string, number>(); // dongleId -> smoothed floor dB
  private static readonly NOISE_FLOOR_EMA_ALPHA = 0.05;
  /**
   * Percentile of the Uint8-quantised bin distribution used as the per-frame
   * noise floor sample fed into the EMA.  5 = 5th percentile.
   * Using a low percentile (rather than the absolute minimum) makes the estimate
   * robust against isolated quiet bins or spectral troughs that would otherwise
   * drag the floor estimate far below the true noise level, eliminating the need
   * for a fixed margin on top.
   */
  private static readonly NOISE_FLOOR_PERCENTILE = 5;
  private clientIdCounter = 0;

  /** Per-IP connection counts for rate limiting */
  private ipConnections = new Map<string, number>();
  private static readonly MAX_CONNECTIONS_PER_IP = 10;

  /** Number of FFT frames to keep per dongle — enough to fill a 1080p waterfall. */
  private static readonly HISTORY_CAPACITY = 1024;

  // Pre-allocated scratch buffers for FFT encoding
  private readonly fftScratchDelta   = Buffer.allocUnsafe(65536);
  private readonly fftScratchClamped = new Uint8Array(65536);
  private readonly fftScratchHist    = new Uint32Array(256);

  // CPU usage tracking — process.cpuUsage() gives cumulative µs
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime  = Date.now();
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private dongleManager: DongleManager,
    private decoderManager: DecoderManager,
    private adminPasswordHash: string,
    private config: import('./config.js').ValidatedConfig,
  ) {
    this.setupDongleListeners();
    this.setupDecoderListeners();
    this.startStatsTimer();
  }

  private startStatsTimer(): void {
    // Broadcast server stats (CPU %, memory, client count) every 2 seconds.
    this.statsTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastCpuTime; // ms
      const cpu = process.cpuUsage(this.lastCpuUsage); // µs since last sample
      // CPU% = (user + system µs) / (elapsed ms × 1000 µs/ms) × 100
      const cpuPercent = Math.min(100, Math.round((cpu.user + cpu.system) / (elapsed * 10)));
      const memMb = Math.round(process.memoryUsage().rss / 1_048_576);
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuTime  = now;

      const msg = packMetaMessage({
        type: 'server_stats',
        cpuPercent,
        memMb,
        clients: this.clients.size,
      });

      // Broadcast to all connected clients
      for (const client of this.clients.values()) {
        try { client.ws.send(msg); } catch { /* disconnected */ }
      }
    }, 2000);
    this.statsTimer.unref();
  }

  private setupDongleListeners(): void {
    // When IQ data arrives from a dongle, process FFT and broadcast
    this.dongleManager.on('iq-data', (dongleId: string, data: Buffer) => {
      this.handleIqData(dongleId, data);
    });

    this.dongleManager.on('dongle-started', (dongleId: string, profile: DongleProfile) => {
      // Create FFT processor for this dongle
      this.fftProcessors.set(dongleId, new FftProcessor({
        fftSize: profile.fftSize,
        sampleRate: profile.sampleRate,
        averaging: 0.3,
        targetFps: profile.fftFps,
      }));
      // Create or reset history buffer — stored at historyFftSize, live at profile.fftSize
      const historyBins = this.config.server.fftHistoryFftSize;
      const existing = this.fftHistories.get(dongleId);
      if (existing) {
        existing.setLiveBinCount(profile.fftSize);
      } else {
        this.fftHistories.set(dongleId, new FftHistoryBuffer(
          WebSocketManager.HISTORY_CAPACITY, historyBins, profile.fftSize,
        ));
      }
    });

    this.dongleManager.on('dongle-stopped', (dongleId: string) => {
      this.fftProcessors.delete(dongleId);
      this.fftHistories.get(dongleId)?.reset();
      this.fftNoiseFloorEma.delete(dongleId);
      this.broadcastToDongle(dongleId, packMetaMessage({
        type: 'dongle_status',
        dongleId,
        running: false,
        clientCount: 0,
      }));
    });

    this.dongleManager.on('profile-changed', (dongleId: string, profile: DongleProfile) => {
      // Reset FFT processor
      const processor = this.fftProcessors.get(dongleId);
      if (processor) {
        processor.reset();
        processor.resize(profile.fftSize);
      } else {
        this.fftProcessors.set(dongleId, new FftProcessor({
          fftSize: profile.fftSize,
          sampleRate: profile.sampleRate,
          averaging: 0.3,
          targetFps: profile.fftFps,
        }));
      }
      // Reset history for the new profile (live fftSize may have changed)
      const historyBins = this.config.server.fftHistoryFftSize;
      const history = this.fftHistories.get(dongleId);
      if (history) {
        history.setLiveBinCount(profile.fftSize);
      } else {
        this.fftHistories.set(dongleId, new FftHistoryBuffer(
          WebSocketManager.HISTORY_CAPACITY, historyBins, profile.fftSize,
        ));
      }
      // Reset adaptive noise floor EMA so the new band's floor is learned fresh
      this.fftNoiseFloorEma.delete(dongleId);

      // Rebuild IQ extractors for all clients on this dongle with the new profile's sample rate
      const iqOutputRate = getOutputSampleRate(profile.defaultMode);
      for (const client of this.clients.values()) {
        if (client.session.dongleId === dongleId) {
          client.session.mode = profile.defaultMode;
          client.session.bandwidth = profile.defaultBandwidth;
          client.session.tuneOffset = profile.defaultTuneOffset;
          client.iqExtractor = new IqExtractor({
            inputSampleRate: profile.sampleRate,
            outputSampleRate: iqOutputRate,
            tuneOffset: profile.defaultTuneOffset,
            ...this.getDspOptions(dongleId, profile),
          });
          this.resetIqAccumBuffer(client, iqOutputRate);
          // Reset ADPCM encoder — new profile invalidates predictor state
          client.iqAdpcmEncoder?.reset();
          // Rebuild Opus pipeline if active
          if (client.opusPipeline) {
            client.opusPipeline.setMode(profile.defaultMode, iqOutputRate);
          }
        }
      }

      // Notify all clients on this dongle
      this.broadcastToDongle(dongleId, packMetaMessage({
        type: 'profile_changed',
        dongleId,
        profileId: profile.id,
        centerFreq: profile.centerFrequency,
        sampleRate: profile.sampleRate,
        fftSize: profile.fftSize,
        iqSampleRate: iqOutputRate,
        mode: profile.defaultMode,
        tuningStep: profile.tuningStep ?? 0,
      }));
    });
  }

  private setupDecoderListeners(): void {
    // When a decoder produces a message, broadcast to subscribers of that dongle
    this.decoderManager.on('decoder-message', (msg: DecoderMessage) => {
      const decoderPayload = packMetaMessage({
        type: 'decoder_data',
        decoderType: msg.decoderType,
        dongleId: msg.dongleId,
        timestamp: msg.timestamp,
        data: msg.data,
      } as any);

      this.broadcastToDongle(msg.dongleId, decoderPayload);
    });

    this.decoderManager.on('decoder-started', (dongleId: string, mode: string) => {
      logger.info({ dongleId, mode }, 'Decoder started, notifying clients');
    });

    this.decoderManager.on('decoder-error', (dongleId: string, mode: string, error: Error) => {
      logger.error({ dongleId, mode, error: error.message }, 'Decoder error');
    });
  }

  /**
   * Handle IQ data from a dongle: compute FFT, broadcast to subscribers
   */
  private iqCount = 0;
  private fftCount = 0;
  private iqBytes = 0;
  private iqOutSamples = 0;
  private lastLogTime = 0;

  private readonly deflateRawAsync = promisify(deflateRaw);

  private handleIqData(dongleId: string, data: Buffer): void {
    // Fire-and-forget: async work runs in the microtask queue, freeing this
    // event-loop tick immediately. deflateRaw runs on libuv's thread pool.
    this._handleIqDataAsync(dongleId, data).catch(err => {
      logger.error({ err, dongleId }, 'handleIqData error');
    });
  }

  private async _handleIqDataAsync(dongleId: string, rawData: Buffer): Promise<void> {
    const processor = this.fftProcessors.get(dongleId);
    if (!processor) {
      if (this.iqCount++ % 100 === 0) {
        logger.warn({ dongleId }, 'No FFT processor for dongle (IQ data dropped)');
      }
      return;
    }

    // Defensive copy — Node.js stream internals reuse the underlying buffer
    // for the next read. Any await below yields the event loop, which would
    // let the next chunk overwrite `rawData` before the IQ extractor runs.
    const data = Buffer.from(rawData);

    // Swap I/Q channels if the active profile requests it (fixes inverted spectrum)
    const profile = this.dongleManager.getActiveProfile(dongleId);
    if (profile?.swapIQ) {
      for (let i = 0; i < data.length - 1; i += 2) {
        const tmp = data[i];
        data[i] = data[i + 1];
        data[i + 1] = tmp;
      }
    }

    this.iqCount++;
    this.iqBytes += data.length;

    // ── IQ per-client sub-band ────────────────────────────────────────────
    // Runs FIRST — fully synchronous, before any await.
    // This guarantees we read from `data` while it is still valid and that
    // IQ extraction is never delayed or interleaved with the next chunk.
    const IQ_BACKPRESSURE = 1024 * 1024;
    for (const client of this.clients.values()) {
      if (client.session.dongleId !== dongleId) continue;
      if (!client.iqExtractor || !client.session.audioEnabled) continue;
      try {
        const raw = client.ws.raw as any;
        if (raw?.bufferedAmount !== undefined && raw.bufferedAmount > IQ_BACKPRESSURE) continue;
        const subBand = client.iqExtractor.process(data);
        if (subBand.length > 0) {
          this.iqOutSamples += subBand.length / 2;
          if ((client.iqCodec === 'opus' || client.iqCodec === 'opus-hq') && client.opusPipeline) {
            const packets = client.opusPipeline.process(subBand);
            for (const { packet, samples, stereo, rdsData } of packets) {
              client.ws.send(packAudioOpusMessage(packet, samples, stereo ? 2 : 1));
              if (rdsData !== null) client.ws.send(packRdsMessage(rdsData));
            }
          } else {
            this.accumulateAndSendIq(client, subBand);
          }
        }
      } catch {
        // Client may have disconnected
      }
    }

    // ── FFT broadcast ─────────────────────────────────────────────────────
    // Runs after IQ. Any async deflate awaits happen here, safely after
    // IQ data has already been consumed from `data`.
    const fftFrames = processor.processIqData(data);

    // Broadcast FFT to all clients.
    // Codec messages are built lazily (only when the first client needing them is found).
    const FFT_MIN_DB = -130;
    const FFT_MAX_DB = 0;

    // Scratch buffers — pre-allocated, no per-frame heap allocation
    const scratchDelta   = this.fftScratchDelta;
    const scratchClamped = this.fftScratchClamped;
    const scratchHist    = this.fftScratchHist;

    for (const fftData of fftFrames) {
      this.fftCount++;
      this.fftHistories.get(dongleId)?.push(fftData);

      // Pre-compute deflate outside the client loop so the await doesn't
      // suspend the client iterator (which would make it unsafe to iterate
      // a Map whose entries may change while awaiting).
      let uint8Data: Uint8Array | null = null;
      let deflateMsg: ArrayBuffer | null = null;
      let deflateFloorMsg: ArrayBuffer | null = null;

      // Determine which deflate codecs any client actually needs — only compress if needed
      let needsDeflate = false;
      let needsDeflateFloor = false;
      for (const client of this.clients.values()) {
        if (client.session.dongleId !== dongleId) continue;
        if (client.fftCodec === 'deflate') needsDeflate = true;
        if (client.fftCodec === 'deflate-floor') needsDeflateFloor = true;
      }

      // Compute deflate payloads before entering the client iterator
      if (needsDeflate || needsDeflateFloor) {
        if (!uint8Data) uint8Data = compressFft(fftData, FFT_MIN_DB, FFT_MAX_DB);
        const n = uint8Data.length;

        if (needsDeflate) {
          scratchDelta[0] = uint8Data[0];
          for (let i = 1; i < n; i++) {
            scratchDelta[i] = (uint8Data[i] - uint8Data[i - 1]) & 0xFF;
          }
          const deflated = await this.deflateRawAsync(scratchDelta.subarray(0, n), { level: 6 });
          deflateMsg = packFftDeflateMessage(
            new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength),
            FFT_MIN_DB, FFT_MAX_DB, n,
          );
        }

        if (needsDeflateFloor) {
          scratchHist.fill(0);
          for (let i = 0; i < n; i++) scratchHist[uint8Data[i]]++;
          const target = Math.ceil(n * WebSocketManager.NOISE_FLOOR_PERCENTILE / 100);
          let cumulative = 0;
          let percentileIdx = 0;
          for (let b = 0; b < 256; b++) {
            cumulative += scratchHist[b];
            if (cumulative >= target) { percentileIdx = b; break; }
          }
          const prevEmaIdx = this.fftNoiseFloorEma.get(dongleId) ?? percentileIdx;
          const emaIdx = prevEmaIdx + WebSocketManager.NOISE_FLOOR_EMA_ALPHA * (percentileIdx - prevEmaIdx);
          this.fftNoiseFloorEma.set(dongleId, emaIdx);
          const floorIdx = Math.max(0, Math.min(255, Math.round(emaIdx)));
          for (let i = 0; i < n; i++) {
            scratchClamped[i] = uint8Data[i] < floorIdx ? floorIdx : uint8Data[i];
          }
          scratchDelta[0] = scratchClamped[0];
          for (let i = 1; i < n; i++) {
            scratchDelta[i] = (scratchClamped[i] - scratchClamped[i - 1]) & 0xFF;
          }
          const deflatedFloor = await this.deflateRawAsync(scratchDelta.subarray(0, n), { level: 6 });
          deflateFloorMsg = packFftDeflateMessage(
            new Uint8Array(deflatedFloor.buffer, deflatedFloor.byteOffset, deflatedFloor.byteLength),
            FFT_MIN_DB, FFT_MAX_DB, n,
          );
        }
      }

      // Now iterate clients synchronously — no more awaits in this loop
      let uint8Msg: ArrayBuffer | null = null;
      let adpcmMsg: ArrayBuffer | null = null;

      for (const client of this.clients.values()) {
        if (client.session.dongleId !== dongleId) continue;

        try {
          const raw = client.ws.raw as any;
          const fftBackpressure = raw?.bufferedAmount !== undefined && raw.bufferedAmount > WebSocketManager.BACKPRESSURE_THRESHOLD;
          if (fftBackpressure) {
            if (!this.backpressureWarned.has(client.id)) {
              logger.warn({ clientId: client.id, buffered: raw.bufferedAmount }, 'Backpressure: skipping FFT frame for slow client');
              this.backpressureWarned.add(client.id);
            }
          } else {
            if (this.backpressureWarned.has(client.id)) {
              this.backpressureWarned.delete(client.id);
            }

            if (client.fftCodec === 'adpcm') {
              if (!adpcmMsg) {
                const adpcmPayload = encodeFftAdpcm(fftData, FFT_MIN_DB, FFT_MAX_DB);
                adpcmMsg = packFftAdpcmMessage(adpcmPayload);
              }
              client.ws.send(adpcmMsg);
            } else if (client.fftCodec === 'deflate') {
              if (deflateMsg) client.ws.send(deflateMsg);
            } else if (client.fftCodec === 'deflate-floor') {
              if (deflateFloorMsg) client.ws.send(deflateFloorMsg);
            } else {
              if (!uint8Msg) {
                if (!uint8Data) uint8Data = compressFft(fftData, FFT_MIN_DB, FFT_MAX_DB);
                uint8Msg = packCompressedFftMessage(uint8Data, FFT_MIN_DB, FFT_MAX_DB);
              }
              client.ws.send(uint8Msg);
            }
          }
        } catch {
          // Client may have disconnected
        }
      }
    }

    // Log throughput every 5 seconds
    const now = Date.now();
    if (now - this.lastLogTime > 5000) {
      // Count subscribers without creating a temporary array
      let subscriberCount = 0;
      for (const c of this.clients.values()) {
        if (c.session.dongleId === dongleId) subscriberCount++;
      }
      const elapsed = (now - this.lastLogTime) / 1000;
      const iqSamplesPerSec = Math.round(this.iqBytes / 2 / elapsed); // 2 bytes per IQ pair (uint8 I + uint8 Q)
      const iqOutSPS = Math.round(this.iqOutSamples / elapsed);
      logger.debug({
        dongleId,
        iqChunks: this.iqCount,
        fftFrames: this.fftCount,
        subscribers: subscriberCount,
        iqBytesTotal: this.iqBytes,
        iqSPS: iqSamplesPerSec,
        iqOutSPS,
        expectedSPS: 2400000,
      }, 'IQ/FFT throughput');

      this.iqCount = 0;
      this.fftCount = 0;
      this.iqBytes = 0;
      this.iqOutSamples = 0;
      this.lastLogTime = now;
    }
  }

  /**
   * Handle a new WebSocket connection
   */
  handleConnection(ws: WSContext, ip = 'unknown'): string {
    // Rate limit: reject if this IP already has too many connections
    const currentCount = this.ipConnections.get(ip) ?? 0;
    if (currentCount >= WebSocketManager.MAX_CONNECTIONS_PER_IP) {
      logger.warn({ ip, currentCount }, 'Rate limit: rejecting connection');
      this.sendMeta(ws, { type: 'error', message: 'Too many connections from your IP', code: 'RATE_LIMITED' });
      try { (ws.raw as any)?.close(1008, 'Rate limited'); } catch { /* ignore */ }
      return '';
    }
    this.ipConnections.set(ip, currentCount + 1);

    const clientId = `client-${++this.clientIdCounter}`;

    const client: ConnectedClient = {
      id: clientId,
      ip,
      ws,
      session: {
        id: clientId,
        dongleId: '',
        tuneOffset: 0,
        mode: 'nfm',
        bandwidth: 12_500,
        volume: 0.8,
        squelch: null,
        muted: false,
        audioEnabled: false,
      },
      isAdmin: false,
      iqExtractor: null,
      fftCodec: 'none',
      iqCodec: 'none',
      iqAdpcmEncoder: null,
      iqAdpcmScratch: null,
      opusPipeline: null,
      iqAccumBuffer: null,
      iqAccumPos: 0,
      iqAccumTarget: 0,
    };

    this.clients.set(clientId, client);

    // Send welcome message
    this.sendMeta(ws, {
      type: 'welcome',
      clientId,
      serverVersion: '0.1.0',
    });

    logger.info({ clientId, total: this.clients.size }, 'Client connected');
    return clientId;
  }

  /**
   * Handle WebSocket disconnection
   */
  handleDisconnection(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      if (client.session.dongleId) {
        this.dongleManager.updateClientCount(client.session.dongleId, -1);
      }
      // Decrement per-IP connection count
      const ipCount = (this.ipConnections.get(client.ip) ?? 1) - 1;
      if (ipCount <= 0) this.ipConnections.delete(client.ip);
      else this.ipConnections.set(client.ip, ipCount);
      // Clean up WASM resources
      client.opusPipeline?.destroy();
      this.clients.delete(clientId);
      logger.info({ clientId, total: this.clients.size }, 'Client disconnected');
    }
  }

  /**
   * Handle an incoming message from a client
   */
  handleMessage(clientId: string, data: string | ArrayBuffer): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Client messages are always JSON text
    if (typeof data !== 'string') {
      logger.warn({ clientId }, 'Unexpected binary message from client');
      return;
    }

    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(data);
    } catch {
      this.sendMeta(client.ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    this.processCommand(client, cmd);
  }

  private processCommand(client: ConnectedClient, cmd: ClientCommand): void {
    switch (cmd.cmd) {
      case 'subscribe':
        this.handleSubscribe(client, cmd.dongleId, cmd.profileId).catch(err => {
          logger.error({ err, clientId: client.id }, 'Subscribe handler failed');
        });
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(client);
        break;

      case 'tune':
        client.session.tuneOffset = cmd.offset;
        client.iqExtractor?.setTuneOffset(cmd.offset);
        client.iqExtractor?.reset();
        // Flush IQ accumulation buffer — zero-fill so no stale samples bleed through
        client.iqAccumPos = 0;
        client.iqAccumBuffer?.fill(0);
        // Reset ADPCM encoder — predictor state is invalid after frequency change
        client.iqAdpcmEncoder?.reset();
        break;

      case 'mode': {
        client.session.mode = cmd.mode as any;
        const newRate = getOutputSampleRate(cmd.mode);
        client.iqExtractor?.setOutputSampleRate(newRate);
        client.iqExtractor?.reset();
        // Reset IQ accumulation buffer for new sample rate
        this.resetIqAccumBuffer(client, newRate);
        // Reset ADPCM encoder — sample rate change invalidates predictor
        client.iqAdpcmEncoder?.reset();
        // Update Opus pipeline for new mode/rate
        if (client.opusPipeline) {
          client.opusPipeline.setMode(cmd.mode as DemodMode, newRate);
        }
        break;
      }

      case 'bandwidth':
        client.session.bandwidth = cmd.hz;
        break;

      case 'squelch':
        client.session.squelch = cmd.db;
        break;

      case 'volume':
        client.session.volume = Math.max(0, Math.min(1, cmd.level));
        break;

      case 'mute':
        client.session.muted = cmd.muted;
        break;

      case 'audio_enabled':
        client.session.audioEnabled = cmd.enabled;
        logger.info({ clientId: client.id, audioEnabled: cmd.enabled }, 'Client audio state changed');
        break;

      case 'stereo_enabled':
        if (client.opusPipeline) {
          client.opusPipeline.setStereoEnabled(cmd.enabled);
          logger.info({ clientId: client.id, stereoEnabled: cmd.enabled }, 'Client stereo preference changed');
        }
        break;

      case 'waterfall_settings':
        // Client-side only, acknowledged
        break;

      case 'set_pre_filter_nb':
      case 'set_pre_filter_nb_threshold':
        // NB disabled — commands ignored (kept for protocol compatibility)
        break;

      case 'codec':
        this.handleCodecChange(client, cmd);
        break;

      case 'admin_auth':
        this.handleAdminAuth(client, cmd.password);
        break;

      case 'admin_set_profile':
        this.handleAdminSetProfile(client, cmd.dongleId, cmd.profileId);
        break;

      case 'admin_stop_dongle':
        this.handleAdminStopDongle(client, cmd.dongleId);
        break;

      case 'admin_start_dongle':
        this.handleAdminStartDongle(client, cmd.dongleId);
        break;

      case 'request_history':
        this.handleRequestHistory(client).catch(err => {
          logger.error({ err, clientId: client.id }, 'handleRequestHistory error');
        });
        break;

      default:
        this.sendMeta(client.ws, { type: 'error', message: `Unknown command: ${(cmd as any).cmd}` });
    }
  }

  /**
   * Reset the IQ accumulation buffer for a client.
   * The buffer size targets IQ_CHUNK_DURATION_S of IQ data at the given sample rate.
   * For WFM at 240kHz: 20ms × 240000 = 4800 IQ pairs = 9600 Int16 values.
   * For NFM at 48kHz: 20ms × 48000 = 960 IQ pairs = 1920 Int16 values.
   */
  /**
   * Get DSP options for IqExtractor from dongle + profile config.
   * Profile-level settings override dongle-level defaults.
   */
  private getDspOptions(dongleId: string, profile: DongleProfile) {
    const dongleConfig = this.config.dongles.find(d => d.id === dongleId);
    const dcDefault = dongleConfig?.dcOffsetRemoval ?? true; // default ON
    return {
      dcOffsetRemoval: profile.dcOffsetRemoval ?? dcDefault,
      preFilterNb: false, // Disabled — NB not useful without real impulse noise sources
      preFilterNbThreshold: 10,
    };
  }

  private resetIqAccumBuffer(client: ConnectedClient, sampleRate: number): void {
    const iqPairs = Math.round(sampleRate * IQ_CHUNK_DURATION_S);
    const int16Elements = iqPairs * 2; // I + Q per pair
    client.iqAccumBuffer = new Int16Array(int16Elements);
    client.iqAccumPos = 0;
    client.iqAccumTarget = int16Elements;
  }

  /**
   * Accumulate IQ data and send fixed-size chunks.
   * Copies subBand data into the accumulation buffer and sends a message
   * every time the buffer reaches the target size.
   */
  private accumulateAndSendIq(client: ConnectedClient, subBand: Int16Array): void {
    if (!client.iqAccumBuffer) {
      // No accumulation buffer — send directly (shouldn't happen)
      this.sendIqDirect(client, subBand);
      return;
    }

    let offset = 0;
    while (offset < subBand.length) {
      const remaining = client.iqAccumTarget - client.iqAccumPos;
      const toCopy = Math.min(remaining, subBand.length - offset);

      client.iqAccumBuffer.set(subBand.subarray(offset, offset + toCopy), client.iqAccumPos);
      client.iqAccumPos += toCopy;
      offset += toCopy;

      if (client.iqAccumPos >= client.iqAccumTarget) {
        // Buffer full — send the fixed-size chunk
        this.sendIqDirect(client, client.iqAccumBuffer);
        client.iqAccumPos = 0;
      }
    }
  }

  /**
   * Send IQ data directly using the client's selected codec.
   */
  private sendIqDirect(client: ConnectedClient, iqData: Int16Array): void {
    if (client.iqCodec === 'adpcm' && client.iqAdpcmEncoder) {
      // Grow scratch if IQ chunk is larger than expected (e.g. after mode change)
      const needed = Math.ceil(iqData.length / 2);
      if (!client.iqAdpcmScratch || client.iqAdpcmScratch.length < needed) {
        client.iqAdpcmScratch = new Uint8Array(needed * 2);
      }
      const adpcm = client.iqAdpcmEncoder.encode(iqData, client.iqAdpcmScratch);
      client.ws.send(packIqAdpcmMessage(adpcm, iqData.length));
    } else {
      client.ws.send(packIqMessage(iqData));
    }
  }

  private async handleSubscribe(client: ConnectedClient, dongleId: string, profileId?: string): Promise<void> {
    // Unsubscribe from previous dongle
    if (client.session.dongleId) {
      this.dongleManager.updateClientCount(client.session.dongleId, -1);
    }

    const dongle = this.dongleManager.getDongle(dongleId);
    if (!dongle) {
      this.sendMeta(client.ws, { type: 'error', message: `Unknown dongle: ${dongleId}`, code: 'UNKNOWN_DONGLE' });
      return;
    }

    if (!dongle.running) {
      this.sendMeta(client.ws, { type: 'error', message: `Dongle ${dongleId} is not running`, code: 'DONGLE_STOPPED' });
      return;
    }

    // If a specific profile was requested and it differs from the active one, switch to it.
    // This restarts the dongle with the new profile (affects all clients on this dongle).
    if (profileId && dongle.activeProfileId !== profileId) {
      try {
        await this.dongleManager.switchProfile(dongleId, profileId);
      } catch (err) {
        this.sendMeta(client.ws, { type: 'error', message: (err as Error).message, code: 'PROFILE_SWITCH_FAILED' });
        return;
      }
    }

    const profile = this.dongleManager.getActiveProfile(dongleId);
    if (!profile) {
      this.sendMeta(client.ws, { type: 'error', message: `No active profile for ${dongleId}`, code: 'NO_PROFILE' });
      return;
    }

    client.session.dongleId = dongleId;
    client.session.mode = profile.defaultMode;
    client.session.bandwidth = profile.defaultBandwidth;
    client.session.tuneOffset = profile.defaultTuneOffset;
    this.dongleManager.updateClientCount(dongleId, 1);

    // Create per-client IQ extractor for demodulation
    const iqOutputRate = getOutputSampleRate(profile.defaultMode);
    client.iqExtractor = new IqExtractor({
      inputSampleRate: profile.sampleRate,
      outputSampleRate: iqOutputRate,
      tuneOffset: profile.defaultTuneOffset,
      ...this.getDspOptions(dongleId, profile),
    });

    // Set up IQ accumulation buffer for fixed-chunk sending
    this.resetIqAccumBuffer(client, iqOutputRate);

    this.sendMeta(client.ws, {
      type: 'subscribed',
      dongleId,
      profileId: profile.id,
      centerFreq: profile.centerFrequency,
      sampleRate: profile.sampleRate,
      fftSize: profile.fftSize,
      iqSampleRate: iqOutputRate,
      mode: profile.defaultMode,
      tuningStep: profile.tuningStep ?? 0,
    });

    logger.info(
      { clientId: client.id, dongleId, profileId: profile.id },
      'Client subscribed to dongle',
    );
  }

  private handleUnsubscribe(client: ConnectedClient): void {
    if (client.session.dongleId) {
      this.dongleManager.updateClientCount(client.session.dongleId, -1);
      client.session.dongleId = '';
    }
  }

  /**
   * Send waterfall history to a client as a single MSG_FFT_HISTORY burst.
   * Compression is controlled by server.fftHistoryCompression config.
   * No-ops silently if the client isn't subscribed or there's no history yet.
   */
  private async handleRequestHistory(client: ConnectedClient): Promise<void> {
    const dongleId = client.session.dongleId;
    if (!dongleId) return;

    const history = this.fftHistories.get(dongleId);
    if (!history || history.count === 0) return;

    const frames = history.getFrames();
    const frameCount = frames.length;
    const binCount = history.binCount;
    const compression = this.config.server.fftHistoryCompression ?? 'deflate';

    try {
      let msg: ArrayBuffer;

      if (compression === 'deflate') {
        // Concatenate all Uint8 frames into one buffer, delta-encode, deflate
        const total = frameCount * binCount;
        const flat = new Uint8Array(total);
        for (let i = 0; i < frameCount; i++) {
          flat.set(frames[i], i * binCount);
        }
        const delta = Buffer.allocUnsafe(total);
        delta[0] = flat[0];
        for (let i = 1; i < total; i++) {
          delta[i] = (flat[i] - flat[i - 1]) & 0xFF;
        }
        const deflated = await this.deflateRawAsync(delta, { level: 6 });
        msg = packFftHistoryDeflateMessage(
          new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength),
          frameCount, binCount, FFT_HISTORY_MIN_DB, FFT_HISTORY_MAX_DB,
        );
        logger.debug(
          { clientId: client.id, dongleId, frames: frameCount, rawBytes: total, compressedBytes: deflated.byteLength },
          'Sent waterfall history (deflate)',
        );

      } else if (compression === 'adpcm') {
        // Concatenate all frames into a single Float32 dB array, then ADPCM encode.
        // History is stored as Uint8 (0-255 quantized), so dequantize first.
        const total = frameCount * binCount;
        const float32 = new Float32Array(total);
        const range = FFT_HISTORY_MAX_DB - FFT_HISTORY_MIN_DB;
        for (let i = 0; i < frameCount; i++) {
          const frame = frames[i];
          const off = i * binCount;
          for (let b = 0; b < binCount; b++) {
            float32[off + b] = FFT_HISTORY_MIN_DB + (frame[b] / 255) * range;
          }
        }
        const adpcmPayload = encodeFftAdpcm(float32, FFT_HISTORY_MIN_DB, FFT_HISTORY_MAX_DB);
        msg = packFftHistoryAdpcmMessage(
          adpcmPayload,
          frameCount, binCount, FFT_HISTORY_MIN_DB, FFT_HISTORY_MAX_DB,
        );
        logger.debug(
          { clientId: client.id, dongleId, frames: frameCount, rawBytes: total, compressedBytes: adpcmPayload.byteLength },
          'Sent waterfall history (adpcm)',
        );

      } else {
        // none — raw Uint8 frames
        msg = packFftHistoryMessage(frames, binCount, FFT_HISTORY_MIN_DB, FFT_HISTORY_MAX_DB);
        logger.debug(
          { clientId: client.id, dongleId, frames: frameCount },
          'Sent waterfall history (none)',
        );
      }

      client.ws.send(msg);
    } catch (err) {
      logger.error({ clientId: client.id, error: (err as Error).message }, 'Failed to send waterfall history');
    }
  }

  private handleCodecChange(client: ConnectedClient, cmd: ClientCommand & { cmd: 'codec' }): void {
    if (cmd.fftCodec !== undefined) {
      client.fftCodec = cmd.fftCodec;
      logger.info({ clientId: client.id, fftCodec: cmd.fftCodec }, 'Client FFT codec changed');
    }
    if (cmd.iqCodec !== undefined) {
      client.iqCodec = cmd.iqCodec;
      // Reset previous codec state
      client.iqAdpcmEncoder = null;
      client.opusPipeline?.destroy();
      client.opusPipeline = null;
      // Flush IQ accumulation buffer
      client.iqAccumPos = 0;

      if (cmd.iqCodec === 'adpcm') {
        client.iqAdpcmEncoder = new ImaAdpcmEncoder();
        // Pre-allocate scratch sized for WFM 20ms chunk (worst case: 4800 IQ pairs × 2 ch × 2 bytes = 19200 int16 → 9600 adpcm bytes)
        client.iqAdpcmScratch = new Uint8Array(Math.ceil(client.iqAccumTarget / 2) || 9600);
      } else if (cmd.iqCodec === 'opus' || cmd.iqCodec === 'opus-hq') {
        if (OpusAudioPipeline.isAvailable()) {
          const mode = (client.session.mode || 'nfm') as DemodMode;
          const iqRate = getOutputSampleRate(mode);
          const hq = cmd.iqCodec === 'opus-hq';
          client.opusPipeline = new OpusAudioPipeline(mode, iqRate, hq);
          logger.info({ clientId: client.id, mode, iqRate, hq }, 'Opus pipeline created');
        } else {
          logger.warn({ clientId: client.id }, 'Opus requested but opusscript not available — falling back to none');
          client.iqCodec = 'none';
        }
      }
      logger.info({ clientId: client.id, iqCodec: client.iqCodec }, 'Client IQ codec changed');
    }
  }

  private async handleAdminAuth(client: ConnectedClient, password: string): Promise<void> {
    // Simple plaintext comparison for now (bcrypt comparison for production)
    if (password === this.adminPasswordHash) {
      client.isAdmin = true;
      this.sendMeta(client.ws, { type: 'admin_auth_ok' });
      logger.info({ clientId: client.id }, 'Admin authenticated');
    } else {
      this.sendMeta(client.ws, { type: 'error', message: 'Invalid admin password', code: 'AUTH_FAILED' });
    }
  }

  private async handleAdminSetProfile(client: ConnectedClient, dongleId: string, profileId: string): Promise<void> {
    if (!client.isAdmin) {
      this.sendMeta(client.ws, { type: 'error', message: 'Not authorized', code: 'UNAUTHORIZED' });
      return;
    }
    try {
      await this.dongleManager.switchProfile(dongleId, profileId);
    } catch (err) {
      this.sendMeta(client.ws, { type: 'error', message: (err as Error).message });
    }
  }

  private async handleAdminStopDongle(client: ConnectedClient, dongleId: string): Promise<void> {
    if (!client.isAdmin) {
      this.sendMeta(client.ws, { type: 'error', message: 'Not authorized', code: 'UNAUTHORIZED' });
      return;
    }
    try {
      await this.dongleManager.stopDongle(dongleId);
    } catch (err) {
      this.sendMeta(client.ws, { type: 'error', message: (err as Error).message });
    }
  }

  private async handleAdminStartDongle(client: ConnectedClient, dongleId: string): Promise<void> {
    if (!client.isAdmin) {
      this.sendMeta(client.ws, { type: 'error', message: 'Not authorized', code: 'UNAUTHORIZED' });
      return;
    }
    try {
      await this.dongleManager.startDongle(dongleId);
    } catch (err) {
      this.sendMeta(client.ws, { type: 'error', message: (err as Error).message });
    }
  }

  // Backpressure: max bytes queued per client before we start dropping FFT frames.
  // 256 KB is generous — at ~60 KB/s compressed FFT + IQ, this is ~4 seconds of buffer.
  private static readonly BACKPRESSURE_THRESHOLD = 256 * 1024;
  private backpressureWarned = new Set<string>();

  /**
   * Broadcast a binary message to all clients subscribed to a dongle.
   * Applies backpressure: skips clients whose send buffer exceeds the threshold.
   * This prevents unbounded memory growth when a client's network is slow.
   */
  private broadcastToDongle(dongleId: string, data: ArrayBuffer): void {
    for (const client of this.clients.values()) {
      if (client.session.dongleId === dongleId) {
        try {
          // Check backpressure via the underlying ws WebSocket's bufferedAmount
          const raw = client.ws.raw as any;
          if (raw?.bufferedAmount !== undefined && raw.bufferedAmount > WebSocketManager.BACKPRESSURE_THRESHOLD) {
            // Skip this frame for this slow client
            if (!this.backpressureWarned.has(client.id)) {
              logger.warn(
                { clientId: client.id, buffered: raw.bufferedAmount },
                'Backpressure: skipping FFT frame for slow client',
              );
              this.backpressureWarned.add(client.id);
            }
            continue;
          }
          // Clear warning flag when buffer drains
          if (this.backpressureWarned.has(client.id)) {
            this.backpressureWarned.delete(client.id);
          }
          client.ws.send(data);
        } catch {
          // Client may have disconnected
        }
      }
    }
  }

  /**
   * Send a JSON metadata message to a specific client
   */
  private sendMeta(ws: WSContext, meta: ServerMeta): void {
    try {
      ws.send(packMetaMessage(meta));
    } catch {
      // Client may have disconnected
    }
  }

  /**
   * Get count of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get status of all dongles including client counts
   */
  getStatus() {
    return {
      totalClients: this.clients.size,
      dongles: this.dongleManager.getDongles(),
      decoders: this.decoderManager.getRunningDecoders(),
    };
  }

  destroy(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }
}
