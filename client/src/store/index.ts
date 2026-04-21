// ============================================================
// node-sdr — SolidJS State Store
// ============================================================
// UI-only reactive state using SolidJS signals.
// FFT/audio data bypasses this entirely (imperative canvas/audio).
// ============================================================

import { createSignal, createRoot } from 'solid-js';
import type {
  CodecType,
  DemodMode,
  WaterfallColorTheme,
  UITheme,
  DongleInfo,
  DongleProfile,
} from '@node-sdr/shared';

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
  const [volume, setVolume] = createSignal(0.8);
  const [muted, setMuted] = createSignal(false);
  const [squelch, setSquelch] = createSignal<number | null>(null);
  const [signalLevel, setSignalLevel] = createSignal(-120); // dB
  const [stereoDetected, setStereoDetected] = createSignal(false);
  const [stereoEnabled, setStereoEnabled] = createSignal(true); // user toggle: allow stereo decoding
  const [stereoThreshold, setStereoThreshold] = createSignal(-60); // dB — minimum signal level to attempt stereo
  const [balance, setBalance] = createSignal(0); // -1 (left) to +1 (right), 0 = center
  const [eqLow, setEqLow] = createSignal(0);        // dB gain, -12 to +12 — 80 Hz lowshelf
  const [eqLowMid, setEqLowMid] = createSignal(0); // dB gain, -12 to +12 — 500 Hz peaking
  const [eqMid, setEqMid] = createSignal(0);        // dB gain, -12 to +12 — 1.5 kHz peaking
  const [eqHighMid, setEqHighMid] = createSignal(0);// dB gain, -12 to +12 — 4 kHz peaking
  const [eqHigh, setEqHigh] = createSignal(0);      // dB gain, -12 to +12 — 12 kHz highshelf
  const [loudness, setLoudness] = createSignal(false); // loudness enhancement on/off

  // ---- Noise Reduction ----
  const [nrEnabled, setNrEnabled] = createSignal(false);        // spectral NR on/off
  const [nrStrength, setNrStrength] = createSignal(0.5);        // 0-1 aggressiveness
  const [nbEnabled, setNbEnabled] = createSignal(false);        // noise blanker on/off
  const [nbLevel, setNbLevel] = createSignal(0.5);              // 0-1 blanker sensitivity

  // ---- Display ----
  const [waterfallTheme, setWaterfallTheme] = createSignal<WaterfallColorTheme>('turbo');
  const [uiTheme, setUITheme] = createSignal<UITheme>('default');
  const [waterfallMin, setWaterfallMin] = createSignal(-60);
  const [waterfallMax, setWaterfallMax] = createSignal(-10);
  const [waterfallAutoRange, setWaterfallAutoRange] = createSignal(true);
  const [waterfallSpeed, setWaterfallSpeed] = createSignal(30); // fps
  const [fftSize, setFftSize] = createSignal(2048);

  // ---- UI State ----
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [decoderPanelOpen, setDecoderPanelOpen] = createSignal(false);
  const [isAdmin, setIsAdmin] = createSignal(false);
  const [meterStyle, setMeterStyle] = createSignal<'bar' | 'needle'>('bar');

  // ---- Codec Preferences ----
  const [fftCodec, setFftCodec] = createSignal<CodecType>('deflate');
  const [iqCodec, setIqCodec] = createSignal<CodecType>('adpcm');

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
    waterfallSpeed, setWaterfallSpeed,
    fftSize, setFftSize,

    // UI State
    sidebarOpen, setSidebarOpen,
    decoderPanelOpen, setDecoderPanelOpen,
    isAdmin, setIsAdmin,
    meterStyle, setMeterStyle,

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
