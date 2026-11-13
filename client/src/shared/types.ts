// ============================================================
// node-sdr — Shared Type Definitions
// ============================================================

// ---- Connection Source ----

/** How to connect to the SDR hardware */
export type SourceType =
  | 'local'       // native USB RTL-SDR
  | 'rtl_tcp'     // TCP client to remote rtl_tcp server
  | 'demo'        // built-in signal simulator
  | 'airspy_tcp'  // TCP client to airspy_tcp server (AirSpy Mini/R2)
  | 'hfp_tcp'     // TCP client to hfp_tcp server (AirSpy HF+)
  | 'rsp_tcp'     // TCP client to rsp_tcp server (SDRplay RSP1/2)
  | 'hackrf'    // native USB HackRF One/Pro
  | 'airspy'    // native USB Airspy R2/Mini
  | 'airspyhf'   // native USB Airspy HF+
  | 'hydrasdr'   // native USB HydraSDR RFOne
  | 'elad'       // native USB ELAD FDM
  | 'rx888'      // native USB RX-888 Mk2
  | 'pluto'      // ADALM-Pluto over IIOD network
  | 'sdrplay'    // SDRplay RSP through the vendor API service
  | 'lime'       // LimeSDR through LimeSuite
  | 'fobos';     // RigExpert Fobos SDR through libfobos

export interface SourceConfig {
  /** Connection type */
  type: SourceType;
  /** For TCP sources: hostname or IP address of the SDR server */
  host?: string;
  /** For TCP sources: TCP port (default 1234) */
  port?: number;
  /** Native USB: serial string; empty means the first device found. */
  serial?: string;
  /** Native USB: device index where the driver supports it. */
  deviceIndex?: number;
  /** Source-specific hardware settings (e.g. lnaDb/vgaDb/amp for HackRF). */
  settings?: Record<string, string | number | boolean>;
  /** For TCP sources: path to the rtl_tcp binary (default: "rtl_tcp" from PATH) */
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
  /** Tuning step size in Hz (used by UI for click-to-tune and arrow key steps) */
  tuningStep?: number;
  /** RF gain in dB, null = auto */
  gain: number | null;
  /** Description shown in UI */
  description: string;
  /** Direct sampling mode: 0=off, 1=I-ADC, 2=Q-ADC (for HF reception) */
  directSampling?: number;
  /** Swap I and Q channels (fixes inverted spectrum on some dongles) */
  swapIQ?: boolean;
  /** Oscillator frequency offset in Hz (compensates LO error on cheap dongles) */
  oscillatorOffset?: number;
  /** Enable bias-T power on the antenna connector (overrides dongle-level setting) */
  biasT?: boolean;
  /** Offset tuning / zero-IF shift (overrides dongle-level setting) */
  offsetTuning?: boolean;

  // ---- DSP options (per-profile, override dongle-level defaults) ----

