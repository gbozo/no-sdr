// ============================================================
// node-sdr — Shared Type Definitions
// ============================================================

// ---- Dongle & Hardware ----

export interface DongleInfo {
  id: string;
  /** Index as seen by rtl_sdr -d <index> */
  deviceIndex: number;
  name: string;
  serial: string;
  /** Currently active profile ID */
  activeProfileId: string | null;
  /** PPM correction */
  ppmCorrection: number;
  /** Whether the dongle is currently running */
  running: boolean;
  /** Number of connected clients */
  clientCount: number;
}

export interface DongleProfile {
  id: string;
  dongleId: string;
  name: string;
  /** Center frequency in Hz */
  centerFrequency: number;
  /** Sample rate in samples/second */
  sampleRate: number;
  /** FFT bin count (power of 2) */
  fftSize: number;
  /** Default demodulation mode */
  defaultMode: DemodMode;
  /** Default demodulation frequency offset from center (Hz) */
  defaultTuneOffset: number;
  /** Default bandwidth for the demodulator (Hz) */
  defaultBandwidth: number;
  /** RF gain in dB, null = auto */
  gain: number | null;
  /** Description shown in UI */
  description: string;
  /** Active digital decoders for this profile */
  decoders: DecoderConfig[];
}

export interface DecoderConfig {
  type: DigitalMode;
  /** Whether this decoder is enabled */
  enabled: boolean;
  /** Frequency offset from center for the decoder (Hz) */
  frequencyOffset: number;
  /** Bandwidth for the decoder input (Hz) */
  bandwidth: number;
  /** Override binary name (defaults to mode's binary) */
  binary?: string;
  /** Override command line arguments */
  args?: string[];
  /** Additional decoder-specific options */
  options: Record<string, unknown>;
}

// ---- Demodulation ----

export type DemodMode = 'wfm' | 'nfm' | 'am' | 'usb' | 'lsb' | 'cw' | 'raw';

export type DigitalMode =
  | 'adsb'
  | 'acars'
  | 'vdl2'
  | 'ais'
  | 'aprs'
  | 'pocsag'
  | 'ft8'
  | 'ft4'
  | 'wspr';

// ---- Client / Session ----

export interface ClientSession {
  id: string;
  dongleId: string;
  /** Tuned frequency offset from center (Hz) */
  tuneOffset: number;
  /** Selected demodulation mode */
  mode: DemodMode;
  /** Filter bandwidth (Hz) */
  bandwidth: number;
  /** Volume 0.0 - 1.0 */
  volume: number;
  /** Squelch level in dB, null = disabled */
  squelch: number | null;
  /** Whether audio is muted */
  muted: boolean;
}

// ---- Configuration (YAML) ----

export interface ServerConfig {
  server: {
    host: string;
    port: number;
    /** Admin password (bcrypt hash or plaintext for dev) */
    adminPassword: string;
  };
  dongles: DongleConfig[];
}

export interface DongleConfig {
  id: string;
  deviceIndex: number;
  name: string;
  serial?: string;
  ppmCorrection: number;
  profiles: DongleProfile[];
  /** Auto-start first profile on server boot */
  autoStart: boolean;
}

// ---- Waterfall & Display ----

export type WaterfallColorTheme = 'turbo' | 'viridis' | 'classic' | 'grayscale' | 'hot';

export type UITheme = 'default' | 'crt' | 'vfd';

export interface WaterfallSettings {
  colorTheme: WaterfallColorTheme;
  minDb: number;
  maxDb: number;
  speed: number; // rows per second
}

// ---- Decoder Output ----

export interface DecoderMessage {
  type: DigitalMode;
  timestamp: number;
  data: Record<string, unknown>;
  raw?: string;
}

export interface AdsbAircraft {
  icao: string;
  callsign?: string;
  altitude?: number;
  speed?: number;
  heading?: number;
  lat?: number;
  lon?: number;
  verticalRate?: number;
  squawk?: string;
  lastSeen: number;
}

export interface AcarsMessage {
  timestamp: number;
  frequency: number;
  registration?: string;
  flightId?: string;
  label: string;
  sublabel?: string;
  text: string;
  mode: string;
  blockId?: string;
}

// ---- Server Status ----

export interface ServerStatus {
  uptime: number;
  dongles: DongleInfo[];
  totalClients: number;
  version: string;
}
