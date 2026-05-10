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
  PushDongleInfo,
  PushServerConfig,
} from '~/shared';

// All codecs supported by the client (used as fallback when server doesn't send allowedCodecs)
const ALL_FFT_CODECS: FftCodecType[] = ['none', 'adpcm', 'deflate', 'deflate-floor'];
const ALL_IQ_CODECS: IqCodecType[] = ['none', 'adpcm', 'opus-lo', 'opus', 'opus-hq'];

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

  // ---- Persistent client ID (server-assigned UUID, survives page refresh) ----
  // Empty string means "no ID yet" — server will generate one on first connect.
  const [localClientId, setLocalClientId] = persist<string>('clientId', '');
  // Connection index — identifies this tab among multiple connections for same UUID
  const [connIndex, setConnIndex] = createSignal(0);

  // ---- Dongle / Profile ----
  const [dongles, setDongles] = createSignal<DongleInfo[]>([]);
  const [activeDongleId, setActiveDongleId] = createSignal('');
  const [activeProfile, setActiveProfile] = createSignal<DongleProfile | null>(null);
  const [activeProfileId, setActiveProfileId] = createSignal('');
  const [profiles, setProfiles] = createSignal<DongleProfile[]>([]);

  // ---- Push-based dongle state (from WS notifications) ----
  const [pushDongles, setPushDongles] = createSignal<PushDongleInfo[]>([]);
  const [pushServerConfig, setPushServerConfig] = createSignal<PushServerConfig | null>(null);
  const [configVersion, setConfigVersion] = createSignal(0);
  // Connection state: 'connecting' | 'connected' | 'disconnected' | 'unconfigured'
  const [connectionState, setConnectionState] = createSignal<'connecting' | 'connected' | 'disconnected' | 'unconfigured'>('disconnected');
  // Reconnect attempt counter (0 = not reconnecting, >0 = attempt N of max)
  const [reconnectAttempt, setReconnectAttempt] = createSignal(0);

  // ---- Tuning ----
  const [centerFrequency, setCenterFrequency] = createSignal(100_000_000);
  const [sampleRate, setSampleRate] = createSignal(2_400_000);
  const [iqSampleRate, setIqSampleRate] = createSignal(240_000); // IQ sub-band rate from server
  const [tuneOffset, setTuneOffset] = createSignal(0);
  const [mode, setMode] = createSignal<DemodMode>('nfm');
  const [bandwidth, setBandwidth] = createSignal(12_500);
  /** Tuning step in Hz. 0 = auto (use bandwidth). User can override. */
  const [tuningStep, setTuningStep] = createSignal(0);

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

  // ---- AGC ----
  const [agcEnabled, setAgcEnabled] = persist<boolean>('audio.agcEnabled', true);
  const [agcDecayMs, setAgcDecayMs] = persist<number>('audio.agcDecayMs', 250);

  // ---- Audio Filters ----
  const [rumbleFilterEnabled, setRumbleFilterEnabled] = persist<boolean>('audio.rumbleFilter', false);
  const [rumbleFilterCutoff, setRumbleFilterCutoff] = persist<number>('audio.rumbleCutoff', 65);
  const [autoNotchEnabled, setAutoNotchEnabled] = persist<boolean>('audio.autoNotch', false);
  const [hiBlendEnabled, setHiBlendEnabled] = persist<boolean>('audio.hiBlend', false);
  const [hiBlendCutoff, setHiBlendCutoff] = persist<number>('audio.hiBlendCutoff', 2500);
  const [softMuteEnabled, setSoftMuteEnabled] = persist<boolean>('audio.softMute', false);
  /** Soft mute threshold in dB — below this level, volume is progressively reduced */
  const [softMuteThreshold, setSoftMuteThreshold] = persist<number>('audio.softMuteThreshold', -40);

  // ---- Display ----
  const [waterfallTheme, setWaterfallTheme] = persist<WaterfallColorTheme>('waterfallTheme', 'classic');
  const [uiTheme, setUITheme] = persist<UITheme>('uiTheme', 'vfd');
  const [waterfallMin, setWaterfallMin] = createSignal(-60);
  const [waterfallMax, setWaterfallMax] = createSignal(-10);
  const [waterfallAutoRange, setWaterfallAutoRange] = createSignal(true);
  const [waterfallGamma, setWaterfallGamma] = persist<number>('waterfallGamma', 1.0);
  const [waterfallSpeed, setWaterfallSpeed] = createSignal(30); // fps
  const [fftSize, setFftSize] = createSignal(2048);

  // ---- Audio Start State ----
  // Persisted so HMR/reconnect can restore audio without another user gesture.
  const [audioStarted, setAudioStarted] = persist<boolean>('audio.started', false);

  // ---- UI State ----
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [decoderPanelOpen, setDecoderPanelOpen] = createSignal(false);
  const [isAdmin, setIsAdmin] = createSignal(false);
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

  // ---- Codec Preferences (localStorage-persisted) ----
  const [fftCodec, setFftCodec] = persist<FftCodecType>('codec.fft', 'deflate-floor');
  const [iqCodec, setIqCodec] = persist<IqCodecType>('codec.iq', 'opus');

  // ---- Available Codecs (from server 'welcome' message) ----
  // Initialized to all codecs; restricted by server on connect.
  const [availableFftCodecs, setAvailableFftCodecs] = createSignal<FftCodecType[]>(ALL_FFT_CODECS);
  const [availableIqCodecs, setAvailableIqCodecs] = createSignal<IqCodecType[]>(ALL_IQ_CODECS);

  // ---- Bandwidth / Throughput Metrics ----
  const [fftRate, setFftRate] = createSignal(0);         // FFT frames/sec
  const [iqRate, setIqRate] = createSignal(0);           // IQ samples/sec
  const [wsBytes, setWsBytes] = createSignal(0);         // WebSocket bytes/sec (total inbound)
  const [wsBytesHistory, setWsBytesHistory] = createSignal<number[]>([]); // last 30 seconds

  // ---- Server Stats (broadcast every 2s) ----
  const [serverCpu, setServerCpu] = createSignal(0);     // server process CPU %
  const [serverMem, setServerMem] = createSignal(0);     // server process RSS MB
  const [serverClients, setServerClients] = createSignal(0); // total connected clients

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

  // ---- Music identification ----
  const [identifyState, setIdentifyState] = createSignal<'idle' | 'capturing' | 'querying' | 'done' | 'error'>('idle');
  const [identifyResult, setIdentifyResult] = createSignal<null | {
    match: boolean;
    title?: string;
    artist?: string;
    album?: string;
    spotify?: string;
    youtube?: string;
    apple?: string;
    service?: string;
    error?: string; // set on failure so the UI can show what went wrong
  }>(null);

  // Timestamp (ms) until which the Identify button should be disabled after a
  // frequency change on ADPCM/none codecs (ring buffer needs to refill).
  // 0 = not waiting. Opus is exempt — the server ring is independent of client tuning.
  const [identifyReadyAt, setIdentifyReadyAt] = createSignal(0);

  // ---- Toast notifications (server-pushed or client-generated) ----
  const [toasts, setToasts] = createSignal<Array<{ id: number; message: string; code?: string }>>([]);
  let toastSeq = 0;

  return {
    // Connection
    connected, setConnected,
    clientId, setClientId,
    localClientId, setLocalClientId,
    connIndex, setConnIndex,

    // Dongle / Profile
    dongles, setDongles,
    activeDongleId, setActiveDongleId,
    activeProfile, setActiveProfile,
    activeProfileId, setActiveProfileId,
    profiles, setProfiles,

    // Push-based state
    pushDongles, setPushDongles,
    pushServerConfig, setPushServerConfig,
    configVersion, setConfigVersion,
    connectionState, setConnectionState,
    reconnectAttempt, setReconnectAttempt,

    // Tuning
    centerFrequency, setCenterFrequency,
    sampleRate, setSampleRate,
    iqSampleRate, setIqSampleRate,
    tuneOffset, setTuneOffset,
    mode, setMode,
    bandwidth, setBandwidth,
    tuningStep, setTuningStep,
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

    // AGC
    agcEnabled, setAgcEnabled,
    agcDecayMs, setAgcDecayMs,

    // Audio Filters
    rumbleFilterEnabled, setRumbleFilterEnabled,
    rumbleFilterCutoff, setRumbleFilterCutoff,
    autoNotchEnabled, setAutoNotchEnabled,
    hiBlendEnabled, setHiBlendEnabled,
    hiBlendCutoff, setHiBlendCutoff,
    softMuteEnabled, setSoftMuteEnabled,
    softMuteThreshold, setSoftMuteThreshold,

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

    // Available Codecs (server-reported)
    availableFftCodecs, setAvailableFftCodecs,
    availableIqCodecs, setAvailableIqCodecs,

    // Bandwidth / Throughput
    fftRate, setFftRate,
    iqRate, setIqRate,
    wsBytes, setWsBytes,
    wsBytesHistory, setWsBytesHistory,

    // Server Stats
    serverCpu, setServerCpu,
    serverMem, setServerMem,
    serverClients, setServerClients,

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
    identifyState, setIdentifyState,
    identifyResult, setIdentifyResult,
    identifyReadyAt, setIdentifyReadyAt,
    toasts,
    addToast: (message: string, code?: string) => {
      const id = ++toastSeq;
      setToasts(prev => [...prev, { id, message, code }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    },
    dismissToast: (id: number) => setToasts(prev => prev.filter(t => t.id !== id)),
  };
}

// Create a singleton store
export const store = createRoot(createStore);
export { ALL_FFT_CODECS, ALL_IQ_CODECS };