  /** Remove DC offset with adaptive IIR blocker (overrides dongle-level default) */
  dcOffsetRemoval?: boolean;
  /** Enable pre-filter noise blanker (blanks impulses BEFORE decimation filter) */
  preFilterNb?: boolean;
  /** Pre-filter noise blanker threshold multiplier (default: 10, range 3-50).
   *  Blanks samples exceeding avgMag × threshold. Lower = more aggressive. */
  preFilterNbThreshold?: number;

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

export type DemodMode = 'wfm' | 'nfm' | 'am' | 'am-stereo' | 'sam' | 'usb' | 'lsb' | 'cw' | 'raw';

export type DigitalMode =
  | 'adsb'
  | 'acars'
  | 'vdl2'
  | 'ais'
  | 'hfdl'
  | 'aprs'
  | 'navtex'
  | 'ism'
  | 'packet'
  | 'pocsag'
  | 'ft8'
  | 'ft4'
  | 'ft2'
  | 'fst4'
  | 'q65'
  | 'jt65'
  | 'jt9'
  | 'wefax'
  | 'sstv'
  | 'hell'
  | 'olivia'
  | 'thor'
  | 'fsq'
  | 'psk31'
  | 'rtty'
  | 'msk144'
  | 'fsk441'
  | 'wspr'
  | 'pi4'
  | 'rade'
  | 'js8'
  | 'dcf77'
  | 'als162';

// ---- ADS-B ----

/**
 * One aircraft in an ADS-B snapshot. The 24-bit ICAO address is the stable
 * key; the server re-sends the whole table about twice a second.
 */
export interface AdsbAircraft {
  icao: number;
  callsign: string;
  category: string | null;
  lat: number | null;
  lon: number | null;
  /** Past positions, oldest first: [lat, lon]. */
  track: [number, number][];
  altitude_ft: number | null;
  gnss_altitude_ft: number | null;
  ground_speed_kt: number | null;
  /** Track over ground, degrees true. */
  track_deg: number | null;
  vertical_rate_fpm: number | null;
  turn_rate_deg_s: number;
  on_ground: boolean;
  squawk: number | null;
  emergency: string | null;
  rssi_dbfs: number;
  frames: number;
  source: 'Squitter' | 'Reply';
  first_at: number;
  last_at: number;
  last_pos_at: number;
  raw_hex: string;
}

/** One `MSG_DECODER` payload with `decoderType: "adsb"`. */
export interface AdsbSnapshot {
  aircraft: AdsbAircraft[];
  /** Why the decoder cannot run here at all, or null. */
  unavailable: string | null;
  /** Why the decoder is running at reduced sensitivity, or null. */
  degraded: string | null;
  suggestCenterHz: number | null;
  windowCenterHz: number;
  windowRateHz: number;
  preambles: number;
  frames: number;
  /** Frames recovered by the one-bit CRC repair pass. */
  repaired: number;
  badCrc: number;
  unmatched: number;
}

// ---- AIS ----

/** One station in an AIS snapshot. `mmsi` is the stable key. */
export interface AisVessel {
  mmsi: number;
  name: string;
  call_sign: string;
  imo: number | null;
  /** ClassA, ClassB, BaseStation, SarAircraft, AidToNavigation, Sart, Craft. */
  kind: string;
  ship_type: number | null;
  aid_type: number | null;
  virtual_aid: boolean;
  nav_status: number | null;
  destination: string;
  eta: string;
  draught_m: number | null;
  dim_bow_m: number;
  dim_stern_m: number;
  dim_port_m: number;
  dim_starboard_m: number;
  lat: number | null;
  lon: number | null;
  /** Past positions, oldest first: [lat, lon]. */
  track: [number, number][];
  sog_kt: number | null;
  cog_deg: number | null;
  heading_deg: number | null;
  turn_rate_deg_min: number | null;
  altitude_m: number | null;
  accuracy: boolean;
  raim: boolean;
  utc: string;
  /** 'A' or 'B'. */
  channel: string;
  rssi_dbfs: number;
  snr_db: number;
  messages: number;
  last_type: number;
  first_at: number;
  last_at: number;
  last_pos_at: number;
  nmea: string;
}

export interface AisChannelStatus {
  freq_hz: number;
  label: string;
  live: boolean;
  reason: string | null;
  bursts: number;
  messages: number;
  floor_dbfs: number;
}

/** One `MSG_DECODER` payload with `decoderType: "ais"`. */
export interface AisSnapshot {
  vessels: AisVessel[];
  channels: AisChannelStatus[];
  unavailable: string | null;
  degraded: string | null;
  suggestCenterHz: number | null;
  windowCenterHz: number;
  windowRateHz: number;
  bursts: number;
  messages: number;
  badFcs: number;
  unsupported: number;
  samplesPerBit: number;
  offsetHz: number | null;
}

// ---- VDL Mode 2 ----

export interface Vdl2Message {
  at: number;
  freq_hz: number;
  src: number;
  dst: number;
  src_kind: string;
  dst_kind: string;
  command: boolean;
  summary: string;
  srcHex: string;
  dstHex: string;
  frameLabel: string;
  snr_db: number;
  rssi_dbfs: number;
  evm_deg: number;
  freq_err_hz: number;
  rs_corrected: number;
  raw_hex: string;
  payload?: unknown;
}

export interface Vdl2Station {
  addr: number;
  kind: string;
  registration: string;
  flight: string;
  lat: number | null;
  lon: number | null;
  first_at: number;
  last_at: number;
  messages: number;
  last_freq_hz: number;
  last_snr_db: number;
  last_label: string;
}

export interface Vdl2ChannelStatus {
  freq_hz: number;
  live: boolean;
  reason: string | null;
  bursts: number;
  frames: number;
  floor_dbfs: number;
}

export interface Vdl2Snapshot {
  channels: Vdl2ChannelStatus[];
  stations: Vdl2Station[];
  messages: Vdl2Message[];
  unavailable: string | null;
  degraded: string | null;
  suggestCenterHz: number | null;
  windowCenterHz: number;
  windowRateHz: number;
  bursts: number;
  syncs: number;
  headers: number;
  headerBad: number;
  rsFail: number;
  rsCorrected: number;
  hdlcBad: number;
  fecBypassed: number;
  fcsBad: number;
  frames: number;
  multiblock: number;
  multiblockOk: number;
  samplesPerSymbol: number;
}

// ---- HFDL ----

export interface HfdlFix {
  lat: number;
  lon: number;
  aircraftId: number | null;
  icao: string | null;
  flight: string | null;
}

export interface HfdlDecode {
  unix: number;
  kind: string;
  gs: string | null;
  freqKhz: number;
  snrDb: number | null;
  freqSkewHz: number | null;
  fecCorrected: number | null;
  details: string;
  position: HfdlFix | null;
}

export interface HfdlSnapshot {
  running: boolean;
  levelDbfs: number;
  bursts: number;
  decodes: number;
  log: HfdlDecode[];
  unavailable: string | null;
  degraded: string | null;
  suggestCenterHz: number | null;
  windowCenterHz: number;
  windowRateHz: number;
}

// ---- APRS ----

export interface AprsPacket {
  at: number;
  from: string;
  to: string;
  via: string[];
  kind: string;
  raw: string;
  text?: string;
  lat?: number;
  lon?: number;
  ambiguity?: number;
  symbol?: string;
  courseDeg?: number | null;
  speedKn?: number | null;
  altitudeM?: number | null;
  comment?: string;
  status?: string;
  message?: {
    addressee: string;
    text: string;
    id: string;
    replyAck: string;
    messageKind: string;
  };
  weather?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
  object?: { name: string; live: boolean };
  item?: { name: string; live: boolean };
  timestamp?: {
    day: number | null;
    hour: number;
    minute: number;
    second: number | null;
    zulu: boolean;
  };
  error?: string;
}

export interface AprsStatus {
  frames: number;
  badFcs: number;
  nonAprs: number;
  level: number;
}

// ---- AX.25 PACKET ----

export interface PacketFrame {
  at: number;
  from: string;
  to: string;
  via: string[];
  type: string;
  pid: number;
  payload: string;
  raw: string;
  length: number;
}

export interface PacketStatus {
  frames: number;
  badFcs: number;
  nonAx25: number;
  level: number;
  baud: number;
}

// ---- WEFAX ----

export interface WefaxImage {
  imageId: number;
  width: number;
  height: number;
  ioc: string;
  lpm: number;
  complete: boolean;
  byTone?: boolean;
  rows: Uint8Array[];
}

export interface WefaxStatus {
  receiving: boolean;
  phasing: boolean;
  lines: number;
  ioc: string;
  lpm: number;
  signal: number;
  subcarrierHz: number;
  slantPpm: number;
  imageId: number;
  width: number;
  height: number;
}

// ---- SSTV ----

export interface SstvImage {
  imageId: number;
  width: number;
  height: number;
  mode: string | null;
  complete: boolean;
  callsign?: string | null;
  /** Interleaved RGB rows, 3 bytes per pixel. */
  rows: Uint8Array[];
}

export interface SstvStatus {
  receiving: boolean;
  progress: number;
  signal: number;
  imageId: number;
  mode: string | null;
  width: number;
  height: number;
  callsign?: string | null;
  unsupported?: string | null;
}

// ---- Hellschreiber ----

export interface HellStatus {
  receiving: boolean;
  variant: string;
  columns: number;
  seq: number;
  level: number;
  audioHz: number;
}

// ---- Continuous text modes (Olivia / THOR / FSQ) ----

export interface TextModeMessage {
  at: number;
  mode: string;
  text: string;
  rfHz: number;
  audioHz: number;
  level: number;
}

export interface TextModeStatus {
  mode: string;
  level: number;
  audioHz: number;
  listening: boolean;
  /** PSK31: symbol rate; RTTY: baud rate. */
  baud?: number;
  /** RTTY shift in Hz. */
  shiftHz?: number;
  /** RTTY mark/space reversal. */
  reverse?: boolean;
  /** RTTY AFC offset in Hz. */
  afcHz?: number;
  /** RTTY decoder confidence. */
  confidence?: number;
}

// ---- Meteor scatter (MSK144 / FSK441) ----

export interface MeteorMessage {
  at: number;
  mode: string;
  text: string;
  rfHz: number;
  audioHz: number;
  snrDb: number;
  dtSec: number;
  durationSec?: number;
  confidence?: number;
  variant?: string;
  fit?: number;
  hardErrors?: number;
  period: number;
}

export interface MeteorStatus {
  mode: string;
  level: number;
  audioHz: number;
  period: number;
  decodes: number;
  listening: boolean;
}

// ---- FreeDV RADE ----

export interface RadeStatus {
  sync: boolean;
  snrDb: number;
  freqOffsetHz: number;
  rxLevel: number;
  eooCount: number;
  dropped: number;
  callsign?: string | null;
  audioHz?: number;
  listening?: boolean;
}

// ---- JS8 ----

export interface Js8Message {
  at: number;
  from: string;
  to: string;
  cmd?: string | null;
  text: string;
  rfHz: number;
  audioHz: number;
  snrDb: number;
  firstSlotUtc: number;
  lastSlotUtc: number;
  frames: number;
  complete: boolean;
  toMe: boolean;
  speed: string;
}

export interface Js8Heard {
  call: string;
  lastSlotUtc: number;
}

export interface Js8Status {
  speed: string;
  period: number;
  level: number;
  decodes: number;
  listening: boolean;
  heard: Js8Heard[];
}

// ---- DCF77 / ALS162 time signals ----

export interface TimeSignalClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  utcOffsetMin: number;
  unix: number;
  dst: boolean;
  leapSecond: boolean;
  clockChange: boolean;
  holidayToday: boolean;
  holidayTomorrow: boolean;
  text: string;
}

