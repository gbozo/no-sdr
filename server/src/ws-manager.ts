// ============================================================
// node-sdr — WebSocket Client Manager
// ============================================================
// Manages WebSocket connections, subscriptions, and message routing.
// Handles the binary protocol defined in @node-sdr/shared/protocol.
// ============================================================

import type { WSContext } from 'hono/ws';
import {
  type ClientCommand,
  type CodecType,
  type ServerMeta,
  type ClientSession,
  type DongleProfile,
  packBinaryMessage,
  packMetaMessage,
  packFftMessage,
  packCompressedFftMessage,
  compressFft,
  packIqMessage,
  packFftAdpcmMessage,
  packIqAdpcmMessage,
  packIqVbrMessage,
  MSG_FFT,
  MSG_FFT_COMPRESSED,
  MSG_FFT_ADPCM,
  MSG_IQ,
  MSG_IQ_ADPCM,
  MSG_IQ_VBR,
  MSG_DECODER,
  ImaAdpcmEncoder,
  encodeFftAdpcm,
  VbrEncoder,
  packVbrBlocks,
} from '@node-sdr/shared';
import { DongleManager } from './dongle-manager.js';
import { DecoderManager, type DecoderMessage } from './decoder-manager.js';
import { FftProcessor } from './fft-processor.js';
import { IqExtractor, getOutputSampleRate } from './iq-extractor.js';
import { logger } from './logger.js';

interface ConnectedClient {
  id: string;
  ws: WSContext;
  session: ClientSession;
  isAdmin: boolean;
  iqExtractor: IqExtractor | null;
  /** Per-client codec preferences (default: 'none' = uncompressed) */
  fftCodec: CodecType;
  iqCodec: CodecType;
  /** Per-client ADPCM encoder for IQ stream (stateful, streaming) */
  iqAdpcmEncoder: ImaAdpcmEncoder | null;
  /** Per-client VBR encoder for IQ stream (stateful, streaming) */
  iqVbrEncoder: VbrEncoder | null;
}

export class WebSocketManager {
  private clients = new Map<string, ConnectedClient>();
  private fftProcessors = new Map<string, FftProcessor>(); // dongleId -> processor
  private clientIdCounter = 0;

