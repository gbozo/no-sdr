// ============================================================
// node-sdr — YAML Configuration + Zod Validation
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { z } from 'zod';
import { logger } from './logger.js';

// ---- Project Root Detection ----
// Works from server/src/ (tsx dev) or server/dist/ (compiled)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ---- Zod Schemas ----

const DecoderConfigSchema = z.object({
  type: z.enum(['adsb', 'acars', 'vdl2', 'ais', 'aprs', 'pocsag', 'ft8', 'ft4', 'wspr']),
  enabled: z.boolean().default(true),
  frequencyOffset: z.number().default(0),
  bandwidth: z.number().positive(),
  binary: z.string().optional(),
  args: z.array(z.string()).optional(),
  options: z.record(z.unknown()).default({}),
});

const DongleProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  centerFrequency: z.number().int().positive(),
  sampleRate: z.number().int().positive().default(2_400_000),
  fftSize: z.number().int().refine((n) => (n & (n - 1)) === 0 && n >= 256 && n <= 65536, {
    message: 'fftSize must be a power of 2 between 256 and 65536',
  }).default(2048),
  fftFps: z.number().int().min(1).max(60).default(30),
  defaultMode: z.enum(['wfm', 'nfm', 'am', 'am-stereo', 'sam', 'usb', 'lsb', 'cw', 'raw']).default('nfm'),
  defaultTuneOffset: z.number().default(0),
  defaultBandwidth: z.number().positive().default(12_500),
  /** Tuning step in Hz (UI click/arrow step size). Defaults to channel bandwidth. */
  tuningStep: z.number().positive().optional(),
  gain: z.number().nullable().default(null),
  description: z.string().default(''),
  /** Direct sampling per profile: 0=off, 1=I-ADC, 2=Q-ADC */
  directSampling: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0).optional(),
  /** Swap I and Q channels (fixes inverted spectrum) */
  swapIQ: z.boolean().default(false).optional(),
  /** Oscillator frequency offset in Hz (compensates LO error) */
  oscillatorOffset: z.number().default(0).optional(),
  /** Bias-T per profile (overrides dongle-level) */
  biasT: z.boolean().optional(),
  /** Offset tuning per profile (overrides dongle-level) */
  offsetTuning: z.boolean().optional(),
  /** DC offset removal per profile (overrides dongle-level, default: true) */
  dcOffsetRemoval: z.boolean().optional(),
  /** Pre-filter noise blanker (blanks impulses before decimation LPF) */
  preFilterNb: z.boolean().optional(),
  /** Pre-filter NB threshold multiplier (3-50, default: 10) */
  preFilterNbThreshold: z.number().min(3).max(50).optional(),
  decoders: z.array(DecoderConfigSchema).default([]),
});

const SourceConfigSchema = z.object({
  type: z.enum([
    'local', 'rtl_tcp', 'demo',
    'airspy_tcp', 'hfp_tcp', 'rsp_tcp',
  ]).default('local'),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  binary: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  // SDRplay-specific options
  antennaPort: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  notchFilter: z.boolean().optional(),
  refclk: z.boolean().optional(),
}).default({ type: 'local' });

