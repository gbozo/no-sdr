// ============================================================
// node-sdr — Demodulation & Digital Mode Definitions
// ============================================================

import type { DemodMode, DigitalMode } from './types';

// ---- Analog Demodulation Mode Info ----

export interface DemodModeInfo {
  id: DemodMode;
  name: string;
  shortName: string;
  description: string;
  /** Typical bandwidth range [min, max] in Hz */
  bandwidthRange: [number, number];
  /** Default bandwidth in Hz */
  defaultBandwidth: number;
  /** Minimum sample rate required in Hz */
  minSampleRate: number;
  /** Whether this mode produces audio output */
  hasAudio: boolean;
  /** Sideband type for display */
  sideband: 'both' | 'upper' | 'lower' | 'none';
}

export const DEMOD_MODES: Record<DemodMode, DemodModeInfo> = {
  wfm: {
    id: 'wfm',
    name: 'Wideband FM',
    shortName: 'WFM',
    description: 'FM broadcast radio (87.5–108 MHz)',
    bandwidthRange: [150_000, 200_000],
    defaultBandwidth: 200_000,
    minSampleRate: 240_000,
    hasAudio: true,
    sideband: 'both',
  },
  nfm: {
    id: 'nfm',
    name: 'Narrowband FM',
    shortName: 'NFM',
    description: 'VHF/UHF communications, PMR, marine',
    bandwidthRange: [5_000, 25_000],
    defaultBandwidth: 12_500,
    minSampleRate: 48_000,
    hasAudio: true,
    sideband: 'both',
  },
  am: {
    id: 'am',
    name: 'Amplitude Modulation',
    shortName: 'AM',
    description: 'Aviation, AM broadcast, shortwave',
    bandwidthRange: [3_000, 10_000],
    defaultBandwidth: 6_000,
    minSampleRate: 24_000,
    hasAudio: true,
    sideband: 'both',
  },
  'am-stereo': {
    id: 'am-stereo',
    name: 'AM Stereo (C-QUAM)',
    shortName: 'AMS',
    description: 'Motorola C-QUAM AM stereo broadcast',
    bandwidthRange: [6_000, 20_000],
    defaultBandwidth: 10_000,
    minSampleRate: 48_000,
    hasAudio: true,
    sideband: 'both',
  },
  sam: {
    id: 'sam',
    name: 'Synchronous AM',
    shortName: 'SAM',
    description: 'PLL carrier lock — superior on fading/weak AM signals',
    bandwidthRange: [3_000, 10_000],
    defaultBandwidth: 6_000,
    minSampleRate: 48_000,
    hasAudio: true,
    sideband: 'both',
  },
  usb: {
    id: 'usb',
    name: 'Upper Sideband',
    shortName: 'USB',
    description: 'HF amateur (20m+), marine SSB',
    bandwidthRange: [1_000, 4_000],
    defaultBandwidth: 2_400,
    minSampleRate: 12_000,
    hasAudio: true,
    sideband: 'upper',
  },
  lsb: {
    id: 'lsb',
    name: 'Lower Sideband',
    shortName: 'LSB',
    description: 'HF amateur (40m-), CB radio',
    bandwidthRange: [1_000, 4_000],
    defaultBandwidth: 2_400,
    minSampleRate: 12_000,
    hasAudio: true,
    sideband: 'lower',
  },
  cw: {
    id: 'cw',
    name: 'Continuous Wave',
    shortName: 'CW',
    description: 'Morse code, beacons',
    bandwidthRange: [50, 3_000],
    defaultBandwidth: 1500,
    minSampleRate: 8_000,
    hasAudio: true,
    sideband: 'both',
  },
  raw: {
    id: 'raw',
    name: 'Raw IQ',
    shortName: 'RAW',
    description: 'Unprocessed I/Q samples',
    bandwidthRange: [1_000, 300_000],
    defaultBandwidth: 48_000,
    minSampleRate: 8_000,
    hasAudio: false,
    sideband: 'none',
  },
};

// ---- Digital Mode Info ----

export interface DigitalModeInfo {
  id: DigitalMode;
  name: string;
  shortName: string;
  description: string;
  /** The binary to spawn for decoding */
  binary: string;
  /** Common arguments */
  defaultArgs: string[];
  /** Typical frequency in Hz */
  typicalFrequency: number;
  /** Required bandwidth in Hz */
  bandwidth: number;
  /** Required sample rate in Hz */
  sampleRate: number;
  /** Base demodulation needed before digital decode */
  baseDemod: DemodMode | null;
  /** Whether JS-native decoding is available (no external binary) */
  jsNative: boolean;
}

