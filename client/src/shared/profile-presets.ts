// ============================================================
// node-sdr — Profile Presets
// ============================================================
// Curated default profiles that can be applied to any dongle.
// Derived from ITU band plans and common radio usage patterns.
// Users can select a preset when adding a profile to quickly
// configure center frequency, sample rate, mode, and bandwidth.
// ============================================================

export interface ProfilePreset {
  /** Unique preset ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Category for grouping in UI */
  category: PresetCategory;
  /** Description of what this covers */
  description: string;
  /** Center frequency in Hz */
  centerFrequency: number;
  /** Sample rate in Hz */
  sampleRate: number;
  /** FFT size (power of 2) */
  fftSize: number;
  /** FFT frames per second */
  fftFps: number;
  /** Default demodulation mode */
  defaultMode: string;
  /** Default tune offset from center in Hz */
  defaultTuneOffset: number;
  /** Default channel bandwidth in Hz */
  defaultBandwidth: number;
  /** Suggested gain (null = auto) */
  gain: number | null;
  /** Whether direct sampling is needed (0=off, 1=I, 2=Q) */
  directSampling?: 0 | 1 | 2;
}

export type PresetCategory =
  | 'broadcast'
  | 'amateur'
  | 'aviation'
  | 'marine'
  | 'utility'
  | 'public-safety'
  | 'satellite'
  | 'weather';

export const PRESET_CATEGORIES: Record<PresetCategory, string> = {
  'broadcast': 'Broadcast',
  'amateur': 'Amateur Radio',
  'aviation': 'Aviation',
  'marine': 'Marine',
  'utility': 'Utility & Services',
  'public-safety': 'Public Safety',
  'satellite': 'Satellite',
  'weather': 'Weather',
};