const DongleConfigSchema = z.object({
  id: z.string().min(1),
  deviceIndex: z.number().int().min(0).default(0),
  name: z.string().min(1),
  serial: z.string().optional(),
  ppmCorrection: z.number().default(0),
  source: SourceConfigSchema,
  profiles: z.array(DongleProfileSchema).default([]),
  /** Whether this dongle is enabled (disabled dongles won't start or accept connections) */
  enabled: z.boolean().default(true),
  autoStart: z.boolean().default(true),

  // ---- Hardware options (RTL-SDR) ----
  /** Direct sampling mode: 0=off, 1=I-ADC, 2=Q-ADC (HF reception) */
  directSampling: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0).optional(),
  /** Bias-T power on antenna connector */
  biasT: z.boolean().default(false).optional(),
  /** RTL2832U digital AGC */
  digitalAgc: z.boolean().default(false).optional(),
  /** Offset tuning (zero-IF shift, useful for E4000) */
  offsetTuning: z.boolean().default(false).optional(),
  /** Tuner IF gain stages: [[stage, tenthsOfDb], ...] */
  ifGain: z.array(z.tuple([z.number().int().min(1).max(6), z.number().int()])).optional(),
  /** Tuner bandwidth in Hz (R820T/R828D only) */
  tunerBandwidth: z.number().int().positive().optional(),

  // ---- DSP options (dongle-level defaults) ----
  /** DC offset removal (adaptive IIR blocker). Default: true. */
  dcOffsetRemoval: z.boolean().default(true).optional(),

  // ---- Hardware options (AirSpy Mini/R2) ----
  /** AirSpy: VGA/IF gain (0-15, default varies by mode) */
  vgaGain: z.number().int().min(0).max(15).optional(),
  /** AirSpy: Mixer gain (0-15) */
  mixerGain: z.number().int().min(0).max(15).optional(),
  /** AirSpy: LNA gain (0-14) */
  lnaGain: z.number().int().min(0).max(14).optional(),
  /** AirSpy: Use linearity mode (vs sensitivity mode) */
  linearityMode: z.boolean().default(false).optional(),

  // ---- Hardware options (AirSpy HF+) ----
  /** AirSpy HF+: Enable HF LNA */
  hfLna: z.boolean().default(false).optional(),
  /** AirSpy HF+: Use HF AGC (vs manual) */
  hfAgc: z.boolean().default(true).optional(),

  // ---- Hardware options (SDRplay) ----
  /** SDRplay: RF gain reduction in dB (20-59, higher = less gain) */
  sdrplayGain: z.number().int().min(20).max(59).optional(),
  /** SDRplay: LNA state (0-3) */
  sdrplayLna: z.number().int().min(0).max(3).optional(),
  /** SDRplay: Enable iq_balance AGC */
  sdrplayAgc: z.boolean().default(true).optional(),
  /** SDRplay: Min sample rate for AGC (Hz) */
  sdrplayMinSampleRate: z.number().int().positive().optional(),
});

const ServerConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(3000),
    adminPassword: z.string().min(1).default('admin'),
    demoMode: z.boolean().default(false),
    /** Operator callsign (e.g. ham radio callsign) */
    callsign: z.string().default(''),
    /** Description of this SDR station */
    description: z.string().default(''),
    /** Geographic location / QTH of the SDR */
    location: z.string().default(''),
    /**
     * FFT bin count used for history storage.
     * Independent of per-profile fftSize — live frames are downsampled to this
     * size before being stored. Clients interpolate back up to the live fftSize.
     * Must be a power of 2 between 256 and 65536. Default: 8192.
     */
    fftHistoryFftSize: z.number().int().refine(
      (n) => (n & (n - 1)) === 0 && n >= 256 && n <= 65536,
      { message: 'fftHistoryFftSize must be a power of 2 between 256 and 65536' },
    ).default(8192),
    /**
     * Compression codec used when sending FFT waterfall history to clients.
     *   'deflate' — delta+zlib deflate, best ratio (~8-12x), default
     *   'adpcm'   — IMA-ADPCM, ~8x, lower CPU
     *   'none'    — uncompressed Uint8
     */
    fftHistoryCompression: z.enum(['deflate', 'adpcm', 'none']).default('deflate'),
  }),
  dongles: z.array(DongleConfigSchema).default([]),
});

export type ValidatedConfig = z.infer<typeof ServerConfigSchema>;

// ---- Config Loading ----

const CONFIG_SEARCH_PATHS = [
  path.join(PROJECT_ROOT, 'config', 'config.yaml'),
  path.join(PROJECT_ROOT, 'config', 'config.yml'),
  path.join(PROJECT_ROOT, 'config.yaml'),
  path.join(PROJECT_ROOT, 'config.yml'),
];

/**
 * Load and validate configuration from YAML file.
 * Searches standard paths relative to project root, or uses NODE_SDR_CONFIG env var.
 */
