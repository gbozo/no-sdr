// ============================================================
// node-sdr — Shared Type Definitions
// ============================================================

// ---- Connection Source ----

/** How to connect to the SDR hardware */
export type SourceType =
  | 'local'       // spawn rtl_sdr as child process
  | 'rtl_tcp'     // TCP client to remote rtl_tcp server
  | 'demo'        // built-in signal simulator
  | 'airspy_tcp'  // TCP client to airspy_tcp server (AirSpy Mini/R2)
  | 'hfp_tcp'     // TCP client to hfp_tcp server (AirSpy HF+)
  | 'rsp_tcp';    // TCP client to rsp_tcp server (SDRplay RSP1/2)

export interface SourceConfig {
  /** Connection type */
  type: SourceType;
  /** For TCP sources: hostname or IP address of the SDR server */
  host?: string;
  /** For TCP sources: TCP port (default 1234) */
  port?: number;
  /** For local: path to rtl_sdr binary (default: "rtl_sdr" from PATH) */
  binary?: string;
  /** For local: additional CLI arguments to rtl_sdr */
  extraArgs?: string[];
  /** For rsp_tcp: antenna port selection (0=Port A, 1=Port B, 2=Port C) */
  antennaPort?: 0 | 1 | 2;
  /** For rsp_tcp: enable broadcast notch filter */
  notchFilter?: boolean;
  /** For rsp_tcp: enable reference clock output */
  refclk?: boolean;
}

// ---- Dongle & Hardware ----

export interface DongleInfo {
  id: string;
  /** Index as seen by rtl_sdr -d <index> */
  deviceIndex: number;
  name: string;
  serial: string;
  /** Connection source type */
  source: SourceType;
  /** Currently active profile ID */
  activeProfileId: string | null;
  /** PPM correction */
  ppmCorrection: number;
  /** Whether the dongle is currently running */
  running: boolean;
  /** Number of connected clients */
  clientCount: number;
  /** Device model (for TCP sources, populated after connect) */
  deviceModel?: string;
  /** Sample rate (for TCP sources) */
  sampleRate?: number;
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
  /** Target FFT output frame rate (fps, 1-60, default 30) */
  fftFps: number;
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

export type DemodMode = 'wfm' | 'nfm' | 'am' | 'am-stereo' | 'usb' | 'lsb' | 'cw' | 'raw';

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
  /** Whether the client has enabled audio playback (IQ data only sent when true) */
  audioEnabled: boolean;
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
  /** How to connect to this dongle's hardware */
  source: SourceConfig;
  profiles: DongleProfile[];
  /** Auto-start first profile on server boot */
  autoStart: boolean;

  // ---- Hardware options ----

  /** Direct sampling mode: 0=off (default), 1=I-ADC input, 2=Q-ADC input.
   *  Bypasses the tuner for HF reception (0–28 MHz). */
  directSampling?: 0 | 1 | 2;

  /** Enable bias-T power on the antenna connector (default: false).
   *  Powers LNAs, active antennas, or upconverters via coax. */
  biasT?: boolean;

  /** RTL2832U digital AGC (default: false).
   *  Adjusts the ADC's digital gain; usually combined with manual tuner gain. */
  digitalAgc?: boolean;

  /** Offset tuning / zero-IF shift (default: false).
   *  Moves the DC spike away from the center frequency. Useful for E4000 tuners. */
  offsetTuning?: boolean;

  /** Tuner IF gain stages (array of [stage, tenthsOfDb]).
   *  Stage numbering is tuner-specific (e.g., E4000 has stages 1-6).
   *  Example: [[1, 60], [2, 90]] sets stage 1 to 6.0 dB, stage 2 to 9.0 dB. */
  ifGain?: [number, number][];

  /** Tuner bandwidth in Hz (default: automatic / same as sample rate).
   *  Only supported by R820T/R828D tuners. Narrows the hardware anti-alias filter.
   *  Local: requires rtl-sdr-blog fork (passes -w flag). Not in stock rtl_sdr.
   *  rtl_tcp: not in standard protocol; requires modified server. */
  tunerBandwidth?: number;
}

// ---- Waterfall & Display ----

export type WaterfallColorTheme = 'turbo' | 'viridis' | 'classic' | 'grayscale' | 'hot' | 'ocean' | 'inferno' | 'magma' | 'plasma' | 'fire' | 'radio' | 'sdr';

export type UITheme = 'default' | 'crt' | 'vfd';

export interface WaterfallSettings {
  colorTheme: WaterfallColorTheme | 'sdr';
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
