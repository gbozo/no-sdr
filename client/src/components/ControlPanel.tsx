// ============================================================
// node-sdr — Control Panel (Sidebar)
// ============================================================

import { Component, For, Show, createSignal, createResource, onMount, onCleanup, createEffect } from 'solid-js';
import { store } from '../store/index.js';
import type { Bookmark } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';
import { DEMOD_MODES } from '~/shared';
import type { CodecType, FftCodecType, IqCodecType, DemodMode, DongleInfo, DongleProfile, WaterfallColorTheme } from '~/shared';
import { getPaletteNames } from '../engine/palettes.js';

const ControlPanel: Component = () => {
  return (
    <div class="flex flex-col gap-3 p-3 overflow-y-auto h-full">
      {/* S-Meter — fixed width centred on mobile, full width on desktop */}
      <div class="flex justify-center md:block">
        <div class="w-full max-w-[300px] md:max-w-none">
          <SMeter />
        </div>
      </div>

      {/* Dongle & Profile Selector */}
      <DongleProfileSelector />

      {/* Mode Selector */}
      <ModeSelector />

      {/* Music Identification */}
      <IdentifyPanel />

      {/* Audio Controls */}
      <AudioControls />

      {/* Noise Reduction */}
      <NoiseReduction />

      {/* Waterfall Settings */}
      <WaterfallSettings />

      {/* Codec Settings */}
      <CodecSettings />

      {/* Frequency Bookmarks */}
      <Bookmarks />
    </div>
  );
};

// ---- Mode Selector ----
// ---- Audio Spectrum Display ----
const AudioSpectrum: Component<{ audioOpen: () => boolean }> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  let rafId: number | undefined;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  const NUM_BARS = 16;
  const FLOOR_DB = -80;
  const PEAK_DB  = -10;

  const draw = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const analyser = engine.getAudioAnalyser();

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Theme colours
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--sdr-accent').trim() || '#4aa3ff';

    // ── Background ──
    ctx.fillStyle = '#04080f';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 3);
    ctx.fill();

    // Bezel
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 3);
    ctx.stroke();

    // Horizontal grid lines (every 20% height)
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 0.5;
    for (let i = 1; i < 5; i++) {
      const y = Math.round(h * i / 5) + 0.5;
      ctx.beginPath();
      ctx.moveTo(2, y);
      ctx.lineTo(w - 2, y);
      ctx.stroke();
    }

    const NUM_SEGS  = 12;
    const pad       = 3;
    const totalW    = w - pad * 2;
    const barW      = totalW / NUM_BARS;
    const segGap    = 1;
    const segH      = (h - pad * 2 - segGap * (NUM_SEGS - 1)) / NUM_SEGS;

    // Get FFT data — 32 bins from fftSize=64
    const binCount   = analyser ? analyser.frequencyBinCount : 0;
    const freqData   = new Uint8Array(binCount);
    if (analyser) analyser.getByteFrequencyData(freqData);

    // Map 16 bars from the available bins
    // Bin 0 = DC, bin 1..binCount-1 = 0..24kHz at 48kHz sample rate
    // Skip DC (bin 0), distribute remaining bins across NUM_BARS
    for (let bar = 0; bar < NUM_BARS; bar++) {
      const binStart = 1 + Math.floor(bar * (binCount - 1) / NUM_BARS);
      const binEnd   = 1 + Math.floor((bar + 1) * (binCount - 1) / NUM_BARS);

      // Max across mapped bins
      let val = 0;
      for (let b = binStart; b <= Math.min(binEnd, binCount - 1); b++) {
        if (freqData[b] > val) val = freqData[b];
      }

      // Convert 0-255 (Uint8 dB scale) to 0-1 normalised level
      const level = val / 255;

      // How many segments to light
      const litSegs = Math.round(level * NUM_SEGS);

      const x = pad + bar * barW + barW * 0.08;
      const bw = barW * 0.84;

      for (let seg = 0; seg < NUM_SEGS; seg++) {
        // seg 0 = top (loudest), seg NUM_SEGS-1 = bottom (quietest)
        const y = pad + seg * (segH + segGap);
        const segFromTop = seg;               // 0 = top
        const lit = segFromTop >= (NUM_SEGS - litSegs);

        if (lit) {
          const ratio = 1 - seg / (NUM_SEGS - 1); // 1 at top, 0 at bottom
          let color: string;
          if (ratio > 0.80)      color = '#ff3344';
          else if (ratio > 0.60) color = '#ff8800';
          else if (ratio > 0.35) color = '#ffcc00';
          else                   color = accent;

          ctx.fillStyle   = color;
          ctx.shadowColor = color;
          ctx.shadowBlur  = 3;
        } else {
          ctx.fillStyle   = 'rgba(255,255,255,0.04)';
          ctx.shadowBlur  = 0;
          ctx.shadowColor = 'transparent';
        }

        ctx.beginPath();
        ctx.roundRect(x, y, bw, segH, 0.5);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
  };

  // Start/stop loop based on visibility and audio panel open state
  createEffect(() => {
    const visible = store.audioSpectrumVisible() && props.audioOpen();

    if (visible) {
      if (!intervalId) {
        intervalId = setInterval(() => {
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(draw);
        }, 1000 / 25);
      }
    } else {
      if (intervalId) { clearInterval(intervalId); intervalId = undefined; }
      if (rafId)      { cancelAnimationFrame(rafId); rafId = undefined; }
    }
  });

  onCleanup(() => {
    if (intervalId) clearInterval(intervalId);
    if (rafId)      cancelAnimationFrame(rafId);
  });

  return (
    <Show when={store.audioSpectrumVisible()}>
      <canvas
        ref={(el) => { canvasRef = el; }}
        class="w-full rounded-sm"
        style={{ height: '56px' }}
      />
    </Show>
  );
};

// ---- Dongle & Profile Selector (fancy dropdown) ----

