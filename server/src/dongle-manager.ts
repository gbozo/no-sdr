// ============================================================
// node-sdr — Dongle Manager
// ============================================================
// Manages RTL-SDR dongle child processes (rtl_sdr / rtl_tcp).
// Each dongle runs as a spawned process piping IQ data via stdout.
// ============================================================

import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DongleProfile, DongleInfo } from '@node-sdr/shared';
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
  simulator: SignalSimulator | null;
  activeProfile: DongleProfile | null;
  running: boolean;
  clientCount: number;
  restartCount: number;
  lastError: string | null;
}

export class DongleManager extends EventEmitter {
  private dongles = new Map<string, DongleState>();
  private readonly maxRestarts = 5;
  private readonly restartDelay = 2000; // ms
  private readonly demoMode: boolean;

  constructor(private config: ValidatedConfig) {
    super();
    this.demoMode = config.server.demoMode ?? !!process.env.NODE_SDR_DEMO;
    if (this.demoMode) {
      logger.info('🎛️  Demo mode enabled — using simulated IQ data (no hardware required)');
    }
    this.initDongles();
  }

  private initDongles(): void {
    for (const dongleConfig of this.config.dongles) {
      this.dongles.set(dongleConfig.id, {
        config: dongleConfig,
        process: null,
        simulator: null,
        activeProfile: null,
        running: false,
        clientCount: 0,
        restartCount: 0,
        lastError: null,
      });
    }
    logger.info({ dongles: this.dongles.size }, 'Dongles initialized');
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

    logger.info(
      {
        dongleId,
        profile: profile.id,
        centerFreq: profile.centerFrequency,
        sampleRate: profile.sampleRate,
      },
      'Starting dongle',
    );

    state.activeProfile = profile as DongleProfile;
    state.restartCount = 0;

    if (this.demoMode) {
      this.startSimulator(dongleId, state, profile as DongleProfile);
    } else {
      this.spawnRtlProcess(dongleId, state, profile as DongleProfile);
    }
  }

  private spawnRtlProcess(dongleId: string, state: DongleState, profile: DongleProfile): void {
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

    // Output to stdout (pipe), - = stdout
    args.push('-');

    logger.debug({ dongleId, cmd: 'rtl_sdr', args }, 'Spawning rtl_sdr process');

    try {
      const proc = spawn('rtl_sdr', args, {
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
        this.handleProcessExit(dongleId, state, profile);
      });

      proc.on('exit', (code, signal) => {
        logger.info({ dongleId, code, signal }, 'rtl_sdr process exited');
        state.running = false;
        state.process = null;

        if (code !== 0 && signal !== 'SIGTERM') {
          this.handleProcessExit(dongleId, state, profile);
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

  /**
   * Start a simulated dongle (demo mode)
   */
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

  private handleProcessExit(dongleId: string, state: DongleState, profile: DongleProfile): void {
    if (state.restartCount >= this.maxRestarts) {
      logger.error(
        { dongleId, restarts: state.restartCount },
        'Max restarts exceeded, giving up',
      );
      this.emit('dongle-error', dongleId, new Error('Max restarts exceeded'));
      return;
    }

    state.restartCount++;
    const delay = this.restartDelay * state.restartCount;
    logger.warn(
      { dongleId, restartCount: state.restartCount, delayMs: delay },
      'Scheduling dongle restart',
    );

    setTimeout(() => {
      if (!state.running) {
        this.spawnRtlProcess(dongleId, state, profile);
      }
    }, delay);
  }

  /**
   * Stop a running dongle
   */
  async stopDongle(dongleId: string): Promise<void> {
    const state = this.dongles.get(dongleId);
    if (!state) {
      throw new Error(`Unknown dongle: ${dongleId}`);
    }

    // Stop simulator if in demo mode
    if (state.simulator) {
      logger.info({ dongleId }, 'Stopping simulator');
      state.simulator.stop();
      state.simulator = null;
      state.running = false;
      state.activeProfile = null;
      this.emit('dongle-stopped', dongleId);
      return;
    }

    if (state.process) {
      logger.info({ dongleId }, 'Stopping dongle');
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
   * Switch a dongle to a different profile. Restarts the process.
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

  /**
   * Get info about all dongles
   */
  getDongles(): DongleInfo[] {
    return Array.from(this.dongles.entries()).map(([id, state]) => ({
      id,
      deviceIndex: state.config.deviceIndex,
      name: state.config.name,
      serial: state.config.serial ?? '',
      activeProfileId: state.activeProfile?.id ?? null,
      ppmCorrection: state.config.ppmCorrection,
      running: state.running,
      clientCount: state.clientCount,
    }));
  }

  /**
   * Get info about a specific dongle
   */
  getDongle(dongleId: string): DongleInfo | null {
    const state = this.dongles.get(dongleId);
    if (!state) return null;
    return {
      id: dongleId,
      deviceIndex: state.config.deviceIndex,
      name: state.config.name,
      serial: state.config.serial ?? '',
      activeProfileId: state.activeProfile?.id ?? null,
      ppmCorrection: state.config.ppmCorrection,
      running: state.running,
      clientCount: state.clientCount,
    };
  }

  /**
   * Get the active profile for a dongle
   */
  getActiveProfile(dongleId: string): DongleProfile | null {
    return this.dongles.get(dongleId)?.activeProfile ?? null;
  }

  /**
   * Get all profiles for a dongle
   */
  getProfiles(dongleId: string): DongleProfile[] {
    const state = this.dongles.get(dongleId);
    if (!state) return [];
    return state.config.profiles as DongleProfile[];
  }

  /**
   * Update client count for a dongle
   */
  updateClientCount(dongleId: string, delta: number): void {
    const state = this.dongles.get(dongleId);
    if (state) {
      state.clientCount = Math.max(0, state.clientCount + delta);
    }
  }
}
