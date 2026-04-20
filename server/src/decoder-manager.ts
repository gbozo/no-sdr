// ============================================================
// node-sdr — Decoder Manager
// ============================================================
// Manages external C binary decoders (dump1090, acarsdec,
// dumpvdl2, multimon-ng, direwolf) for digital mode decoding.
//
// Each decoder runs as a child process that receives IQ or
// demodulated audio data and outputs decoded messages.
// ============================================================

import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { DecoderConfig, DigitalMode } from '@node-sdr/shared';
import { DIGITAL_MODES } from '@node-sdr/shared';
import { logger } from './logger.js';

// ---- Decoder Output Types ----

export interface DecoderMessage {
  decoderType: DigitalMode;
  dongleId: string;
  timestamp: number;
  data: unknown;
  raw?: string;
}

export interface DecoderEvents {
  'decoder-message': (msg: DecoderMessage) => void;
  'decoder-started': (dongleId: string, decoderType: DigitalMode) => void;
  'decoder-stopped': (dongleId: string, decoderType: DigitalMode) => void;
  'decoder-error': (dongleId: string, decoderType: DigitalMode, error: Error) => void;
}

// ---- Individual Decoder Instance ----

interface DecoderInstance {
  config: DecoderConfig;
  process: ChildProcess | null;
  running: boolean;
  dongleId: string;
  mode: DigitalMode;
  restartCount: number;
  lineBuffer: string;
}

// ---- Decoder Output Parsers ----

type OutputParser = (line: string, mode: DigitalMode) => unknown | null;

/**
 * Parse dump1090 raw Mode-S / ADS-B output
 * Expected: JSON lines or hex frames
 */
function parseDump1090(line: string, _mode: DigitalMode): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // dump1090 --net JSON format
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  // Raw hex format: *AABBCCDDEE...;
  if (trimmed.startsWith('*') && trimmed.endsWith(';')) {
    const hex = trimmed.slice(1, -1);
    return {
      type: 'raw_frame',
      hex,
      length: hex.length / 2,
      df: parseInt(hex.slice(0, 2), 16) >> 3, // Downlink format
    };
  }

  return null;
}

/**
 * Parse acarsdec JSON output (-j flag)
 */
function parseAcarsdec(line: string, _mode: DigitalMode): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  try {
    const msg = JSON.parse(trimmed);
    return {
      type: 'acars',
      registration: msg.tail ?? '',
      flight: msg.flight ?? '',
      label: msg.label ?? '',
      blockId: msg.block_id ?? '',
      msgNo: msg.msgno ?? '',
      text: msg.text ?? '',
      mode: msg.mode ?? '',
      channel: msg.channel ?? 0,
      frequency: msg.freq ?? 0,
      level: msg.level ?? 0,
      error: msg.error ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Parse dumpvdl2 JSON output (--output decoded:json)
 */
function parseDumpvdl2(line: string, _mode: DigitalMode): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Parse multimon-ng output (POCSAG, FLEX, etc.)
 */
function parseMultimonNg(line: string, _mode: DigitalMode): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // POCSAG format: POCSAG512: Address: 1234567  Function: 0  Alpha:   Test message
  const pocsagMatch = trimmed.match(
    /POCSAG(\d+):\s+Address:\s+(\d+)\s+Function:\s+(\d+)\s+(Alpha|Numeric|Skyper):\s*(.*)/,
  );
  if (pocsagMatch) {
    return {
      type: 'pocsag',
      baud: parseInt(pocsagMatch[1]),
      address: parseInt(pocsagMatch[2]),
      function: parseInt(pocsagMatch[3]),
      encoding: pocsagMatch[4].toLowerCase(),
      message: pocsagMatch[5].trim(),
    };
  }

  // FLEX format: FLEX|...
  const flexMatch = trimmed.match(/FLEX[:|](.*)/);
  if (flexMatch) {
    return {
      type: 'flex',
      raw: flexMatch[1],
    };
  }

  return null;
}

/**
 * Parse direwolf APRS output
 */
function parseDirewolf(line: string, _mode: DigitalMode): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Direwolf outputs AX.25 frames, look for APRS format
  // Station>PATH:payload
  const aprsMatch = trimmed.match(/^([A-Z0-9-]+)>([^:]+):(.*)$/);
  if (aprsMatch) {
    return {
      type: 'aprs',
      source: aprsMatch[1],
      path: aprsMatch[2],
      payload: aprsMatch[3],
    };
  }

  return null;
}

