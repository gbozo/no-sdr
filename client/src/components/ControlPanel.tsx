// ============================================================
// node-sdr — Control Panel (Sidebar)
// ============================================================

import { Component, For, Show, createSignal, createResource, onMount, onCleanup, createEffect } from 'solid-js';
import { store } from '../store/index.js';
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

      {/* Connection Status */}
      <ConnectionStatus />

      {/* Dongle Selector */}
      <DongleSelector />

      {/* Admin Panel */}
      <AdminPanel />
    </div>
  );
};

// ---- Mode Selector ----
const ModeSelector: Component = () => {
  const modes: DemodMode[] = ['wfm', 'nfm', 'am', 'usb', 'lsb', 'cw', 'raw'];

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Demodulation</div>
      <div class="p-2">
        <div class="flex flex-wrap gap-1">
          <For each={modes}>
            {(mode) => (
              <button
                class={`sdr-mode-btn ${store.mode() === mode ? 'active' : ''}`}
                onClick={() => engine.setMode(mode)}
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
            min={-150}
            max={0}
            value={store.squelch() ?? -150}
            onInput={(e) => {
              const val = parseInt(e.currentTarget.value);
              engine.setSquelch(val <= -150 ? null : val);
            }}
            class="sdr-range"
          />
        </div>
      </div>
    </div>
  );
};

// ---- Audio Controls ----
const AudioControls: Component = () => {
  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">
        <span>Audio</span>
        {/* Stereo indicator — visible for WFM, AM (auto-detected), and AM Stereo */}
        <Show when={store.mode() === 'wfm' || store.mode() === 'am' || store.mode() === 'am-stereo'}>
          <span
            class={`ml-auto text-[9px] font-mono font-bold tracking-wider px-1.5 py-0.5 rounded border transition-all duration-500 ${
              store.stereoDetected()
                ? 'text-green border-green/40 bg-green-dim shadow-[0_0_6px_rgba(56,193,128,0.3)]'
                : 'text-text-muted border-border bg-transparent opacity-50'
            }`}
            title={store.stereoDetected()
              ? (store.iqCodec() === 'opus'
                ? 'Server-side stereo active (Opus)'
                : store.mode() === 'wfm' ? 'Stereo pilot detected (19 kHz)' : 'C-QUAM stereo pilot detected (25 Hz)')
              : (store.iqCodec() === 'opus'
                ? 'No stereo from server'
                : store.mode() === 'wfm' ? 'No stereo pilot' : 'No C-QUAM stereo pilot')
            }
          >
            STEREO
          </span>
        </Show>
      </div>
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

        {/* Mute + Loudness row */}
        <div class="flex gap-1.5">
          <button
            class={`sdr-btn flex-1 ${store.muted() ? 'sdr-btn-primary' : 'sdr-btn-ghost'}`}
            onClick={() => engine.setMuted(!store.muted())}
          >
            {store.muted() ? 'Unmute' : 'Mute'}
          </button>
          <button
            class={`sdr-btn flex-1 ${
              store.loudness()
                ? 'bg-amber text-text-inverse shadow-glow-amber font-bold'
                : 'sdr-btn-ghost'
            }`}
            onClick={() => engine.setLoudness(!store.loudness())}
            title="Loudness: compresses dynamic range and boosts quiet signals"
          >
            Loudness
          </button>
        </div>

        {/* Stereo Settings (WFM, AM, AM Stereo) */}
        <Show when={store.mode() === 'wfm' || store.mode() === 'am' || store.mode() === 'am-stereo'}>
          <div class="space-y-2">
            <div class="flex justify-between items-center">
              <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
                Stereo
              </label>
              <button
                class={`px-3 py-1 rounded-sm text-[9px] font-mono font-semibold uppercase tracking-wider
                        transition-all duration-150
                        ${store.stereoEnabled()
                          ? 'bg-cyan text-text-inverse shadow-glow-cyan'
                          : 'bg-sdr-base border border-border text-text-secondary hover:text-text-primary hover:bg-sdr-hover'}`}
                onClick={() => engine.setStereoEnabled(!store.stereoEnabled())}
                title={store.stereoEnabled() ? 'Stereo decoding enabled — click to force mono' : 'Stereo decoding disabled — click to enable'}
              >
                {store.stereoEnabled() ? 'On' : 'Off'}
              </button>
            </div>
            {/* Stereo threshold — only for IQ path (not Opus — server handles detection) */}
            <Show when={store.stereoEnabled() && store.iqCodec() !== 'opus'}>
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
            <Show when={store.stereoEnabled() && store.iqCodec() === 'opus'}>
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
  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Noise Reduction</div>
      <div class="p-3 space-y-3">
        {/* Spectral NR */}
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider">
              Spectral NR
            </label>
            <button
              class={`px-3 py-1 rounded-sm text-[9px] font-mono font-semibold uppercase tracking-wider
                      transition-all duration-150
                      ${store.nrEnabled()
                        ? 'bg-cyan text-text-inverse shadow-glow-cyan'
                        : 'bg-sdr-base border border-border text-text-secondary hover:text-text-primary hover:bg-sdr-hover'}`}
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
              class={`px-3 py-1 rounded-sm text-[9px] font-mono font-semibold uppercase tracking-wider
                      transition-all duration-150
                      ${store.nbEnabled()
                        ? 'bg-cyan text-text-inverse shadow-glow-cyan'
                        : 'bg-sdr-base border border-border text-text-secondary hover:text-text-primary hover:bg-sdr-hover'}`}
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

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Waterfall</div>
      <div class="p-3 space-y-3">
        {/* Color Theme */}
        <div>
          <label class="text-[9px] font-mono text-text-secondary uppercase tracking-wider mb-1 block">
            Color Theme
          </label>
          <div class="flex flex-wrap gap-1">
            <For each={themes}>
              {(theme) => (
                <button
                  class={`sdr-mode-btn text-[8px] ${store.waterfallTheme() === theme ? 'active' : ''}`}
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
            class={`px-3 py-1 rounded-sm text-[9px] font-mono font-semibold uppercase tracking-wider
                    transition-all duration-150
                    ${store.waterfallAutoRange()
                      ? 'bg-cyan text-text-inverse shadow-glow-cyan'
                      : 'bg-sdr-base border border-border text-text-secondary hover:text-text-primary hover:bg-sdr-hover'}`}
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
      </div>
    </div>
  );
};

// ---- S-Meter ----
const SMeter: Component = () => {
  // Peak hold: tracks the highest level and decays slowly
  let peakPct = 0;
  let peakDecayTimer: ReturnType<typeof setInterval> | undefined;
  const [peakHold, setPeakHold] = createSignal(0);

  // Canvas ref for needle meter
  let canvasRef: HTMLCanvasElement | undefined;
  let rafId: number | undefined;

  // Start peak decay timer on mount
  onMount(() => {
    peakDecayTimer = setInterval(() => {
      // Decay peak by 0.5% per tick (50ms interval ≈ 10 seconds from full to zero)
      if (peakPct > 0) {
        peakPct = Math.max(0, peakPct - 0.5);
        setPeakHold(peakPct);
      }
    }, 50);
  });

  onCleanup(() => {
    if (peakDecayTimer) clearInterval(peakDecayTimer);
    if (rafId) cancelAnimationFrame(rafId);
  });

  const pct = () => {
    const level = store.signalLevel();
    const min = store.waterfallMin();
    const max = store.waterfallMax();
    const range = max - min;
    if (range === 0) return 0;
    const p = Math.max(0, Math.min(100, ((level - min) / range) * 100));

    // Update peak if current exceeds it
    if (p > peakPct) {
      peakPct = p;
      setPeakHold(p);
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

  // Needle meter: smoothed angle for fluid movement
  let smoothedPct = 0;

  // Draw classic analog S-meter (Kenwood/Yaesu style)
  const drawNeedleMeter = () => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── Warm backlit face background ──
    const bgGrad = ctx.createRadialGradient(w / 2, h * 0.35, 0, w / 2, h * 0.35, w * 0.7);
    bgGrad.addColorStop(0, '#faf6e8');      // warm white center
    bgGrad.addColorStop(0.5, '#f5edd4');    // yellowish warmth
    bgGrad.addColorStop(1, '#e8dfc0');      // darker edges — aged paper
    ctx.fillStyle = bgGrad;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 3);
    ctx.fill();

    // Subtle inner shadow / bezel
    ctx.strokeStyle = 'rgba(160, 140, 100, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 3);
    ctx.stroke();

    // ── Geometry ──
    const cx = w / 2;
    const cy = h - 10;
    const radius = Math.min(w * 0.40, h - 28);
    const startAngle = Math.PI * 0.83;
    const endAngle = Math.PI * 0.17;
    const sweep = (2 * Math.PI - startAngle + endAngle);

    // Smooth the needle
    const targetPct = pct();
    smoothedPct += (targetPct - smoothedPct) * 0.15;

    const pctToAngle = (p: number) => startAngle + (p / 100) * sweep;

    // ── Scale definitions ──
    // Top scale: S-units (S1–S9, then +10 to +60 dB over S9)
    const sScale = [
      { label: '1',   pct: 0 },
      { label: '2',   pct: 7.1 },
      { label: '3',   pct: 14.3 },
      { label: '4',   pct: 21.4 },
      { label: '5',   pct: 28.6 },
      { label: '6',   pct: 35.7 },
      { label: '7',   pct: 42.9 },
      { label: '8',   pct: 50.0 },
      { label: '9',   pct: 57.1 },
      { label: '+10', pct: 66.7 },
      { label: '+20', pct: 71.4 },
      { label: '+30', pct: 78.6 },
      { label: '+40', pct: 85.7 },
      { label: '+50', pct: 92.9 },
      { label: '+60', pct: 100 },
    ];

    // Bottom scale: dB (rough mapping)
    const dbScale = [
      { label: '-54', pct: 0 },
      { label: '-42', pct: 14.3 },
      { label: '-30', pct: 28.6 },
      { label: '-18', pct: 42.9 },
      { label: '-6',  pct: 57.1 },
      { label: '0',   pct: 66.7 },
      { label: '+10', pct: 71.4 },
      { label: '+20', pct: 78.6 },
      { label: '+30', pct: 85.7 },
      { label: '+40', pct: 92.9 },
      { label: '+50', pct: 100 },
    ];

    // Minor ticks between major S-units (every ~3.57%)
    const minorTicks: number[] = [];
    for (let p = 0; p <= 100; p += 3.57) {
      minorTicks.push(p);
    }

    // ── "S" label ──
    const sLabelSize = Math.max(11, w * 0.045);
    ctx.font = `bold italic ${sLabelSize}px serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#2a2520';
    const sLabelAngle = pctToAngle(-6);
    ctx.fillText('S', cx + (radius + 12) * Math.cos(sLabelAngle), cy + (radius + 12) * Math.sin(sLabelAngle));

    // ── Top arc: S-unit scale ──
    const outerR = radius + 5;
    const tickFont = Math.max(7, w * 0.027);
    const smallTickFont = Math.max(6, w * 0.022);

    // Draw colored arc segments behind the scale
    // Green zone: S1–S9
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1, pctToAngle(0), pctToAngle(57.1), false);
    ctx.strokeStyle = 'rgba(40, 100, 60, 0.12)';
    ctx.lineWidth = 8;
    ctx.stroke();

    // Red zone: S9+
    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 1, pctToAngle(57.1), pctToAngle(100), false);
    ctx.strokeStyle = 'rgba(180, 30, 30, 0.12)';
    ctx.lineWidth = 8;
    ctx.stroke();

    // Minor tick marks
    ctx.strokeStyle = 'rgba(80, 70, 50, 0.25)';
    ctx.lineWidth = 0.5;
    for (const mp of minorTicks) {
      const a = pctToAngle(mp);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + (outerR + 2) * cos, cy + (outerR + 2) * sin);
      ctx.lineTo(cx + (outerR - 3) * cos, cy + (outerR - 3) * sin);
      ctx.stroke();
    }

    // Major S-unit ticks and labels
    ctx.font = `bold ${tickFont}px "Arial", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const su of sScale) {
      const a = pctToAngle(su.pct);
      const cos = Math.cos(a);
      const sin = Math.sin(a);

      // Major tick
      ctx.beginPath();
      ctx.moveTo(cx + (outerR + 3) * cos, cy + (outerR + 3) * sin);
      ctx.lineTo(cx + (outerR - 6) * cos, cy + (outerR - 6) * sin);
      ctx.strokeStyle = su.pct > 57.1 ? '#b01e1e' : '#2a2520';
      ctx.lineWidth = su.pct === 57.1 ? 1.5 : 1;
      ctx.stroke();

      // Label
      const lr = outerR + (su.label.length > 2 ? 14 : 11);
      ctx.fillStyle = su.pct > 57.1 ? '#b01e1e' : '#2a2520';
      ctx.font = su.pct > 57.1
        ? `bold ${smallTickFont}px "Arial", sans-serif`
        : `bold ${tickFont}px "Arial", sans-serif`;
      ctx.fillText(su.label, cx + lr * cos, cy + lr * sin);
    }

    // ── Bottom arc: dB scale ──
    const innerR = radius - 8;
    ctx.font = `${smallTickFont}px "Arial", sans-serif`;

    // Thin arc for dB scale
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, pctToAngle(0), pctToAngle(100), false);
    ctx.strokeStyle = 'rgba(80, 70, 50, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    for (const db of dbScale) {
      const a = pctToAngle(db.pct);
      const cos = Math.cos(a);
      const sin = Math.sin(a);

      // Tick inward
      ctx.beginPath();
      ctx.moveTo(cx + innerR * cos, cy + innerR * sin);
      ctx.lineTo(cx + (innerR - 4) * cos, cy + (innerR - 4) * sin);
      ctx.strokeStyle = 'rgba(80, 70, 50, 0.4)';
      ctx.lineWidth = 0.7;
      ctx.stroke();

      // Label
      const lr = innerR - 10;
      ctx.fillStyle = 'rgba(80, 70, 50, 0.6)';
      ctx.font = `${smallTickFont}px "Arial", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(db.label, cx + lr * cos, cy + lr * sin);
    }

    // "dB" label
    ctx.font = `italic ${smallTickFont}px "Arial", sans-serif`;
    ctx.fillStyle = 'rgba(80, 70, 50, 0.5)';
    ctx.textAlign = 'right';
    const dbLabelAngle = pctToAngle(106);
    ctx.fillText('dB', cx + (innerR - 6) * Math.cos(dbLabelAngle), cy + (innerR - 6) * Math.sin(dbLabelAngle));

    // ── Peak hold ghost needle ──
    const peakAngle = pctToAngle(peakHold());
    const peakLen = radius - 2;
    ctx.beginPath();
    ctx.moveTo(cx + 3 * Math.cos(peakAngle + Math.PI / 2), cy + 3 * Math.sin(peakAngle + Math.PI / 2));
    ctx.lineTo(cx + peakLen * Math.cos(peakAngle), cy + peakLen * Math.sin(peakAngle));
    ctx.lineTo(cx + 3 * Math.cos(peakAngle - Math.PI / 2), cy + 3 * Math.sin(peakAngle - Math.PI / 2));
    ctx.closePath();
    ctx.fillStyle = 'rgba(180, 30, 30, 0.10)';
    ctx.fill();

    // ── Main needle (red, classic tapered shape) ──
    const needleAngle = pctToAngle(smoothedPct);
    const needleLen = radius + 1;
    const needleTailLen = 10;

    // Needle shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;

    // Tapered needle body
    ctx.beginPath();
    // Tail (thick end behind pivot)
    ctx.moveTo(
      cx - needleTailLen * Math.cos(needleAngle) + 2.5 * Math.cos(needleAngle + Math.PI / 2),
      cy - needleTailLen * Math.sin(needleAngle) + 2.5 * Math.sin(needleAngle + Math.PI / 2)
    );
    ctx.lineTo(
      cx - needleTailLen * Math.cos(needleAngle) - 2.5 * Math.cos(needleAngle + Math.PI / 2),
      cy - needleTailLen * Math.sin(needleAngle) - 2.5 * Math.sin(needleAngle + Math.PI / 2)
    );
    // Tip (sharp point)
    ctx.lineTo(
      cx + needleLen * Math.cos(needleAngle),
      cy + needleLen * Math.sin(needleAngle)
    );
    ctx.closePath();
    ctx.fillStyle = '#cc2222';
    ctx.fill();

    // Thin center line for realism
    ctx.beginPath();
    ctx.moveTo(cx - needleTailLen * Math.cos(needleAngle), cy - needleTailLen * Math.sin(needleAngle));
    ctx.lineTo(cx + needleLen * Math.cos(needleAngle), cy + needleLen * Math.sin(needleAngle));
    ctx.strokeStyle = '#a01818';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.restore();

    // Pivot cap (black circle with highlight)
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a1a';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - 1, cy - 1, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.fill();

    // ── dB readout below the scales ──
    const readoutSize = Math.max(8, w * 0.032);
    ctx.font = `${readoutSize}px "Arial", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(60, 50, 35, 0.5)';
    ctx.fillText(`${store.signalLevel().toFixed(0)} dBm`, cx, cy - radius * 0.32);

    // Schedule next frame
    rafId = requestAnimationFrame(drawNeedleMeter);
  };

  // Start/stop animation when meter style changes
  createEffect(() => {
    if (store.meterStyle() === 'needle') {
      // Kick off render loop next frame (canvas should be in DOM by then)
      rafId = requestAnimationFrame(drawNeedleMeter);
    } else {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = undefined;
      }
    }
  });

  const toggleStyle = () => {
    store.setMeterStyle(store.meterStyle() === 'bar' ? 'needle' : 'bar');
  };

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">
        <span>Signal</span>
        <button
          class="ml-auto text-[8px] font-mono text-text-dim hover:text-text-secondary transition-colors uppercase tracking-wider"
          onClick={toggleStyle}
          title={`Switch to ${store.meterStyle() === 'bar' ? 'needle' : 'bar'} meter`}
        >
          {store.meterStyle() === 'bar' ? 'Needle' : 'Bar'}
        </button>
      </div>
      <div class="p-3">
        <Show when={store.meterStyle() === 'bar'}>
          <div class="flex justify-between text-[9px] text-text-dim font-mono mb-1">
            <span>S-Meter</span>
            <span class="text-text-secondary">{store.signalLevel().toFixed(0)} dB</span>
          </div>
          <div class="h-2.5 bg-sdr-base rounded-sm border border-border overflow-hidden relative">
            {/* Segment dividers */}
            <div class="absolute inset-0 flex">
              <For each={Array(9).fill(0)}>
                {() => <div class="flex-1 border-r border-border/30" />}
              </For>
            </div>
            {/* Current level bar */}
            <div
              class={`h-full rounded-sm transition-[width] duration-100 ease-linear
                      ${barColor()} shadow-[0_0_8px_currentColor]`}
              style={{ width: `${pct()}%` }}
            />
            {/* Peak hold indicator */}
            <div
              class="absolute top-0 bottom-0 w-[2px] bg-text-secondary opacity-80 transition-[left] duration-75 ease-linear"
              style={{ left: `${peakHold()}%` }}
            />
          </div>
          <div class="flex justify-between text-[7px] text-text-muted font-mono mt-0.5">
            <span>S1</span><span>3</span><span>5</span><span>7</span><span>9</span>
            <span>+20</span><span>+40</span><span>+60</span>
          </div>
        </Show>
        <Show when={store.meterStyle() === 'needle'}>
          <canvas
            ref={canvasRef}
            class="w-full rounded-sm"
            style={{ height: '110px' }}
          />
        </Show>
      </div>
    </div>
  );
};

// ---- Codec Settings ----
const CodecSettings: Component = () => {
  const fftCodecs: { value: CodecType; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'adpcm', label: 'ADPCM' },
    { value: 'deflate', label: 'Deflate' },
  ];

  const iqCodecs: { value: CodecType; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'adpcm', label: 'ADPCM' },
    { value: 'opus', label: 'Opus' },
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

  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Compression</div>
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
          <div class="flex gap-1">
            <For each={fftCodecs}>
              {(c) => (
                <button
                  class={`sdr-mode-btn flex-1 ${store.fftCodec() === c.value ? 'active' : ''}`}
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
          <div class="flex gap-1">
            <For each={iqCodecs}>
              {(c) => (
                <button
                  class={`sdr-mode-btn flex-1 ${store.iqCodec() === c.value ? 'active' : ''}`}
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
    </div>
  );
};

// ---- Connection Status ----
const ConnectionStatus: Component = () => {
  return (
    <div class="sdr-panel">
      <div class="sdr-panel-header">Status</div>
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
