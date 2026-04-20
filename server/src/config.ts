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
  fftSize: z.number().int().refine((n) => (n & (n - 1)) === 0 && n >= 256 && n <= 16384, {
    message: 'fftSize must be a power of 2 between 256 and 16384',
  }).default(2048),
  fftFps: z.number().int().min(1).max(60).default(30),
  defaultMode: z.enum(['wfm', 'nfm', 'am', 'usb', 'lsb', 'cw', 'raw']).default('nfm'),
  defaultTuneOffset: z.number().default(0),
  defaultBandwidth: z.number().positive().default(12_500),
  gain: z.number().nullable().default(null),
  description: z.string().default(''),
  decoders: z.array(DecoderConfigSchema).default([]),
});

const SourceConfigSchema = z.object({
  type: z.enum(['local', 'rtl_tcp', 'demo']).default('local'),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  binary: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
}).default({ type: 'local' });

const DongleConfigSchema = z.object({
  id: z.string().min(1),
  deviceIndex: z.number().int().min(0).default(0),
  name: z.string().min(1),
  serial: z.string().optional(),
  ppmCorrection: z.number().default(0),
  source: SourceConfigSchema,
  profiles: z.array(DongleProfileSchema).min(1),
  autoStart: z.boolean().default(true),
});

const ServerConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(3000),
    adminPassword: z.string().min(1).default('admin'),
    demoMode: z.boolean().default(false),
  }),
  dongles: z.array(DongleConfigSchema).min(1),
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
      'No config file found, generating default config',
    );
    return getDefaultConfig();
  }

  logger.info({ path: filePath }, 'Loading configuration');
  resolvedConfigPath = filePath;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(raw);

  const result = ServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    logger.error({ errors: result.error.issues }, 'Configuration validation failed');
    throw new Error(`Invalid configuration: ${result.error.message}`);
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
  logger.info('Using default demo configuration (no config file found)');
  return {
    server: {
      host: '0.0.0.0',
      port: 3000,
      adminPassword: 'admin',
      demoMode: true, // default to demo when no config file exists
    },
    dongles: [
      {
        id: 'dongle-0',
        deviceIndex: 0,
        name: 'Simulated SDR (Demo)',
        ppmCorrection: 0,
        source: { type: 'demo' },
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
    ],
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