  constructor(
    private dongleManager: DongleManager,
    private decoderManager: DecoderManager,
    private adminPasswordHash: string,
  ) {
    this.setupDongleListeners();
    this.setupDecoderListeners();
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
    });

    this.dongleManager.on('dongle-stopped', (dongleId: string) => {
      this.fftProcessors.delete(dongleId);
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

      // Notify all clients on this dongle
      this.broadcastToDongle(dongleId, packMetaMessage({
        type: 'profile_changed',
        dongleId,
        profileId: profile.id,
        centerFreq: profile.centerFrequency,
        sampleRate: profile.sampleRate,
        fftSize: profile.fftSize,
        iqSampleRate: getOutputSampleRate(profile.defaultMode),
        mode: profile.defaultMode,
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

  private handleIqData(dongleId: string, data: Buffer): void {
    const processor = this.fftProcessors.get(dongleId);
    if (!processor) {
      if (this.iqCount++ % 100 === 0) {
        logger.warn({ dongleId }, 'No FFT processor for dongle (IQ data dropped)');
      }
      return;
    }

    this.iqCount++;
    this.iqBytes += data.length;
    const fftFrames = processor.processIqData(data);

    // Broadcast FFT to all clients subscribed to this dongle.
    // Each client gets their preferred codec:
    //   'none'  → MSG_FFT_COMPRESSED (Uint8 quantization, ~4x reduction)
    //   'adpcm' → MSG_FFT_ADPCM (ADPCM on Int16 dB×100, ~8x reduction)
    const FFT_MIN_DB = -130;
    const FFT_MAX_DB = 0;

    for (const fftData of fftFrames) {
      this.fftCount++;

      // Pre-encode both formats lazily (only if at least one client needs them)
      let uint8Msg: ArrayBuffer | null = null;
      let adpcmMsg: ArrayBuffer | null = null;

      for (const client of this.clients.values()) {
        if (client.session.dongleId !== dongleId) continue;
        try {
          const raw = client.ws.raw as any;
          if (raw?.bufferedAmount !== undefined && raw.bufferedAmount > WebSocketManager.BACKPRESSURE_THRESHOLD) {
            if (!this.backpressureWarned.has(client.id)) {
              logger.warn({ clientId: client.id, buffered: raw.bufferedAmount }, 'Backpressure: skipping FFT frame for slow client');
              this.backpressureWarned.add(client.id);
            }
            continue;
          }
          if (this.backpressureWarned.has(client.id)) {
            this.backpressureWarned.delete(client.id);
          }

          if (client.fftCodec === 'adpcm') {
            if (!adpcmMsg) {
              const adpcmPayload = encodeFftAdpcm(fftData, FFT_MIN_DB, FFT_MAX_DB);
              adpcmMsg = packFftAdpcmMessage(adpcmPayload);
            }
            client.ws.send(adpcmMsg);
          } else {
            if (!uint8Msg) {
              const compressed = compressFft(fftData, FFT_MIN_DB, FFT_MAX_DB);
              uint8Msg = packCompressedFftMessage(compressed, FFT_MIN_DB, FFT_MAX_DB);
            }
            client.ws.send(uint8Msg);
          }
        } catch {
          // Client may have disconnected
        }
      }
    }

    // Send per-client IQ sub-band (frequency-shifted + decimated).
    // IQ data is critical for audio continuity, so we use a higher
    // backpressure threshold (1 MB) before dropping.
    // Each client gets their preferred codec:
    //   'none'  → MSG_IQ (raw Int16, no compression)
    //   'adpcm' → MSG_IQ_ADPCM (4:1 compression, streaming state per client)
    const IQ_BACKPRESSURE = 1024 * 1024;
    for (const client of this.clients.values()) {
      if (client.session.dongleId === dongleId && client.iqExtractor && client.session.audioEnabled) {
        try {
          const raw = client.ws.raw as any;
          if (raw?.bufferedAmount !== undefined && raw.bufferedAmount > IQ_BACKPRESSURE) {
            // Skip IQ for severely congested clients
            continue;
          }
          const subBand = client.iqExtractor.process(data);
          if (subBand.length > 0) {
            this.iqOutSamples += subBand.length / 2; // count IQ pairs

            if (client.iqCodec === 'adpcm' && client.iqAdpcmEncoder) {
              const adpcm = client.iqAdpcmEncoder.encode(subBand);
              client.ws.send(packIqAdpcmMessage(adpcm, subBand.length));
            } else if (client.iqCodec === 'vbr' && client.iqVbrEncoder) {
              const blocks = client.iqVbrEncoder.encode(subBand);
              if (blocks.length > 0) {
                const packed = packVbrBlocks(blocks);
                client.ws.send(packIqVbrMessage(packed));
              }
            } else {
              client.ws.send(packIqMessage(subBand));
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
      const subscriberCount = [...this.clients.values()].filter(c => c.session.dongleId === dongleId).length;
      const elapsed = (now - this.lastLogTime) / 1000;
      const iqSamplesPerSec = Math.round(this.iqBytes / 2 / elapsed); // 2 bytes per IQ pair (uint8 I + uint8 Q)
      const iqOutSPS = Math.round(this.iqOutSamples / elapsed);
      logger.info({
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
  handleConnection(ws: WSContext): string {
    const clientId = `client-${++this.clientIdCounter}`;

    const client: ConnectedClient = {
      id: clientId,
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
      iqVbrEncoder: null,
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
        this.handleSubscribe(client, cmd.dongleId, cmd.profileId);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(client);
        break;

      case 'tune':
        client.session.tuneOffset = cmd.offset;
        client.iqExtractor?.setTuneOffset(cmd.offset);
        client.iqExtractor?.reset();
        break;

      case 'mode':
        client.session.mode = cmd.mode as any;
        client.iqExtractor?.setOutputSampleRate(getOutputSampleRate(cmd.mode));
        client.iqExtractor?.reset();
        break;

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

      case 'waterfall_settings':
        // Client-side only, acknowledged
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

      default:
        this.sendMeta(client.ws, { type: 'error', message: `Unknown command: ${(cmd as any).cmd}` });
    }
  }

  private handleSubscribe(client: ConnectedClient, dongleId: string, profileId?: string): void {
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
    });

    this.sendMeta(client.ws, {
      type: 'subscribed',
      dongleId,
      profileId: profile.id,
      centerFreq: profile.centerFrequency,
      sampleRate: profile.sampleRate,
      fftSize: profile.fftSize,
      iqSampleRate: iqOutputRate,
      mode: profile.defaultMode,
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

  private handleCodecChange(client: ConnectedClient, cmd: ClientCommand & { cmd: 'codec' }): void {
    if (cmd.fftCodec !== undefined) {
      client.fftCodec = cmd.fftCodec;
      logger.info({ clientId: client.id, fftCodec: cmd.fftCodec }, 'Client FFT codec changed');
    }
    if (cmd.iqCodec !== undefined) {
      client.iqCodec = cmd.iqCodec;
      if (cmd.iqCodec === 'adpcm') {
        // Create or reset per-client ADPCM encoder
        if (!client.iqAdpcmEncoder) {
          client.iqAdpcmEncoder = new ImaAdpcmEncoder();
        } else {
          client.iqAdpcmEncoder.reset();
        }
        client.iqVbrEncoder = null;
      } else if (cmd.iqCodec === 'vbr') {
        // Create or reset per-client VBR encoder
        if (!client.iqVbrEncoder) {
          client.iqVbrEncoder = new VbrEncoder();
        } else {
          client.iqVbrEncoder.reset();
        }
        client.iqAdpcmEncoder = null;
      } else {
        client.iqAdpcmEncoder = null;
        client.iqVbrEncoder = null;
      }
      logger.info({ clientId: client.id, iqCodec: cmd.iqCodec }, 'Client IQ codec changed');
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
}