const DongleProfileSelector: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [profileMap, setProfileMap] = createSignal<Record<string, DongleProfile[]>>({});

  // Fetch profiles for a dongle and merge into the map
  const fetchProfiles = async (dongleId: string) => {
    try {
      const res = await fetch(`/api/dongles/${dongleId}/profiles`);
      if (res.ok) {
        const data: DongleProfile[] = await res.json();
        setProfileMap(prev => ({ ...prev, [dongleId]: data }));
      }
    } catch { /* ignore */ }
  };

  // Load profiles for the active dongle eagerly (so trigger label shows profile name)
  // Re-fetch when activeProfileId changes (profile added/deleted/switched)
  createEffect(() => {
    const dongleId = store.activeDongleId();
    const _profileId = store.activeProfileId(); // track changes
    if (dongleId) {
      fetchProfiles(dongleId);
    }
  });

  // Load profiles for all dongles when dropdown opens (always refresh)
  createEffect(() => {
    if (open()) {
      for (const dongle of store.dongles()) {
        fetchProfiles(dongle.id);
      }
    }
  });

  // Build the label for the currently active selection
  const currentLabel = () => {
    const dongle = store.dongles().find(d => d.id === store.activeDongleId());
    if (!dongle) return null;
    const freq = store.centerFrequency();
    const mhz = (freq / 1e6).toFixed(3);
    // Find active profile name using the reactive activeProfileId signal
    const dongleProfileList = profileMap()[dongle.id] ?? [];
    const activeProfile = dongleProfileList.find(p => p.id === store.activeProfileId());
    const profileName = activeProfile?.name ?? store.activeProfileId() ?? '';
    return { dongleName: dongle.name, freq: `${mhz} MHz`, profileName };
  };

  const handleSelect = (dongleId: string, profileId?: string) => {
    engine.subscribe(dongleId, profileId);
    setOpen(false);
  };

  // Close dropdown on outside click
  let containerRef: HTMLDivElement | undefined;
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false);
    }
  };
  onMount(() => document.addEventListener('mousedown', handleClickOutside));
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside));

  return (
    <Show when={store.dongles().length > 0} fallback={
      <div class="sdr-panel">
        <div class="px-3 py-3 flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-text-muted shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2 5h12v9H2z" stroke-linejoin="round"/>
            <circle cx="5.5" cy="9.5" r="2"/>
            <path d="M9 8h3M9 11h3"/>
            <path d="M4 5L11 2" stroke-linecap="round"/>
          </svg>
          <span class="text-[10px] font-mono text-text-dim">
            {store.connectionState() === 'unconfigured'
              ? 'No receivers configured'
              : store.connectionState() === 'connecting'
              ? 'Connecting...'
              : store.connectionState() === 'disconnected'
              ? 'Disconnected'
              : 'Waiting for data...'}
          </span>
        </div>
      </div>
    }>
      <div class="sdr-panel relative" ref={containerRef}>
        {/* Trigger button */}
        <button
          class="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-sdr-hover rounded-sm"
          onClick={() => setOpen(o => !o)}
        >
          {/* Radio icon */}
          <svg class="w-3.5 h-3.5 text-[var(--sdr-accent)] shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M2 5h12v9H2z" stroke-linejoin="round"/>
            <circle cx="5.5" cy="9.5" r="2"/>
            <path d="M9 8h3M9 11h3"/>
            <path d="M4 5L11 2" stroke-linecap="round"/>
          </svg>

          <Show when={currentLabel()} fallback={<span class="text-[10px] font-mono text-text-dim">No receiver</span>}>
            {(label) => (
              <div class="flex items-center gap-1.5 min-w-0 flex-1">
                <Show when={label().profileName}>
                  <span class="text-[10px] font-mono text-text-primary truncate font-medium">
                    {label().profileName}
                  </span>
                  <svg class="w-2.5 h-2.5 text-text-muted shrink-0" viewBox="0 0 10 10" fill="none">
                    <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </Show>
                <span class="text-[10px] font-mono text-[var(--sdr-accent)] truncate">
                  {label().freq}
                </span>
              </div>
            )}
          </Show>

          {/* Chevron */}
          <svg class={`w-3 h-3 text-text-muted shrink-0 transition-transform ${open() ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 4.5L6 7.5L9 4.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>

        {/* Dropdown panel */}
        <Show when={open()}>
          <div class="absolute left-0 right-0 top-full mt-1 z-50 bg-sdr-surface border border-border rounded-sm shadow-lg shadow-black/40 max-h-64 overflow-y-auto">
            <For each={store.dongles()}>
              {(dongle) => {
                const dongleProfiles = () => profileMap()[dongle.id] ?? [];
                return (
                  <div class="border-b border-border last:border-b-0">
                    {/* Dongle header */}
                    <div
                      class={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-sdr-hover
                        ${store.activeDongleId() === dongle.id ? 'bg-sdr-elevated' : 'bg-sdr-surface'}`}
                      onClick={() => {
                        // If no profiles, subscribe directly to the dongle
                        if (dongleProfiles().length === 0) handleSelect(dongle.id);
                      }}
                    >
                      <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${dongle.running ? 'bg-status-online' : 'bg-status-offline'}`} />
                      <span class={`text-[10px] font-mono font-medium ${store.activeDongleId() === dongle.id ? 'text-[var(--sdr-accent)]' : 'text-text-primary'}`}>
                        {dongle.name}
                      </span>
                      <Show when={dongle.clientCount > 0}>
                        <span class="ml-auto text-[8px] font-mono text-text-dim">
                          {dongle.clientCount} user{dongle.clientCount > 1 ? 's' : ''}
                        </span>
                      </Show>
                    </div>

                    {/* Profiles for this dongle */}
                    <Show when={dongleProfiles().length > 0}>
                      <div class="py-0.5">
                        <For each={dongleProfiles()}>
                          {(profile) => {
                            const isActive = () => store.activeDongleId() === dongle.id && store.activeProfileId() === profile.id;
                            return (
                              <button
                                class={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors rounded-none
                                  ${isActive()
                                    ? 'bg-cyan-dim text-cyan'
                                    : 'text-text-secondary hover:bg-sdr-hover hover:text-text-primary'}`}
                                onClick={() => handleSelect(dongle.id, profile.id)}
                              >
                                <svg class={`w-2.5 h-2.5 shrink-0 ${isActive() ? 'text-cyan' : 'text-text-muted'}`} viewBox="0 0 10 10" fill="none">
                                  <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                <span class="text-[10px] font-mono truncate">{profile.name}</span>
                                <span class="ml-auto text-[9px] font-mono text-text-dim whitespace-nowrap">
                                  {(profile.centerFrequency / 1e6).toFixed(3)} MHz
                                </span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        {/* Active dongle info display */}
        <Show when={store.activeDongleId()}>
          {(_id) => {
            const dongle = () => store.dongles().find(d => d.id === store.activeDongleId());
            return (
              <Show when={dongle()}>
                {(d) => (
                  <div class="flex items-center gap-2 px-3 py-1.5 border-t border-border">
                    <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${d().running ? 'bg-status-online' : 'bg-status-offline'}`} />
                    <span class="text-[9px] font-mono text-text-secondary truncate">{d().name}</span>
                    <Show when={d().source}>
                      <span class="text-[8px] font-mono text-text-dim uppercase">{d().source}</span>
                    </Show>
                    <span class="ml-auto text-[8px] font-mono text-text-dim">
                      {(store.sampleRate() / 1e6).toFixed(2)} MSPS
                    </span>
                  </div>
                )}
              </Show>
            );
          }}
        </Show>
      </div>
    </Show>
  );
};

const ModeSelector: Component = () => {
  const modes: DemodMode[] = ['wfm', 'nfm', 'am', 'sam', 'am-stereo', 'usb', 'lsb', 'cw', 'raw'];
  const [open, setOpen] = createSignal(true);

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>Demodulation</span>
        <Show when={!open()}>
          <span class="ml-auto text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal">
            {DEMOD_MODES[store.mode()]?.shortName ?? ''}
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-2">
        <div class="flex flex-wrap gap-2">
          <For each={modes}>
            {(mode) => (
              <button
                class={`mil-btn ${store.mode() === mode ? 'active' : ''}`}
                onClick={() => engine.setMode(mode)}
                title={DEMOD_MODES[mode].description}
              >
                {DEMOD_MODES[mode].shortName}
              </button>
            )}
          </For>
        </div>
        <div class="mt-2 text-[9px] text-text-dim font-mono">
          {DEMOD_MODES[store.mode()]?.description ?? ''}
        </div>

        {/* Filter Bandwidth slider */}
        <div class="mt-3 pt-2 border-t border-border/40">
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Filter BW
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {(store.bandwidth() / 1000).toFixed(1)} kHz
            </span>
          </div>
          <input
            type="range"
            aria-label="Filter bandwidth"
            min={DEMOD_MODES[store.mode()]?.bandwidthRange[0] ?? 100}
            max={DEMOD_MODES[store.mode()]?.bandwidthRange[1] ?? 200000}
            step={100}
            value={store.bandwidth()}
            onInput={(e) => engine.setBandwidth(parseInt(e.currentTarget.value))}
            class="sdr-range"
          />
        </div>

        {/* Squelch */}
        <div class="mt-3 pt-2 border-t border-border/40">
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Squelch
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {store.squelch() !== null ? `${store.squelch()} dB` : 'Off'}
            </span>
          </div>
          <input
            type="range"
            aria-label="Squelch threshold"
            min={-80}
            max={0}
            value={store.squelch() ?? -80}
            onInput={(e) => {
              const val = parseInt(e.currentTarget.value);
              engine.setSquelch(val <= -80 ? null : val);
            }}
            class="sdr-range"
          />
        </div>
      </div>
      </Show>
    </div>
  );
};

// ---- Audio Controls ----
const AudioControls: Component = () => {
  const [open, setOpen] = createSignal(true);

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>Audio</span>
        <Show when={!open()}>
          <span class="ml-auto text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal">
            {Math.round(store.volume() * 100)}% {store.muted() ? '· muted' : ''}{store.stereoDetected() ? ' · stereo' : ''}
          </span>
        </Show>
        {/* Stereo indicator — visible for WFM, AM (auto-detected), and AM Stereo */}
        <Show when={open() && (store.mode() === 'wfm' || store.mode() === 'am' || store.mode() === 'am-stereo')}>
          <span
            class={`ml-auto text-[9px] font-mono font-bold tracking-wider px-1.5 py-0.5 rounded border transition-all duration-500 ${
              store.stereoDetected()
                ? 'text-green border-green/40 bg-green-dim shadow-[0_0_6px_rgba(56,193,128,0.3)]'
                : 'text-text-muted border-border bg-transparent opacity-50'
            }`}
            title={store.stereoDetected()
              ? (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq'
                ? 'Server-side stereo active (Opus)'
                : store.mode() === 'wfm' ? 'Stereo pilot detected (19 kHz)' : 'C-QUAM stereo pilot detected (25 Hz)')
              : (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq'
                ? 'No stereo from server'
                : store.mode() === 'wfm' ? 'No stereo pilot' : 'No C-QUAM stereo pilot')
            }
          >
            STEREO
          </span>
        </Show>
        <span class={`${open() && (store.mode() === 'wfm' || store.mode() === 'am' || store.mode() === 'am-stereo') ? '' : 'ml-auto'} text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-3 space-y-3">
        {/* Volume */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Volume
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {Math.round(store.volume() * 100)}%
            </span>
          </div>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={100}
            value={Math.round(store.volume() * 100)}
            onInput={(e) => engine.setVolume(parseInt(e.currentTarget.value) / 100)}
            class="sdr-range"
          />
        </div>

        {/* Balance (L/R) */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Balance
            </label>
            <span class="text-[9px] font-mono text-text-dim min-w-[28px] text-right">
              {store.balance() === 0 ? 'C' : store.balance() < 0 ? `L${Math.round(Math.abs(store.balance()) * 100)}` : `R${Math.round(store.balance() * 100)}`}
            </span>
          </div>
          <div class="relative">
            <input
              type="range"
              aria-label="Balance left-right"
              min={-100}
              max={100}
              value={Math.round(store.balance() * 100)}
              onInput={(e) => engine.setBalance(parseInt(e.currentTarget.value) / 100)}
              class="sdr-range"
            />
            {/* Center tick mark */}
            <div class="absolute top-0 left-1/2 -translate-x-1/2 w-px h-2 bg-text-dim pointer-events-none" />
          </div>
          <div class="flex justify-between text-[7px] text-text-muted font-mono mt-0.5">
            <span>L</span><span>C</span><span>R</span>
          </div>
        </div>

        {/* Mute + Loudness + Stereo row */}
        <div class="flex gap-2">
          <button
            class={`mil-btn flex-1 ${store.muted() ? 'active' : ''}`}
            onClick={() => engine.setMuted(!store.muted())}
            title={store.muted() ? 'Click to unmute' : 'Click to mute'}
          >
            {store.muted() ? 'Unmute' : 'Mute'}
          </button>
          <button
            class={`mil-btn flex-1 ${store.loudness() ? 'active' : ''}`}
            onClick={() => engine.setLoudness(!store.loudness())}
            title="Loudness: compresses dynamic range and boosts quiet signals"
          >
            Loudness
          </button>
          <Show when={store.mode() === 'wfm' || store.mode() === 'am' || store.mode() === 'am-stereo'}>
            <button
              class={`mil-btn flex-1 ${store.stereoEnabled() ? 'active' : ''}`}
              onClick={() => engine.setStereoEnabled(!store.stereoEnabled())}
              title={store.stereoEnabled() ? 'Stereo decoding enabled — click to force mono' : 'Stereo decoding disabled — click to enable'}
            >
              Stereo
            </button>
          </Show>
        </div>

        {/* Stereo Settings (WFM, AM, AM Stereo) */}
        <Show when={store.mode() === 'wfm' || store.mode() === 'am' || store.mode() === 'am-stereo'}>
          <div class="space-y-2">
            {/* Stereo threshold — only for IQ path (not Opus — server handles detection) */}
            <Show when={store.stereoEnabled() && store.iqCodec() !== 'opus' && store.iqCodec() !== 'opus-hq'}>
              <div>
                <div class="flex justify-between items-center mb-1">
                  <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
                    Stereo Threshold
                  </label>
                  <span class="text-[9px] font-mono text-text-dim min-w-[36px] text-right">
                    {store.stereoThreshold()} dB
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Stereo blend threshold"
                  min={-80}
                  max={0}
                  value={store.stereoThreshold()}
                  onInput={(e) => engine.setStereoThreshold(parseInt(e.currentTarget.value))}
                  class="sdr-range"
                />
                <div class="text-[7px] font-mono text-text-muted mt-0.5">
                  Decode stereo only when signal &gt; {store.stereoThreshold()} dB
                </div>
              </div>
            </Show>
            {/* Opus stereo info */}
            <Show when={store.stereoEnabled() && (store.iqCodec() === 'opus' || store.iqCodec() === 'opus-hq')}>
              <div class="text-[7px] font-mono text-text-muted">
                Server-side stereo decoding via Opus
              </div>
            </Show>
          </div>
        </Show>

        {/* 5-Band Equalizer */}
        <div>
          <div class="flex justify-between items-center mb-2">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Equalizer
            </label>
            <div class="flex items-center gap-2">
              <button
                class="text-[8px] font-mono text-text-dim hover:text-text-secondary transition-colors"
                onClick={() => store.setAudioSpectrumVisible(!store.audioSpectrumVisible())}
                title={store.audioSpectrumVisible() ? 'Hide spectrum' : 'Show spectrum'}
              >
                {store.audioSpectrumVisible() ? 'Hide' : 'Spectrum'}
              </button>
              <button
                class="text-[8px] font-mono text-text-dim hover:text-text-secondary transition-colors"
                onClick={() => {
                  engine.setEqLow(0);
                  engine.setEqLowMid(0);
                  engine.setEqMid(0);
                  engine.setEqHighMid(0);
                  engine.setEqHigh(0);
                }}
                title="Reset EQ to flat"
              >
                Reset
              </button>
            </div>
          </div>
          {/* Audio spectrum analyzer */}
          <AudioSpectrum audioOpen={open} />
          <div class="flex gap-1">
            {/* Low */}
            <EqBand
              label="LOW"
              sublabel="80"
              value={store.eqLow()}
              onChange={(v) => engine.setEqLow(v)}
            />
            {/* Low-Mid */}
            <EqBand
              label="L-M"
              sublabel="500"
              value={store.eqLowMid()}
              onChange={(v) => engine.setEqLowMid(v)}
            />
            {/* Mid */}
            <EqBand
              label="MID"
              sublabel="1.5k"
              value={store.eqMid()}
              onChange={(v) => engine.setEqMid(v)}
            />
            {/* High-Mid */}
            <EqBand
              label="H-M"
              sublabel="4k"
              value={store.eqHighMid()}
              onChange={(v) => engine.setEqHighMid(v)}
            />
            {/* High */}
            <EqBand
              label="HIGH"
              sublabel="12k"
              value={store.eqHigh()}
              onChange={(v) => engine.setEqHigh(v)}
            />
          </div>
        </div>

      </div>
      </Show>
    </div>
  );
};

// ---- EQ Band (vertical slider) ----
const EqBand: Component<{
  label: string;
  sublabel: string;
  value: number;
  onChange: (dB: number) => void;
}> = (props) => {
  return (
    <div class="flex-1 flex flex-col items-center gap-1">
      <span class="text-[8px] font-mono text-text-dim">{props.label}</span>
      <div class="h-20 flex items-center justify-center relative">
        <input
          type="range"
          aria-label={`EQ ${props.label} band`}
          min={-12}
          max={12}
          step={1}
          value={props.value}
          onInput={(e) => props.onChange(parseInt(e.currentTarget.value))}
          class="sdr-range-vertical"
        />
      </div>
      <span class={`text-[8px] font-mono font-bold ${
        props.value === 0 ? 'text-text-dim' : props.value > 0 ? 'text-cyan' : 'text-amber'
      }`}>
        {props.value > 0 ? '+' : ''}{props.value}
      </span>
      <span class="text-[7px] font-mono text-text-muted">{props.sublabel}</span>
    </div>
  );
};



// ---- Noise Reduction ----
const NoiseReduction: Component = () => {
  const [open, setOpen] = createSignal(true);

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>Noise Reduction</span>
        <Show when={!open()}>
          <span class="ml-auto text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal">
            {[store.nrEnabled() ? 'NR' : '', store.agcEnabled() ? 'AGC' : ''].filter(Boolean).join(' · ') || 'off'}
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-3 space-y-3">
        {/* Adaptive NR (LMS) */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Adaptive NR
            </label>
            <button
              class={`mil-btn ${store.nrEnabled() ? 'active' : ''}`}
              onClick={() => engine.setNrEnabled(!store.nrEnabled())}
              title="LMS adaptive noise reduction — reduces noise without musical artifacts"
            >
              {store.nrEnabled() ? 'On' : 'Off'}
            </button>
          </div>
          <Show when={store.nrEnabled()}>
            <div>
              <div class="flex justify-between items-center mb-1">
                <label class="text-[9px] font-mono text-text-dim">
                  Strength
                </label>
                <span class="text-[9px] font-mono text-text-dim">
                  {Math.round(store.nrStrength() * 100)}%
                </span>
              </div>
              <input
                type="range"
                aria-label="Noise reduction strength"
                min={0}
                max={100}
                value={Math.round(store.nrStrength() * 100)}
                onInput={(e) => engine.setNrStrength(parseInt(e.currentTarget.value) / 100)}
                class="sdr-range"
              />
              <div class="text-[7px] font-mono text-text-muted mt-0.5">
                LMS adaptive predictor — best for SSB/CW. May affect music on AM/FM.
              </div>
            </div>
          </Show>
        </div>

        {/* AGC (Automatic Gain Control) */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              AGC
            </label>
            <button
              class={`mil-btn ${store.agcEnabled() ? 'active' : ''}`}
              onClick={() => engine.setAgcEnabled(!store.agcEnabled())}
              title="Automatic gain control — normalizes audio level with hang timer"
            >
              {store.agcEnabled() ? 'On' : 'Off'}
            </button>
          </div>
          <Show when={store.agcEnabled()}>
            <div>
              <div class="flex justify-between items-center mb-1">
                <label class="text-[9px] font-mono text-text-dim">
                  Decay
                </label>
                <span class="text-[9px] font-mono text-text-dim">
                  {store.agcDecayMs()} ms
                </span>
              </div>
              <input
                type="range"
                aria-label="AGC decay time"
                min={50}
                max={2000}
                step={50}
                value={store.agcDecayMs()}
                onInput={(e) => engine.setAgcDecay(parseInt(e.currentTarget.value))}
                class="sdr-range"
              />
              <div class="text-[7px] font-mono text-text-muted mt-0.5">
                Hang-timer AGC — fast attack, adjustable decay
              </div>
            </div>
          </Show>
        </div>

        {/* Rumble Filter (HPF) */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Rumble Filter
            </label>
            <button
              class={`mil-btn ${store.rumbleFilterEnabled() ? 'active' : ''}`}
              onClick={() => engine.setRumbleFilterEnabled(!store.rumbleFilterEnabled())}
              title="High-pass filter — removes hum and wind/blowing noise below cutoff"
            >
              {store.rumbleFilterEnabled() ? 'On' : 'Off'}
            </button>
          </div>
          <Show when={store.rumbleFilterEnabled()}>
            <div>
              <div class="flex justify-between items-center mb-1">
                <label class="text-[9px] font-mono text-text-dim">
                  Cutoff
                </label>
                <span class="text-[9px] font-mono text-text-dim">
                  {store.rumbleFilterCutoff()} Hz
                </span>
              </div>
              <input
                type="range"
                aria-label="Rumble filter cutoff frequency"
                min={30}
                max={150}
                step={5}
                value={store.rumbleFilterCutoff()}
                onInput={(e) => engine.setRumbleFilterCutoff(parseInt(e.currentTarget.value))}
                class="sdr-range"
              />
              <div class="text-[7px] font-mono text-text-muted mt-0.5">
                4th-order HPF — removes hum, wind, and rumble below cutoff
              </div>
            </div>
          </Show>
        </div>

        {/* Auto-Notch (tone removal) */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Auto-Notch
            </label>
            <button
              class={`mil-btn ${store.autoNotchEnabled() ? 'active' : ''}`}
              onClick={() => engine.setAutoNotchEnabled(!store.autoNotchEnabled())}
              title="Adaptive notch — removes hum harmonics and heterodyne tones"
            >
              {store.autoNotchEnabled() ? 'On' : 'Off'}
            </button>
          </div>
          <Show when={store.autoNotchEnabled()}>
            <div class="text-[7px] font-mono text-text-muted">
              LMS adaptive — removes 50/60Hz harmonics and carrier tones automatically
            </div>
          </Show>
        </div>

        {/* FM Hi-Blend (stereo noise reduction) — only shown for WFM stereo */}
        <Show when={store.mode() === 'wfm' && store.stereoDetected()}>
          <div>
            <div class="flex justify-between items-center mb-1">
              <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
                Hi-Blend
              </label>
              <button
                class={`mil-btn ${store.hiBlendEnabled() ? 'active' : ''}`}
                onClick={() => engine.setHiBlendEnabled(!store.hiBlendEnabled())}
                title="FM stereo hi-blend — reduces hiss on weak stations by narrowing stereo separation at high frequencies"
              >
                {store.hiBlendEnabled() ? 'On' : 'Off'}
              </button>
            </div>
            <Show when={store.hiBlendEnabled()}>
              <div>
                <div class="flex justify-between items-center mb-1">
                  <label class="text-[9px] font-mono text-text-dim">
                    Cutoff
                  </label>
                  <span class="text-[9px] font-mono text-text-dim">
                    {(store.hiBlendCutoff() / 1000).toFixed(1)} kHz
                  </span>
                </div>
                <input
                  type="range"
                  aria-label="Hi-blend stereo cutoff"
                  min={500}
                  max={8000}
                  step={100}
                  value={store.hiBlendCutoff()}
                  onInput={(e) => engine.setHiBlendCutoff(parseInt(e.currentTarget.value))}
                  class="sdr-range"
                />
                <div class="text-[7px] font-mono text-text-muted mt-0.5">
                  Below cutoff: full stereo. Above: fades to mono. Reduces FM hiss.
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* Soft Mute */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Soft Mute
            </label>
            <button
              class={`mil-btn ${store.softMuteEnabled() ? 'active' : ''}`}
              onClick={() => engine.setSoftMuteEnabled(!store.softMuteEnabled())}
              title="Soft mute — progressively reduces volume on weak signals instead of playing noise"
            >
              {store.softMuteEnabled() ? 'On' : 'Off'}
            </button>
          </div>
          <Show when={store.softMuteEnabled()}>
            <div>
              <div class="flex justify-between items-center mb-1">
                <label class="text-[9px] font-mono text-text-dim">
                  Threshold
                </label>
                <span class="text-[9px] font-mono text-text-dim">
                  {store.softMuteThreshold()} dB
                </span>
              </div>
              <input
                type="range"
                aria-label="Soft mute threshold"
                min={-80}
                max={-10}
                step={1}
                value={store.softMuteThreshold()}
                onInput={(e) => engine.setSoftMuteThreshold(parseInt(e.currentTarget.value))}
                class="sdr-range"
              />
              <div class="text-[7px] font-mono text-text-muted mt-0.5">
                Below threshold: volume fades to silence. Above: full volume.
              </div>
            </div>
          </Show>
        </div>
      </div>
      </Show>
    </div>
  );
};

// ---- Waterfall Settings ----
const WaterfallSettings: Component = () => {
  const themes = getPaletteNames();
  const [themeDropdownOpen, setThemeDropdownOpen] = createSignal(false);

  // Color preview bars for dropdown (CSS rgb strings)
  const themePreviews: Record<string, string[]> = {
    classic: ['rgb(0,0,0)', 'rgb(0,0,128)', 'rgb(0,0,255)', 'rgb(0,255,255)', 'rgb(255,255,0)', 'rgb(255,128,0)', 'rgb(255,0,0)', 'rgb(255,255,255)'],
    sdr: ['rgb(0,0,8)', 'rgb(0,0,128)', 'rgb(0,160,220)', 'rgb(180,220,40)', 'rgb(255,200,0)', 'rgb(255,60,0)', 'rgb(255,0,0)'],
    turbo: ['rgb(48,18,59)', 'rgb(70,117,237)', 'rgb(27,207,212)', 'rgb(97,252,108)', 'rgb(243,198,58)', 'rgb(254,155,45)', 'rgb(122,4,2)'],
    viridis: ['rgb(68,1,84)', 'rgb(62,73,137)', 'rgb(38,130,142)', 'rgb(53,183,121)', 'rgb(253,231,37)'],
    hot: ['rgb(0,0,0)', 'rgb(128,0,0)', 'rgb(255,0,0)', 'rgb(255,200,0)', 'rgb(255,255,255)'],
    fire: ['rgb(0,0,0)', 'rgb(180,0,0)', 'rgb(255,80,0)', 'rgb(255,240,80)', 'rgb(255,255,255)'],
    ocean: ['rgb(0,0,80)', 'rgb(0,120,200)', 'rgb(0,180,210)', 'rgb(180,240,250)', 'rgb(240,250,255)'],
    grayscale: ['rgb(0,0,0)', 'rgb(255,255,255)'],
    inferno: ['rgb(0,0,4)', 'rgb(133,54,120)', 'rgb(227,117,48)', 'rgb(252,254,164)', 'rgb(255,255,200)'],
    magma: ['rgb(0,0,4)', 'rgb(140,58,115)', 'rgb(224,109,67)', 'rgb(252,223,148)', 'rgb(255,255,255)'],
    plasma: ['rgb(4,6,68)', 'rgb(120,42,164)', 'rgb(195,99,107)', 'rgb(252,211,66)', 'rgb(252,253,85)'],
    radio: ['rgb(8,24,32)', 'rgb(32,140,140)', 'rgb(80,200,120)', 'rgb(255,220,100)', 'rgb(255,255,200)'],
  };

  const handleAutoRange = () => {
    const current = store.waterfallAutoRange();
    store.setWaterfallAutoRange(!current);
    if (!current) {
      // Turning auto-range ON — engine will adapt on next FFT frame
      console.log('[UI] Auto-range enabled');
    } else {
      console.log('[UI] Auto-range disabled, manual control');
    }
  };

  const [open, setOpen] = createSignal(true);

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>Waterfall</span>
        <Show when={!open()}>
          <span class="ml-auto text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal">
            {store.waterfallTheme()} · FFT {store.fftSize()} · {store.waterfallAutoRange() ? 'auto' : `${store.waterfallMin()}/${store.waterfallMax()} dB`}
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-3 space-y-3">
        {/* Color Theme Dropdown */}
        <div>
          <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1 block">
            Color Theme
          </label>
          <div class="relative">
            <button
              class="w-full flex items-center justify-between px-2 py-1.5 rounded border border-border bg-sdr-surface text-[10px] font-mono"
              onClick={() => setThemeDropdownOpen(!themeDropdownOpen())}
            >
              <span>{store.waterfallTheme()}</span>
              <span class="text-text-dim">{themeDropdownOpen() ? '▲' : '▼'}</span>
            </button>
            {/* Color preview bar */}
            <div class="h-1.5 mt-1 rounded overflow-hidden flex">
              <For each={themePreviews[store.waterfallTheme()]}>
                {(color) => (
                  <div class="flex-1" style={{ background: color }} />
                )}
              </For>
            </div>
            {/* Dropdown options */}
            <Show when={themeDropdownOpen()}>
              <div class="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded border border-border bg-sdr-surface shadow-lg">
                <For each={themes}>
                  {(theme) => (
                    <button
                      class={`w-full px-2 py-1 text-left text-[10px] font-mono hover:bg-sdr-hover flex items-center gap-2
                        ${store.waterfallTheme() === theme ? 'bg-sdr-elevated text-text-primary' : 'text-text-secondary'}`}
                      onClick={() => {
                        engine.setWaterfallTheme(theme);
                        setThemeDropdownOpen(false);
                      }}
                    >
                      <span class="flex-1">{theme}</span>
                      <div class="h-3 flex-3 flex rounded overflow-hidden">
                        <For each={themePreviews[theme]}>
                          {(color) => (
                            <div class="flex-1" style={{ background: color }} />
                          )}
                        </For>
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>

        {/* Auto-Range Toggle */}
        <div class="flex items-center justify-between">
          <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
            Auto Scale
          </label>
          <button
            class={`mil-btn ${store.waterfallAutoRange() ? 'active' : ''}`}
            onClick={handleAutoRange}
          >
            {store.waterfallAutoRange() ? 'Auto' : 'Manual'}
          </button>
        </div>

        {/* Min dB */}
        <div class={store.waterfallAutoRange() ? 'opacity-50 pointer-events-none' : ''}>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Min Level
            </label>
            <span class="text-[9px] font-mono text-text-dim">{store.waterfallMin()} dB</span>
          </div>
          <input
            type="range"
            aria-label="Waterfall minimum level"
            min={-100}
            max={0}
            value={store.waterfallMin()}
            onInput={(e) => engine.setWaterfallRange(parseInt(e.currentTarget.value), store.waterfallMax())}
            class="sdr-range"
          />
        </div>

        {/* Max dB */}
        <div class={store.waterfallAutoRange() ? 'opacity-50 pointer-events-none' : ''}>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Max Level
            </label>
            <span class="text-[9px] font-mono text-text-dim">{store.waterfallMax()} dB</span>
          </div>
          <input
            type="range"
            aria-label="Waterfall maximum level"
            min={-60}
            max={20}
            value={store.waterfallMax()}
            onInput={(e) => engine.setWaterfallRange(store.waterfallMin(), parseInt(e.currentTarget.value))}
            class="sdr-range"
          />
        </div>

        {/* Current range display */}
        <div class="text-[8px] font-mono text-text-dim text-center">
          Range: {store.waterfallMin()} to {store.waterfallMax()} dB
          ({store.waterfallMax() - store.waterfallMin()} dB span)
        </div>

        {/* FFT Info */}
        <div class="mt-2 pt-2 border-t border-border/40 flex justify-between items-center">
          <span class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">FFT Size</span>
          <span class="text-[9px] font-mono text-text-dim">{store.fftSize()} bins</span>
        </div>

        {/* Gamma / contrast */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Contrast
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {store.waterfallGamma().toFixed(2)}
              {store.waterfallGamma() > 1 ? ' (dark)' : store.waterfallGamma() < 1 ? ' (bright)' : ' (linear)'}
            </span>
          </div>
          <input
            type="range"
            aria-label="Waterfall contrast gamma"
            min={30}
            max={300}
            step={1}
            value={Math.round(store.waterfallGamma() * 100)}
            onInput={(e) => engine.setWaterfallGamma(parseInt(e.currentTarget.value) / 100)}
            class="sdr-range"
          />
          <div class="flex justify-between text-[7px] font-mono text-text-dim mt-0.5">
            <span>0.30 bright</span>
            <span>1.00</span>
            <span>dark 3.00</span>
          </div>
        </div>
      </div>
      </Show>
    </div>
  );
};

// ---- S-Meter ----
const SMeter: Component = () => {
  // Peak hold: tracks the highest level and decays slowly (ghost needle)
  let peakPct = 0;
  let peakDecayTimer: ReturnType<typeof setInterval> | undefined;
  const [peakHold, setPeakHold] = createSignal(0);

  // 5-second max marker: highest level in a rolling 5s window
  // Signal so the bar meter's reactive JSX updates when it changes.
  const [maxPct5s, setMaxPct5s] = createSignal(0);
  let maxPct5sRaw = 0; // raw variable for the needle rAF loop
  let maxExpiry = 0; // performance.now() timestamp when the max expires

  // Canvas ref for needle meter
  let canvasRef: HTMLCanvasElement | undefined;
  let rafId: number | undefined;

  // Start peak decay timer on mount
  onMount(() => {
    peakDecayTimer = setInterval(() => {
      // Decay peak by 0.2% per tick (50ms interval ≈ 25 seconds from full to zero)
      if (peakPct > 0) {
        peakPct = Math.max(0, peakPct - 0.2);
        setPeakHold(peakPct);
      }
    }, 50);
  });

  onCleanup(() => {
    if (peakDecayTimer) clearInterval(peakDecayTimer);
    if (intervalId)     clearInterval(intervalId);
    if (rafId)          cancelAnimationFrame(rafId);
  });

  const pct = () => {
    const level = store.signalLevel();

    // Fixed scale: -120 dB = 0% (S0/noise floor), -13 dB = 100% (S9+60dB).
    const MIN_DB = -120;
    const MAX_DB = -13;
    const range = MAX_DB - MIN_DB;
    const p = Math.max(0, Math.min(100, ((level - MIN_DB) / range) * 100));

    // Update ghost-needle peak hold
    if (p > peakPct) {
      peakPct = p;
      setPeakHold(p);
    }

    // Update 5-second max marker: reset window whenever a new high is seen
    const now = performance.now();
    if (p >= maxPct5sRaw) {
      maxPct5sRaw = p;
      setMaxPct5s(p);
      maxExpiry = now + 5000;
    } else if (now > maxExpiry) {
      // Window expired — drop to current value and start a fresh 5s window
      maxPct5sRaw = p;
      setMaxPct5s(p);
      maxExpiry = now + 5000;
    }

    return p;
  };

  const barColor = () => {
    const p = pct();
    if (p > 85) return 'bg-neon-red';
    if (p > 65) return 'bg-neon-orange';
    if (p > 40) return 'bg-amber';
    return 'bg-green';
  };

  // Needle lerp state — smoothed toward targetPct each paint call.
  let smoothedPct = 0;

  // Draw classic analog S-meter (Kenwood/Yaesu style)
  // ── Two cached layers ──
  // bgCache    — background (gradient, vignette, bezel) at natural canvas size.
  //              Blitted unscaled every frame.
  // scaleCache — meter content (arcs, ticks, labels) at natural canvas size,
  //              drawn WITHOUT any scale transform so it can be blitted through
  //              the 2×/1.4× scale in the per-frame draw without double-scaling.
  let bgCache: HTMLCanvasElement | undefined;
  let scaleCache: HTMLCanvasElement | undefined;
  let cacheW = 0;
  let cacheH = 0;
  let cacheTheme = '';

  // Hoisted per-frame state (avoid repeated lookups inside rAF)
  let ctx2d: CanvasRenderingContext2D | null = null;
  let lastDpr = 0;

  const buildBgCache = (w: number, h: number, dpr: number) => {
    const off = document.createElement('canvas');
    off.width  = Math.round(w * dpr);
    off.height = Math.round(h * dpr);
    const ctx = off.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── Theme-aware backlit face ──
    const theme = document.documentElement.dataset.theme ?? 'default';

    // Per-theme gradient stops: [center, mid, outer, edge]
    // VFD  → warm amber/orange backlight
    // CRT  → cool phosphor green backlight
    // LCD  → neutral warm-white / blue-grey backlight
    const stops: [string, string, string, string] = theme === 'vfd'
      ? ['#ffe060', '#ffb020', '#e07000', '#b04400']
      : theme === 'crt'
      ? ['#c8ffcc', '#50e870', '#18a840', '#0a5c20']
      : ['#e8eef8', '#c0cede', '#8090aa', '#3a4a5e']; // default LCD

    const vigDark = theme === 'vfd'
      ? 'rgba(60,10,0,0.40)'
      : theme === 'crt'
      ? 'rgba(0,30,5,0.40)'
      : 'rgba(10,18,30,0.45)';

    const bezelColor = theme === 'vfd'
      ? 'rgba(80,25,0,0.7)'
      : theme === 'crt'
      ? 'rgba(0,50,10,0.7)'
      : 'rgba(20,35,55,0.7)';

    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.15, 0, w * 0.5, h * 0.6, w * 0.72);
    bgGrad.addColorStop(0,    stops[0]);
    bgGrad.addColorStop(0.35, stops[1]);
    bgGrad.addColorStop(0.75, stops[2]);
    bgGrad.addColorStop(1,    stops[3]);
    ctx.fillStyle = bgGrad;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 4);
    ctx.fill();

    // Vignette
    const vig = ctx.createRadialGradient(w*.5, h*.3, h*.05, w*.5, h*.5, w*.65);
    vig.addColorStop(0, 'rgba(255,255,255,0.0)');
    vig.addColorStop(1, vigDark);
    ctx.fillStyle = vig;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 4);
    ctx.fill();

    // Bezel
    ctx.strokeStyle = bezelColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0.75, 0.75, w-1.5, h-1.5, 4);
    ctx.stroke();

    return off;
  };

  const buildStaticCache = (w: number, h: number, dpr: number) => {
    // Build cache at 2× natural size so when scaled 2× to get target size, 
    // we have more pixels = less blur from browser interpolation
    const scaleW = 2;
    const scaleH = 1.4;
    const off = document.createElement('canvas');
    off.width  = Math.round(w * scaleW * dpr);
    off.height = Math.round(h * scaleH * dpr);
    const ctx = off.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(scaleW * dpr, 0, 0, scaleH * dpr, 0, 0);

    // Theme-aware ink colours for ticks and labels
    const theme = document.documentElement.dataset.theme ?? 'default';
    const inkDark   = theme === 'crt' ? '#0a3010'                 : theme === 'vfd' ? '#2a1a08'                 : '#1a2540';
    const inkOver   = theme === 'crt' ? '#0a5010'                 : theme === 'vfd' ? '#9a1010'                 : '#1a3a7a';
    const inkDimA   = theme === 'crt' ? 'rgba(10,48,16,0.45)'     : theme === 'vfd' ? 'rgba(60,45,30,0.45)'     : 'rgba(26,45,80,0.45)';
    const inkOverA  = theme === 'crt' ? 'rgba(10,80,16,0.50)'     : theme === 'vfd' ? 'rgba(160,30,30,0.50)'    : 'rgba(26,60,160,0.50)';
    const arcGreen  = theme === 'crt' ? 'rgba(0,120,30,0.20)'     : theme === 'vfd' ? 'rgba(40,100,60,0.15)'    : 'rgba(20,60,140,0.18)';
    const arcRed    = theme === 'crt' ? 'rgba(0,100,20,0.15)'     : theme === 'vfd' ? 'rgba(180,30,30,0.15)'    : 'rgba(60,100,200,0.18)';
    const powerInk  = theme === 'crt' ? 'rgba(0,60,15,0.65)'      : theme === 'vfd' ? 'rgba(60,40,10,0.65)'     : 'rgba(20,50,110,0.65)';
    const powerFill = theme === 'crt' ? 'rgba(0,50,10,0.70)'      : theme === 'vfd' ? 'rgba(50,30,5,0.70)'      : 'rgba(20,45,100,0.70)';
    const labelInk  = theme === 'crt' ? 'rgba(0,60,15,0.80)'      : theme === 'vfd' ? 'rgba(40,25,5,0.80)'      : 'rgba(20,50,110,0.80)';
    const sigLvlInk = theme === 'crt' ? 'rgba(0,50,10,0.55)'      : theme === 'vfd' ? 'rgba(50,30,5,0.55)'      : 'rgba(20,45,100,0.55)';
    const powerArcA = theme === 'crt' ? 'rgba(0,50,10,0.18)'      : theme === 'vfd' ? 'rgba(60,40,10,0.18)'     : 'rgba(20,40,90,0.18)';
    const powerDimA = theme === 'crt' ? 'rgba(0,50,10,0.30)'      : theme === 'vfd' ? 'rgba(60,40,10,0.30)'     : 'rgba(20,40,90,0.30)';
    const powerMidA = theme === 'crt' ? 'rgba(0,50,10,0.45)'      : theme === 'vfd' ? 'rgba(60,40,10,0.45)'     : 'rgba(20,40,90,0.45)';
    const cx = w / 2;
    const cy = h + h * 0.60;
    const radius = Math.min(w * 0.55, h * 1.1);
    const sweepRad   = Math.PI / 4;
    const startAngle = -Math.PI / 2 - sweepRad / 2;
    const sweep      = sweepRad;
    const pctToAngle = (p: number) => startAngle + (p / 100) * sweep;

    const scaleLabels = ['S', '1', '3', '5', '7', '9', '+20', '+40', '+60'];
    const majorPcts   = scaleLabels.map((_, i) => (i / (scaleLabels.length - 1)) * 100);
    const minorPcts: number[] = [];
    for (let i = 0; i < scaleLabels.length - 1; i++) {
      minorPcts.push((majorPcts[i] + majorPcts[i + 1]) / 2);
    }
    const outerR        = radius + 5;
    const tickFont      = Math.max(7, w * 0.030);
    const smallTickFont = Math.max(6, w * 0.024);
    const s9Pct         = majorPcts[5];
    const midAngle      = pctToAngle(50);

    // ── "SIGNAL LEVEL" label ──
    const labelR = outerR + 10;
    const labelFont = Math.max(7, w * 0.028);
    ctx.font         = `900 ${labelFont}px "Arial", sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = labelInk;
    ctx.fillText('SIGNAL LEVEL',
      cx + labelR * Math.cos(midAngle),
      cy + labelR * Math.sin(midAngle) - 6);

    // ── Coloured arc bands (single path each) ──
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1, pctToAngle(0), pctToAngle(s9Pct), false);
    ctx.strokeStyle = arcGreen;
    ctx.lineWidth = 8;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1, pctToAngle(s9Pct), pctToAngle(100), false);
    ctx.strokeStyle = arcRed;
    ctx.lineWidth = 8;
    ctx.stroke();

    // ── Minor ticks — batched into two paths (green zone / red zone) ──
    ctx.strokeStyle = `${inkDark.replace('#', 'rgba(').replace(/^rgba\(([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})\)$/, (_, r, g, b) => `rgba(${parseInt(r,16)},${parseInt(g,16)},${parseInt(b,16)},0.45)`)}`;
    // minor ticks green zone
    ctx.beginPath();
    for (const mp of minorPcts) {
      if (mp > s9Pct) continue;
      const a = pctToAngle(mp);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + (outerR + 1) * cos, cy + (outerR + 1) * sin);
      ctx.lineTo(cx + (outerR - 4) * cos, cy + (outerR - 4) * sin);
    }
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = inkDimA;
    ctx.stroke();

    ctx.beginPath();
    for (const mp of minorPcts) {
      if (mp <= s9Pct) continue;
      const a = pctToAngle(mp);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + (outerR + 1) * cos, cy + (outerR + 1) * sin);
      ctx.lineTo(cx + (outerR - 4) * cos, cy + (outerR - 4) * sin);
    }
    ctx.strokeStyle = inkOverA;
    ctx.stroke();

    // ── Major ticks — batched into two paths ──
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < scaleLabels.length; i++) {
      const p = majorPcts[i];
      if (p > s9Pct) continue;
      const a = pctToAngle(p);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + (outerR + 2) * cos, cy + (outerR + 2) * sin);
      ctx.lineTo(cx + (outerR - 7) * cos, cy + (outerR - 7) * sin);
    }
    ctx.strokeStyle = inkDark;
    ctx.stroke();

    // S9 tick slightly thicker — drawn separately
    {
      const a = pctToAngle(s9Pct);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + (outerR + 2) * cos, cy + (outerR + 2) * sin);
      ctx.lineTo(cx + (outerR - 7) * cos, cy + (outerR - 7) * sin);
      ctx.strokeStyle = inkDark;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }

    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < scaleLabels.length; i++) {
      const p = majorPcts[i];
      if (p <= s9Pct) continue;
      const a = pctToAngle(p);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + (outerR + 2) * cos, cy + (outerR + 2) * sin);
      ctx.lineTo(cx + (outerR - 7) * cos, cy + (outerR - 7) * sin);
    }
    ctx.strokeStyle = inkOver;
    ctx.stroke();

    // ── Major tick labels ──
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < scaleLabels.length; i++) {
      const p     = majorPcts[i];
      const label = scaleLabels[i];
      const a     = pctToAngle(p);
      const cos   = Math.cos(a); const sin = Math.sin(a);
      const isOver = p > s9Pct;
      const isWide = label.length > 2;
      const lr     = outerR - 14;
      ctx.fillStyle = isOver ? inkOver : inkDark;
      ctx.font      = `bold ${isOver ? smallTickFont : tickFont}px "Arial", sans-serif`;
      ctx.fillText(label, cx + lr * cos, cy + lr * sin + (isWide ? -2 : 0));
    }

    // ── Power scale ──
    const powerR    = outerR - 22;
    const powerFont = Math.max(5, w * 0.021);

    // Arc guide
    ctx.beginPath();
    ctx.arc(cx, cy, powerR, pctToAngle(0), pctToAngle(100), false);
    ctx.strokeStyle = powerArcA;
    ctx.lineWidth   = 0.5;
    ctx.stroke();

    // Small ticks (every 5, skip 10-multiples) — single batched path
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let v = 5; v < 100; v += 5) {
      if (v % 10 === 0) continue;
      const a = pctToAngle(v);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + powerR * cos,       cy + powerR * sin);
      ctx.lineTo(cx + (powerR - 3) * cos, cy + (powerR - 3) * sin);
    }
    ctx.strokeStyle = powerDimA;
    ctx.stroke();

    // Medium ticks — single batched path
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const v of [10, 20, 30, 40, 60, 70, 80, 90]) {
      const a = pctToAngle(v);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + powerR * cos,       cy + powerR * sin);
      ctx.lineTo(cx + (powerR - 5) * cos, cy + (powerR - 5) * sin);
    }
    ctx.strokeStyle = powerMidA;
    ctx.stroke();

    // Major ticks + labels
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth    = 1.2;
    ctx.beginPath();
    for (const v of [0, 50, 100]) {
      const a = pctToAngle(v);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + (powerR + 1) * cos,  cy + (powerR + 1) * sin);
      ctx.lineTo(cx + (powerR - 7) * cos,  cy + (powerR - 7) * sin);
    }
    ctx.strokeStyle = powerInk;
    ctx.stroke();

    ctx.font      = `bold ${powerFont}px "Arial", sans-serif`;
    ctx.fillStyle = powerFill;
    for (const v of [0, 50, 100]) {
      const a = pctToAngle(v);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.fillText(String(v), cx + (powerR - 13) * cos, cy + (powerR - 13) * sin);
    }

    // POWER label
    const powerLabelR = powerR - 22;
    ctx.font      = `bold ${powerFont}px "Arial", sans-serif`;
    ctx.fillStyle = sigLvlInk;
    ctx.fillText('POWER',
      cx + powerLabelR * Math.cos(midAngle),
      cy + powerLabelR * Math.sin(midAngle));

    // no content scale in cache — scale is applied at blit time
    return off;
  };

  const drawNeedleMeter = () => {
    const canvas = canvasRef;
    if (!canvas) return;

    // Cache the 2D context — getContext is cheap but avoid every frame
    if (!ctx2d) ctx2d = canvas.getContext('2d');
    const ctx = ctx2d;
    if (!ctx) return;

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w    = rect.width;
    const h    = rect.height;

    // Resize backing store only when dimensions actually change
    const needResize = canvas.width  !== Math.round(w * dpr)
                    || canvas.height !== Math.round(h * dpr)
                    || dpr !== lastDpr;
    if (needResize) {
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      lastDpr = dpr;
      // Invalidate caches
      bgCache = undefined;
      scaleCache = undefined;
      cacheW = 0; cacheH = 0;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // Rebuild caches if missing, stale, or theme changed
    const currentTheme = document.documentElement.dataset.theme ?? 'default';
    if (!bgCache || !scaleCache || cacheW !== w || cacheH !== h || cacheTheme !== currentTheme) {
      bgCache    = buildBgCache(w, h, dpr);
      // Build cache at natural size (transform applied at blit)
      scaleCache = buildStaticCache(w, h, dpr);
      cacheW = w; cacheH = h; cacheTheme = currentTheme;
    }

    // 1. Blit background at natural size (no transform)
    ctx.drawImage(bgCache, 0, 0, w, h);

    // 2. Apply transform, draw static content, restore
    ctx.save();
    ctx.translate(w / 2, h / 2 + h * 0.10);
    ctx.scale(2, 1.4);
    ctx.translate(-w / 2, -(h / 2 + h * 0.10));
    ctx.drawImage(scaleCache, 0, 0, w, h);
    ctx.restore();

    // ── Geometry (transformed coordinates) ──
    ctx.save();
    ctx.translate(w / 2, h / 2 + h * 0.10);
    ctx.scale(2, 1.4);
    ctx.translate(-w / 2, -(h / 2 + h * 0.10));

    const cx = w / 2;
    const cy = h + h * 0.60;
    const radius = Math.min(w * 0.55, h * 1.1);
    const sweepRad   = Math.PI / 4;
    const startAngle = -Math.PI / 2 - sweepRad / 2;
    const sweep      = sweepRad;
    const pctToAngle = (p: number) => startAngle + (p / 100) * sweep;
    const outerR     = radius + 5;

    // Lerp needle
    const targetPct = pct();
    smoothedPct += (targetPct - smoothedPct) * 0.3;

    // ── Peak hold ghost needle ──
    const peakAngle = pctToAngle(peakPct);
    const peakLen   = radius - 2;
    ctx.beginPath();
    ctx.moveTo(cx + 7 * Math.cos(peakAngle + Math.PI / 2), cy + 7 * Math.sin(peakAngle + Math.PI / 2));
    ctx.lineTo(cx + peakLen * Math.cos(peakAngle), cy + peakLen * Math.sin(peakAngle));
    ctx.lineTo(cx + 7 * Math.cos(peakAngle - Math.PI / 2), cy + 7 * Math.sin(peakAngle - Math.PI / 2));
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fill();

    // ── 5-second max marker ──
    if (maxPct5sRaw > 0) {
      const maxAngle = pctToAngle(maxPct5sRaw);
      const cosM = Math.cos(maxAngle);
      const sinM = Math.sin(maxAngle);
      ctx.beginPath();
      ctx.moveTo(cx + (outerR + 5) * cosM, cy + (outerR + 5) * sinM);
      ctx.lineTo(cx + (outerR - 9) * cosM, cy + (outerR - 9) * sinM);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // ── Main needle ──
    const needleAngle  = pctToAngle(smoothedPct);
    const needleLen    = outerR + 4;
    const needleTailLen = 10;

    ctx.save();
    ctx.shadowColor   = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur    = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;

    const tipHalfW = 0.6;
    const perp = needleAngle + Math.PI / 2;
    const tipX = cx + needleLen * Math.cos(needleAngle);
    const tipY = cy + needleLen * Math.sin(needleAngle);
    ctx.beginPath();
    ctx.moveTo(
      cx - needleTailLen * Math.cos(needleAngle) + 1.25 * Math.cos(perp),
      cy - needleTailLen * Math.sin(needleAngle) + 1.25 * Math.sin(perp)
    );
    ctx.lineTo(
      cx - needleTailLen * Math.cos(needleAngle) - 1.25 * Math.cos(perp),
      cy - needleTailLen * Math.sin(needleAngle) - 1.25 * Math.sin(perp)
    );
    ctx.lineTo(tipX - tipHalfW * Math.cos(perp), tipY - tipHalfW * Math.sin(perp));
    ctx.lineTo(tipX + tipHalfW * Math.cos(perp), tipY + tipHalfW * Math.sin(perp));
    ctx.closePath();
    ctx.fillStyle = '#cc2222';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - needleTailLen * Math.cos(needleAngle), cy - needleTailLen * Math.sin(needleAngle));
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = '#a01818';
    ctx.lineWidth   = 0.5;
    ctx.stroke();
    ctx.restore(); // needle shadow

    // ── dB readout ──
    const readoutSize = Math.max(8, w * 0.032);
    ctx.font      = `${readoutSize}px "Arial", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(60, 50, 35, 0.5)';
    ctx.fillText(`${store.signalLevel().toFixed(0)} dBm`, cx, cy - radius * 0.32);

    ctx.restore(); // content scale transform

    // Reschedule at 25fps
    rafId = requestAnimationFrame(drawNeedleMeter);
  };

  // 25fps interval — fires drawNeedleMeter at ~40ms cadence
  let intervalId: ReturnType<typeof setInterval> | undefined;

  createEffect(() => {
    if (store.meterStyle() === 'needle') {
      if (!intervalId) {
        intervalId = setInterval(() => {
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(drawNeedleMeter);
        }, 1000 / 25);
      }
    } else {
      if (intervalId) { clearInterval(intervalId); intervalId = undefined; }
      if (rafId)      { cancelAnimationFrame(rafId); rafId = undefined; }
    }
  });

  const [open, setOpen] = createSignal(true);

  const toggleStyle = () => {
    store.setMeterStyle(store.meterStyle() === 'bar' ? 'needle' : 'bar');
  };

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={(e) => { if ((e.target as HTMLElement).closest('button')) return; setOpen(o => !o); }}
      >
        <span>Signal</span>
        <Show when={!open()}>
          <span class="text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal">
            {store.signalLevel().toFixed(0)} dBm
          </span>
        </Show>
        <button
          class="ml-auto text-[8px] font-mono text-text-dim hover:text-text-secondary transition-colors uppercase tracking-wider"
          onClick={(e) => { e.stopPropagation(); toggleStyle(); }}
          title={`Switch to ${store.meterStyle() === 'bar' ? 'needle' : 'bar'} meter`}
        >
          {store.meterStyle() === 'bar' ? 'Needle' : 'Bar'}
        </button>
        <span class={`text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-3">
        <Show when={store.meterStyle() === 'bar'}>
          <div class="flex justify-between text-[9px] text-text-dim font-mono mb-1">
            <span>S-Meter</span>
            <span class="text-text-secondary">{store.signalLevel().toFixed(0)} dBm</span>
          </div>
          {/* Bar track */}
          <div class="h-3 bg-sdr-base rounded-sm border border-border overflow-hidden relative">
            {/* Colour zone backgrounds: green S1-S9, amber S9-+20, red +20 onwards */}
            <div class="absolute inset-y-0 left-0 bg-green/10"        style={{ width: '57.1%' }} />
            <div class="absolute inset-y-0 bg-amber/10"               style={{ left: '57.1%', width: '14.3%' }} />
            <div class="absolute inset-y-0 bg-neon-red/10"            style={{ left: '71.4%', right: '0' }} />
            {/* S-unit dividers at fixed positions */}
            <For each={[7.1,14.3,21.4,28.6,35.7,42.9,50.0,57.1,66.7,71.4,78.6,85.7,92.9]}>
              {(p) => <div class="absolute inset-y-0 w-px bg-border/40" style={{ left: `${p}%` }} />}
            </For>
            {/* Current level bar — no CSS transition, engine EMA handles smoothing */}
            <div
              class={`absolute inset-y-0 left-0 rounded-sm shadow-[0_0_6px_currentColor] ${barColor()}`}
              style={{ width: `${pct()}%` }}
            />
            {/* 5-second max marker — white vertical line */}
            <div
              class="absolute inset-y-0 w-0.5 bg-white rounded-full"
              style={{ left: `${maxPct5s()}%` }}
            />
            {/* Peak hold indicator — white line, slow decay */}
            <div
              class="absolute inset-y-0 w-px bg-text-secondary opacity-80"
              style={{ left: `${peakHold()}%` }}
            />
          </div>
          {/* Scale labels aligned to fixed dB positions */}
          <div class="relative text-[7px] text-text-muted font-mono mt-0.5 h-3">
            <span class="absolute -translate-x-1/2" style={{ left:  '0%' }}>S1</span>
            <span class="absolute -translate-x-1/2" style={{ left: '14.3%' }}>3</span>
            <span class="absolute -translate-x-1/2" style={{ left: '28.6%' }}>5</span>
            <span class="absolute -translate-x-1/2" style={{ left: '42.9%' }}>7</span>
            <span class="absolute -translate-x-1/2" style={{ left: '57.1%' }}>9</span>
            <span class="absolute -translate-x-1/2" style={{ left: '66.7%' }}>+10</span>
            <span class="absolute -translate-x-1/2" style={{ left: '78.6%' }}>+30</span>
            <span class="absolute -translate-x-1/2" style={{ left: '100%', transform: 'translateX(-100%)' }}>+60</span>
          </div>
        </Show>
        <Show when={store.meterStyle() === 'needle'}>
          <canvas
            ref={(el) => {
              canvasRef = el;
              // Reset cached context and offscreen caches whenever the canvas
              // element is (re)mounted — happens when toggling bar ↔ needle.
              ctx2d = null;
              bgCache = undefined;
              scaleCache = undefined;
              cacheW = 0; cacheH = 0;
            }}
            class="w-full rounded-sm"
            style={{ height: '110px', 'image-rendering': 'crisp-edges' }}
          />
        </Show>
      </div>
      </Show>
    </div>
  );
};

// ---- Codec Settings ----
const CodecSettings: Component = () => {
  const allFftCodecs: { value: FftCodecType; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'adpcm', label: 'ADPCM' },
    { value: 'deflate', label: 'Deflate' },
    { value: 'deflate-floor', label: 'DeflateFl' },
  ];

  const allIqCodecs: { value: IqCodecType; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'adpcm', label: 'ADPCM' },
    { value: 'opus', label: 'Opus' },
    { value: 'opus-hq', label: 'Opus HQ' },
  ];

  // Filter to only codecs the server reports as available
  const fftCodecs = () => allFftCodecs.filter(c => store.availableFftCodecs().includes(c.value));
  const iqCodecs = () => allIqCodecs.filter(c => store.availableIqCodecs().includes(c.value));

  // Format bytes/sec into human-readable string
  const formatRate = (bytes: number) => {
    if (bytes === 0) return '—';
    if (bytes < 1024) return `${bytes} B/s`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`;
  };

  // Compute compression ratio
  const fftRatio = () => {
    const raw = store.fftRawBytes();
    const wire = store.fftWireBytes();
    if (wire === 0 || raw === 0) return null;
    return raw / wire;
  };

  const iqRatio = () => {
    const raw = store.iqRawBytes();
    const wire = store.iqWireBytes();
    if (wire === 0 || raw === 0) return null;
    return raw / wire;
  };

  const ratioText = (ratio: number | null) => {
    if (ratio === null) return '—';
    return `${ratio.toFixed(1)}:1`;
  };

  const savingsText = (raw: number, wire: number) => {
    if (raw === 0 || wire === 0) return '';
    const saved = raw - wire;
    if (saved <= 0) return '';
    const pct = ((saved / raw) * 100).toFixed(0);
    return `(-${pct}%)`;
  };

  const [open, setOpen] = createSignal(true);

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>Compression</span>
        <Show when={!open()}>
          <span class="ml-auto text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal">
            {formatRate(store.fftWireBytes() + store.iqWireBytes())}
            {' '}
            {savingsText(store.fftRawBytes() + store.iqRawBytes(), store.fftWireBytes() + store.iqWireBytes())}
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-2 space-y-2">
        {/* FFT Codec */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              FFT
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {ratioText(fftRatio())}
              {' '}
              <span class="text-neon">{formatRate(store.fftWireBytes())}</span>
            </span>
          </div>
          <div class="flex gap-2">
            <For each={fftCodecs()}>
              {(c) => (
                <button
                  class={`mil-btn flex-1 ${store.fftCodec() === c.value ? 'active' : ''}`}
                  onClick={() => engine.setFftCodec(c.value)}
                >
                  {c.label}
                </button>
              )}
            </For>
          </div>
        </div>
        {/* IQ Codec */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              IQ
            </label>
            <span class="text-[9px] font-mono text-text-dim">
              {ratioText(iqRatio())}
              {' '}
              <span class="text-neon">{formatRate(store.iqWireBytes())}</span>
            </span>
          </div>
          <div class="flex gap-2">
            <For each={iqCodecs()}>
              {(c) => (
                <button
                  class={`mil-btn flex-1 ${store.iqCodec() === c.value ? 'active' : ''}`}
                  onClick={() => engine.setIqCodec(c.value)}
                >
                  {c.label}
                </button>
              )}
            </For>
          </div>
        </div>
        {/* Stats summary */}
        <div class="border-t border-border/40 pt-1.5 text-[8px] font-mono text-text-dim leading-relaxed">
          <div class="flex justify-between">
            <span>Total wire</span>
            <span class="text-text-secondary">{formatRate(store.fftWireBytes() + store.iqWireBytes())}</span>
          </div>
          <div class="flex justify-between">
            <span>Uncompressed equiv.</span>
            <span class="text-text-secondary">{formatRate(store.fftRawBytes() + store.iqRawBytes())}</span>
          </div>
          <div class="flex justify-between">
            <span>Savings</span>
            <span class="text-neon">
              {savingsText(
                store.fftRawBytes() + store.iqRawBytes(),
                store.fftWireBytes() + store.iqWireBytes()
              )}
            </span>
          </div>
        </div>
      </div>
      </Show>
    </div>
  );
};

// ---- Frequency Bookmarks ----
const Bookmarks: Component = () => {
  const [label, setLabel] = createSignal('');
  const [editId, setEditId] = createSignal<string | null>(null);
  const [editLabel, setEditLabel] = createSignal('');

  const formatHz = (hz: number) => {
    const mhz = hz / 1e6;
    return mhz >= 1 ? `${mhz.toFixed(4)} MHz` : `${(hz / 1e3).toFixed(2)} kHz`;
  };

  const handleAdd = () => {
    engine.addBookmark(label());
    setLabel('');
  };

  const handleRecall = (bm: Bookmark) => {
    engine.recallBookmark(bm);
  };

  const handleDelete = (id: string) => {
    engine.deleteBookmark(id);
  };

  const startEdit = (bm: Bookmark) => {
    setEditId(bm.id);
    setEditLabel(bm.label);
  };

  const commitEdit = (id: string) => {
    const updated = store.bookmarks().map(b =>
      b.id === id ? { ...b, label: editLabel().trim() || b.label } : b,
    );
    store.setBookmarks(updated);
    setEditId(null);
  };

  const [open, setOpen] = createSignal(true);

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>Bookmarks</span>
        <Show when={!open()}>
          <span class="ml-auto text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal">
            {store.bookmarks().length} saved
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-2 space-y-1.5">
        {/* Add current frequency */}
        <div class="flex gap-1">
          <input
            id="bookmark-label"
            name="bookmark-label"
            aria-label="Bookmark label"
            class="flex-1 bg-sdr-base border border-border rounded-sm
                   px-2 py-0.5 text-[9px] font-mono text-text-primary
                   placeholder:text-text-muted focus:outline-none focus:border-[var(--sdr-accent)]"
            placeholder="Label (optional)"
            value={label()}
            onInput={e => setLabel(e.currentTarget.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <button
            class="sdr-btn sdr-btn-primary text-[8px] px-2 shrink-0"
            onClick={handleAdd}
            title="Bookmark current frequency"
          >
            + Add
          </button>
        </div>

        {/* Bookmark list */}
        <Show when={store.bookmarks().length === 0}>
          <div class="text-[8px] font-mono text-text-muted text-center py-1">
            No bookmarks
          </div>
        </Show>
        <For each={store.bookmarks()}>
          {(bm) => (
            <div class="flex items-center gap-1 group">
              <Show
                when={editId() === bm.id}
                fallback={
                  <button
                    class="flex-1 text-left px-1.5 py-0.5 rounded-sm
                           text-[9px] font-mono text-text-primary
                           hover:bg-sdr-elevated transition-colors truncate"
                    title={`${formatHz(bm.hz)} · ${bm.mode.toUpperCase()}`}
                    onClick={() => handleRecall(bm)}
                    onDblClick={() => startEdit(bm)}
                  >
                    <span class="text-[var(--sdr-accent)] mr-1">▶</span>
                    <span class="text-text-secondary mr-1.5">{bm.label}</span>
                    <span class="text-text-muted text-[8px]">{formatHz(bm.hz)}</span>
                  </button>
                }
              >
                <input
                  class="flex-1 bg-sdr-base border border-[var(--sdr-accent)] rounded-sm
                         px-1.5 py-0.5 text-[9px] font-mono text-text-primary
                         focus:outline-none"
                  value={editLabel()}
                  onInput={e => setEditLabel(e.currentTarget.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitEdit(bm.id);
                    if (e.key === 'Escape') setEditId(null);
                  }}
                  onBlur={() => commitEdit(bm.id)}
                  ref={el => setTimeout(() => el?.focus(), 0)}
                />
              </Show>
              <button
                class="opacity-0 group-hover:opacity-100 transition-opacity
                       text-text-muted hover:text-status-error text-[9px] px-0.5 shrink-0"
                title="Delete bookmark"
                onClick={() => handleDelete(bm.id)}
              >
                ×
              </button>
            </div>
          )}
        </For>
      </div>
      </Show>
    </div>
  );
};

// ---- Connection Status ----
// ---- Dongle Selector ----
// ---- Admin Panel ----
const AdminPanel: Component = () => {
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [profiles, setProfiles] = createSignal<DongleProfile[]>([]);
  const [loading, setLoading] = createSignal(false);

  const apiBase = () => {
    // In dev, proxy handles this. In prod, same origin.
    return '';
  };

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${password()}`,
  });

  const handleLogin = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${apiBase()}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password() }),
      });
      if (res.ok) {
        store.setIsAdmin(true);
        // Also authenticate via WebSocket
        engine.adminAuth(password());
      } else {
        const data = await res.json();
        setError(data.error || 'Authentication failed');
      }
    } catch {
      setError('Connection failed');
    }
    setLoading(false);
  };

  const handleLogout = () => {
    store.setIsAdmin(false);
    setPassword('');
    setProfiles([]);
  };

  const loadProfiles = async (dongleId: string) => {
    try {
      const res = await fetch(`${apiBase()}/api/dongles/${dongleId}/profiles`);
      if (res.ok) {
        const data = await res.json();
        setProfiles(data);
      }
    } catch {
      // ignore
    }
  };

  const handleSwitchProfile = async (dongleId: string, profileId: string) => {
    setLoading(true);
    try {
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/profile`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ profileId }),
      });
    } catch {
      setError('Failed to switch profile');
    }
    setLoading(false);
  };

  const handleStartDongle = async (dongleId: string) => {
    setLoading(true);
    try {
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/start`, {
        method: 'POST',
        headers: authHeaders(),
      });
      // State update arrives via WS push (dongle_started notification)
    } catch {
      setError('Failed to start dongle');
    }
    setLoading(false);
  };

  const handleStopDongle = async (dongleId: string) => {
    setLoading(true);
    try {
      await fetch(`${apiBase()}/api/admin/dongles/${dongleId}/stop`, {
        method: 'POST',
        headers: authHeaders(),
      });
      // State update arrives via WS push (dongle_stopped notification)
    } catch {
      setError('Failed to stop dongle');
    }
    setLoading(false);
  };

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Admin</div>
      <div class="p-3">
        <Show
          when={store.isAdmin()}
          fallback={
            <div class="space-y-2">
              <input
                type="password"
                placeholder="Admin password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                class="w-full bg-sdr-base border border-border rounded-sm px-2 py-1.5
                       text-[10px] font-mono text-text-primary placeholder:text-text-muted
                       focus:border-border-focus focus:outline-none"
              />
              <button
                class="sdr-btn sdr-btn-primary w-full"
                onClick={handleLogin}
                disabled={loading() || !password()}
              >
                {loading() ? 'Authenticating...' : 'Login'}
              </button>
              <Show when={error()}>
                <div class="text-[9px] font-mono text-status-error">{error()}</div>
              </Show>
            </div>
          }
        >
          {/* Admin Controls */}
          <div class="space-y-3">
            <div class="flex justify-between items-center">
              <span class="text-[9px] font-mono text-amber uppercase tracking-wider font-bold">
                Admin Mode
              </span>
              <button
                class="text-[8px] font-mono text-text-dim hover:text-text-secondary"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>

            {/* Dongle Management */}
            <For each={store.dongles()}>
              {(dongle) => (
                <div class="bg-sdr-base border border-border rounded-sm p-2 space-y-2">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-1.5">
                      <div class={`w-1.5 h-1.5 rounded-full ${dongle.running ? 'bg-status-online' : 'bg-status-offline'}`} />
                      <span class="text-[10px] font-mono text-text-primary">{dongle.name}</span>
                    </div>
                    <span class="text-[8px] font-mono text-text-dim">
                      {dongle.clientCount} user{dongle.clientCount !== 1 ? 's' : ''}
                    </span>
                  </div>

                  <div class="flex gap-1">
                    <Show when={dongle.running}>
                      <button
                        class="sdr-btn flex-1 text-[8px] bg-status-error/20 text-status-error hover:bg-status-error/30"
                        onClick={() => handleStopDongle(dongle.id)}
                        disabled={loading()}
                      >
                        Stop
                      </button>
                    </Show>
                    <Show when={!dongle.running}>
                      <button
                        class="sdr-btn flex-1 text-[8px] bg-status-online/20 text-status-online hover:bg-status-online/30"
                        onClick={() => handleStartDongle(dongle.id)}
                        disabled={loading()}
                      >
                        Start
                      </button>
                    </Show>
                    <button
                      class="sdr-btn flex-1 text-[8px]"
                      onClick={() => loadProfiles(dongle.id)}
                    >
                      Profiles
                    </button>
                  </div>

                  {/* Profile list (shown when loaded) */}
                  <Show when={profiles().length > 0}>
                    <div class="space-y-0.5">
                      <div class="text-[8px] font-mono text-text-dim uppercase tracking-wider mb-1">
                        Switch Profile:
                      </div>
                      <For each={profiles()}>
                        {(profile) => (
                          <button
                            class={`w-full text-left px-2 py-1 rounded-sm text-[9px] font-mono
                                    transition-colors duration-100
                                    ${store.activeProfileId() === profile.id
                                      ? 'bg-cyan-dim text-cyan'
                                      : 'text-text-secondary hover:bg-sdr-hover'}`}
                            onClick={() => handleSwitchProfile(dongle.id, profile.id)}
                            disabled={loading()}
                          >
                            <div>{profile.name}</div>
                            <div class="text-[7px] text-text-dim">
                              {(profile.centerFrequency / 1e6).toFixed(3)} MHz — {profile.defaultMode.toUpperCase()}
                            </div>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>

            <Show when={error()}>
              <div class="text-[9px] font-mono text-status-error">{error()}</div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default ControlPanel;

// ---- Music Identification Panel ----

const IdentifyPanel: Component = () => {
  const state = () => store.identifyState();
  const result = () => store.identifyResult();

  // Reactive boolean — true while the ADPCM/none ring buffer is still filling.
  // Uses a 250ms tick so the button re-enables promptly when the cooldown expires.
  const [now, setNow] = createSignal(Date.now());
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  createEffect(() => {
    const readyAt = store.identifyReadyAt();
    if (readyAt > Date.now()) {
      if (!tickTimer) {
        tickTimer = setInterval(() => {
          setNow(Date.now());
          if (Date.now() >= store.identifyReadyAt() && tickTimer) {
            clearInterval(tickTimer);
            tickTimer = undefined;
          }
        }, 250);
      }
    }
  });

  onCleanup(() => { if (tickTimer) clearInterval(tickTimer); });

  const busy    = () => state() === 'capturing' || state() === 'querying';
  const warming = () => now() < store.identifyReadyAt();
  const disabled = () => busy() || warming();
  const ready   = () => !disabled();

  const label = () => {
    switch (state()) {
      case 'capturing': return 'Capturing...';
      case 'querying':  return 'Identifying...';
      default: return 'Identify Song';
    }
  };

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">
        <span>Identify</span>
        <Show when={state() === 'done' && result()?.match}>
          <span class="ml-auto text-[9px] font-mono text-[var(--sdr-accent)] normal-case tracking-normal font-normal truncate max-w-[160px]">
            {result()?.artist} — {result()?.title}
          </span>
        </Show>
      </div>
      <div class="p-3 space-y-2">
        {/* Identify button */}
        <button
          class="mil-btn w-full"
          disabled={disabled()}
          onClick={() => engine.identify()}
        >
          {/* Waveform icon — pulses while capturing/querying, steady glow when ready, dim while warming */}
          <svg
            class={`w-3 h-3 mr-1.5 inline-block rounded-sm ${busy() ? 'identify-capturing' : 'transition-all duration-500'}`}
            style={!busy() && ready() ? {
              color: 'var(--sdr-accent)',
              filter: 'drop-shadow(0 0 4px var(--sdr-accent))',
            } : {}}
            viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
          >
            <path d="M1 8h2M4 5v6M7 3v10M10 5v6M13 8h2" />
          </svg>
          {label()}
        </button>

        {/* Result display */}
        <Show when={state() === 'done' || state() === 'error'}>
          <Show when={result()?.match}
            fallback={
              <div class="text-[9px] font-mono text-text-dim text-center py-1">
                {state() === 'error'
                  ? (result()?.error ?? 'Recognition failed')
                  : 'No match found'}
              </div>
            }
          >
            <div class="border border-border rounded-sm bg-sdr-elevated p-2 space-y-1">
              <div class="text-[11px] font-mono text-text-primary font-semibold leading-tight">
                {result()?.title}
              </div>
              <div class="text-[9px] font-mono text-text-secondary">
                {result()?.artist}
                <Show when={result()?.album}>
                  <span class="text-text-dim"> · {result()?.album}</span>
                </Show>
              </div>
              {/* Links */}
              <div class="flex gap-2 pt-1">
                <Show when={result()?.spotify}>
                  <a href={result()!.spotify} target="_blank" rel="noopener"
                     class="text-[8px] font-mono uppercase tracking-wider text-[#1DB954] hover:brightness-125 transition-all">
                    Spotify
                  </a>
                </Show>
                <Show when={result()?.youtube}>
                  <a href={result()!.youtube} target="_blank" rel="noopener"
                     class="text-[8px] font-mono uppercase tracking-wider text-[#FF0000] hover:brightness-125 transition-all">
                    YouTube
                  </a>
                </Show>
                <Show when={result()?.apple}>
                  <a href={result()!.apple} target="_blank" rel="noopener"
                     class="text-[8px] font-mono uppercase tracking-wider text-text-dim hover:text-text-secondary transition-all">
                    Apple
                  </a>
                </Show>
                <span class="ml-auto text-[7px] font-mono text-text-muted">
                  via {result()?.service ?? '—'}
                </span>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};
