// ============================================================
// node-sdr — Control Panel (Sidebar)
// ============================================================

import { Component, For, Show, createSignal, createResource, onMount, onCleanup, createEffect } from 'solid-js';
import { store } from '../store/index.js';
import type { Bookmark } from '../store/index.js';
import { engine } from '../engine/sdr-engine.js';
import { DEMOD_MODES } from '@node-sdr/shared';
import type { CodecType, DemodMode, DongleInfo, DongleProfile, WaterfallColorTheme } from '@node-sdr/shared';
import { getPaletteNames } from '../engine/palettes.js';

const ControlPanel: Component = () => {
  return (
    <div class="flex flex-col gap-3 p-3 overflow-y-auto h-full">
      {/* S-Meter */}
      <SMeter />

      {/* Mode Selector */}
      <ModeSelector />

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

      {/* Connection Status */}
      <ConnectionStatus />

      {/* Dongle Selector */}
      <DongleSelector />
    </div>
  );
};

// ---- Mode Selector ----
const ModeSelector: Component = () => {
  const modes: DemodMode[] = ['wfm', 'nfm', 'am', 'usb', 'lsb', 'cw', 'raw'];
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
            {[store.nrEnabled() ? 'NR' : '', store.nbEnabled() ? 'NB' : ''].filter(Boolean).join(' · ') || 'off'}
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-3 space-y-3">
        {/* Spectral NR */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Spectral NR
            </label>
            <button
              class={`mil-btn ${store.nrEnabled() ? 'active' : ''}`}
              onClick={() => engine.setNrEnabled(!store.nrEnabled())}
              title="Spectral noise reduction — reduces background noise using Wiener filter"
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
                Wiener filter — min. statistics noise floor estimation
              </div>
            </div>
          </Show>
        </div>

        {/* Noise Blanker */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Noise Blanker
            </label>
            <button
              class={`mil-btn ${store.nbEnabled() ? 'active' : ''}`}
              onClick={() => engine.setNbEnabled(!store.nbEnabled())}
              title="Noise blanker — removes impulse noise (clicks, pops)"
            >
              {store.nbEnabled() ? 'On' : 'Off'}
            </button>
          </div>
          <Show when={store.nbEnabled()}>
            <div>
              <div class="flex justify-between items-center mb-1">
                <label class="text-[9px] font-mono text-text-dim">
                  Threshold
                </label>
                <span class="text-[9px] font-mono text-text-dim">
                  {Math.round(store.nbLevel() * 100)}%
                </span>
              </div>
              <input
                type="range"
                aria-label="Noise blanker threshold"
                min={0}
                max={100}
                value={Math.round(store.nbLevel() * 100)}
                onInput={(e) => engine.setNbLevel(parseInt(e.currentTarget.value) / 100)}
                class="sdr-range"
              />
              <div class="text-[7px] font-mono text-text-muted mt-0.5">
                Impulse blanker — EMA amplitude tracking + hang timer
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
            {store.waterfallTheme()} · {store.waterfallAutoRange() ? 'auto' : `${store.waterfallMin()}/${store.waterfallMax()} dB`}
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-3 space-y-3">
        {/* Color Theme */}
        <div>
          <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1 block">
            Color Theme
          </label>
          <div class="flex flex-wrap gap-2">
            <For each={themes}>
              {(theme) => (
                <button
                  class={`mil-btn ${store.waterfallTheme() === theme ? 'active' : ''}`}
                  onClick={() => engine.setWaterfallTheme(theme)}
                >
                  {theme}
                </button>
              )}
            </For>
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

  // Hoisted per-frame state (avoid repeated lookups inside rAF)
  let ctx2d: CanvasRenderingContext2D | null = null;
  let lastDpr = 0;

  const buildBgCache = (w: number, h: number, dpr: number) => {
    const off = document.createElement('canvas');
    off.width  = Math.round(w * dpr);
    off.height = Math.round(h * dpr);
    const ctx = off.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── Amber backlit face ──
    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.15, 0, w * 0.5, h * 0.6, w * 0.72);
    bgGrad.addColorStop(0,   '#ffe060');
    bgGrad.addColorStop(0.35,'#ffb020');
    bgGrad.addColorStop(0.75,'#e07000');
    bgGrad.addColorStop(1,   '#b04400');
    ctx.fillStyle = bgGrad;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 4);
    ctx.fill();

    // Vignette
    const vig = ctx.createRadialGradient(w*.5, h*.3, h*.05, w*.5, h*.5, w*.65);
    vig.addColorStop(0, 'rgba(255,180,0,0.0)');
    vig.addColorStop(1, 'rgba(60,10,0,0.40)');
    ctx.fillStyle = vig;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 4);
    ctx.fill();

    // Bezel
    ctx.strokeStyle = 'rgba(80,25,0,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0.75, 0.75, w-1.5, h-1.5, 4);
    ctx.stroke();

    return off;
  };

  const buildStaticCache = (w: number, h: number, dpr: number) => {
    const off = document.createElement('canvas');
    off.width  = Math.round(w * dpr);
    off.height = Math.round(h * dpr);
    const ctx = off.getContext('2d')!;
    // DPR scale only — NO content scale transform here.
    // The content scale (2×/1.4×) is applied at blit time in drawNeedleMeter.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    ctx.fillStyle    = 'rgba(40, 25, 5, 0.80)';
    ctx.fillText('SIGNAL LEVEL',
      cx + labelR * Math.cos(midAngle),
      cy + labelR * Math.sin(midAngle) - 6);

    // ── Coloured arc bands (single path each) ──
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1, pctToAngle(0), pctToAngle(s9Pct), false);
    ctx.strokeStyle = 'rgba(40, 100, 60, 0.15)';
    ctx.lineWidth = 8;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1, pctToAngle(s9Pct), pctToAngle(100), false);
    ctx.strokeStyle = 'rgba(180, 30, 30, 0.15)';
    ctx.lineWidth = 8;
    ctx.stroke();

    // ── Minor ticks — batched into two paths (green zone / red zone) ──
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const mp of minorPcts) {
      if (mp > s9Pct) continue;
      const a = pctToAngle(mp);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + (outerR + 1) * cos, cy + (outerR + 1) * sin);
      ctx.lineTo(cx + (outerR - 4) * cos, cy + (outerR - 4) * sin);
    }
    ctx.strokeStyle = 'rgba(60,45,30,0.45)';
    ctx.stroke();

    ctx.beginPath();
    for (const mp of minorPcts) {
      if (mp <= s9Pct) continue;
      const a = pctToAngle(mp);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.moveTo(cx + (outerR + 1) * cos, cy + (outerR + 1) * sin);
      ctx.lineTo(cx + (outerR - 4) * cos, cy + (outerR - 4) * sin);
    }
    ctx.strokeStyle = 'rgba(160,30,30,0.5)';
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
    ctx.strokeStyle = '#2a1a08';
    ctx.stroke();

    // S9 tick slightly thicker — drawn separately
    {
      const a = pctToAngle(s9Pct);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + (outerR + 2) * cos, cy + (outerR + 2) * sin);
      ctx.lineTo(cx + (outerR - 7) * cos, cy + (outerR - 7) * sin);
      ctx.strokeStyle = '#2a1a08';
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
    ctx.strokeStyle = '#a01818';
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
      ctx.fillStyle = isOver ? '#9a1010' : '#2a1a08';
      ctx.font      = `bold ${isOver ? smallTickFont : tickFont}px "Arial", sans-serif`;
      ctx.fillText(label, cx + lr * cos, cy + lr * sin + (isWide ? -2 : 0));
    }

    // ── Power scale ──
    const powerR    = outerR - 22;
    const powerFont = Math.max(5, w * 0.021);

    // Arc guide
    ctx.beginPath();
    ctx.arc(cx, cy, powerR, pctToAngle(0), pctToAngle(100), false);
    ctx.strokeStyle = 'rgba(60, 40, 10, 0.18)';
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
    ctx.strokeStyle = 'rgba(60, 40, 10, 0.30)';
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
    ctx.strokeStyle = 'rgba(60, 40, 10, 0.45)';
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
    ctx.strokeStyle = 'rgba(60, 40, 10, 0.65)';
    ctx.stroke();

    ctx.font      = `bold ${powerFont}px "Arial", sans-serif`;
    ctx.fillStyle = 'rgba(50, 30, 5, 0.70)';
    for (const v of [0, 50, 100]) {
      const a = pctToAngle(v);
      const cos = Math.cos(a); const sin = Math.sin(a);
      ctx.fillText(String(v), cx + (powerR - 13) * cos, cy + (powerR - 13) * sin);
    }

    // POWER label
    const powerLabelR = powerR - 22;
    ctx.font      = `bold ${powerFont}px "Arial", sans-serif`;
    ctx.fillStyle = 'rgba(50, 30, 5, 0.55)';
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

    // Rebuild caches if missing or stale
    if (!bgCache || !scaleCache || cacheW !== w || cacheH !== h) {
      bgCache    = buildBgCache(w, h, dpr);
      scaleCache = buildStaticCache(w, h, dpr);
      cacheW = w; cacheH = h;
    }

    // 1. Blit background at natural size (no transform)
    ctx.drawImage(bgCache, 0, 0, w, h);

    // 2. Apply content scale, blit meter content, draw dynamic elements
    ctx.save();
    ctx.translate(w / 2, h / 2 + h * 0.10);
    ctx.scale(2, 1.4);
    ctx.translate(-w / 2, -(h / 2 + h * 0.10));

    // Blit scale cache through the content transform
    ctx.drawImage(scaleCache, 0, 0, w, h);

    // ── Geometry (matches buildStaticCache exactly) ──
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
            style={{ height: '110px' }}
          />
        </Show>
      </div>
      </Show>
    </div>
  );
};