/**
 * Parse rtl_ais / AIS decoder output
 */
function parseAis(line: string, _mode: DigitalMode): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // AIVDM sentence: !AIVDM,1,1,,A,1...,...,0*xx
  if (trimmed.startsWith('!AIVDM') || trimmed.startsWith('!AIVDO')) {
    const parts = trimmed.split(',');
    return {
      type: 'ais',
      sentenceType: parts[0],
      fragmentCount: parseInt(parts[1]) || 1,
      fragmentNumber: parseInt(parts[2]) || 1,
      channel: parts[3] || '',
      payload: parts[4] || '',
      raw: trimmed,
    };
  }

  return null;
}

/**
 * Generic JSON line parser (fallback)
 */
function parseJsonLine(line: string, _mode: DigitalMode): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// Map decoder binary names to parsers
const PARSERS: Record<string, OutputParser> = {
  dump1090: parseDump1090,
  'dump1090-mutability': parseDump1090,
  'dump1090-fa': parseDump1090,
  acarsdec: parseAcarsdec,
  dumpvdl2: parseDumpvdl2,
  'multimon-ng': parseMultimonNg,
  direwolf: parseDirewolf,
  rtl_ais: parseAis,
};

// ============================================================
// Decoder Manager
// ============================================================

export class DecoderManager extends EventEmitter {
  private decoders = new Map<string, DecoderInstance>();
  private readonly maxRestarts = 3;
  private readonly restartDelay = 5000;

  /**
   * Start a decoder for a given dongle
   */
  async startDecoder(dongleId: string, config: DecoderConfig): Promise<void> {
    const key = `${dongleId}:${config.type}`;

    // Stop existing decoder if running
    if (this.decoders.has(key)) {
      await this.stopDecoder(dongleId, config.type as DigitalMode);
    }

    const modeInfo = DIGITAL_MODES[config.type as DigitalMode];
    if (!modeInfo) {
      throw new Error(`Unknown digital mode: ${config.type}`);
    }

    const instance: DecoderInstance = {
      config,
      process: null,
      running: false,
      dongleId,
      mode: config.type as DigitalMode,
      restartCount: 0,
      lineBuffer: '',
    };

    this.decoders.set(key, instance);
    this.spawnDecoder(key, instance);
  }

