// ============================================================
// node-sdr — SolidJS State Store
// ============================================================
// UI-only reactive state using SolidJS signals.
// FFT/audio data bypasses this entirely (imperative canvas/audio).
// ============================================================

import { createSignal, createRoot } from 'solid-js';
import type {
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

  // ---- Display ----
  const [waterfallTheme, setWaterfallTheme] = createSignal<WaterfallColorTheme>('turbo');
  const [uiTheme, setUITheme] = createSignal<UITheme>('default');
  const [waterfallMin, setWaterfallMin] = createSignal(-120);
  const [waterfallMax, setWaterfallMax] = createSignal(-40);
  const [waterfallSpeed, setWaterfallSpeed] = createSignal(30); // fps
  const [fftSize, setFftSize] = createSignal(2048);

  // ---- UI State ----
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [decoderPanelOpen, setDecoderPanelOpen] = createSignal(false);
  const [isAdmin, setIsAdmin] = createSignal(false);

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
    tuneOffset, setTuneOffset,
    mode, setMode,
    bandwidth, setBandwidth,
    tunedFrequency,

    // Audio
    volume, setVolume,
    muted, setMuted,
    squelch, setSquelch,
    signalLevel, setSignalLevel,

    // Display
    waterfallTheme, setWaterfallTheme,
    uiTheme, setUITheme,
    waterfallMin, setWaterfallMin,
    waterfallMax, setWaterfallMax,
    waterfallSpeed, setWaterfallSpeed,
    fftSize, setFftSize,

    // UI State
    sidebarOpen, setSidebarOpen,
    decoderPanelOpen, setDecoderPanelOpen,
    isAdmin, setIsAdmin,
  };
}

// Create a singleton store
export const store = createRoot(createStore);