export function loadConfig(configPath?: string): ValidatedConfig {
  const envPath = configPath ?? process.env.NODE_SDR_CONFIG;
  const searchPaths = envPath
    ? [path.resolve(envPath)]
    : CONFIG_SEARCH_PATHS;

  let filePath: string | null = null;
  for (const p of searchPaths) {
    const resolved = path.resolve(p);
    if (fs.existsSync(resolved)) {
      filePath = resolved;
      break;
    }
  }

  if (!filePath) {
    logger.warn(
      { searchPaths },
      'No config file found, starting with defaults (configure via admin panel)',
    );
    // Set the resolved path so saveConfig knows where to write
    resolvedConfigPath = path.join(PROJECT_ROOT, 'config', 'config.yaml');
    return getDefaultConfig();
  }

  logger.info({ path: filePath }, 'Loading configuration');
  resolvedConfigPath = filePath;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw);

  const result = ServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    logger.error({ errors: result.error.issues }, 'Configuration validation failed — falling back to defaults');
    return getDefaultConfig();
  }

  // Populate dongleId on profiles
  for (const dongle of result.data.dongles) {
    for (const profile of dongle.profiles) {
      (profile as any).dongleId = dongle.id;
    }
  }

  logger.info(
    {
      dongles: result.data.dongles.length,
      profiles: result.data.dongles.reduce((sum, d) => sum + d.profiles.length, 0),
    },
    'Configuration loaded successfully',
  );

  return result.data;
}

function getDefaultConfig(): ValidatedConfig {
  const isDemoMode = !!process.env.NODE_SDR_DEMO;
  logger.info(isDemoMode
    ? 'Using default demo configuration (NODE_SDR_DEMO=1)'
    : 'Using empty default configuration — add receivers via admin panel',
  );
  return {
    server: {
      host: '0.0.0.0',
      port: 3000,
      adminPassword: 'admin',
      demoMode: isDemoMode,
      callsign: '',
      description: '',
      location: '',
      fftHistoryFftSize: 8192,
      fftHistoryCompression: 'deflate' as const,
    },
    dongles: isDemoMode ? [
      {
        id: 'dongle-0',
        deviceIndex: 0,
        name: 'Simulated SDR (Demo)',
        ppmCorrection: 0,
        source: { type: 'demo' },
        enabled: true,
        autoStart: true,
        profiles: [
          {
            id: 'fm-broadcast',
            name: 'FM Broadcast',
            centerFrequency: 100_000_000,
            sampleRate: 2_400_000,
            fftSize: 2048,
            fftFps: 30,
            defaultMode: 'wfm',
            defaultTuneOffset: 0,
            defaultBandwidth: 200_000,
            gain: null,
            description: 'Simulated FM broadcast band — 87.5 to 108 MHz',
            decoders: [],
          },
        ],
      },
    ] : [],
  };
}

// Store the resolved config file path for save operations
let resolvedConfigPath: string | null = null;

/**
 * Save the current configuration back to the YAML file.
 * Used for admin profile CRUD operations.
 */
export function saveConfig(config: ValidatedConfig): void {
  const filePath = resolvedConfigPath ?? path.join(PROJECT_ROOT, 'config', 'config.yaml');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const header = `# ============================================================
# node-sdr Configuration
# ============================================================
# Dongle profiles define frequency/sample rate/demod presets.
# When an admin switches a dongle's profile, all connected
# clients on that dongle are switched automatically.
#
# Source types:
#   local   - spawn rtl_sdr as child process (default)
#   rtl_tcp - connect to remote rtl_tcp server via TCP
#   demo    - use built-in signal simulator
# ============================================================

`;

  const yamlStr = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  fs.writeFileSync(filePath, header + yamlStr, 'utf-8');
  logger.info({ path: filePath }, 'Configuration saved to disk');
}

/**
 * Write a default config file for first-time setup
 */
export function writeDefaultConfig(filePath: string = path.join(PROJECT_ROOT, 'config', 'config.yaml')): void {
  const config = getDefaultConfig();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const yamlStr = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  const header = `# ============================================================
# node-sdr Configuration
# ============================================================
# See docs for full configuration reference
#
# Dongle profiles define frequency/sample rate/demod presets.
# When an admin switches a dongle's profile, all connected
# clients on that dongle are switched automatically.
# ============================================================

`;

  fs.writeFileSync(filePath, header + yamlStr, 'utf-8');
  logger.info({ path: filePath }, 'Default configuration written');
}
