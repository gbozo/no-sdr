// ============================================================
// node-sdr — Dongle Manager
// ============================================================
// Manages RTL-SDR connections via three source types:
//   - local:   spawn rtl_sdr as child process (IQ on stdout)
//   - rtl_tcp: connect as TCP client to remote rtl_tcp server
//   - demo:    use built-in signal simulator
// ============================================================

import { ChildProcess, spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { DongleProfile, DongleInfo, SourceType } from '@node-sdr/shared';
import type { ValidatedConfig } from './config.js';
import { SignalSimulator, getSimulationForProfile } from './signal-simulator.js';
import { logger } from './logger.js';

export interface DongleEvents {
  'iq-data': (dongleId: string, data: Buffer) => void;
  'dongle-started': (dongleId: string, profile: DongleProfile) => void;
  'dongle-stopped': (dongleId: string) => void;
  'dongle-error': (dongleId: string, error: Error) => void;
  'profile-changed': (dongleId: string, profile: DongleProfile) => void;
}

interface DongleState {
  config: ValidatedConfig['dongles'][number];
  process: ChildProcess | null;
  socket: Socket | null;
  simulator: SignalSimulator | null;
  activeProfile: DongleProfile | null;
  running: boolean;
  clientCount: number;
  restartCount: number;
  lastError: string | null;
  /** Tracks whether we've received the rtl_tcp 12-byte dongle info header */
  rtlTcpHeaderReceived: boolean;
}

// ---- rtl_tcp protocol constants ----
// rtl_tcp command structure: 1 byte command + 4 bytes parameter (big-endian)
const RTL_TCP_CMD_SET_FREQ            = 0x01;
const RTL_TCP_CMD_SET_SAMPLERATE      = 0x02;
const RTL_TCP_CMD_SET_GAIN_MODE       = 0x03; // 0=auto, 1=manual
const RTL_TCP_CMD_SET_GAIN            = 0x04; // gain in tenths of dB
const RTL_TCP_CMD_SET_FREQ_CORR       = 0x05; // PPM
const RTL_TCP_CMD_SET_IF_GAIN         = 0x06; // (stage << 16) | (gain & 0xFFFF), gain in tenths of dB
const RTL_TCP_CMD_SET_TEST_MODE       = 0x07; // 0=off, 1=on
const RTL_TCP_CMD_SET_AGC_MODE        = 0x08; // 0=off, 1=on (RTL2832U digital AGC)
const RTL_TCP_CMD_SET_DIRECT_SAMPLING = 0x09; // 0=off, 1=I-ADC, 2=Q-ADC
const RTL_TCP_CMD_SET_OFFSET_TUNING   = 0x0A; // 0=off, 1=on
const RTL_TCP_CMD_SET_RTL_XTAL        = 0x0B; // Hz
const RTL_TCP_CMD_SET_TUNER_XTAL      = 0x0C; // Hz
const RTL_TCP_CMD_SET_GAIN_BY_INDEX   = 0x0D; // index into gain table
const RTL_TCP_CMD_SET_BIAS_TEE        = 0x0E; // 0=off, 1=on
const RTL_TCP_HEADER_SIZE             = 12;   // "RTL0" magic + tuner type (4) + gain count (4)

export class DongleManager extends EventEmitter {
  private dongles = new Map<string, DongleState>();
  private readonly maxRestarts = 5;
  private readonly restartDelay = 2000; // ms
  private readonly demoMode: boolean;

  constructor(private config: ValidatedConfig) {
    super();
    this.demoMode = config.server.demoMode || !!process.env.NODE_SDR_DEMO;
    if (this.demoMode) {
      logger.info('Demo mode enabled — using simulated IQ data (no hardware required)');
    }
    this.initDongles();
  }

  private initDongles(): void {
    for (const dongleConfig of this.config.dongles) {
      this.dongles.set(dongleConfig.id, {
        config: dongleConfig,
        process: null,
        socket: null,
        simulator: null,
        activeProfile: null,
        running: false,
        clientCount: 0,
        restartCount: 0,
        lastError: null,
        rtlTcpHeaderReceived: false,
      });
    }
    logger.info({ dongles: this.dongles.size }, 'Dongles initialized');
  }

  /**
   * Resolve the effective source type for a dongle.
   * Global demoMode overrides per-dongle source to 'demo'.
   */
  private getEffectiveSource(state: DongleState): SourceType {
    if (this.demoMode) return 'demo';
    return state.config.source?.type ?? 'local';
  }

  /**
   * Start a dongle with the given profile. If already running, stops first.
   */
  async startDongle(dongleId: string, profileId?: string): Promise<void> {
    const state = this.dongles.get(dongleId);
    if (!state) {
      throw new Error(`Unknown dongle: ${dongleId}`);
    }

    // Resolve profile
    const profile = profileId
      ? state.config.profiles.find((p) => p.id === profileId)
      : state.config.profiles[0];

    if (!profile) {
      throw new Error(`Unknown profile: ${profileId} for dongle ${dongleId}`);
    }

    // Stop if already running
    if (state.running) {
      await this.stopDongle(dongleId);
    }

    const sourceType = this.getEffectiveSource(state);

    logger.info(
      {
        dongleId,
        profile: profile.id,
        source: sourceType,
        centerFreq: profile.centerFrequency,
        sampleRate: profile.sampleRate,
      },
      'Starting dongle',
    );

    state.activeProfile = profile as DongleProfile;
    state.restartCount = 0;

    switch (sourceType) {
      case 'demo':
        this.startSimulator(dongleId, state, profile as DongleProfile);
        break;
      case 'rtl_tcp':
        this.connectRtlTcp(dongleId, state, profile as DongleProfile);
        break;
      case 'local':
      default:
        this.spawnRtlProcess(dongleId, state, profile as DongleProfile);
        break;
    }
  }

  // ----------------------------------------------------------------
  // Source: local (spawn rtl_sdr child process)
  // ----------------------------------------------------------------

  private spawnRtlProcess(dongleId: string, state: DongleState, profile: DongleProfile): void {
    const source = state.config.source ?? { type: 'local' as const };
    const binary = source.binary ?? 'rtl_sdr';

    // Build rtl_sdr arguments
    const args: string[] = [
      '-d', state.config.deviceIndex.toString(),
      '-f', profile.centerFrequency.toString(),
      '-s', profile.sampleRate.toString(),
      '-p', state.config.ppmCorrection.toString(),
    ];

    // Gain: null = auto, number = manual
    if (profile.gain !== null && profile.gain !== undefined) {
      args.push('-g', profile.gain.toString());
    }

    // Direct sampling mode (HF reception)
    if (state.config.directSampling && state.config.directSampling > 0) {
      args.push('-D', state.config.directSampling.toString());
    }

    // Tuner bandwidth (requires rtl-sdr-blog fork or compatible binary with -w flag)
    if (state.config.tunerBandwidth && state.config.tunerBandwidth > 0) {
      args.push('-w', state.config.tunerBandwidth.toString());
    }

    // Extra args from source config
    if (source.extraArgs?.length) {
      args.push(...source.extraArgs);
    }

    // Output to stdout (pipe)
    args.push('-');

    logger.debug({ dongleId, cmd: binary, args }, 'Spawning rtl_sdr process');

    try {
      const proc = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      state.process = proc;
      state.running = true;

      // IQ data arrives on stdout as raw bytes (uint8 interleaved I/Q)
      proc.stdout!.on('data', (chunk: Buffer) => {
        this.emit('iq-data', dongleId, chunk);
      });

      proc.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          // rtl_sdr prints info to stderr (e.g., "Found 1 device")
          logger.debug({ dongleId, stderr: msg }, 'rtl_sdr stderr');
        }
      });

      proc.on('error', (err) => {
        logger.error({ dongleId, error: err.message }, 'rtl_sdr process error');
        state.lastError = err.message;
        state.running = false;
        this.emit('dongle-error', dongleId, err);
        this.scheduleRestart(dongleId, state, profile, 'local');
      });

      proc.on('exit', (code, signal) => {
        logger.info({ dongleId, code, signal }, 'rtl_sdr process exited');
        state.running = false;
        state.process = null;

        if (code !== 0 && signal !== 'SIGTERM') {
          this.scheduleRestart(dongleId, state, profile, 'local');
        } else {
          this.emit('dongle-stopped', dongleId);
        }
      });

      this.emit('dongle-started', dongleId, profile);

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ dongleId, error: error.message }, 'Failed to spawn rtl_sdr');
      state.lastError = error.message;
      state.running = false;
      this.emit('dongle-error', dongleId, error);
    }
  }

  // ----------------------------------------------------------------
  // Source: rtl_tcp (TCP client to remote rtl_tcp server)
  // ----------------------------------------------------------------

  /**
   * Connect to a remote rtl_tcp server via TCP.
   *
   * rtl_tcp protocol:
   *   1. Server sends 12-byte header: "RTL0" (4B) + tuner type (4B BE) + gain count (4B BE)
   *   2. Server then streams raw uint8 interleaved I/Q continuously
   *   3. Client sends 5-byte commands: cmd (1B) + param (4B BE)
   */
  private connectRtlTcp(dongleId: string, state: DongleState, profile: DongleProfile): void {
    const source = state.config.source ?? { type: 'rtl_tcp' as const };
    const host = source.host ?? '127.0.0.1';
    const port = source.port ?? 1234;

    logger.info({ dongleId, host, port }, 'Connecting to rtl_tcp server');

    const socket = new Socket();
    state.socket = socket;
    state.rtlTcpHeaderReceived = false;

    // Buffer for accumulating data until we've consumed the header
    let headerBuf = Buffer.alloc(0);

    socket.on('connect', () => {
      logger.info({ dongleId, host, port }, 'Connected to rtl_tcp server');
      state.running = true;

      // Send initial configuration commands
      this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_FREQ, profile.centerFrequency);
      this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_SAMPLERATE, profile.sampleRate);
      this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_FREQ_CORR, state.config.ppmCorrection);

      if (profile.gain !== null && profile.gain !== undefined) {
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_GAIN_MODE, 1); // manual gain
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_GAIN, Math.round(profile.gain * 10)); // tenths of dB
      } else {
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_GAIN_MODE, 0); // auto gain
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_AGC_MODE, 1);  // enable AGC
      }

      // ---- Hardware options (dongle-level) ----

      // Direct sampling (HF reception via I/Q-ADC bypass)
      if (state.config.directSampling !== undefined && state.config.directSampling > 0) {
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_DIRECT_SAMPLING, state.config.directSampling);
        logger.info({ dongleId, mode: state.config.directSampling }, 'Direct sampling enabled');
      }

      // Bias-T power on antenna connector
      if (state.config.biasT) {
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_BIAS_TEE, 1);
        logger.info({ dongleId }, 'Bias-T enabled');
      }

      // RTL2832U digital AGC
      if (state.config.digitalAgc) {
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_AGC_MODE, 1);
        logger.info({ dongleId }, 'Digital AGC enabled');
      }

      // Offset tuning (zero-IF shift, useful for E4000 tuner)
      if (state.config.offsetTuning) {
        this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_OFFSET_TUNING, 1);
        logger.info({ dongleId }, 'Offset tuning enabled');
      }

      // Tuner IF gain stages
      if (state.config.ifGain?.length) {
        for (const [stage, tenthsDb] of state.config.ifGain) {
          const param = ((stage & 0xFFFF) << 16) | (tenthsDb & 0xFFFF);
          this.rtlTcpSendCommand(socket, RTL_TCP_CMD_SET_IF_GAIN, param);
          logger.info({ dongleId, stage, gainTenthsDb: tenthsDb }, 'IF gain stage set');
        }
      }

      this.emit('dongle-started', dongleId, profile);
    });

    socket.on('data', (chunk: Buffer) => {
      if (!state.rtlTcpHeaderReceived) {
        // Accumulate until we have the 12-byte header
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length >= RTL_TCP_HEADER_SIZE) {
          // Parse header
          const magic = headerBuf.subarray(0, 4).toString('ascii');
          const tunerType = headerBuf.readUInt32BE(4);
          const gainCount = headerBuf.readUInt32BE(8);
          logger.info(
            { dongleId, magic, tunerType, gainCount },
            'rtl_tcp header received',
          );
          state.rtlTcpHeaderReceived = true;

          // Any remaining data after header is IQ
          const remaining = headerBuf.subarray(RTL_TCP_HEADER_SIZE);
          if (remaining.length > 0) {
            this.emit('iq-data', dongleId, remaining);
          }
          headerBuf = Buffer.alloc(0); // free
        }
      } else {
        // Normal IQ data flow
        this.emit('iq-data', dongleId, chunk);
      }
    });

    socket.on('error', (err) => {
      logger.error({ dongleId, host, port, error: err.message }, 'rtl_tcp connection error');
      state.lastError = err.message;
      state.running = false;
      state.socket = null;
      this.emit('dongle-error', dongleId, err);
      this.scheduleRestart(dongleId, state, profile, 'rtl_tcp');
    });

    socket.on('close', () => {
      logger.info({ dongleId }, 'rtl_tcp connection closed');
      const wasRunning = state.running;
      state.running = false;
      state.socket = null;

      if (wasRunning) {
        // Unexpected close — try to reconnect
        this.scheduleRestart(dongleId, state, profile, 'rtl_tcp');
      } else {
        this.emit('dongle-stopped', dongleId);
      }
    });

    socket.connect(port, host);
  }

  /**
   * Send a 5-byte rtl_tcp command packet
   */
  private rtlTcpSendCommand(socket: Socket, cmd: number, param: number): void {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(cmd, 0);
    buf.writeUInt32BE(param >>> 0, 1); // unsigned 32-bit
    socket.write(buf);
  }

  /**
   * Send a frequency change to a running rtl_tcp connection
   */
  setRtlTcpFrequency(dongleId: string, frequency: number): void {
    const state = this.dongles.get(dongleId);
    if (state?.socket && state.running) {
      this.rtlTcpSendCommand(state.socket, RTL_TCP_CMD_SET_FREQ, frequency);
    }
  }

  /**
   * Send a sample rate change to a running rtl_tcp connection
   */
  setRtlTcpSampleRate(dongleId: string, sampleRate: number): void {
    const state = this.dongles.get(dongleId);
    if (state?.socket && state.running) {
      this.rtlTcpSendCommand(state.socket, RTL_TCP_CMD_SET_SAMPLERATE, sampleRate);
    }
  }

  /**
   * Send a gain change to a running rtl_tcp connection
   */
  setRtlTcpGain(dongleId: string, gainDb: number | null): void {
    const state = this.dongles.get(dongleId);
    if (!state?.socket || !state.running) return;

    if (gainDb !== null) {
      this.rtlTcpSendCommand(state.socket, RTL_TCP_CMD_SET_GAIN_MODE, 1);
      this.rtlTcpSendCommand(state.socket, RTL_TCP_CMD_SET_GAIN, Math.round(gainDb * 10));
    } else {
      this.rtlTcpSendCommand(state.socket, RTL_TCP_CMD_SET_GAIN_MODE, 0);
      this.rtlTcpSendCommand(state.socket, RTL_TCP_CMD_SET_AGC_MODE, 1);
    }
  }

  // ----------------------------------------------------------------
  // Source: demo (signal simulator)
  // ----------------------------------------------------------------

  private startSimulator(dongleId: string, state: DongleState, profile: DongleProfile): void {
    const simOptions = getSimulationForProfile(profile.centerFrequency, profile.sampleRate);
    simOptions.fftSize = profile.fftSize;

    const simulator = new SignalSimulator(simOptions);

    simulator.on('data', (chunk: Buffer) => {
      this.emit('iq-data', dongleId, chunk);
    });

    simulator.start();
    state.simulator = simulator;
    state.running = true;

    logger.info(
      {
        dongleId,
        profile: profile.id,
        centerFreq: profile.centerFrequency,
        signals: simOptions.signals.length,
      },
      'Demo simulator started',
    );

    this.emit('dongle-started', dongleId, profile);
  }

  // ----------------------------------------------------------------
  // Restart / Stop
  // ----------------------------------------------------------------

  private scheduleRestart(
    dongleId: string,
    state: DongleState,
    profile: DongleProfile,
    sourceType: SourceType,
  ): void {
    if (state.restartCount >= this.maxRestarts) {
      logger.error(
        { dongleId, restarts: state.restartCount, sourceType },
        'Max restarts exceeded, giving up',
      );
      this.emit('dongle-error', dongleId, new Error('Max restarts exceeded'));
      return;
    }

    state.restartCount++;
    const delay = this.restartDelay * state.restartCount;
    logger.warn(
      { dongleId, restartCount: state.restartCount, delayMs: delay, sourceType },
      'Scheduling dongle restart',
    );

    setTimeout(() => {
      if (!state.running) {
        switch (sourceType) {
          case 'rtl_tcp':
            this.connectRtlTcp(dongleId, state, profile);
            break;
          case 'demo':
            this.startSimulator(dongleId, state, profile);
            break;
          case 'local':
          default:
            this.spawnRtlProcess(dongleId, state, profile);
            break;
        }
      }
    }, delay);
  }

  /**
   * Stop a running dongle (any source type)
   */
  async stopDongle(dongleId: string): Promise<void> {
    const state = this.dongles.get(dongleId);
    if (!state) {
      throw new Error(`Unknown dongle: ${dongleId}`);
    }

    // Stop simulator
    if (state.simulator) {
      logger.info({ dongleId }, 'Stopping simulator');
      state.simulator.stop();
      state.simulator = null;
      state.running = false;
      state.activeProfile = null;
      this.emit('dongle-stopped', dongleId);
      return;
    }

    // Close rtl_tcp socket
    if (state.socket) {
      logger.info({ dongleId }, 'Closing rtl_tcp connection');
      state.running = false; // prevent reconnect on close event
      state.socket.destroy();
      state.socket = null;
      state.activeProfile = null;
      this.emit('dongle-stopped', dongleId);
      return;
    }

    // Kill local rtl_sdr process
    if (state.process) {
      logger.info({ dongleId }, 'Stopping rtl_sdr process');
      state.process.kill('SIGTERM');

      // Force kill after 3 seconds
      const forceKillTimer = setTimeout(() => {
        if (state.process && !state.process.killed) {
          logger.warn({ dongleId }, 'Force killing dongle process');
          state.process.kill('SIGKILL');
        }
      }, 3000);

      await new Promise<void>((resolve) => {
        if (!state.process) {
          resolve();
          return;
        }
        state.process.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }

    state.running = false;
    state.process = null;
    state.activeProfile = null;
  }

  /**
   * Switch a dongle to a different profile. Restarts the connection.
   */
  async switchProfile(dongleId: string, profileId: string): Promise<void> {
    const state = this.dongles.get(dongleId);
    if (!state) {
      throw new Error(`Unknown dongle: ${dongleId}`);
    }

    const profile = state.config.profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    logger.info({ dongleId, profileId }, 'Switching profile');
    await this.startDongle(dongleId, profileId);
    this.emit('profile-changed', dongleId, profile as DongleProfile);
  }

  /**
   * Auto-start dongles that have autoStart enabled
   */
  async autoStartAll(): Promise<void> {
    for (const [dongleId, state] of this.dongles) {
      if (state.config.autoStart) {
        try {
          await this.startDongle(dongleId);
        } catch (err) {
          logger.error(
            { dongleId, error: (err as Error).message },
            'Failed to auto-start dongle',
          );
        }
      }
    }
  }

  /**
   * Stop all dongles gracefully
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.dongles.keys()).map((id) =>
      this.stopDongle(id).catch((err) => {
        logger.error({ dongleId: id, error: (err as Error).message }, 'Error stopping dongle');
      }),
    );
    await Promise.all(promises);
  }

  // ----------------------------------------------------------------
  // Profile CRUD (admin operations)
  // ----------------------------------------------------------------

  /**
   * Add a new profile to a dongle. Returns the updated profiles array.
   */
  addProfile(dongleId: string, profile: DongleProfile): DongleProfile[] {
    const state = this.dongles.get(dongleId);
    if (!state) throw new Error(`Unknown dongle: ${dongleId}`);

    // Check for duplicate ID
    if (state.config.profiles.some((p) => p.id === profile.id)) {
      throw new Error(`Profile ID already exists: ${profile.id}`);
    }

    state.config.profiles.push(profile as any);
    logger.info({ dongleId, profileId: profile.id }, 'Profile added');
    return state.config.profiles as DongleProfile[];
  }

  /**
   * Update an existing profile on a dongle. Returns the updated profile.
   * If the profile is currently active, the dongle is NOT restarted automatically.
   */
  updateProfile(dongleId: string, profileId: string, updates: Partial<DongleProfile>): DongleProfile {
    const state = this.dongles.get(dongleId);
    if (!state) throw new Error(`Unknown dongle: ${dongleId}`);

    const idx = state.config.profiles.findIndex((p) => p.id === profileId);
    if (idx === -1) throw new Error(`Unknown profile: ${profileId}`);

    // Merge updates (don't allow changing id)
    const existing = state.config.profiles[idx];
    const updated = { ...existing, ...updates, id: profileId };
    state.config.profiles[idx] = updated as any;

    logger.info({ dongleId, profileId }, 'Profile updated');
    return updated as DongleProfile;
  }

  /**
   * Delete a profile from a dongle. Cannot delete the last profile.
   * Cannot delete the currently active profile (must switch first).
   */
  deleteProfile(dongleId: string, profileId: string): void {
    const state = this.dongles.get(dongleId);
    if (!state) throw new Error(`Unknown dongle: ${dongleId}`);

    if (state.config.profiles.length <= 1) {
      throw new Error('Cannot delete the last profile — each dongle must have at least one');
    }

    if (state.activeProfile?.id === profileId) {
      throw new Error('Cannot delete the active profile — switch to another profile first');
    }

    const idx = state.config.profiles.findIndex((p) => p.id === profileId);
    if (idx === -1) throw new Error(`Unknown profile: ${profileId}`);

    state.config.profiles.splice(idx, 1);
    logger.info({ dongleId, profileId }, 'Profile deleted');
  }

  /**
   * Get the full config (for saving to disk)
   */
  getConfig(): ValidatedConfig {
    return this.config;
  }

  // ----------------------------------------------------------------
  // Info / Status
  // ----------------------------------------------------------------

  getDongles(): DongleInfo[] {
    return Array.from(this.dongles.entries()).map(([id, state]) => ({
      id,
      deviceIndex: state.config.deviceIndex,
      name: state.config.name,
      serial: state.config.serial ?? '',
      source: this.getEffectiveSource(state),
      activeProfileId: state.activeProfile?.id ?? null,
      ppmCorrection: state.config.ppmCorrection,
      running: state.running,
      clientCount: state.clientCount,
    }));
  }

  getDongle(dongleId: string): DongleInfo | null {
    const state = this.dongles.get(dongleId);
    if (!state) return null;
    return {
      id: dongleId,
      deviceIndex: state.config.deviceIndex,
      name: state.config.name,
      serial: state.config.serial ?? '',
      source: this.getEffectiveSource(state),
      activeProfileId: state.activeProfile?.id ?? null,
      ppmCorrection: state.config.ppmCorrection,
      running: state.running,
      clientCount: state.clientCount,
    };
  }

  getActiveProfile(dongleId: string): DongleProfile | null {
    return this.dongles.get(dongleId)?.activeProfile ?? null;
  }

  getProfiles(dongleId: string): DongleProfile[] {
    const state = this.dongles.get(dongleId);
    if (!state) return [];
    return state.config.profiles as DongleProfile[];
  }

  updateClientCount(dongleId: string, delta: number): void {
    const state = this.dongles.get(dongleId);
    if (state) {
      state.clientCount = Math.max(0, state.clientCount + delta);
    }
  }
}