  private spawnDecoder(key: string, instance: DecoderInstance): void {
    const { config, dongleId, mode } = instance;
    const modeInfo = DIGITAL_MODES[mode];

    // Use configured binary or fall back to mode default
    const binary = config.binary ?? modeInfo.binary;
    const args = config.args ?? modeInfo.defaultArgs;

    logger.info(
      { dongleId, mode, binary, args },
      'Starting decoder',
    );

    // Check if binary exists (best effort)
    try {
      const proc = spawn(binary, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      instance.process = proc;
      instance.running = true;

      const parser = PARSERS[binary] ?? parseJsonLine;

      // Stdout: decoder output (parsed line by line)
      proc.stdout!.on('data', (chunk: Buffer) => {
        instance.lineBuffer += chunk.toString();

        // Process complete lines
        const lines = instance.lineBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        instance.lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const parsed = parser(line, mode);
          if (parsed) {
            const msg: DecoderMessage = {
              decoderType: mode,
              dongleId,
              timestamp: Date.now(),
              data: parsed,
              raw: line,
            };
            this.emit('decoder-message', msg);
          }
        }
      });

      // Stderr: log warnings/info
      proc.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          logger.debug({ dongleId, mode, stderr: msg }, 'Decoder stderr');
        }
      });

      proc.on('error', (err) => {
        logger.error(
          { dongleId, mode, binary, error: err.message },
          'Decoder process error',
        );
        instance.running = false;
        this.emit('decoder-error', dongleId, mode, err);
        this.handleDecoderExit(key, instance);
      });

      proc.on('exit', (code, signal) => {
        logger.info(
          { dongleId, mode, code, signal },
          'Decoder process exited',
        );
        instance.running = false;
        instance.process = null;

        if (code !== 0 && signal !== 'SIGTERM') {
          this.handleDecoderExit(key, instance);
        } else {
          this.emit('decoder-stopped', dongleId, mode);
        }
      });

      this.emit('decoder-started', dongleId, mode);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        { dongleId, mode, binary, error: error.message },
        'Failed to spawn decoder',
      );
      instance.running = false;
      this.emit('decoder-error', dongleId, mode, error);
    }
  }

  private handleDecoderExit(key: string, instance: DecoderInstance): void {
    if (instance.restartCount >= this.maxRestarts) {
      logger.error(
        {
          dongleId: instance.dongleId,
          mode: instance.mode,
          restarts: instance.restartCount,
        },
        'Decoder max restarts exceeded',
      );
      return;
    }

    instance.restartCount++;
    const delay = this.restartDelay * instance.restartCount;

    logger.warn(
      {
        dongleId: instance.dongleId,
        mode: instance.mode,
        restartCount: instance.restartCount,
        delayMs: delay,
      },
      'Scheduling decoder restart',
    );

    setTimeout(() => {
      if (!instance.running && this.decoders.has(key)) {
        this.spawnDecoder(key, instance);
      }
    }, delay);
  }

  /**
   * Feed IQ data to a decoder's stdin (for decoders that accept raw IQ input)
   */
  feedIqData(dongleId: string, mode: DigitalMode, data: Buffer): void {
    const key = `${dongleId}:${mode}`;
    const instance = this.decoders.get(key);
    if (!instance?.process?.stdin?.writable) return;

    try {
      instance.process.stdin.write(data);
    } catch {
      // Process might have died; ignore write errors
    }
  }

  /**
   * Stop a specific decoder
   */
  async stopDecoder(dongleId: string, mode: DigitalMode): Promise<void> {
    const key = `${dongleId}:${mode}`;
    const instance = this.decoders.get(key);
    if (!instance) return;

    if (instance.process) {
      logger.info({ dongleId, mode }, 'Stopping decoder');

      // Close stdin first
      try {
        instance.process.stdin?.end();
      } catch {
        // Ignore
      }

      instance.process.kill('SIGTERM');

      // Force kill after 3 seconds
      const forceKillTimer = setTimeout(() => {
        if (instance.process && !instance.process.killed) {
          instance.process.kill('SIGKILL');
        }
      }, 3000);

      await new Promise<void>((resolve) => {
        if (!instance.process) {
          resolve();
          return;
        }
        instance.process.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }

    this.decoders.delete(key);
  }

  /**
   * Stop all decoders for a dongle
   */
  async stopDongleDecoders(dongleId: string): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [key, instance] of this.decoders) {
      if (instance.dongleId === dongleId) {
        promises.push(this.stopDecoder(dongleId, instance.mode));
      }
    }

    await Promise.all(promises);
  }

  /**
   * Stop all decoders
   */
  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [_key, instance] of this.decoders) {
      promises.push(this.stopDecoder(instance.dongleId, instance.mode));
    }

    await Promise.all(promises);
  }

  /**
   * Get info about running decoders
   */
  getRunningDecoders(): Array<{
    dongleId: string;
    mode: DigitalMode;
    running: boolean;
    binary: string;
  }> {
    return Array.from(this.decoders.values()).map((instance) => ({
      dongleId: instance.dongleId,
      mode: instance.mode,
      running: instance.running,
      binary: instance.config.binary ?? DIGITAL_MODES[instance.mode].binary,
    }));
  }

  /**
   * Check if a decoder binary is available on the system
   */
  async checkBinaryAvailable(binary: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('which', [binary], { stdio: 'pipe' });
      proc.on('exit', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  /**
   * Check availability of all known decoder binaries
   */
  async checkAllBinaries(): Promise<Record<string, boolean>> {
    const binaries = new Set<string>();
    for (const mode of Object.values(DIGITAL_MODES)) {
      binaries.add(mode.binary);
    }

    const results: Record<string, boolean> = {};
    await Promise.all(
      Array.from(binaries).map(async (binary) => {
        results[binary] = await this.checkBinaryAvailable(binary);
      }),
    );

    return results;
  }
}