export const DIGITAL_MODES: Record<DigitalMode, DigitalModeInfo> = {
  adsb: {
    id: 'adsb',
    name: 'ADS-B (Mode S)',
    shortName: 'ADSB',
    description: 'Aircraft position and identity broadcast at 1090 MHz',
    binary: 'dump1090',
    defaultArgs: ['--raw', '--net', '--quiet'],
    typicalFrequency: 1_090_000_000,
    bandwidth: 1_000_000,
    sampleRate: 2_000_000,
    baseDemod: null, // direct from IQ
    jsNative: true, // mode-s-demodulator npm package
  },
  acars: {
    id: 'acars',
    name: 'ACARS',
    shortName: 'ACARS',
    description: 'Aircraft data link communications',
    binary: 'acarsdec',
    defaultArgs: ['-j', '-r', '0'],
    typicalFrequency: 131_550_000,
    bandwidth: 8_330,
    sampleRate: 48_000,
    baseDemod: 'am',
    jsNative: false,
  },
  vdl2: {
    id: 'vdl2',
    name: 'VDL Mode 2',
    shortName: 'VDL2',
    description: 'VHF digital data link for aviation',
    binary: 'dumpvdl2',
    defaultArgs: ['--output', 'decoded:json'],
    typicalFrequency: 136_900_000,
    bandwidth: 25_000,
    sampleRate: 96_000,
    baseDemod: null,
    jsNative: false,
  },
  hfdl: {
    id: 'hfdl',
    name: 'HFDL',
    shortName: 'HFDL',
    description: 'HF Data Link (ARINC 635) aircraft/ground network',
    binary: 'dumphfdl',
    defaultArgs: [],
    typicalFrequency: 21_931_000,
    bandwidth: 24_000,
    sampleRate: 24_000,
    baseDemod: null,
    jsNative: false,
  },
  ais: {
    id: 'ais',
    name: 'AIS',
    shortName: 'AIS',
    description: 'Automatic Identification System for ships',
    binary: 'rtl_ais',
    defaultArgs: ['-n'],
    typicalFrequency: 162_000_000,
    bandwidth: 25_000,
    sampleRate: 96_000,
    baseDemod: null,
    jsNative: true, // ais-stream-decoder npm package
  },
  aprs: {
    id: 'aprs',
    name: 'APRS',
    shortName: 'APRS',
    description: 'Amateur Packet Reporting System',
    binary: 'direwolf',
    defaultArgs: ['-r', '48000', '-t', '0'],
    typicalFrequency: 144_390_000,
    bandwidth: 12_500,
    sampleRate: 48_000,
    baseDemod: 'nfm',
    jsNative: true, // @hamradio/aprs parser (not demod)
  },
  navtex: {
    id: 'navtex',
    name: 'NAVTEX',
    shortName: 'NAVTEX',
    description: 'Maritime safety broadcasts, SITOR-B 100 baud',
    binary: 'navtex',
    defaultArgs: [],
    typicalFrequency: 518_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  ism: {
    id: 'ism',
    name: 'ISM sensors and meters',
    shortName: 'ISM',
    description: '868 MHz weather sensors, utility meters and home automation',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 868_950_000,
    bandwidth: 1_500_000,
    sampleRate: 2_400_000,
    baseDemod: null,
    jsNative: false,
  },
  packet: {
    id: 'packet',
    name: 'AX.25 Packet',
    shortName: 'PACKET',
    description: 'AX.25 packet radio, 1200 baud Bell 202 / 9600 baud G3RUH',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 145_010_000,
    bandwidth: 12_500,
    sampleRate: 48_000,
    baseDemod: 'nfm',
    jsNative: false,
  },
  pocsag: {
    id: 'pocsag',
    name: 'POCSAG',
    shortName: 'POCSAG',
    description: 'Pager protocol (512/1200/2400 baud)',
    binary: 'multimon-ng',
    defaultArgs: ['-t', 'raw', '-a', 'POCSAG512', '-a', 'POCSAG1200', '-a', 'POCSAG2400'],
    typicalFrequency: 153_350_000,
    bandwidth: 12_500,
    sampleRate: 48_000,
    baseDemod: 'nfm',
    jsNative: false,
  },
  ft8: {
    id: 'ft8',
    name: 'FT8',
    shortName: 'FT8',
    description: 'Weak-signal digital mode for HF amateur',
    binary: 'jt9',
    defaultArgs: ['--ft8'],
    typicalFrequency: 14_074_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  ft4: {
    id: 'ft4',
    name: 'FT4',
    shortName: 'FT4',
    description: 'Fast variant of FT8',
    binary: 'jt9',
    defaultArgs: ['--ft4'],
    typicalFrequency: 14_080_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  ft2: {
    id: 'ft2',
    name: 'FT2',
    shortName: 'FT2',
    description: 'Fast 3.75-second weak-signal mode',
    binary: 'jt9',
    defaultArgs: ['--ft2'],
    typicalFrequency: 14_080_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  fst4: {
    id: 'fst4',
    name: 'FST4',
    shortName: 'FST4',
    description: 'WSJT-X FST4 weak-signal mode',
    binary: 'jt9',
    defaultArgs: ['--fst4'],
    typicalFrequency: 7_078_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  q65: {
    id: 'q65',
    name: 'Q65',
    shortName: 'Q65',
    description: 'Q65 weak-signal mode for EME and scatter',
    binary: 'jt9',
    defaultArgs: ['--q65'],
    typicalFrequency: 50_275_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  jt65: {
    id: 'jt65',
    name: 'JT65',
    shortName: 'JT65',
    description: '60-second weak-signal mode for HF and EME',
    binary: 'jt9',
    defaultArgs: ['--jt65'],
    typicalFrequency: 14_076_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  jt9: {
    id: 'jt9',
    name: 'JT9',
    shortName: 'JT9',
    description: 'Narrow 60-second weak-signal mode',
    binary: 'jt9',
    defaultArgs: ['--jt9'],
    typicalFrequency: 14_078_000,
    bandwidth: 1_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  wefax: {
    id: 'wefax',
    name: 'Weather Fax',
    shortName: 'WEFAX',
    description: 'HF weather facsimile charts (radiofax)',
    binary: 'wefax',
    defaultArgs: [],
    typicalFrequency: 7_880_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  sstv: {
    id: 'sstv',
    name: 'SSTV',
    shortName: 'SSTV',
    description: 'Slow-scan television images on HF',
    binary: 'sstv',
    defaultArgs: [],
    typicalFrequency: 14_230_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  hell: {
    id: 'hell',
    name: 'Hellschreiber',
    shortName: 'HELL',
    description: 'Facsimile dot-matrix text on HF',
    binary: 'hell',
    defaultArgs: [],
    typicalFrequency: 7_040_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  olivia: {
    id: 'olivia',
    name: 'Olivia',
    shortName: 'OLIVIA',
    description: 'Multi-tone weak-signal keyboard mode',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 14_070_000,
    bandwidth: 1_000,
    sampleRate: 8_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  thor: {
    id: 'thor',
    name: 'THOR',
    shortName: 'THOR',
    description: 'Robust MFSK keyboard mode',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 14_070_000,
    bandwidth: 2_500,
    sampleRate: 8_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  fsq: {
    id: 'fsq',
    name: 'FSQ',
    shortName: 'FSQ',
    description: 'Fast Simple QSO keyboard mode',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 7_104_000,
    bandwidth: 2_500,
    sampleRate: 8_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  psk31: {
    id: 'psk31',
    name: 'PSK31',
    shortName: 'PSK31',
    description: 'BPSK31 narrowband keyboard mode',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 14_070_000,
    bandwidth: 500,
    sampleRate: 8_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  rtty: {
    id: 'rtty',
    name: 'RTTY',
    shortName: 'RTTY',
    description: 'Baudot FSK teleprinter',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 14_080_000,
    bandwidth: 500,
    sampleRate: 8_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  msk144: {
    id: 'msk144',
    name: 'MSK144',
    shortName: 'MSK144',
    description: 'Meteor-scatter MSK, 15 s periods',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 50_260_000,
    bandwidth: 2_500,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  fsk441: {
    id: 'fsk441',
    name: 'FSK441',
    shortName: 'FSK441',
    description: 'Meteor-scatter FSK, 15/30 s periods',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 50_260_000,
    bandwidth: 2_500,
    sampleRate: 11_025,
    baseDemod: 'usb',
    jsNative: false,
  },
  wspr: {
    id: 'wspr',
    name: 'WSPR',
    shortName: 'WSPR',
    description: 'Weak Signal Propagation Reporter',
    binary: 'wsprd',
    defaultArgs: [],
    typicalFrequency: 14_095_600,
    bandwidth: 200,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  pi4: {
    id: 'pi4',
    name: 'PI4',
    shortName: 'PI4',
    description: 'Next Generation Beacon 4-FSK',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 144_471_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  rade: {
    id: 'rade',
    name: 'FreeDV RADE',
    shortName: 'RADE',
    description: 'Neural digital voice for weak-signal HF',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 14_236_000,
    bandwidth: 3_000,
    sampleRate: 48_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  js8: {
    id: 'js8',
    name: 'JS8 Call',
    shortName: 'JS8',
    description: 'Keyboard messaging built on an FT8-like waveform',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 7_078_000,
    bandwidth: 3_000,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  dcf77: {
    id: 'dcf77',
    name: 'DCF77 time signal',
    shortName: 'DCF77',
    description: '77.5 kHz German longwave time and date code',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 77_500,
    bandwidth: 200,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
  als162: {
    id: 'als162',
    name: 'ALS162 time signal',
    shortName: 'ALS162',
    description: '162 kHz French longwave time and date code',
    binary: '',
    defaultArgs: [],
    typicalFrequency: 162_000,
    bandwidth: 200,
    sampleRate: 12_000,
    baseDemod: 'usb',
    jsNative: false,
  },
};

// ---- Frequency Band Definitions ----

export interface FrequencyBand {
  name: string;
  startHz: number;
  endHz: number;
  defaultMode: DemodMode;
  description: string;
}

export const FREQUENCY_BANDS: FrequencyBand[] = [
  { name: 'LW', startHz: 148_500, endHz: 283_500, defaultMode: 'am', description: 'Longwave broadcast' },
  { name: 'MW', startHz: 526_500, endHz: 1_706_500, defaultMode: 'am', description: 'Mediumwave broadcast' },
  { name: '160m', startHz: 1_800_000, endHz: 2_000_000, defaultMode: 'lsb', description: 'Amateur 160m' },
  { name: '80m', startHz: 3_500_000, endHz: 4_000_000, defaultMode: 'lsb', description: 'Amateur 80m' },
  { name: '60m', startHz: 5_330_500, endHz: 5_406_400, defaultMode: 'usb', description: 'Amateur 60m' },
  { name: '40m', startHz: 7_000_000, endHz: 7_300_000, defaultMode: 'lsb', description: 'Amateur 40m' },
  { name: '30m', startHz: 10_100_000, endHz: 10_150_000, defaultMode: 'cw', description: 'Amateur 30m' },
  { name: '20m', startHz: 14_000_000, endHz: 14_350_000, defaultMode: 'usb', description: 'Amateur 20m' },
  { name: '17m', startHz: 18_068_000, endHz: 18_168_000, defaultMode: 'usb', description: 'Amateur 17m' },
  { name: '15m', startHz: 21_000_000, endHz: 21_450_000, defaultMode: 'usb', description: 'Amateur 15m' },
  { name: '12m', startHz: 24_890_000, endHz: 24_990_000, defaultMode: 'usb', description: 'Amateur 12m' },
  { name: '10m', startHz: 28_000_000, endHz: 29_700_000, defaultMode: 'usb', description: 'Amateur 10m' },
  { name: '6m', startHz: 50_000_000, endHz: 54_000_000, defaultMode: 'usb', description: 'Amateur 6m' },
  { name: 'FM', startHz: 87_500_000, endHz: 108_000_000, defaultMode: 'wfm', description: 'FM broadcast' },
  { name: 'Air', startHz: 108_000_000, endHz: 137_000_000, defaultMode: 'am', description: 'Aviation VHF' },
  { name: '2m', startHz: 144_000_000, endHz: 148_000_000, defaultMode: 'nfm', description: 'Amateur 2m' },
  { name: 'Marine', startHz: 156_000_000, endHz: 162_025_000, defaultMode: 'nfm', description: 'Marine VHF' },
  { name: 'NOAA', startHz: 162_400_000, endHz: 162_550_000, defaultMode: 'nfm', description: 'NOAA Weather' },
  { name: '70cm', startHz: 420_000_000, endHz: 450_000_000, defaultMode: 'nfm', description: 'Amateur 70cm' },
  { name: 'PMR', startHz: 446_006_250, endHz: 446_193_750, defaultMode: 'nfm', description: 'PMR446' },
  { name: 'ADS-B', startHz: 1_090_000_000, endHz: 1_090_000_000, defaultMode: 'raw', description: 'ADS-B 1090 MHz' },
];

/**
 * Find the most likely demod mode for a given frequency
 */
export function suggestMode(frequencyHz: number): DemodMode {
  for (const band of FREQUENCY_BANDS) {
    if (frequencyHz >= band.startHz && frequencyHz <= band.endHz) {
      return band.defaultMode;
    }
  }
  // Default to NFM for unknown frequencies
  return 'nfm';
}

/**
 * Format frequency for display: 145.800.000 MHz
 */
export function formatFrequency(hz: number): string {
  const mhz = hz / 1_000_000;
  if (mhz >= 1000) {
    return `${(mhz / 1000).toFixed(6)} GHz`;
  }
  return `${mhz.toFixed(6)} MHz`;
}

/**
 * Format frequency with dot separators: 145.800.000
 */
export function formatFrequencyDotted(hz: number): string {
  const str = Math.round(hz).toString();
  // Insert dots every 3 digits from right
  const parts: string[] = [];
  for (let i = str.length; i > 0; i -= 3) {
    parts.unshift(str.slice(Math.max(0, i - 3), i));
  }
  return parts.join('.');
}

/**
 * Parse a dotted frequency string back to Hz
 */
export function parseFrequency(str: string): number {
  // Remove dots, spaces, and unit suffixes
  const clean = str.replace(/[.\s]/g, '').replace(/(MHz|GHz|kHz|Hz)/i, '');
  return parseInt(clean, 10);
}