export const PROFILE_PRESETS: ProfilePreset[] = [
  // ---- Broadcast ----
  {
    id: 'fm-broadcast',
    name: 'FM Broadcast',
    category: 'broadcast',
    description: 'FM radio 87.5–108 MHz (stereo, RDS)',
    centerFrequency: 100_000_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 20,
    defaultMode: 'wfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 200_000,
    gain: null,
  },
  {
    id: 'mw-broadcast',
    name: 'MW Broadcast (AM)',
    category: 'broadcast',
    description: 'Medium wave 530–1700 kHz (requires direct sampling)',
    centerFrequency: 1_000_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 10,
    defaultMode: 'am',
    defaultTuneOffset: 500_000,
    defaultBandwidth: 10_000,
    gain: null,
    directSampling: 2,
  },
  {
    id: 'sw-broadcast',
    name: 'Shortwave Broadcast',
    category: 'broadcast',
    description: 'International shortwave 5.9–6.2 MHz (requires direct sampling)',
    centerFrequency: 6_050_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'am',
    defaultTuneOffset: 0,
    defaultBandwidth: 10_000,
    gain: null,
    directSampling: 2,
  },
  {
    id: 'dab-broadcast',
    name: 'DAB+ Digital Radio',
    category: 'broadcast',
    description: 'DAB Band III 174–230 MHz',
    centerFrequency: 200_000_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 1_536_000,
    gain: null,
  },

  // ---- Amateur Radio ----
  {
    id: 'ham-80m',
    name: '80m Band (3.5–4 MHz)',
    category: 'amateur',
    description: 'HF amateur 80m — SSB, CW, digital (direct sampling)',
    centerFrequency: 3_750_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'lsb',
    defaultTuneOffset: 0,
    defaultBandwidth: 2_700,
    gain: null,
    directSampling: 2,
  },
  {
    id: 'ham-40m',
    name: '40m Band (7–7.3 MHz)',
    category: 'amateur',
    description: 'HF amateur 40m — SSB, CW, FT8 (direct sampling)',
    centerFrequency: 7_100_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'lsb',
    defaultTuneOffset: 0,
    defaultBandwidth: 2_700,
    gain: null,
    directSampling: 2,
  },
  {
    id: 'ham-20m',
    name: '20m Band (14–14.35 MHz)',
    category: 'amateur',
    description: 'HF amateur 20m — SSB, CW, FT8 (direct sampling)',
    centerFrequency: 14_175_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'usb',
    defaultTuneOffset: 0,
    defaultBandwidth: 2_700,
    gain: null,
    directSampling: 2,
  },
  {
    id: 'ham-2m',
    name: '2m Band (144–148 MHz)',
    category: 'amateur',
    description: 'VHF amateur 2m — FM repeaters, SSB, APRS',
    centerFrequency: 146_000_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },
  {
    id: 'ham-70cm',
    name: '70cm Band (430–440 MHz)',
    category: 'amateur',
    description: 'UHF amateur 70cm — FM repeaters, digital, satellite',
    centerFrequency: 435_000_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },

  // ---- Aviation ----
  {
    id: 'airband',
    name: 'Aviation VHF',
    category: 'aviation',
    description: 'Airband 118–137 MHz — tower, approach, ATIS',
    centerFrequency: 127_500_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'am',
    defaultTuneOffset: 0,
    defaultBandwidth: 8_330,
    gain: 40,
  },
  {
    id: 'airband-mil',
    name: 'Military Airband (UHF)',
    category: 'aviation',
    description: 'Military aviation 225–380 MHz — AM',
    centerFrequency: 300_000_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'am',
    defaultTuneOffset: 0,
    defaultBandwidth: 8_330,
    gain: 40,
  },
  {
    id: 'adsb-1090',
    name: 'ADS-B (1090 MHz)',
    category: 'aviation',
    description: 'Aircraft transponder 1090 MHz',
    centerFrequency: 1_090_000_000,
    sampleRate: 2_400_000,
    fftSize: 2048,
    fftFps: 10,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 2_000_000,
    gain: 49,
  },

  // ---- Marine ----
  {
    id: 'marine-vhf',
    name: 'Marine VHF',
    category: 'marine',
    description: 'Marine band 156–162 MHz — Ch16 distress, port ops',
    centerFrequency: 158_000_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },
  {
    id: 'marine-hf',
    name: 'Marine HF',
    category: 'marine',
    description: 'Marine HF 4–8 MHz — SSB (direct sampling)',
    centerFrequency: 6_200_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'usb',
    defaultTuneOffset: 0,
    defaultBandwidth: 2_700,
    gain: null,
    directSampling: 2,
  },

  // ---- Utility & Services ----
  {
    id: 'pmr446',
    name: 'PMR446',
    category: 'utility',
    description: 'European license-free PMR 446.0–446.2 MHz',
    centerFrequency: 446_100_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },
  {
    id: 'gmrs-frs',
    name: 'GMRS / FRS',
    category: 'utility',
    description: 'US family/general mobile radio 462–467 MHz',
    centerFrequency: 464_500_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },
  {
    id: 'cb-radio',
    name: 'CB Radio (27 MHz)',
    category: 'utility',
    description: 'Citizens band 26.965–27.405 MHz (direct sampling)',
    centerFrequency: 27_185_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'am',
    defaultTuneOffset: 0,
    defaultBandwidth: 10_000,
    gain: null,
    directSampling: 2,
  },
  {
    id: 'ism-433',
    name: 'ISM 433 MHz',
    category: 'utility',
    description: 'IoT, sensors, remotes, weather stations 433–434 MHz',
    centerFrequency: 433_920_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },
  {
    id: 'ism-868',
    name: 'ISM 868 MHz (EU)',
    category: 'utility',
    description: 'LoRa, IoT, smart meters 868 MHz (Europe)',
    centerFrequency: 868_000_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 125_000,
    gain: null,
  },
  {
    id: 'ism-915',
    name: 'ISM 915 MHz (US)',
    category: 'utility',
    description: 'LoRa, IoT, smart meters 915 MHz (Americas)',
    centerFrequency: 915_000_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 125_000,
    gain: null,
  },

  // ---- Public Safety ----
  {
    id: 'public-safety-vhf',
    name: 'Public Safety VHF',
    category: 'public-safety',
    description: 'Emergency services 148–174 MHz',
    centerFrequency: 155_000_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },
  {
    id: 'public-safety-uhf',
    name: 'Public Safety UHF',
    category: 'public-safety',
    description: 'Emergency services 450–470 MHz',
    centerFrequency: 460_000_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 25,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },

  // ---- Satellite ----
  {
    id: 'noaa-apt',
    name: 'NOAA Weather Satellites',
    category: 'satellite',
    description: 'NOAA APT 137 MHz — weather imagery',
    centerFrequency: 137_500_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 40_000,
    gain: 40,
  },
  {
    id: 'meteor-m2',
    name: 'Meteor-M2 Satellite',
    category: 'satellite',
    description: 'Russian weather satellite LRPT 137.1/137.9 MHz',
    centerFrequency: 137_500_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 120_000,
    gain: 40,
  },
  {
    id: 'inmarsat-aero',
    name: 'Inmarsat Aero (L-band)',
    category: 'satellite',
    description: 'Inmarsat aero/maritime 1.545 GHz',
    centerFrequency: 1_545_000_000,
    sampleRate: 2_400_000,
    fftSize: 4096,
    fftFps: 15,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 25_000,
    gain: 49,
  },

  // ---- Weather ----
  {
    id: 'noaa-weather-radio',
    name: 'NOAA Weather Radio',
    category: 'weather',
    description: 'US weather broadcasts 162.4–162.55 MHz',
    centerFrequency: 162_475_000,
    sampleRate: 2_400_000,
    fftSize: 8192,
    fftFps: 20,
    defaultMode: 'nfm',
    defaultTuneOffset: 0,
    defaultBandwidth: 12_500,
    gain: null,
  },
];
