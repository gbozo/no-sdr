// ============================================================
// node-sdr — SolidJS State Store
// ============================================================
// UI-only reactive state using SolidJS signals.
// FFT/audio data bypasses this entirely (imperative canvas/audio).
// ============================================================

import { createSignal, createRoot } from 'solid-js';
import type {
  CodecType,
  FftCodecType,
  IqCodecType,
  DemodMode,
  WaterfallColorTheme,
  UITheme,
  DongleInfo,
  DongleProfile,
} from '@node-sdr/shared';

// ---- Bookmark type ----
export interface Bookmark {
  id: string;
  label: string;
  hz: number;
  mode: DemodMode;
  bandwidth: number;
}

// ---- localStorage persistence helper ----
const NS = 'node-sdr:';

function persist<T>(key: string, defaultValue: T): [() => T, (v: T) => void] {
  let stored: T = defaultValue;
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw !== null) stored = JSON.parse(raw) as T;
  } catch { /* ignore parse errors, use default */ }
  const [get, setRaw] = createSignal<T>(stored);
  const set = (v: T) => {
    setRaw(() => v);
    try { localStorage.setItem(NS + key, JSON.stringify(v)); } catch { /* quota exceeded etc */ }
  };
  return [get, set];
}

function createStore() {
  // ---- Connection State ----
  const [connected, setConnected] = createSignal(false);
  const [clientId, setClientId] = createSignal('');

  // ---- Dongle / Profile ----
  const [dongles, setDongles] = createSignal<DongleInfo[]>([]);
  const [activeDongleId, setActiveDongleId] = createSignal('');
  const [activeProfile, setActiveProfile] = createSignal<DongleProfile | null>(null);
  const [profiles, setProfiles] = createSignal<DongleProfile[]>([]);

  // ---- Tuning ----
  const [centerFrequency, setCenterFrequency] = createSignal(100_000_000);
  const [sampleRate, setSampleRate] = createSignal(2_400_000);
  const [iqSampleRate, setIqSampleRate] = createSignal(240_000); // IQ sub-band rate from server
  const [tuneOffset, setTuneOffset] = createSignal(0);
  const [mode, setMode] = createSignal<DemodMode>('nfm');
  const [bandwidth, setBandwidth] = createSignal(12_500);

  // Computed: actual tuned frequency
  const tunedFrequency = () => centerFrequency() + tuneOffset();

  // ---- Audio ----
  const [volume, setVolume] = persist<number>('audio.volume', 0.8);
  const [muted, setMuted] = createSignal(false);
  const [squelch, setSquelch] = persist<number | null>('audio.squelch', null);
  const [signalLevel, setSignalLevel] = createSignal(-120); // dB
  const [stereoDetected, setStereoDetected] = createSignal(false);
  const [stereoEnabled, setStereoEnabled] = persist<boolean>('audio.stereoEnabled', true);
  const [stereoThreshold, setStereoThreshold] = persist<number>('audio.stereoThreshold', -60);
  const [balance, setBalance] = persist<number>('audio.balance', 0);
  const [eqLow, setEqLow] = persist<number>('audio.eqLow', 0);
  const [eqLowMid, setEqLowMid] = persist<number>('audio.eqLowMid', 0);
  const [eqMid, setEqMid] = persist<number>('audio.eqMid', 0);
  const [eqHighMid, setEqHighMid] = persist<number>('audio.eqHighMid', 0);
  const [eqHigh, setEqHigh] = persist<number>('audio.eqHigh', 0);
  const [loudness, setLoudness] = persist<boolean>('audio.loudness', false);

  // ---- Noise Reduction ----
  const [nrEnabled, setNrEnabled] = persist<boolean>('audio.nrEnabled', false);
  const [nrStrength, setNrStrength] = persist<number>('audio.nrStrength', 0.5);
  const [nbEnabled, setNbEnabled] = persist<boolean>('audio.nbEnabled', false);
  const [nbLevel, setNbLevel] = persist<number>('audio.nbLevel', 0.5);

  // ---- Display ----
  const [waterfallTheme, setWaterfallTheme] = persist<WaterfallColorTheme>('waterfallTheme', 'turbo');
  const [uiTheme, setUITheme] = persist<UITheme>('uiTheme', 'default');
  const [waterfallMin, setWaterfallMin] = createSignal(-60);
  const [waterfallMax, setWaterfallMax] = createSignal(-10);
  const [waterfallAutoRange, setWaterfallAutoRange] = createSignal(true);
  const [waterfallGamma, setWaterfallGamma] = persist<number>('waterfallGamma', 1.0);
  const [waterfallSpeed, setWaterfallSpeed] = createSignal(30); // fps
  const [fftSize, setFftSize] = createSignal(2048);

  // ---- Audio Start State ----
  const [audioStarted, setAudioStarted] = createSignal(false);

  // ---- UI State ----
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [decoderPanelOpen, setDecoderPanelOpen] = createSignal(false);
  const [isAdmin, setIsAdmin] = createSignal(false);
  const [adminModalOpen, setAdminModalOpen] = createSignal(false);
  const [adminSection, setAdminSection] = createSignal<'dongles' | 'profiles' | 'server'>('dongles');
  const [meterStyle, setMeterStyle] = persist<'bar' | 'needle'>('meterStyle', 'needle');
  const [audioSpectrumVisible, setAudioSpectrumVisible] = persist<boolean>('audioSpectrumVisible', true);
  const [spectrumPeakHold, setSpectrumPeakHold] = persist<boolean>('spectrumPeakHold', false);
  const [spectrumSignalFill, setSpectrumSignalFill] = persist<boolean>('spectrumSignalFill', false);
  const [spectrumPaused, setSpectrumPaused] = createSignal(false);
  const [spectrumAveraging, setSpectrumAveraging] = persist<'fast' | 'med' | 'slow'>('spectrumAveraging', 'fast');
  const [spectrumNoiseFloor, setSpectrumNoiseFloor] = persist<boolean>('spectrumNoiseFloor', false);
  // Zoom viewport [start, end] as fractions of full bandwidth 0..1
  const [spectrumZoom, setSpectrumZoom] = createSignal<[number, number]>([0, 1]);
  const [spectrumRangeSelect, setSpectrumRangeSelect] = createSignal(false);
  // Signal markers: array of absolute Hz frequencies
  const [signalMarkers, setSignalMarkers] = createSignal<number[]>([]);

  // ---- Frequency Bookmarks (localStorage-persisted) ----
  const [bookmarksRaw, setBookmarksRaw] = persist<Bookmark[]>('bookmarks', []);
  const setBookmarks = (bm: Bookmark[]) => {
    setBookmarksRaw(bm);
    // Keep signal markers in sync with bookmark frequencies
    setSignalMarkers(bm.map(b => b.hz));
  };
  const bookmarks = bookmarksRaw;
  // Init markers from stored bookmarks on load
  setSignalMarkers(bookmarksRaw().map(b => b.hz));

  // ---- Codec Preferences ----
  const [fftCodec, setFftCodec] = createSignal<FftCodecType>('deflate-floor');
  const [iqCodec, setIqCodec] = createSignal<IqCodecType>('opus');

  // ---- Bandwidth / Throughput Metrics ----
  const [fftRate, setFftRate] = createSignal(0);         // FFT frames/sec
  const [iqRate, setIqRate] = createSignal(0);           // IQ samples/sec
  const [wsBytes, setWsBytes] = createSignal(0);         // WebSocket bytes/sec (total inbound)
  const [wsBytesHistory, setWsBytesHistory] = createSignal<number[]>([]); // last 30 seconds

  // ---- Codec Performance Stats (bytes/sec) ----
  const [fftWireBytes, setFftWireBytes] = createSignal(0);   // FFT wire bytes/sec (compressed)
  const [fftRawBytes, setFftRawBytes] = createSignal(0);     // FFT equivalent raw bytes/sec
  const [iqWireBytes, setIqWireBytes] = createSignal(0);     // IQ wire bytes/sec (compressed)
  const [iqRawBytes, setIqRawBytes] = createSignal(0);       // IQ equivalent raw bytes/sec

  // ---- RDS Data (WFM only) ----
  const [rdsPs, setRdsPs] = createSignal('');                 // Programme Service name (8 chars)
  const [rdsRt, setRdsRt] = createSignal('');                 // RadioText (up to 64 chars)
  const [rdsPty, setRdsPty] = createSignal('');               // Programme Type name
  const [rdsPi, setRdsPi] = createSignal('');                 // PI code (hex string)
  const [rdsSynced, setRdsSynced] = createSignal(false);      // RDS sync acquired

  return {
    // Connection
    connected, setConnected,
    clientId, setClientId,

    // Dongle / Profile
    dongles, setDongles,
    activeDongleId, setActiveDongleId,
    activeProfile, setActiveProfile,
    profiles, setProfiles,

    // Tuning
    centerFrequency, setCenterFrequency,
    sampleRate, setSampleRate,
    iqSampleRate, setIqSampleRate,
    tuneOffset, setTuneOffset,
    mode, setMode,
    bandwidth, setBandwidth,
    tunedFrequency,

    // Audio
    volume, setVolume,
    muted, setMuted,
    squelch, setSquelch,
    signalLevel, setSignalLevel,
    stereoDetected, setStereoDetected,
    stereoEnabled, setStereoEnabled,
    stereoThreshold, setStereoThreshold,
    balance, setBalance,
    eqLow, setEqLow,
    eqLowMid, setEqLowMid,
    eqMid, setEqMid,
    eqHighMid, setEqHighMid,
    eqHigh, setEqHigh,
    loudness, setLoudness,

    // Noise Reduction
    nrEnabled, setNrEnabled,
    nrStrength, setNrStrength,
    nbEnabled, setNbEnabled,
    nbLevel, setNbLevel,

    // Display
    waterfallTheme, setWaterfallTheme,
    uiTheme, setUITheme,
    waterfallMin, setWaterfallMin,
    waterfallMax, setWaterfallMax,
    waterfallAutoRange, setWaterfallAutoRange,
    waterfallGamma, setWaterfallGamma,
    waterfallSpeed, setWaterfallSpeed,
    fftSize, setFftSize,

    // UI State
    audioStarted, setAudioStarted,
    sidebarOpen, setSidebarOpen,
    decoderPanelOpen, setDecoderPanelOpen,
    isAdmin, setIsAdmin,
    adminModalOpen, setAdminModalOpen,
    adminSection, setAdminSection,
    meterStyle, setMeterStyle,
    audioSpectrumVisible, setAudioSpectrumVisible,
    spectrumPeakHold, setSpectrumPeakHold,
    spectrumSignalFill, setSpectrumSignalFill,
    spectrumPaused, setSpectrumPaused,
    spectrumAveraging, setSpectrumAveraging,
    spectrumNoiseFloor, setSpectrumNoiseFloor,
    spectrumZoom, setSpectrumZoom,
    spectrumRangeSelect, setSpectrumRangeSelect,
    signalMarkers, setSignalMarkers,
    bookmarks, setBookmarks,

    // Codec Preferences
    fftCodec, setFftCodec,
    iqCodec, setIqCodec,

    // Bandwidth / Throughput
    fftRate, setFftRate,
    iqRate, setIqRate,
    wsBytes, setWsBytes,
    wsBytesHistory, setWsBytesHistory,

    // Codec Performance Stats
    fftWireBytes, setFftWireBytes,
    fftRawBytes, setFftRawBytes,
    iqWireBytes, setIqWireBytes,
    iqRawBytes, setIqRawBytes,

    // RDS Data
    rdsPs, setRdsPs,
    rdsRt, setRdsRt,
    rdsPty, setRdsPty,
    rdsPi, setRdsPi,
    rdsSynced, setRdsSynced,
  };
}

// Create a singleton store
export const store = createRoot(createStore);