// ---- Codec Settings ----
const CodecSettings: Component = () => {
  const fftCodecs: { value: CodecType; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'adpcm', label: 'ADPCM' },
    { value: 'deflate', label: 'Deflate' },
    { value: 'deflate-floor', label: 'DeflateFl' },
  ];

  const iqCodecs: { value: CodecType; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'adpcm', label: 'ADPCM' },
    { value: 'opus', label: 'Opus' },
    { value: 'opus-hq', label: 'Opus HQ' },
  ];

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
            <For each={fftCodecs}>
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
            <For each={iqCodecs}>
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
const ConnectionStatus: Component = () => {
  const [open, setOpen] = createSignal(true);

  return (
    <div class="sdr-panel">
      <div
        class={`sdr-panel-header collapsible ${open() ? '' : 'collapsed'}`}
        onClick={() => setOpen(o => !o)}
      >
        <span>Status</span>
        <Show when={!open()}>
          <span class={`ml-auto text-[9px] font-mono normal-case tracking-normal font-normal ${store.connected() ? 'text-status-online' : 'text-status-error'}`}>
            {store.connected() ? 'Connected' : 'Disconnected'}
          </span>
        </Show>
        <span class={`ml-auto text-text-muted text-[9px] transition-transform ${open() ? 'rotate-0' : '-rotate-90'}`}>▾</span>
      </div>
      <Show when={open()}>
        <div class="p-3 space-y-1 text-[9px] font-mono">
        <div class="flex justify-between">
          <span class="text-text-secondary">Connection</span>
          <span class={store.connected() ? 'text-status-online' : 'text-status-error'}>
            {store.connected() ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div class="flex justify-between">
          <span class="text-text-secondary">Client ID</span>
          <span class="text-text-dim">{store.clientId() || '—'}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-text-secondary">Sample Rate</span>
          <span class="text-text-dim">{(store.sampleRate() / 1e6).toFixed(2)} MSPS</span>
        </div>
        <div class="flex justify-between">
          <span class="text-text-secondary">FFT Size</span>
          <span class="text-text-dim">{store.fftSize()}</span>
        </div>
      </div>
      </Show>
    </div>
  );
};

// ---- Dongle Selector ----
const DongleSelector: Component = () => {
  return (
    <Show when={store.dongles().length > 0}>
      <div class="sdr-panel">
        <div class="sdr-panel-header">Receivers</div>
        <div class="p-2">
          <For each={store.dongles()}>
            {(dongle) => (
              <button
                class={`w-full text-left p-2 rounded-sm text-[10px] font-mono
                        transition-colors duration-100
                        ${store.activeDongleId() === dongle.id
                          ? 'bg-cyan-dim text-cyan'
                          : 'text-text-secondary hover:bg-sdr-hover'}`}
                onClick={() => engine.subscribe(dongle.id)}
              >
                <div class="flex items-center gap-2">
                  <div class={`w-1.5 h-1.5 rounded-full ${dongle.running ? 'bg-status-online' : 'bg-status-offline'}`} />
                  <span>{dongle.name}</span>
                </div>
                <Show when={dongle.activeProfileId}>
                  <div class="text-text-dim ml-3.5 mt-0.5">
                    Profile: {dongle.activeProfileId}
                  </div>
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

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
      // Refresh dongle list
      engine.fetchDongles();
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
      engine.fetchDongles();
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
                                    ${dongle.activeProfileId === profile.id
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