export interface TimeSignalStatus {
  mode: string;
  sync: boolean;
  bits: number;
  second?: number;
  pulses?: number;
  level: number;
  listening: boolean;
  time?: TimeSignalClock | null;
}

// ---- NAVTEX ----

export interface NavtexMessage {
  at: number;
  station: string;
  subject: string;
  serial: number;
  text: string;
  complete: boolean;
  lost: number;
}

export interface NavtexStatus {
  inSync: boolean;
  level: number;
  reverse: boolean;
  direct: number;
  repaired: number;
  lost: number;
  messages: number;
  live?: NavtexMessage | null;
}

// ---- ISM ----

export interface IsmReading {
  quantity: string;
  value: number;
  unit: string;
  decimals: number;
}

export interface IsmDevice {
  id: number;
  protocol: string;
  kind: string;
  model: string | null;
  device: string;
  freqHz: number;
  snrDb: number;
  firstAt: number;
  lastAt: number;
  count: number;
  readings: IsmReading[];
  readingsText: string;
  extra: [string, string][];
  encrypted: boolean;
  rawHex: string;
}

export interface IsmChannelStatus {
  freqHz: number;
  label: string;
  live: boolean;
  reason: string | null;
}

export interface IsmStatus {
  channels: IsmChannelStatus[];
  unavailable: string | null;
  suggestCenterHz: number | null;
  bursts: number;
  decodes: number;
  windowCenterHz: number;
  windowRateHz: number;
}

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
  /** Whether this dongle is enabled (disabled dongles won't start or accept connections) */
  enabled: boolean;
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

  // ---- DSP options (dongle-level defaults, overridable per profile) ----

  /** Remove DC offset with adaptive IIR blocker (default: true).
   *  Eliminates the center spike from RTL-SDR's ADC DC bias. */
  dcOffsetRemoval?: boolean;
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

export interface AcarsMessage {
  /** Mode character, as text. */
  mode: string;
  /** Aircraft address / registration. */
  address: string;
  ack: string;
  label: string;
  blockId: string;
  text: string;
  crcOk: boolean;
  /** Unix seconds. */
  at: number;
  /** Client reception time (ms). */
  receivedAt?: number;
}

export interface AcarsStatus {
  frames: number;
  bad: number;
  /** Smoothed audio level, 0–1-ish. */
  level: number;
}

// ---- Server Status ----

export interface ServerStatus {
  uptime: number;
  dongles: DongleInfo[];
  totalClients: number;
  version: string;
}
